// SPDX-License-Identifier: AGPL-3.0-only
// E3 en script (tâche 1.6, INV7, D-29) : un Chromium du pool, un contexte de run neuf derrière le proxy d'egress de
// l'essai (verrou de domaines compris), la page de départ ouverte et classée par l'hôte, puis le script dans le bac à
// sable de 1.5 (`SandboxEngine`) avec les ponts `ctx.fetch` (session réseau de l'essai, même barreau), `ctx.page.*`,
// `ctx.emit`, `ctx.log`. Le script ne touche jamais la page directement ; ses éléments sont validés contre
// `output_schema` par l'appelant (INV1). Toute violation tue l'enfant (`sandbox_violation`).
// Cadence par domaine (1.9, 17 §5) : comme les exécuteurs déclaratifs, chaque requête du script réserve un créneau
// avant de partir et rend compte de son statut (429, `Retry-After`, 5xx allongent la cadence) : chaque saut de
// `ctx.fetch`, et chaque requête de document, XHR ou fetch de la page (page de départ, `ctx.page.goto`, navigations d'un
// clic, requêtes lancées par `evaluate` ou par le site), au niveau du contexte de run. Toutes comptent dans
// `domain_pacing.max_requests_per_run` ; au-delà, refus sans violation et sortie tronquée.
// Actions d'écriture (08 §4 mesure 4) : sans `allow_write_actions`, toute soumission (navigation hors GET/HEAD) est
// coupée au niveau du contexte de run et imputée au script ; le clic sur un contrôle d'envoi est refusé par le pont.
// Journal du script (`ctx.log`) : rendu à l'appelant, qui l'écrit dans le journal du run (masqué, 17 §6).
import type { SandboxEngine, SandboxLimits, SandboxViolation } from '@runtime/core';
import { classifyExchange, classifyTransportError, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type NetworkSession, type SsrfGuard } from '@runtime/core/net';
import type { Logger } from 'pino';
import type { Request } from 'playwright-core';
import { boundedContent, TOO_LARGE } from '../browser/bounded.js';
import type { BrowserPool } from '../browser/pool.js';
import { hostAllowed, openRunContext } from '../browser/run-context.js';
import { DEFAULT_SANDBOX_LIMITS } from '../sandbox/engine.js';
import { createSandboxBridges, SandboxBridgeError, type BridgeResponse } from '../sandbox/bridges.js';
import { createPageBridge, hostViolationWatch } from './script.js';

const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_ITEMS = 10_000;
/** Plafond de requêtes d'un essai quand l'API n'en fixe pas (`domain_pacing.max_requests_per_run`). */
const DEFAULT_MAX_REQUESTS = 100;
/** Requêtes de la page soumises à la cadence : documents (navigations) et appels de données. */
const PACED_TYPES = new Set(['document', 'xhr', 'fetch', 'eventsource']);
const READ_METHODS = new Set(['GET', 'HEAD']);

/** Branchement du bac à sable (1.5) : moteur, lecture du script référencé par la version de stratégie, plafonds. */
export type ScriptPort = {
  readonly engine: SandboxEngine;
  loadScript(scriptRef: string, spec: unknown): Promise<string>;
  readonly limits?: SandboxLimits;
};

/**
 * Source d'un script E3 : en V1, gardée dans la version de stratégie elle-même (`script_ref = "inline"`,
 * `spec.source`), donc versionnée, visible et réversible avec elle (08 §4.6). Toute autre référence est refusée.
 */
const MAX_SCRIPT_BYTES = 256 * 1024;
export async function loadInlineScript(scriptRef: string, spec: unknown): Promise<string> {
  const source = (spec as { source?: unknown } | null)?.source;
  if (scriptRef !== 'inline' || typeof source !== 'string' || source.length === 0 || Buffer.byteLength(source) > MAX_SCRIPT_BYTES) {
    throw new Error('script introuvable');
  }
  return source;
}

export type ScriptExecutorOptions = {
  readonly pool: BrowserPool;
  readonly egress: BrowserEgress;
  readonly guard: SsrfGuard;
  /** Session réseau de l'essai (même barreau que l'egress) : transport de `ctx.fetch`. */
  readonly session: Pick<NetworkSession, 'fetch'>;
  readonly engine: SandboxEngine;
  readonly code: string;
  readonly allowedHosts: readonly string[];
  readonly startUrl: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly limits?: SandboxLimits;
  readonly pacer?: RequestPacer;
  /** `domain_pacing.max_requests_per_run` (défaut 100). */
  readonly maxRequests?: number;
  /** `apis.allow_write_actions` (défaut : faux). */
  readonly allowWriteActions?: boolean;
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
  readonly navigationTimeoutMs?: number;
};

export type ScriptRunOutcome = {
  readonly result: DeclarativeRunResult;
  /** Violations du bac à sable (journalisées `sandbox_violation`), vides si aucune. */
  readonly violations: readonly SandboxViolation[];
  readonly killed: boolean;
  readonly killLatencyMs?: number;
  /** Lignes de `ctx.log` du script (texte libre non fiable) : à écrire dans le journal du run, jamais ailleurs. */
  readonly logs: readonly (readonly string[])[];
};

const fail = (failure: ExecFailure, pages: number, requests: number): DeclarativeRunResult => ({ ok: false, failure, pages, requests });
const codeError = (detail: string): ExecFailure => ({ failure_class: 'code_error', retryable: false, detail });

export function runScriptExecutor(options: ScriptExecutorOptions): Promise<ScriptRunOutcome> {
  const timeoutMs = options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const allowWriteActions = options.allowWriteActions === true;
  const { pacer } = options;
  const logs: string[][] = [];
  let requests = 0;
  let capReached = false;
  let paceRefusal: string | undefined;
  /** Compte rendu à la cadence, sérialisé : une réservation attend le compte rendu précédent (un 429 ralentit la suivante). */
  let reporting: Promise<void> = Promise.resolve();
  const report = (url: string, status: number, retryAfter: string | null): Promise<void> => {
    if (pacer === undefined) return Promise.resolve();
    reporting = reporting.then(() => pacer.report(url, { status, retryAfter })).catch(() => undefined);
    return reporting;
  };
  /** Une requête de plus : plafond du run, puis créneau de la cadence. `false` : refusée (sans connexion). */
  const reserve = async (url: string): Promise<'ok' | 'cap' | 'paced'> => {
    if (paceRefusal !== undefined) return 'paced';
    if (requests >= maxRequests) {
      capReached = true;
      return 'cap';
    }
    requests += 1;
    if (pacer === undefined) return 'ok';
    await reporting;
    const slot = await pacer.acquire(url);
    if (slot.granted) return 'ok';
    paceRefusal = slot.reason;
    return 'paced';
  };
  const pacedRequests = new WeakSet<Request>();

  return options.pool.run(options.signal, async (browser) => {
    const host = hostViolationWatch();
    const rc = await openRunContext(browser, {
      egressServer: options.egress.server,
      allowedHosts: options.allowedHosts,
      onViolation: (h) => host.report(h),
      admit: async (request) => {
        // Soumission (navigation hors GET/HEAD) sans `allow_write_actions` : coupée, imputée au script.
        if (!allowWriteActions && request.isNavigationRequest() && !READ_METHODS.has(request.method())) {
          host.report(new URL(request.url()).hostname, 'write_action_blocked');
          return false;
        }
        if (!PACED_TYPES.has(request.resourceType())) return true;
        if ((await reserve(request.url())) !== 'ok') return false;
        pacedRequests.add(request);
        return true;
      },
    });
    rc.context.on('response', (response) => {
      if (pacedRequests.has(response.request())) void report(response.url(), response.status(), response.headers()['retry-after'] ?? null);
    });
    rc.page.on('domcontentloaded', () => host.documentLoaded());
    // Refus du verrou au niveau du proxy d'egress (sauts de redirection, TURN/TCP de WebRTC…) : même guet.
    const unsubscribe = options.egress.onDomainBlocked((target) => host.report(target.host));
    const onAbort = () => void rc.close();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (result: DeclarativeRunResult, rest: Omit<ScriptRunOutcome, 'result' | 'logs'> = { violations: [], killed: false }): ScriptRunOutcome => ({
      ...rest,
      result: paceRefusal !== undefined && !result.ok ? { ...result, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${paceRefusal}` } } : result,
      logs,
    });
    try {
      rc.page.setDefaultNavigationTimeout(timeoutMs);
      rc.page.setDefaultTimeout(timeoutMs);
      // Page de départ : réservée à la cadence (au niveau du contexte), ouverte par l'hôte, classée avant tout code.
      let exchange: HttpExchange;
      try {
        host.beginHostOp();
        const landing = await guardedGoto(rc.page, options.startUrl, options.guard, { waitUntil: 'load' as const, timeout: timeoutMs }).finally(() => host.endHostOp());
        // Redirection hors des domaines de l'API : refusée par le proxy d'egress ; faute de stratégie, jamais un réseau.
        if (landing !== null && !hostAllowed(landing.url(), options.allowedHosts)) throw new DomainNotAllowedError(new URL(landing.url()).hostname);
        const html = await boundedContent(rc.page, MAX_RESPONSE_BYTES);
        if (html === TOO_LARGE) return finish(fail({ failure_class: 'extraction', retryable: false, detail: 'response_too_large' }, 1, requests));
        exchange = { status: landing?.status() ?? 0, headers: landing?.headers() ?? {}, body: html, url: rc.page.url() };
      } catch (error) {
        if (options.signal.aborted) throw error;
        return finish(fail(classifyTransportError(error), 1, requests));
      }
      const refused = (options.classify ?? classifyExchange)(exchange);
      if (refused !== null) return finish(fail(refused, 1, requests));

      const handle = createSandboxBridges({
        allowedDomains: options.allowedHosts,
        guard: options.guard,
        logger: options.logger,
        maxItems: MAX_ITEMS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        // Le plafond du run est tenu par le transport ci-dessous (refus sans violation), pas par le quota du pont.
        maxRequests: Number.MAX_SAFE_INTEGER,
        onLog: (args) => void logs.push([...args]),
        // `ctx.fetch` : un saut à la fois (le pont contrôle le domaine de chaque redirection), par la session de l'essai,
        // chaque saut réservé à la cadence et compté dans le plafond du run.
        fetch: async (request, signal) => {
          const slot = await reserve(request.url);
          if (slot === 'cap') throw new SandboxBridgeError('request_cap', false);
          if (slot === 'paced') throw new SandboxBridgeError('rate_limited', false);
          const response = (await options.session.fetch(
            request.url,
            { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), signal },
            { followRedirects: false },
          )) as unknown as BridgeResponse;
          await report(request.url, response.status, response.headers.get('retry-after'));
          return response;
        },
      });
      handle.bridges.page = createPageBridge({
        page: rc.page,
        guard: options.guard,
        allowedHosts: options.allowedHosts,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxItems: MAX_ITEMS,
        timeoutMs,
        watch: host,
        allowWriteActions,
      });
      const sandbox = await options.engine.run(options.code, handle.bridges, options.limits ?? DEFAULT_SANDBOX_LIMITS, {
        input: options.input,
        signal: options.signal,
        watch: host.watch,
      });
      options.signal.throwIfAborted();
      const base = { violations: sandbox.violations, killed: sandbox.killed, ...(sandbox.killLatencyMs === undefined ? {} : { killLatencyMs: sandbox.killLatencyMs }) };
      if (sandbox.outcome === 'violation') return finish(fail(codeError('sandbox_violation'), 1, requests), base);
      if (sandbox.outcome !== 'ok') return finish(fail(codeError(capReached ? 'max_requests_per_run' : `sandbox_${sandbox.outcome}`), 1, requests), base);
      if (paceRefusal !== undefined) return finish(fail({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${paceRefusal}` }, 1, requests), base);
      const records = handle.items.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && !Array.isArray(i));
      if (records.length !== handle.items.length) return finish(fail({ failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }, 1, requests), base);
      return finish(
        { ok: true, records, pages: 1, requests, escalated: false, stop: capReached ? 'max_requests_per_run' : 'no_pagination', truncated: capReached },
        base,
      );
    } finally {
      unsubscribe();
      options.signal.removeEventListener('abort', onAbort);
      await rc.close();
    }
  });
}
