// SPDX-License-Identifier: AGPL-3.0-only
// Boucle d'exécution d'une stratégie déclarative (tâche 1.6 ; 04b §2) commune à E1, E2 et E3 : étapes préalables,
// requête modèle, pagination, extraction validée contre `output_schema` (INV1), cadence par domaine avant chaque
// requête (1.9), plafond de requêtes par run. Seul le transport change d'un exécuteur à l'autre. Aucun `eval` :
// l'interpréteur de 1.1b fait toute l'extraction ; une réponse refusée (classe d'échec) n'est jamais extraite.
import { selectElements, elementAttribute, parseHtml } from '../dsl/css.js';
import { DslError } from '../dsl/errors.js';
import { extractRecords } from '../dsl/extract.js';
import { queryValues } from '../dsl/jsonpath.js';
import { parseJsonBounded, resolveLimits, type DslLimits } from '../dsl/limits.js';
import { advancePagination, initialParam, resolveNextUrl, startPagination, type StopReason } from '../dsl/pagination.js';
import type { DeclarativeSpec } from '../dsl/spec.js';
import { renderRequest, type RenderedRequest, type TemplateContext } from '../dsl/template.js';
import { classifyExchange, classifyTransportError } from './classify.js';
import { applyParamAt } from './params.js';
import type { ExecFailure, HttpExchange, RequestPacer, Transport } from './types.js';

export type DeclarativeRunOptions = {
  readonly spec: DeclarativeSpec;
  readonly input: unknown;
  /** `output_schema` d'un enregistrement : chaque page est validée (INV1). */
  readonly outputSchema?: unknown;
  readonly transport: Transport;
  readonly signal: AbortSignal;
  readonly pacer?: RequestPacer;
  /** `domain_pacing.max_requests_per_run` : au-delà, la pagination s'arrête (sortie tronquée, run dégradé). */
  readonly maxRequests?: number;
  /** Garde de classification avant extraction (1.7). Défaut : le statut HTTP seul. */
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
  readonly limits?: Partial<DslLimits>;
};

export type DeclarativeStop = StopReason | 'max_requests_per_run' | 'max_items';

export type DeclarativeRunResult =
  | {
      readonly ok: true;
      readonly records: Record<string, unknown>[];
      readonly pages: number;
      readonly requests: number;
      /** Une source de repli a servi (signal `escalated`, 04b §2). */
      readonly escalated: boolean;
      readonly stop: DeclarativeStop;
      /** Arrêt imposé par un plafond (requêtes par run, items) avant la fin naturelle de la pagination. */
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly failure: ExecFailure; readonly pages: number; readonly requests: number };

class RunFailure extends Error {
  readonly failure: ExecFailure;
  constructor(failure: ExecFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

class RequestCapReached extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function tryParseJson(body: string, limits: DslLimits): unknown {
  const head = body.trimStart()[0];
  if (head !== '{' && head !== '[') return undefined;
  try {
    return parseJsonBounded(body, limits);
  } catch {
    return undefined;
  }
}

/** Lien « suivant » d'une page HTML (`<link rel="next">` ou `<a rel="next">`), rendu comme un en-tête `Link`. */
function htmlNextLink(body: string, limits: DslLimits): string | undefined {
  if (!/rel\s*=\s*["']?next/i.test(body)) return undefined;
  try {
    const doc = parseHtml(body, limits);
    const [first] = selectElements('link[rel~="next"], a[rel~="next"]', doc, 1);
    const href = first === undefined ? undefined : elementAttribute(first, 'href');
    return href === undefined || href === '' ? undefined : `<${href}>; rel="next"`;
  } catch {
    return undefined;
  }
}

function maxPagesFromInput(spec: DeclarativeSpec, input: Record<string, unknown>): number | undefined {
  const ref = spec.pagination?.limits?.max_pages_input;
  if (ref === undefined || !ref.startsWith('input.')) return undefined;
  const value = input[ref.slice('input.'.length)];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Exécute la stratégie : renvoie les enregistrements conformes, ou la classe d'échec du premier refus. */
export async function runDeclarative(options: DeclarativeRunOptions): Promise<DeclarativeRunResult> {
  const { spec, transport, signal, pacer } = options;
  const classify = options.classify ?? classifyExchange;
  const limits = resolveLimits(spec.limits, options.limits);
  const input = isRecord(options.input) ? options.input : {};
  const allowed = spec.request.allowed_hosts;
  const ctx: TemplateContext = { input, page: {}, steps: {} };
  let requests = 0;
  let pages = 0;

  const send = async (request: RenderedRequest): Promise<HttpExchange> => {
    if (options.maxRequests !== undefined && requests >= options.maxRequests) throw new RequestCapReached();
    signal.throwIfAborted();
    if (pacer !== undefined) {
      const slot = await pacer.acquire(request.url);
      if (!slot.granted) throw new RunFailure({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` });
    }
    requests += 1;
    let exchange: HttpExchange;
    try {
      exchange = await transport(request, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RunFailure(classifyTransportError(error));
    }
    await pacer?.report(request.url, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null });
    // Garde de classification AVANT extraction : une réponse refusée n'est jamais extraite (INV6).
    const refused = classify(exchange);
    if (refused !== null) throw new RunFailure(refused);
    return exchange;
  };

  try {
    for (const step of spec.steps ?? []) {
      const exchange = await send(renderRequest(step.request, allowed, ctx));
      let doc: unknown;
      try {
        doc = parseJsonBounded(exchange.body, limits);
      } catch (error) {
        throw new RunFailure({ failure_class: 'extraction', retryable: false, detail: error instanceof DslError ? `step_${error.code}` : 'step_invalid_json' });
      }
      const captured: Record<string, unknown> = {};
      for (const [name, path] of Object.entries(step.capture)) {
        const [value] = queryValues(path, doc, { limits });
        if (value === undefined) throw new RunFailure({ failure_class: 'extraction', retryable: false, detail: 'step_capture_missing' });
        Object.defineProperty(captured, name, { value, enumerable: true, writable: true, configurable: true });
      }
      Object.defineProperty(ctx.steps, step.id, { value: captured, enumerable: true, writable: true, configurable: true });
    }

    const pagination = spec.pagination;
    const state = startPagination();
    const maxPagesInput = maxPagesFromInput(spec, input);
    let param: { at: string; value: string | number } | undefined = pagination === undefined ? undefined : initialParam(pagination);
    let nextUrl: string | undefined;
    const records: Record<string, unknown>[] = [];
    let escalated = false;

    for (;;) {
      ctx.page = { number: state.pages + 1, offset: state.received, ...(param === undefined ? {} : { value: param.value }), ...(state.cursor === null ? {} : { cursor: state.cursor }) };
      let request = nextUrl === undefined ? renderRequest(spec.request, allowed, ctx) : { ...renderRequest(spec.request, allowed, ctx), method: 'GET' as const, url: nextUrl, body: undefined };
      if (nextUrl === undefined && param !== undefined) request = applyParamAt(request, param.at, param.value);
      if (request.body === undefined) delete (request as { body?: unknown }).body;

      let exchange: HttpExchange;
      try {
        exchange = await send(request);
      } catch (error) {
        if (error instanceof RequestCapReached && pages > 0) return { ok: true, records, pages, requests, escalated, stop: 'max_requests_per_run', truncated: true };
        throw error;
      }
      pages += 1;
      const out = extractRecords(spec, { body: exchange.body }, { ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }), limits });
      // Après la première page, une page vide marque la fin (`records_empty`), pas une casse.
      const emptyPage = !out.ok && pages > 1 && out.attempts.every((a) => a.records === 0 && a.problems.every((p) => p.code === 'no_records' || p.code === 'too_few_records'));
      if (!out.ok && !emptyPage) {
        const codes = out.attempts.flatMap((a) => a.problems.map((p) => p.code));
        const detail = codes.includes('schema_mismatch') ? 'schema_mismatch' : (codes[0] ?? 'no_records');
        return { ok: false, failure: { failure_class: 'extraction', retryable: false, detail }, pages, requests };
      }
      const got = out.ok ? out.records : [];
      escalated ||= out.ok && out.escalated;
      for (const r of got) records.push(r);
      if (records.length >= limits.maxItems) {
        records.length = limits.maxItems;
        return { ok: true, records, pages, requests, escalated, stop: 'max_items', truncated: true };
      }
      const document = tryParseJson(exchange.body, limits);
      const linkHeader = exchange.headers['link'] ?? (pagination?.type === 'next_link' && document === undefined ? htmlNextLink(exchange.body, limits) : undefined);
      const decision = advancePagination(
        pagination,
        state,
        { records: got.length, ...(document === undefined ? {} : { document }), ...(linkHeader === undefined ? {} : { linkHeader }) },
        { limits },
        maxPagesInput,
      );
      if (decision.done) return { ok: true, records, pages, requests, escalated, stop: decision.reason, truncated: false };
      if (decision.nextUrl !== undefined) {
        nextUrl = resolveNextUrl(decision.nextUrl, exchange.url, allowed);
      } else if (decision.param !== undefined) {
        param = decision.param;
        nextUrl = undefined;
      }
    }
  } catch (error) {
    if (error instanceof RunFailure) return { ok: false, failure: error.failure, pages, requests };
    if (error instanceof RequestCapReached) return { ok: false, failure: { failure_class: 'code_error', retryable: false, detail: 'max_requests_per_run' }, pages, requests };
    if (error instanceof DslError) return { ok: false, failure: classifyTransportError(error), pages, requests };
    throw error;
  }
}
