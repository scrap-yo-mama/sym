// OpenTelemetry opt-in (14 § 10, INV9) : COUPÉ par défaut. Aucun module `@opentelemetry/*` n'est importé tant que
// `OTEL_ENABLED=true` : tous les imports du SDK sont dynamiques, dans `initTelemetry`, après la décision de l'admin.
//
// Garanties (assert_otel_off_by_default, assert_no_traceparent_outbound) :
// - aucune instrumentation automatique (ni http, ni undici, ni pg) : c'est elle qui injecte `traceparent` dans les
//   requêtes sortantes ; ici, seuls des spans manuels sont créés ;
// - aucun propagateur global n'est enregistré : `tracestate` et `baggage` ne sont donc jamais écrits non plus ;
// - le contexte W3C n'est porté que dans la charge des jobs pg-boss (`_trace`) et lu à la main (format `traceparent`) ;
// - tout span passe par un exporteur qui masque (INV8) et retire le contenu LLM avant l'envoi au collecteur configuré.
import type { Attributes } from '@opentelemetry/api';
import type * as OtelApi from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { redact, secretValues, type SecretValueRegistry } from '../crypto/redact.js';
import type { OtelConfig } from './config.js';

export type Telemetry = {
  readonly enabled: boolean;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
};

export type SpanHandle = {
  setAttribute(key: string, value: string | number | boolean): void;
  /** Marque le span en erreur ; aucun message n'est joint (il pourrait contenir un secret ou du contenu cible). */
  fail(errorClass?: string): void;
};

const NOOP_SPAN: SpanHandle = { setAttribute() {}, fail() {} };
const DISABLED: Telemetry = { enabled: false, forceFlush: async () => undefined, shutdown: async () => undefined };

type Active = { api: typeof OtelApi; tracer: OtelApi.Tracer; provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> }; refs: number };
let active: Active | undefined;

/** Contenu de prompt ou de réponse d'un modèle : jamais exporté (14 § 10 : « Contenu LLM coupé des spans »). */
const LLM_CONTENT_KEY = /^(?:gen_ai\.(?:prompt|completion|input|output|system_instructions|request\.messages|response\.messages)|llm\.(?:prompt|completion|content|messages))/i;

function cleanAttributes(attributes: Attributes | undefined, registry: SecretValueRegistry): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (LLM_CONTENT_KEY.test(key)) continue;
    out[registry.redactText(key)] = redact(value, registry);
  }
  return out;
}

/** Copie lecture seule du span avec nom, attributs, évènements, liens et statut masqués (INV8). */
function redactSpan(span: ReadableSpan, registry: SecretValueRegistry): ReadableSpan {
  return Object.create(span, {
    name: { value: registry.redactText(span.name), enumerable: true },
    attributes: { value: cleanAttributes(span.attributes, registry), enumerable: true },
    events: {
      value: span.events.map((e) => ({ ...e, name: registry.redactText(e.name), attributes: cleanAttributes(e.attributes, registry) })),
      enumerable: true,
    },
    links: { value: span.links.map((l) => ({ ...l, attributes: cleanAttributes(l.attributes, registry) })), enumerable: true },
    status: {
      value: span.status.message === undefined ? span.status : { ...span.status, message: registry.redactText(span.status.message) },
      enumerable: true,
    },
  }) as ReadableSpan;
}

export function redactingExporter(inner: SpanExporter, registry: SecretValueRegistry = secretValues): SpanExporter {
  return {
    export: (spans, done) => inner.export(spans.map((s) => redactSpan(s, registry)), done),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

export type InitTelemetryOptions = {
  /** Remplace l'exporteur OTLP (tests : capture des spans sans réseau). Il reste enveloppé par le masquage. */
  exporter?: SpanExporter;
  registry?: SecretValueRegistry;
  /** Délai du lot d'export (défaut 5 s). */
  exportIntervalMs?: number;
};

/**
 * Démarre le traçage si `config.enabled` ; sinon ne charge rien et ne fait rien. Un seul fournisseur par processus : un
 * second appel (server et worker dans le même processus, tests) le partage, et le dernier `shutdown` l'arrête.
 */
export async function initTelemetry(config: OtelConfig, options: InitTelemetryOptions = {}): Promise<Telemetry> {
  if (!config.enabled) return DISABLED;
  if (active) return handle(active);
  const registry = options.registry ?? secretValues;
  const [api, base, resources, hooks] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/context-async-hooks'),
  ]);

  let inner = options.exporter;
  if (!inner) {
    const headers: Record<string, string> = {};
    for (const pair of config.headers?.reveal().split(',') ?? []) {
      const at = pair.indexOf('=');
      if (at > 0) headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    const settings = { url: config.tracesUrl, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    inner =
      config.protocol === 'http/json'
        ? new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter(settings)
        : new (await import('@opentelemetry/exporter-trace-otlp-proto')).OTLPTraceExporter(settings);
  }

  const ratio = new base.TraceIdRatioBasedSampler(config.samplerArg);
  const sampler =
    config.sampler === 'always_on' ? new base.AlwaysOnSampler()
    : config.sampler === 'always_off' ? new base.AlwaysOffSampler()
    : config.sampler === 'traceidratio' ? ratio
    : config.sampler === 'parentbased_always_on' ? new base.ParentBasedSampler({ root: new base.AlwaysOnSampler() })
    : config.sampler === 'parentbased_always_off' ? new base.ParentBasedSampler({ root: new base.AlwaysOffSampler() })
    : new base.ParentBasedSampler({ root: ratio });

  const provider = new base.BasicTracerProvider({
    resource: resources.resourceFromAttributes({ 'service.name': config.serviceName }),
    sampler,
    spanProcessors: [
      new base.BatchSpanProcessor(redactingExporter(inner, registry), { scheduledDelayMillis: options.exportIntervalMs ?? 5000 }),
    ],
  });
  // Gestionnaire de contexte seul : propage le span actif. Ni propagateur, ni instrumentation (voir l'en-tête).
  api.context.setGlobalContextManager(new hooks.AsyncLocalStorageContextManager().enable());

  active = { api, tracer: provider.getTracer('scrapyomama'), provider, refs: 1 };
  return handle(active, true);
}

/** Poignée propre à chaque appelant : `shutdown` est idempotent et ne ferme le fournisseur qu'à la dernière libération. */
function handle(shared: Active, first = false): Telemetry {
  let released = false;
  if (!first) shared.refs += 1;
  return {
    enabled: true,
    forceFlush: () => shared.provider.forceFlush(),
    shutdown: async () => {
      if (released) return;
      released = true;
      shared.refs -= 1;
      if (shared.refs > 0 || active !== shared) return;
      active = undefined;
      await shared.provider.shutdown();
      shared.api.context.disable();
    },
  };
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Contexte courant au format W3C `traceparent`, pour la charge d'un job (`_trace`) ; `undefined` si OTel est coupé. */
export function currentTraceparent(): string | undefined {
  if (!active) return undefined;
  const ctx = active.api.trace.getActiveSpan()?.spanContext();
  if (!ctx || !active.api.isSpanContextValid(ctx)) return undefined;
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, '0')}`;
}

/**
 * Exécute `fn` dans un span (racine, ou enfant du `traceparent` reçu dans la charge du job). OTel coupé :
 * `fn` s'exécute seule, sans aucun coût ni module chargé.
 */
export async function withSpan<T>(
  name: string,
  options: { attributes?: Record<string, string | number | boolean>; parentTraceparent?: string | null },
  fn: (span: SpanHandle) => Promise<T> | T,
): Promise<T> {
  const current = active;
  if (!current) return fn(NOOP_SPAN);
  const { api, tracer } = current;
  let parent = api.context.active();
  const match = options.parentTraceparent ? TRACEPARENT.exec(options.parentTraceparent) : null;
  if (match && match[1] !== '0'.repeat(32) && match[2] !== '0'.repeat(16)) {
    parent = api.trace.setSpanContext(api.ROOT_CONTEXT, { traceId: match[1]!, spanId: match[2]!, traceFlags: parseInt(match[3]!, 16), isRemote: true });
  }
  return tracer.startActiveSpan(name, { attributes: options.attributes ?? {} }, parent, async (span) => {
    try {
      return await fn({
        setAttribute: (key, value) => void span.setAttribute(key, value),
        fail: (errorClass) => {
          if (errorClass) span.setAttribute('error.class', errorClass);
          span.setStatus({ code: api.SpanStatusCode.ERROR });
        },
      });
    } catch (error) {
      span.setAttribute('error.class', error instanceof Error ? error.name : 'unknown');
      span.setStatus({ code: api.SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Span dont la durée dépasse un appel unique (requête HTTP : ouvert à l'arrivée, fermé à la fin de la réponse).
 * `run(fn)` exécute `fn` dans le contexte du span (le contexte suit les appels asynchrones suivants). `null` si OTel est coupé.
 */
export function startDetachedSpan(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
): { run<T>(fn: () => T): T; end(): void } | null {
  if (!active) return null;
  const { api, tracer } = active;
  const span = tracer.startSpan(name, { attributes });
  const ctx = api.trace.setSpan(api.context.active(), span);
  return { run: (fn) => api.context.with(ctx, fn), end: () => span.end() };
}

/** En-têtes qu'écrirait le propagateur global (`[]` : aucun propagateur, donc ni traceparent, ni tracestate, ni baggage). */
export function registeredPropagationFields(): string[] {
  return active ? active.api.propagation.fields() : [];
}
