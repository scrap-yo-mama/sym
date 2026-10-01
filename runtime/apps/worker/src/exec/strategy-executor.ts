// SPDX-License-Identifier: AGPL-3.0-only
// `RunExecutor` des stratégies E1-E3 (tâche 1.6), branché sur le worker de 1.3 et la cadence de 1.9 :
// 1. cible lue comme le propriétaire (RLS) : API et version de stratégie figée au claim (INV4) ;
// 2. barreau réseau de la stratégie construit depuis la politique de l'API et les proxys de l'admin (1.4) — jamais
//    depuis la stratégie elle-même ; aucune escalade ici (l'échelle est l'affaire de l'enquête et de la réparation) ;
// 3. exécution : E1 par la session réseau, E2 / E3 par un Chromium du pool et un proxy d'egress propre à l'essai ;
// 4. un essai journalisé (exécution, réseau, classe, durée, coût proxy) ; sortie conforme à `output_schema` (INV1)
//    écrite en dataset comme le propriétaire ; `max_cost_usd` tenu PENDANT l'essai (requête ou tunnel refusé au-delà)
//    → `run_budget_exceeded` ; verrou de domaines de l'API (`allowed_hosts`) à chaque saut, au niveau réseau ;
// 5. RGPD (D-28) : chaque item extrait inscrit au registre de masquage du run (`ctx.personal`), sujets effacés retirés
//    (`ctx.excludeSubjects`) avant collecte et avant toute écriture du dataset ; journaux du run par `ctx.log`.
import {
  validateDeclarativeSpec,
  validateOutput,
  type SandboxViolation,
  type DeclarativeSpec,
  type FailureClass,
  type RunContext as RunCtx,
  type RunExecutor,
  type RunResult,
} from '@runtime/core';
import { domainRequestPacer, runFetchExecutor, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import type { DomainPacer } from '@runtime/core';
import {
  buildNetworkRungs,
  loadProxyCredentials,
  openBrowserEgress,
  openNetworkSession,
  parseNetworkPolicy,
  parseProxyDefinitions,
  type BrowserEgress,
  type NetworkRung,
  type NetworkSession,
  type NetworkSessionOptions,
  type NetworkUsage,
  type ProxyCredentials,
  type Resolver,
  type SecretReader,
  type SsrfGuard,
} from '@runtime/core/net';
import { loadRunTarget, readProxySettings, saveRunDataset, type RunTarget } from '@runtime/db';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import type { BrowserPool } from '../browser/pool.js';
import { runFetchInPageExecutor, runPlaywrightExecutor } from './browser-executors.js';
import { runScriptExecutor, type ScriptPort } from './script-executor.js';

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
  /** Journal du worker (violations du bac à sable, détail admin). */
  readonly logger?: Logger;
  readonly now?: () => number;
};

type Outcome = { result: DeclarativeRunResult; usage: NetworkUsage | null; violations?: readonly SandboxViolation[] };

/** Somme des usages réseau d'un essai (egress Chromium + session `ctx.fetch` du script). */
function addUsage(a: NetworkUsage, b: NetworkUsage): NetworkUsage {
  return { ...a, bytes: a.bytes + b.bytes, requests: a.requests + b.requests, costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6 };
}

/** Script E3 en échec après un refus de la garde SSRF au proxy d'egress : la cause journalisée est la garde. */
function refineEgress(result: DeclarativeRunResult, egress: BrowserEgress): DeclarativeRunResult {
  if (result.ok || egress.blocked.length === 0 || result.failure.detail === 'sandbox_violation') return result;
  return { ...result, failure: { failure_class: 'forbidden', retryable: false, detail: 'ssrf_blocked' } };
}

const BUDGET: ExecFailure = { failure_class: 'run_budget_exceeded', retryable: false, detail: 'max_cost_usd' };
/** Plafond atteint pendant l'essai : la classe est `run_budget_exceeded`, quel que soit l'effet vu par l'exécuteur. */
function budgetChecked(result: DeclarativeRunResult, exceeded: boolean): DeclarativeRunResult {
  return exceeded && !result.ok ? { ...result, failure: BUDGET } : result;
}

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

  const logger = deps.logger ?? pino({ enabled: false });

  /** E3 en script : bac à sable de 1.5, ponts `ctx.fetch` (session de l'essai) et `ctx.page.*` (Chromium de l'essai). */
  const runScript = async (
    ctx: RunCtx,
    target: RunTarget,
    scriptRef: string,
    base: { pool: BrowserPool; egress: BrowserEgress; session: NetworkSession; pacer?: RequestPacer; allowedHosts: readonly string[]; startUrl: string },
  ): Promise<Outcome> => {
    const port = deps.script;
    if (port === undefined) return { result: { ok: false, failure: { failure_class: 'code_error', retryable: false, detail: 'sandbox_unavailable' }, pages: 0, requests: 0 }, usage: null };
    let code: string;
    try {
      code = await port.loadScript(scriptRef, target.strategy?.spec);
    } catch {
      return refuse('code_error', 'script_not_found');
    }
    const run = await runScriptExecutor({
      pool: base.pool,
      egress: base.egress,
      guard: deps.guard,
      session: base.session,
      engine: port.engine,
      code,
      allowedHosts: base.allowedHosts,
      startUrl: base.startUrl,
      input: ctx.input,
      signal: ctx.signal,
      logger: logger.child({ runId: ctx.runId }),
      ...(port.limits === undefined ? {} : { limits: port.limits }),
      ...(base.pacer === undefined ? {} : { pacer: base.pacer }),
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
    });
    let result = run.result;
    if (result.ok && result.records.some((r) => !validateOutput(target.api.outputSchema, r).ok)) {
      result = { ok: false, failure: { failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }, pages: result.pages, requests: result.requests };
    }
    return { result, usage: null, violations: run.violations };
  };

  const execute = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>): Promise<Outcome> => {
    const { rung, credentials } = await rungFor(target, strategy.network);
    const script = strategy.execution === 'playwright' && strategy.scriptRef !== null ? scriptSpecOf(strategy.spec) : undefined;
    const spec = script === undefined && ['fetch', 'fetch_in_page', 'playwright'].includes(strategy.execution) ? specOf(target, strategy) : undefined;
    // Plafond de coût de l'essai, partagé entre l'egress Chromium et la session `ctx.fetch` d'un script.
    let otherUsd: { egress: () => number; session: () => number } = { egress: () => 0, session: () => 0 };
    const sessionOptions = (side: 'egress' | 'session'): NetworkSessionOptions => ({
      rung,
      guard: deps.guard,
      ...(credentials === undefined ? {} : { credentials }),
      ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
      allowedHosts: script?.allowedHosts ?? spec?.request.allowed_hosts ?? [],
      costCeiling: { maxUsd: target.api.maxCostUsd, otherUsd: () => (side === 'egress' ? otherUsd.session() : otherUsd.egress()) },
    });
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
        const session = openNetworkSession(sessionOptions('session'));
        try {
          const result = await runFetchExecutor(session, { ...common, spec: spec! });
          return { result: budgetChecked(result, session.budgetExceeded()), usage: session.usage() };
        } finally {
          await session.close().catch(() => undefined);
        }
      }
      case 'fetch_in_page':
      case 'playwright': {
        if (deps.browsers === null) return refuse('code_error', 'browser_disabled');
        const egress = await openBrowserEgress(sessionOptions('egress'));
        otherUsd = { ...otherUsd, egress: () => egress.usage().costUsd };
        try {
          if (script !== undefined) {
            const session = openNetworkSession(sessionOptions('session'));
            otherUsd = { ...otherUsd, session: () => session.usage().costUsd };
            try {
              const out = await runScript(ctx, target, strategy.scriptRef!, { pool: deps.browsers, egress, session, ...(pacer === undefined ? {} : { pacer }), ...script });
              const exceeded = egress.budgetExceeded() || session.budgetExceeded();
              return { ...out, result: budgetChecked(refineEgress(out.result, egress), exceeded), usage: addUsage(egress.usage(), session.usage()) };
            } finally {
              await session.close().catch(() => undefined);
            }
          }
          const base = { ...common, pool: deps.browsers, egress, guard: deps.guard, spec: spec! };
          const result = strategy.execution === 'fetch_in_page' ? await runFetchInPageExecutor(base) : await runPlaywrightExecutor(base);
          return { result: budgetChecked(result, egress.budgetExceeded()), usage: egress.usage() };
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
    const { usage } = outcome;
    let result = outcome.result;
    if (outcome.violations !== undefined && outcome.violations.length > 0) {
      await ctx.log('warn', 'sandbox_violation', { reasons: outcome.violations.map((v) => v.reason) });
    }
    if (result.ok) {
      // RGPD (D-28) : registre de masquage alimenté par TOUS les items extraits, puis sujets effacés retirés avant
      // collecte et avant toute écriture.
      for (const item of result.records) ctx.personal.addFromItem(target.api.outputSchema, item);
      const { kept, dropped } = ctx.excludeSubjects(target.api.outputSchema, result.records);
      if (dropped > 0) {
        await ctx.log('info', 'subjects_excluded', { dropped });
        result = { ...result, records: kept };
      }
    }
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
