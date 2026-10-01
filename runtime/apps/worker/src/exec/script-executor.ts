// SPDX-License-Identifier: AGPL-3.0-only
// E3 en script (tâche 1.6, INV7, D-29) : un Chromium du pool, un contexte de run neuf derrière le proxy d'egress de
// l'essai (verrou de domaines compris), la page de départ ouverte et classée par l'hôte, puis le script dans le bac à
// sable de 1.5 (`SandboxEngine`) avec les ponts `ctx.fetch` (session réseau de l'essai, même barreau), `ctx.page.*`,
// `ctx.emit`, `ctx.log`. Le script ne touche jamais la page directement ; ses éléments sont validés contre
// `output_schema` par l'appelant (INV1). Toute violation tue l'enfant (`sandbox_violation`).
import type { SandboxEngine, SandboxLimits, SandboxViolation } from '@runtime/core';
import { classifyExchange, classifyTransportError, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import { guardedGoto, type BrowserEgress, type NetworkSession, type SsrfGuard } from '@runtime/core/net';
import type { Logger } from 'pino';
import type { BrowserPool } from '../browser/pool.js';
import { openRunContext } from '../browser/run-context.js';
import { DEFAULT_SANDBOX_LIMITS } from '../sandbox/engine.js';
import { createSandboxBridges, type BridgeResponse } from '../sandbox/bridges.js';
import { createPageBridge, hostViolationWatch } from './script.js';

const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_ITEMS = 10_000;

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
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
  readonly navigationTimeoutMs?: number;
};

export type ScriptRunOutcome = {
  readonly result: DeclarativeRunResult;
  /** Violations du bac à sable (journalisées `sandbox_violation`), vides si aucune. */
  readonly violations: readonly SandboxViolation[];
  readonly killed: boolean;
  readonly killLatencyMs?: number;
};

const fail = (failure: ExecFailure, pages = 1): DeclarativeRunResult => ({ ok: false, failure, pages, requests: pages });
const codeError = (detail: string): ExecFailure => ({ failure_class: 'code_error', retryable: false, detail });

export function runScriptExecutor(options: ScriptExecutorOptions): Promise<ScriptRunOutcome> {
  const timeoutMs = options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
  return options.pool.run(options.signal, async (browser) => {
    const host = hostViolationWatch();
    const rc = await openRunContext(browser, { egressServer: options.egress.server, allowedHosts: options.allowedHosts, onViolation: host.report });
    const onAbort = () => void rc.close();
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      rc.page.setDefaultNavigationTimeout(timeoutMs);
      rc.page.setDefaultTimeout(timeoutMs);
      // Page de départ : réservée à la cadence (1.9), ouverte par l'hôte, classée avant tout code (un refus arrête).
      if (options.pacer !== undefined) {
        const slot = await options.pacer.acquire(options.startUrl);
        if (!slot.granted) return { result: fail({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }, 0), violations: [], killed: false };
      }
      let exchange: HttpExchange;
      try {
        const landing = await guardedGoto(rc.page, options.startUrl, options.guard, { waitUntil: 'load' as const, timeout: timeoutMs });
        const headers = landing?.headers() ?? {};
        await options.pacer?.report(options.startUrl, { status: landing?.status() ?? 0, retryAfter: headers['retry-after'] ?? null });
        exchange = { status: landing?.status() ?? 0, headers, body: await rc.page.content(), url: rc.page.url() };
      } catch (error) {
        if (options.signal.aborted) throw error;
        return { result: fail(classifyTransportError(error)), violations: [], killed: false };
      }
      const refused = (options.classify ?? classifyExchange)(exchange);
      if (refused !== null) return { result: fail(refused), violations: [], killed: false };

      const handle = createSandboxBridges({
        allowedDomains: options.allowedHosts,
        guard: options.guard,
        logger: options.logger,
        maxItems: MAX_ITEMS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        // `ctx.fetch` : un saut à la fois (le pont contrôle le domaine de chaque redirection), par la session de l'essai.
        fetch: (request, signal) =>
          options.session.fetch(
            request.url,
            { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), signal },
            { followRedirects: false },
          ) as unknown as Promise<BridgeResponse>,
      });
      handle.bridges.page = createPageBridge({
        page: rc.page,
        guard: options.guard,
        allowedHosts: options.allowedHosts,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxItems: MAX_ITEMS,
        timeoutMs,
        blockedHosts: () => [...rc.violations, ...options.egress.domainBlocked.map((t) => t.host)],
        onEvaluate: host.arm,
      });
      const sandbox = await options.engine.run(options.code, handle.bridges, options.limits ?? DEFAULT_SANDBOX_LIMITS, {
        input: options.input,
        signal: options.signal,
        watch: host.watch,
      });
      options.signal.throwIfAborted();
      const base = { violations: sandbox.violations, killed: sandbox.killed, ...(sandbox.killLatencyMs === undefined ? {} : { killLatencyMs: sandbox.killLatencyMs }) };
      if (sandbox.outcome === 'violation') return { ...base, result: fail(codeError('sandbox_violation')) };
      if (sandbox.outcome !== 'ok') return { ...base, result: fail(codeError(`sandbox_${sandbox.outcome}`)) };
      const records = handle.items.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && !Array.isArray(i));
      if (records.length !== handle.items.length) return { ...base, result: fail({ failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }) };
      return { ...base, result: { ok: true, records, pages: 1, requests: 1, escalated: false, stop: 'no_pagination', truncated: false } };
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      await rc.close();
    }
  });
}
