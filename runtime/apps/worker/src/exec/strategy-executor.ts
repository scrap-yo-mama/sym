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
//    (`ctx.excludeSubjects`) avant collecte et avant toute écriture du dataset ; journaux du run par `ctx.log`. Le
//    `ctx.log(...)` d'un script E3 (texte libre d'un code généré, non fiable, qui peut contenir des données lues mais
//    jamais émises, que le registre du run ne connaît pas) n'est JAMAIS écrit : `run_logs` comme le journal du worker
//    n'en reçoivent que des identifiants techniques (nombre de lignes, octets), 17 §6 « aucune donnée personnelle » ;
// 6. garde de classification (1.7) : chaque réponse est classée AVANT extraction (classifieur par défaut des exécuteurs) ;
//    un échec n'atteint la réparation (port `repair`, tâche 2.3) qu'à travers `invokeAgentGuarded` : jamais sur un refus,
//    un défi, une connexion requise ou un 429 (INV6). L'échange en échec (corps borné) est la preuve de la garde : une
//    « extraction » sur une page de défi est un refus, et le run rend alors la classe corrigée. La suite retenue est
//    journalisée (`failure_route`, `reclassified_from` si la garde a corrigé la classe). L'agent ne reçoit jamais la
//    page : seulement les preuves que la garde laisse passer, MINIMISÉES (squelette HTML ou JSON, valeurs retirées,
//    masquage par le registre du run ; 04 §5, 17 §6). Câblage run échoué → statut (`sain → reparation → bloquee`,
//    transitions 10 et 15) : tâche 2.3, avec la réparation ; en 1.7 le run rend la classe, la machine à états l'applique.
// 7. module d'accès (1.11, INV11) : robots.txt relu (cache de 24 h au plus) AVANT toute requête de contenu, dans TOUS
//    les modes, sans option pour l'ignorer : requête de la stratégie (E1-E3, pagination comprise), chaque saut de la
//    session réseau (E1, `ctx.fetch`), chaque requête du contexte Chromium (E2, E3, page de départ d'un script), saut de
//    redirection compris (contrôle CDP, `browser/request-guard.ts`), et chaque poignée de main WebSocket. Un chemin
//    interdit → `robots_disallowed` sans aucune requête vers lui ; robots.txt injoignable → `robots_unreachable`, rien
//    n'est collecté. `Crawl-delay` est un plancher de la cadence. User-Agent honnête `Scrapyomama/<version> (+contact)`
//    imposé à chaque requête (une stratégie ne le remplace pas) ; le navigateur garde le sien et y ajoute celui-ci.
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
import {
  domainRequestPacer,
  failureRoute,
  guardAgentInvocation,
  invokeAgentGuarded,
  minimizeEvidence,
  type AgentEvidence,
  runFetchExecutor,
  type ClassifyContext,
  type DeclarativeRunResult,
  type ExecFailure,
  type HttpExchange,
  type RequestPacer,
} from '@runtime/core/exec';
import type { DomainPacer } from '@runtime/core';
import { InstanceContactError, RobotsCache, RobotsGate, sessionRobotsFetcher } from '@runtime/core/access';
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
import { robotIdentity } from './robot-identity.js';
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
  /** Garde de classification avant extraction (1.7) ; défaut : `classifyExchange` de chaque exécuteur. */
  readonly classify?: (exchange: HttpExchange, context?: ClassifyContext) => ExecFailure | null;
  /**
   * Réparation dans le même run (tâche 2.3). Appelée SEULEMENT à travers la garde de classification : jamais pour un
   * refus, un défi, une connexion requise, un 429 ou un échec réseau (04 §5, INV6). Rend le résultat du run réparé, ou
   * `null` (échec d'origine conservé).
   */
  readonly repair?: RepairPort;
  /** Journal du worker (violations du bac à sable, détail admin). */
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Cache des robots.txt du worker (24 h au plus) ; défaut : un cache propre à cet exécuteur. */
  readonly robotsCache?: RobotsCache;
  /** Contact de l'instance (réglage `instance_contact`, puis `INSTANCE_CONTACT`) pour le User-Agent ; `null` : aucun. */
  readonly instanceContact?: () => Promise<string | null>;
  /** Version annoncée dans le User-Agent (`RUNTIME_VERSION`). */
  readonly version?: string;
};

/**
 * Port de réparation (2.3). `evidence` : preuves DÉJÀ passées par la garde (aucune n'est un refus ni une page de défi,
 * un signal faible en 2xx est retiré) puis MINIMISÉES par `minimizeEvidence` avec le registre du run (`ctx.personal`) :
 * squelette HTML (balises, id, class), squelette JSON (clés, types), texte libre masqué ; jamais le corps de la page,
 * ses valeurs, ses cookies ni sa requête (04 §5 « journaux masqués, diff de forme », 17 §6, RGPD). Les sujets effacés
 * (`ctx.excludeSubjects`) ne sont connus que par empreinte : d'où « aucune valeur de la page ». Le port doit encore
 * passer chaque texte par `assertPromptSafe` avant de l'inclure dans un prompt (04b §6).
 */
export type RepairPort = (request: {
  readonly ctx: RunCtx;
  readonly failure: ExecFailure;
  readonly strategyVersion: number;
  readonly evidence: readonly AgentEvidence[];
}) => Promise<RunResult | null>;

type Outcome = {
  result: DeclarativeRunResult;
  usage: NetworkUsage | null;
  violations?: readonly SandboxViolation[];
  /** Journal du script E3 : nombre de lignes et octets seulement (le texte n'est jamais écrit, 17 §6). */
  scriptLog?: { readonly lines: number; readonly bytes: number };
  /** Tous les éléments émis par un script E3, essai réussi ou non (inscrits au registre de masquage du run). */
  scriptItems?: readonly unknown[];
};

/** Somme des usages réseau d'un essai (egress Chromium + session `ctx.fetch` du script). */
function addUsage(a: NetworkUsage, b: NetworkUsage): NetworkUsage {
  return { ...a, bytes: a.bytes + b.bytes, requests: a.requests + b.requests, costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6 };
}

/**
 * Script E3 en échec après un refus de la garde SSRF au proxy d'egress → `ssrf_blocked`. Le verrou de domaines n'est
 * pas déduit ici des compteurs globaux du proxy (les sous-ressources tierces du site y passent aussi) : l'exécuteur
 * qualifie lui-même `domain_not_allowed` sur les seules requêtes de la stratégie (script-executor.ts).
 */
function refineEgress(result: DeclarativeRunResult, egress: BrowserEgress): DeclarativeRunResult {
  if (result.ok || result.failure.detail === 'sandbox_violation') return result;
  const cls = result.failure.failure_class;
  if (egress.blocked.length > 0 && (cls === 'network' || cls === 'transient' || cls === 'code_error' || cls === 'forbidden')) {
    return { ...result, failure: { failure_class: 'forbidden', retryable: false, detail: 'ssrf_blocked' } };
  }
  return result;
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

  const pacerFor = (target: RunTarget, robots?: RobotsGate): RequestPacer | undefined =>
    deps.pacer === undefined
      ? undefined
      : domainRequestPacer(deps.pacer, {
          ...(target.api.domainPacing.min_delay_ms === undefined ? {} : { minDelayMs: target.api.domainPacing.min_delay_ms }),
          ...(target.api.domainPacing.max_wait_ms === undefined ? {} : { maxWaitMs: target.api.domainPacing.max_wait_ms }),
          // `Crawl-delay` de robots.txt : plancher de la cadence (17 §2), lu à chaque réservation.
          ...(robots === undefined ? {} : { crawlDelayMs: robots.crawlDelayMs }),
        });
  const robotsCache = deps.robotsCache ?? new RobotsCache();

  const logger = deps.logger ?? pino({ enabled: false });

  /** User-Agent du robot pour ce run : jeton, version, contact de l'instance (17 §5) ; contact absent journalisé. */
  const identity = robotIdentity({
    ...(deps.version === undefined ? {} : { version: deps.version }),
    ...(deps.instanceContact === undefined ? {} : { instanceContact: deps.instanceContact }),
    warn: (code) => logger.warn({ code }, "contact d'instance absent : User-Agent sans contact (17 §5 : requis avant la première enquête)"),
  });
  const userAgentFor = async (): Promise<string> => {
    try {
      return await identity();
    } catch (error) {
      if (error instanceof InstanceContactError) return refuse('code_error', error.code);
      throw error;
    }
  };

  /** E3 en script : bac à sable de 1.5, ponts `ctx.fetch` (session de l'essai) et `ctx.page.*` (Chromium de l'essai). */
  const runScript = async (
    ctx: RunCtx,
    target: RunTarget,
    scriptRef: string,
    base: { pool: BrowserPool; egress: BrowserEgress; session: NetworkSession; pacer?: RequestPacer; allowedHosts: readonly string[]; startUrl: string; robots: RobotsGate; userAgent: string },
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
      ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
      allowWriteActions: target.api.allowWriteActions,
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
      robots: base.robots.access,
      userAgent: base.userAgent,
    });
    let result = run.result;
    if (result.ok && result.records.some((r) => !validateOutput(target.api.outputSchema, r).ok)) {
      result = { ok: false, failure: { failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }, pages: result.pages, requests: result.requests };
    }
    const bytes = run.logs.reduce((sum, args) => sum + Buffer.byteLength(JSON.stringify(args)), 0);
    return { result, usage: null, violations: run.violations, scriptLog: { lines: run.logs.length, bytes }, scriptItems: run.items };
  };

  const execute = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>): Promise<Outcome> => {
    const { rung, credentials } = await rungFor(target, strategy.network);
    const userAgent = await userAgentFor();
    const script = strategy.execution === 'playwright' && strategy.scriptRef !== null ? scriptSpecOf(strategy.spec) : undefined;
    const spec = script === undefined && ['fetch', 'fetch_in_page', 'playwright'].includes(strategy.execution) ? specOf(target, strategy) : undefined;
    // Plafond de coût de l'essai, partagé entre l'egress Chromium et la session `ctx.fetch` d'un script.
    let otherUsd: { egress: () => number; session: () => number } = { egress: () => 0, session: () => 0 };
    // Lecture de robots.txt : session du même barreau, SANS contrôle robots (pas de récursion), même User-Agent. Sans
    // verrou de domaines : RFC 9309 suit les redirections de robots.txt quel que soit l'hôte (CDN, apex → www), sous la
    // garde SSRF ; la garde ne lit que l'origine d'un domaine de l'API (`allowedHosts` du `RobotsGate`). Plafond de coût
    // partagé (revue de 1.11) : sur un barreau payant, sa lecture est coupée avant que l'essai ne dépasse `max_cost_usd`
    // (robots.txt alors injoignable : refus, échec fermé).
    const robotsSession = openNetworkSession({
      rung,
      guard: deps.guard,
      ...(credentials === undefined ? {} : { credentials }),
      ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
      costCeiling: { maxUsd: target.api.maxCostUsd, otherUsd: () => otherUsd.egress() + otherUsd.session() },
      userAgent,
    });
    const robotsPacer = pacerFor(target);
    const robots = new RobotsGate({
      fetch: sessionRobotsFetcher(robotsSession),
      cache: robotsCache,
      signal: ctx.signal,
      allowedHosts: script?.allowedHosts ?? spec?.request.allowed_hosts ?? [],
      ...(robotsPacer === undefined ? {} : { pacer: robotsPacer }),
    });
    const sessionOptions = (side: 'egress' | 'session'): NetworkSessionOptions => ({
      rung,
      guard: deps.guard,
      ...(credentials === undefined ? {} : { credentials }),
      ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
      allowedHosts: script?.allowedHosts ?? spec?.request.allowed_hosts ?? [],
      costCeiling: { maxUsd: target.api.maxCostUsd, otherUsd: () => (side === 'egress' ? otherUsd.session() : otherUsd.egress()) + robotsSession.usage().costUsd },
      checkUrl: robots.checkUrl,
      userAgent,
    });
    const pacer = pacerFor(target, robots);
    const common = {
      input: ctx.input,
      outputSchema: target.api.outputSchema,
      signal: ctx.signal,
      access: robots.access,
      ...(pacer === undefined ? {} : { pacer }),
      ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
    };
    try {
      const outcome = await executeOn(strategy, { spec, script, sessionOptions, common, pacer, robots, userAgent, ctx, target, setOther: (o) => (otherUsd = { ...otherUsd, ...o }) });
      return { ...outcome, usage: outcome.usage === null ? null : addUsage(outcome.usage, robotsSession.usage()) };
    } finally {
      await robotsSession.close().catch(() => undefined);
    }
  };

  type ExecuteArgs = {
    spec: DeclarativeSpec | undefined;
    script: { allowedHosts: string[]; startUrl: string } | undefined;
    sessionOptions: (side: 'egress' | 'session') => NetworkSessionOptions;
    common: Omit<Parameters<typeof runFetchExecutor>[1], 'spec'>;
    pacer: RequestPacer | undefined;
    robots: RobotsGate;
    userAgent: string;
    ctx: RunCtx;
    target: RunTarget;
    setOther: (o: Partial<{ egress: () => number; session: () => number }>) => void;
  };

  const executeOn = async (strategy: NonNullable<RunTarget['strategy']>, args: ExecuteArgs): Promise<Outcome> => {
    const { spec, script, sessionOptions, common, pacer, robots, userAgent, ctx, target } = args;
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
        args.setOther({ egress: () => egress.usage().costUsd });
        try {
          if (script !== undefined) {
            const session = openNetworkSession(sessionOptions('session'));
            args.setOther({ session: () => session.usage().costUsd });
            try {
              const out = await runScript(ctx, target, strategy.scriptRef!, { pool: deps.browsers, egress, session, ...(pacer === undefined ? {} : { pacer }), ...script, robots, userAgent });
              const exceeded = egress.budgetExceeded() || session.budgetExceeded();
              return { ...out, result: budgetChecked(refineEgress(out.result, egress), exceeded), usage: addUsage(egress.usage(), session.usage()) };
            } finally {
              await session.close().catch(() => undefined);
            }
          }
          const base = { ...common, pool: deps.browsers, egress, guard: deps.guard, spec: spec!, userAgent };
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
    // Éléments émis par un script E3, essai réussi ou non (schéma non conforme, violation, refus, plafond…) : inscrits au
    // registre du run, qui masque aussi `error_detail` et toute écriture ultérieure de `run_logs`.
    for (const item of outcome.scriptItems ?? []) ctx.personal.addFromItem(target.api.outputSchema, item);
    // Journal du script E3 : identifiants techniques seulement, jamais son texte (17 §6).
    if (outcome.scriptLog !== undefined && outcome.scriptLog.lines > 0) {
      await ctx.log('info', 'sandbox_log', { lines: outcome.scriptLog.lines, bytes: outcome.scriptLog.bytes });
    }
    // Garde par preuves (1.7) : un échec dont l'échange est un refus ou une page de défi prend la classe de la garde
    // (essai, run et route), avant toute réparation.
    const evidence: readonly AgentEvidence[] = result.ok || result.evidence === undefined ? [] : [result.evidence];
    const guardedFailure = result.ok ? undefined : (guardAgentInvocation(result.failure, evidence) ?? result.failure);
    // Classe corrigée par la garde (une « extraction » sur une page de défi est un refus) : rapportée à la cadence, pour
    // que le disjoncteur du domaine compte ce refus (la réponse a été rapportée à sa réception, avant l'extraction).
    if (!result.ok && guardedFailure !== undefined && guardedFailure.failure_class !== result.failure.failure_class && result.evidence !== undefined) {
      await pacerFor(target)?.report(result.evidence.url, { status: result.evidence.status, retryAfter: null, failureClass: guardedFailure.failure_class });
    }
    const proxyUsd = usage?.costUsd ?? 0;
    await ctx.recordAttempt({
      execution: strategy.execution,
      network: strategy.network,
      est_cost_usd: strategy.estCostUsd,
      result: guardedFailure === undefined ? 'ok' : guardedFailure.failure_class,
      ms: Math.max(0, Math.round(now() - started)),
      proxy_usd: proxyUsd,
    });
    const version = strategy.version;
    if (proxyUsd > target.api.maxCostUsd) {
      return { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'max_cost_usd', strategy_version: version };
    }
    if (!result.ok) {
      const original = result.failure;
      const failure = guardedFailure ?? original;
      // Garde AVANT réparation (1.7) : l'agent n'est invoqué que pour `extraction`, `code_error` ou `not_found`, et
      // seulement si aucune preuve n'est un refus ; il ne reçoit que des preuves passées par la garde.
      const repair = deps.repair;
      const guarded =
        repair === undefined
          ? null
          : await invokeAgentGuarded(original, evidence, (f, shown) =>
              repair({ ctx, failure: f, strategyVersion: version, evidence: shown.map((item) => minimizeEvidence(item, ctx.personal)) }),
            );
      const route = failureRoute(failure.failure_class);
      await ctx.log('info', 'failure_route', {
        failure_class: failure.failure_class,
        next: route.next,
        agent_invoked: guarded?.invoked ?? false,
        ...(failure.failure_class === original.failure_class ? {} : { reclassified_from: original.failure_class }),
      });
      if (guarded !== null && guarded.invoked && guarded.value !== null) return guarded.value;
      return { state: 'failed', failure_class: failure.failure_class, retryable: failure.retryable, error_detail: failure.detail, strategy_version: version };
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
