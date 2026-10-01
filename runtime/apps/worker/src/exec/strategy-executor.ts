// SPDX-License-Identifier: AGPL-3.0-only
// `RunExecutor` des stratégies E1-E3 (tâche 1.6), branché sur le worker de 1.3 et la cadence de 1.9 :
// 1. cible lue comme le propriétaire (RLS) : API et version de stratégie figée au claim (INV4) ;
// 2. barreau réseau de la stratégie construit depuis la politique de l'API et les proxys de l'admin (1.4) — jamais
//    depuis la stratégie elle-même ; aucune escalade ici (l'échelle est l'affaire de l'enquête et de la réparation) ;
// 3. exécution : E1 par la session réseau, E2 / E3 par un Chromium du pool et un proxy d'egress propre à l'essai ;
// 4. un essai journalisé (exécution, réseau, classe, durée, coût proxy) ; sortie conforme à `output_schema` (INV1)
//    écrite en dataset comme le propriétaire ; `max_cost_usd` dépassé → `run_budget_exceeded`.
import {
  validateDeclarativeSpec,
  validateOutput,
  type DeclarativeSpec,
  type FailureClass,
  type RunContext as RunCtx,
  type RunExecutor,
  type RunResult,
} from '@runtime/core';
import { classifyExchange, domainRequestPacer, runFetchExecutor, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import type { DomainPacer } from '@runtime/core';
import {
  buildNetworkRungs,
  guardedGoto,
  loadProxyCredentials,
  openBrowserEgress,
  openNetworkSession,
  parseNetworkPolicy,
  parseProxyDefinitions,
  type BrowserEgress,
  type NetworkRung,
  type NetworkSessionOptions,
  type NetworkUsage,
  type ProxyCredentials,
  type Resolver,
  type SecretReader,
  type SsrfGuard,
} from '@runtime/core/net';
import { loadRunTarget, readProxySettings, saveRunDataset, type RunTarget } from '@runtime/db';
import type pg from 'pg';
import type { BrowserPool } from '../browser/pool.js';
import { openRunContext } from '../browser/run-context.js';
import { runFetchInPageExecutor, runPlaywrightExecutor } from './browser-executors.js';
import { createScriptBridges, SCRIPT_DEFAULT_LIMITS, type ScriptPort } from './script.js';

export type StrategyExecutorDeps = {
  readonly pool: pg.Pool;
  /** Garde des cibles (`ssrfPolicyFromEnv`). */
  readonly guard: SsrfGuard;
  /** Cadence par domaine distribuée (1.9) ; absente, aucune réservation (tests seulement). */
  readonly pacer?: DomainPacer;
  /** Pool Chromium ; `null` : `DISABLE_BROWSER` (E2 et E3 refusés). */
  readonly browsers: BrowserPool | null;
  /** Dépôt de secrets (identifiants des proxys BYO). */
  readonly secrets?: SecretReader;
  /** Résolveur de la garde des proxys (tests). */
  readonly proxyResolver?: Resolver;
  /** Bac à sable (1.5) pour les stratégies E3 en script. */
  readonly script?: ScriptPort;
  /** Garde de classification avant extraction (1.7). */
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
  readonly now?: () => number;
};

type Outcome = { result: DeclarativeRunResult; usage: NetworkUsage | null };

class TargetError extends Error {
  readonly failure: ExecFailure;
  constructor(failure: ExecFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

const refuse = (failure_class: FailureClass, detail: string, retryable = false): never => {
  throw new TargetError({ failure_class, retryable, detail });
};

function specOf(target: RunTarget, strategy: NonNullable<RunTarget['strategy']>): DeclarativeSpec {
  const check = validateDeclarativeSpec(strategy.spec, { outputSchema: target.api.outputSchema });
  if (!check.ok) return refuse('code_error', 'invalid_strategy_spec');
  return check.spec;
}

/** Spécification d'une stratégie E3 en script : domaines de l'API et page de départ (aucun code ici). */
function scriptSpecOf(spec: unknown): { allowedHosts: string[]; startUrl: string } {
  const s = spec as { kind?: unknown; allowed_hosts?: unknown; start_url?: unknown } | null;
  const hosts = Array.isArray(s?.allowed_hosts) ? s.allowed_hosts.filter((h): h is string => typeof h === 'string' && /^[a-z0-9_.-]{1,253}$/.test(h)) : [];
  if (s?.kind !== 'script' || hosts.length === 0 || typeof s.start_url !== 'string') return refuse('code_error', 'invalid_script_spec');
  let start: URL;
  try {
    start = new URL(s.start_url);
  } catch {
    return refuse('code_error', 'invalid_script_spec');
  }
  if (!hosts.includes(start.hostname)) return refuse('code_error', 'invalid_script_spec');
  return { allowedHosts: hosts, startUrl: start.href };
}

export function createStrategyExecutor(deps: StrategyExecutorDeps): RunExecutor {
  const now = deps.now ?? Date.now;

  const rungFor = async (target: RunTarget, network: string): Promise<{ rung: NetworkRung; credentials?: ProxyCredentials }> => {
    if (network === 'tunnel') return refuse('code_error', 'tunnel_unavailable');
    let rungs: NetworkRung[];
    try {
      rungs = buildNetworkRungs(parseNetworkPolicy(target.api.networkPolicy), parseProxyDefinitions(await readProxySettings(deps.pool)));
    } catch {
      return refuse('code_error', 'network_config');
    }
    const rung = rungs.find((r) => r.mode === network);
    if (rung === undefined) return refuse('code_error', network === 'direct' ? 'network_not_allowed' : 'proxy_not_configured');
    if (rung.mode === 'direct' || rung.proxy.credentialsSecretId === undefined) return { rung };
    if (deps.secrets === undefined) return refuse('code_error', 'proxy_credentials_unavailable');
    const credentials = await loadProxyCredentials(deps.secrets, rung.proxy).catch(() => refuse('code_error', 'proxy_credentials_unavailable'));
    return credentials === undefined ? { rung } : { rung, credentials };
  };

  const pacerFor = (target: RunTarget): RequestPacer | undefined =>
    deps.pacer === undefined
      ? undefined
      : domainRequestPacer(deps.pacer, {
          ...(target.api.domainPacing.min_delay_ms === undefined ? {} : { minDelayMs: target.api.domainPacing.min_delay_ms }),
          ...(target.api.domainPacing.max_wait_ms === undefined ? {} : { maxWaitMs: target.api.domainPacing.max_wait_ms }),
        });

  const runScript = async (
    ctx: RunCtx,
    target: RunTarget,
    scriptRef: string,
    base: { pool: BrowserPool; egress: BrowserEgress; pacer?: RequestPacer; sessionOptions: NetworkSessionOptions },
  ): Promise<DeclarativeRunResult> => {
    const port = deps.script;
    if (port === undefined) return { ok: false, failure: { failure_class: 'code_error', retryable: false, detail: 'sandbox_unavailable' }, pages: 0, requests: 0 };
    const { allowedHosts, startUrl } = scriptSpecOf(target.strategy?.spec);
    const code = await port.loadScript(scriptRef);
    return base.pool.run(ctx.signal, async (browser) => {
      const rc = await openRunContext(browser, { egressServer: base.egress.server, allowedHosts });
      // `ctx.fetch` du script : même barreau réseau que l'essai (garde SSRF, proxy BYO éventuel).
      const session = openNetworkSession(base.sessionOptions);
      try {
        const slot = await base.pacer?.acquire(startUrl);
        if (slot !== undefined && !slot.granted) return { ok: false, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }, pages: 0, requests: 0 };
        const landing = await guardedGoto(rc.page, startUrl, deps.guard, { waitUntil: 'load' as const });
        const status = landing?.status() ?? 0;
        const refused = (deps.classify ?? classifyExchange)({
          status,
          headers: landing?.headers() ?? {},
          body: await rc.page.content(),
          url: rc.page.url(),
        });
        if (refused !== null) return { ok: false, failure: refused, pages: 0, requests: 1 };
        const set = createScriptBridges({ page: rc.page, guard: deps.guard, allowedHosts, session, maxItems: 10_000, maxResponseBytes: 5_000_000 });
        const outcome = await port.engine.run(code, set.bridges, SCRIPT_DEFAULT_LIMITS);
        if (!outcome.ok) return { ok: false, failure: { failure_class: 'code_error', retryable: false, detail: `sandbox_${outcome.error}` }, pages: 1, requests: 1 };
        const records = set.items.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && !Array.isArray(i));
        if (records.length !== set.items.length || records.length === 0 || records.some((r) => !validateOutput(target.api.outputSchema, r).ok)) {
          return { ok: false, failure: { failure_class: 'extraction', retryable: false, detail: records.length === 0 ? 'no_records' : 'schema_mismatch' }, pages: 1, requests: 1 };
        }
        return { ok: true, records, pages: 1, requests: 1, escalated: false, stop: 'no_pagination', truncated: false };
      } finally {
        await session.close().catch(() => undefined);
        await rc.close();
      }
    });
  };

  const execute = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>): Promise<Outcome> => {
    const { rung, credentials } = await rungFor(target, strategy.network);
    const sessionOptions = { rung, guard: deps.guard, ...(credentials === undefined ? {} : { credentials }), ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }) };
    const pacer = pacerFor(target);
    const common = {
      input: ctx.input,
      outputSchema: target.api.outputSchema,
      signal: ctx.signal,
      ...(pacer === undefined ? {} : { pacer }),
      ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
    };
    switch (strategy.execution) {
      case 'fetch': {
        const spec = specOf(target, strategy);
        const session = openNetworkSession(sessionOptions);
        try {
          const result = await runFetchExecutor(session, { ...common, spec });
          return { result, usage: session.usage() };
        } finally {
          await session.close().catch(() => undefined);
        }
      }
      case 'fetch_in_page':
      case 'playwright': {
        if (deps.browsers === null) return refuse('code_error', 'browser_disabled');
        const egress = await openBrowserEgress(sessionOptions);
        try {
          const base = { ...common, pool: deps.browsers, egress, guard: deps.guard };
          let result: DeclarativeRunResult;
          if (strategy.execution === 'playwright' && strategy.scriptRef !== null) {
            result = await runScript(ctx, target, strategy.scriptRef, { pool: deps.browsers, egress, ...(pacer === undefined ? {} : { pacer }), sessionOptions });
          }
          else {
            const spec = specOf(target, strategy);
            result = strategy.execution === 'fetch_in_page' ? await runFetchInPageExecutor({ ...base, spec }) : await runPlaywrightExecutor({ ...base, spec });
          }
          return { result, usage: egress.usage() };
        } finally {
          await egress.close().catch(() => undefined);
        }
      }
      default:
        // E4-E6 : moteur agentique (tâche 2.4).
        return refuse('code_error', 'execution_unavailable');
    }
  };

  return async (ctx): Promise<RunResult> => {
    const started = now();
    const target = await loadRunTarget(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: ctx.strategyVersion });
    if (target === null) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'api_not_found' };
    const strategy = target.strategy;
    if (strategy === null) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'no_strategy_version' };

    let outcome: Outcome;
    try {
      outcome = await execute(ctx, target, strategy);
    } catch (error) {
      if (!(error instanceof TargetError)) throw error;
      outcome = { result: { ok: false, failure: error.failure, pages: 0, requests: 0 }, usage: null };
    }
    const { result, usage } = outcome;
    const proxyUsd = usage?.costUsd ?? 0;
    await ctx.recordAttempt({
      execution: strategy.execution,
      network: strategy.network,
      est_cost_usd: strategy.estCostUsd,
      result: result.ok ? 'ok' : result.failure.failure_class,
      ms: Math.max(0, Math.round(now() - started)),
      proxy_usd: proxyUsd,
    });
    const version = strategy.version;
    if (proxyUsd > target.api.maxCostUsd) {
      return { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'max_cost_usd', strategy_version: version };
    }
    if (!result.ok) {
      return { state: 'failed', failure_class: result.failure.failure_class, retryable: result.failure.retryable, error_detail: result.failure.detail, strategy_version: version };
    }
    const saved = await saveRunDataset(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, projectId: target.api.projectId, items: result.records });
    const reasons = [...(result.escalated ? ['escalated'] : []), ...(result.truncated ? ['pagination_short'] : [])];
    return {
      state: 'succeeded',
      outcome: reasons.length > 0 ? 'degraded' : 'clean',
      degraded_reasons: reasons,
      items: result.records.length,
      dataset_id: saved.datasetId,
      strategy_version: version,
    };
  };
}
