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
  assertExecutionOnNetwork,
  ExecutionNotOnNetworkError,
  type AgentFetchSpec,
  type AgentSpec,
  type HybridSpec,
  validateAgentFetchSpec,
  validateAgentSpec,
  validateDeclarativeSpec,
  validateHybridSpec,
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
  checkSiteDomain,
  loadProxyCredentials,
  openBrowserEgress,
  openNetworkSession,
  parseNetworkPolicy,
  policyAllowsTunnel,
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
import { loadRunTarget, readProxySettings, saveCompiledStrategy, saveRunDataset, type RunTarget } from '@runtime/db';
import type { LlmClient, LlmConfig } from '@runtime/llm';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import type { BrowserPool } from '../browser/pool.js';
import { runFetchInPageExecutor, runPlaywrightExecutor } from './browser-executors.js';
import { robotIdentity } from './robot-identity.js';
import { runScriptExecutor, type ScriptPort } from './script-executor.js';
import type { AgentBrowser, AgentBrowserOptions } from '../browser/agent-browser.js';
import { runAgentExecutor, runAgentFetchExecutor, runHybridExecutor, type AgentOutcome, type EngineFactory, type LlmSpend } from './agent-executors.js';
import { AttemptCost } from './attempt-cost.js';
import { runTunnelExecutor, TunnelSession, type TunnelStop } from './tunnel-executor.js';
import type { TunnelPort } from '../tunnel/client.js';

/**
 * Ports des exécuteurs agentiques E4-E6 (tâche 2.4). La configuration LLM est relue à chaque essai (`settings.llm`,
 * clés dans le dépôt de secrets) ; un client neuf par essai porte le compteur de coût de cet essai.
 */
export type AgentPorts = {
  readonly llmConfig: () => Promise<LlmConfig | null>;
  readonly client: (config: LlmConfig) => LlmClient;
  /** Moteur du rôle `agent` sur le Chromium dédié de l'essai (Stagehand en production). */
  readonly engineFor: (config: LlmConfig) => EngineFactory;
  /** Lancement du Chromium dédié (proxy d'egress de l'essai). */
  readonly agentBrowser: (options: AgentBrowserOptions) => Promise<AgentBrowser>;
};

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
  /** Exécuteurs agentiques E4-E6 ; absents : ces stratégies échouent en `code_error` (`execution_unavailable`). */
  readonly agent?: AgentPorts;
  /** Client du tunnel (mode réseau `tunnel`, tâche 2.7) ; absent : `tunnel_unavailable`. */
  readonly tunnel?: TunnelPort;
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
  /** Essai agentique (E4-E6) : coût LLM, compilation E6 → E5, refus du verrou de domaines. */
  agent?: Omit<AgentOutcome, 'result'>;
  /** Mode tunnel : arrêt sans classe d'échec (défi, extension hors ligne). */
  stop?: TunnelStop;
  /** Mode tunnel : le site n'est pas connecté dans le navigateur de l'utilisateur. */
  needsUser?: boolean;
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

/** Entrée de run non vide : toute valeur autre que absente, `null` ou un objet sans clé. */
function hasInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === 'object' && !Array.isArray(input)) return Object.keys(input).length > 0;
  return true;
}

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

type AgenticSpec =
  | { readonly kind: 'agent_fetch'; readonly spec: AgentFetchSpec; readonly hosts: readonly string[] }
  | { readonly kind: 'hybrid'; readonly spec: HybridSpec; readonly hosts: readonly string[] }
  | { readonly kind: 'agent'; readonly spec: AgentSpec; readonly hosts: readonly string[] };

/** Spécification d'une stratégie E4-E6, validée (liste fermée, domaines de l'API) ; refus `invalid_agent_spec`. */
function agenticSpecOf(execution: string, spec: unknown): AgenticSpec | undefined {
  if (execution === 'agent_fetch') {
    const c = validateAgentFetchSpec(spec);
    return c.ok ? { kind: 'agent_fetch', spec: c.spec, hosts: c.spec.request.allowed_hosts } : refuse('code_error', 'invalid_agent_spec');
  }
  if (execution === 'hybrid') {
    const c = validateHybridSpec(spec);
    return c.ok ? { kind: 'hybrid', spec: c.spec, hosts: c.spec.allowed_hosts } : refuse('code_error', 'invalid_agent_spec');
  }
  if (execution === 'agent') {
    const c = validateAgentSpec(spec);
    return c.ok ? { kind: 'agent', spec: c.spec, hosts: c.spec.allowed_hosts } : refuse('code_error', 'invalid_agent_spec');
  }
  return undefined;
}

export function createStrategyExecutor(deps: StrategyExecutorDeps): RunExecutor {
  const now = deps.now ?? Date.now;

  const rungFor = async (target: RunTarget, network: string): Promise<{ rung: NetworkRung; credentials?: ProxyCredentials }> => {
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

  /**
   * Mode `tunnel` (07 § 3-5) : stratégie déclarative E1-E3 par l'extension du propriétaire du run. E6 refusé (ADR 0001),
   * script E3 refusé (aucun code dans l'extension). Domaine = `requires.session_domain` de l'API, sinon l'hôte de la
   * requête ; toute URL de la stratégie doit y rester (vérifié aussi par la passerelle et par l'extension).
   */
  const executeTunnel = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>): Promise<Outcome> => {
    // Pendant de `rungFor` (04 §3.2, X3, INV6) : le tunnel n'est servi que s'il est choisi dans la politique réseau de
    // l'API ou si l'API exige l'identité de l'utilisateur (`requires.tunnel`, `requires_session`). Une version de
    // stratégie `tunnel` venue d'une enquête, d'une réparation ou d'un import ne passe pas d'elle-même par son IP.
    let chosen: boolean;
    try {
      chosen = policyAllowsTunnel(target.api.networkPolicy);
    } catch {
      return refuse('code_error', 'network_config');
    }
    if (!chosen && target.api.requires.tunnel !== true && !target.api.requiresSession) return refuse('code_error', 'network_not_allowed');
    try {
      assertExecutionOnNetwork(strategy.execution, 'tunnel');
    } catch (error) {
      if (error instanceof ExecutionNotOnNetworkError) return refuse('code_error', 'execution_server_only');
      throw error;
    }
    if (deps.tunnel === undefined) return refuse('code_error', 'tunnel_unavailable');
    if (strategy.scriptRef !== null || !['fetch', 'fetch_in_page', 'playwright'].includes(strategy.execution)) return refuse('code_error', 'execution_not_in_tunnel');
    const spec = specOf(target, strategy);
    const declared = target.api.requires.session_domain;
    const verdict = checkSiteDomain(typeof declared === 'string' && declared !== '' ? declared : new URL(spec.request.url).hostname);
    if (!verdict.ok) return refuse('code_error', 'domain_not_allowed');
    const session = new TunnelSession(
      deps.tunnel,
      { runId: ctx.runId, ownerId: ctx.ownerId, domain: verdict.domain, allowWriteActions: target.api.allowWriteActions, execution: strategy.execution },
      ctx.signal,
      ctx.waitingTunnel === undefined ? undefined : (waiting) => ctx.waitingTunnel!(waiting),
    );
    const pacer = pacerFor(target);
    const out = await runTunnelExecutor({
      session,
      execution: strategy.execution as 'fetch' | 'fetch_in_page' | 'playwright',
      spec,
      input: ctx.input,
      outputSchema: target.api.outputSchema,
      signal: ctx.signal,
      ...(pacer === undefined ? {} : { pacer }),
      ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
    });
    if (session.refusedAfterStop > 0) await ctx.log('info', 'tunnel_commands_withheld', { count: session.refusedAfterStop, reason: session.stop });
    return { result: out.result, usage: null, ...(out.stop === null ? {} : { stop: out.stop }), ...(out.needsUser ? { needsUser: true } : {}) };
  };

  const execute = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>): Promise<Outcome> => {
    if (strategy.network === 'tunnel') return executeTunnel(ctx, target, strategy);
    // E6 limité au serveur (0.6b, ADR 0001) : refusé en tunnel avant tout réseau.
    try {
      assertExecutionOnNetwork(strategy.execution, strategy.network);
    } catch (error) {
      if (error instanceof ExecutionNotOnNetworkError) return refuse('code_error', error.code);
      throw error;
    }
    const agentic = agenticSpecOf(strategy.execution, strategy.spec);
    // Entrée non prise en charge par E4-E6 (ADR 0001, « Suivi de l'intégration ») : leurs spécifications n'ont aucun
    // gabarit d'entrée et une trace E6 compilée fige les choix de l'agent. Servir l'essai rendrait la même sortie quelle
    // que soit l'entrée (conforme au schéma, mais fausse) : refus avant tout réseau et tout appel au modèle.
    if (agentic !== undefined && hasInput(ctx.input)) return refuse('code_error', 'input_unsupported');
    const { rung, credentials } = await rungFor(target, strategy.network);
    const userAgent = await userAgentFor();
    const script = strategy.execution === 'playwright' && strategy.scriptRef !== null ? scriptSpecOf(strategy.spec) : undefined;
    const spec = script === undefined && ['fetch', 'fetch_in_page', 'playwright'].includes(strategy.execution) ? specOf(target, strategy) : undefined;
    // Plafond de coût de l'essai, partagé entre l'egress Chromium, la session `ctx.fetch` d'un script et le LLM d'un essai
    // agentique (E4-E6) : un coût LLM inconnu (prix absent) laisse 0 au proxy.
    let otherUsd: { egress: () => number; session: () => number } = { egress: () => 0, session: () => 0 };
    let llmSpent: () => number | null = () => 0;
    const llmForCeiling = (): number => llmSpent() ?? target.api.maxCostUsd;
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
      costCeiling: { maxUsd: target.api.maxCostUsd, otherUsd: () => otherUsd.egress() + otherUsd.session() + llmForCeiling() },
      userAgent,
    });
    const robotsPacer = pacerFor(target);
    const robots = new RobotsGate({
      fetch: sessionRobotsFetcher(robotsSession),
      cache: robotsCache,
      signal: ctx.signal,
      allowedHosts: script?.allowedHosts ?? spec?.request.allowed_hosts ?? agentic?.hosts ?? [],
      ...(robotsPacer === undefined ? {} : { pacer: robotsPacer }),
    });
    const sessionOptions = (side: 'egress' | 'session'): NetworkSessionOptions => ({
      rung,
      guard: deps.guard,
      ...(credentials === undefined ? {} : { credentials }),
      ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
      allowedHosts: script?.allowedHosts ?? spec?.request.allowed_hosts ?? agentic?.hosts ?? [],
      costCeiling: {
        maxUsd: target.api.maxCostUsd,
        otherUsd: () => (side === 'egress' ? otherUsd.session() : otherUsd.egress()) + llmForCeiling() + robotsSession.usage().costUsd,
      },
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
      const outcome = await executeOn(strategy, { spec, script, agentic, setLlmSpent: (f) => (llmSpent = f), sessionOptions, common, pacer, robots, userAgent, ctx, target, setOther: (o) => (otherUsd = { ...otherUsd, ...o }) });
      return { ...outcome, usage: outcome.usage === null ? null : addUsage(outcome.usage, robotsSession.usage()) };
    } finally {
      await robotsSession.close().catch(() => undefined);
    }
  };

  type ExecuteArgs = {
    spec: DeclarativeSpec | undefined;
    script: { allowedHosts: string[]; startUrl: string } | undefined;
    agentic: AgenticSpec | undefined;
    /** Coût LLM de l'essai agentique, compté sous `max_cost_usd` avec le proxy (egress, session, robots.txt). */
    setLlmSpent: (spent: () => number | null) => void;
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
    const { spec, script, agentic, sessionOptions, common, pacer, robots, userAgent, ctx, target } = args;
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
          const base = { ...common, access: robots.access, pool: deps.browsers, egress, guard: deps.guard, spec: spec!, userAgent };
          const result = strategy.execution === 'fetch_in_page' ? await runFetchInPageExecutor(base) : await runPlaywrightExecutor(base);
          return { result: budgetChecked(result, egress.budgetExceeded()), usage: egress.usage() };
        } finally {
          await egress.close().catch(() => undefined);
        }
      }
      case 'agent_fetch':
      case 'hybrid':
      case 'agent': {
        const ports = deps.agent;
        if (ports === undefined || agentic === undefined) return refuse('code_error', 'execution_unavailable');
        // Chromium requis pour E5 et E6, et pour E4 par le navigateur (`DISABLE_BROWSER`).
        if (deps.browsers === null && !(agentic.kind === 'agent_fetch' && agentic.spec.via === 'fetch')) return refuse('code_error', 'browser_disabled');
        let config: LlmConfig | null;
        try {
          config = await ports.llmConfig();
        } catch {
          config = null;
        }
        // UN compteur de coût pour l'essai : proxy (egress, session) et LLM (rôle extract, moteur) sous `max_cost_usd`.
        const cost = new AttemptCost(target.api.maxCostUsd);
        args.setLlmSpent(() => cost.llmUsd());
        const egress = agentic.kind === 'agent_fetch' && agentic.spec.via === 'fetch' ? undefined : await openBrowserEgress(sessionOptions('egress'));
        if (egress !== undefined) cost.addProxy(() => egress.usage().costUsd);
        if (egress !== undefined) args.setOther({ egress: () => egress.usage().costUsd });
        const session = agentic.kind === 'agent_fetch' && agentic.spec.via === 'fetch' ? openNetworkSession(sessionOptions('session')) : undefined;
        if (session !== undefined) args.setOther({ session: () => session.usage().costUsd });
        if (session !== undefined) cost.addProxy(() => session.usage().costUsd);
        const agentBrowser = (o: Omit<AgentBrowserOptions, 'egressServer'>) => ports.agentBrowser({ ...o, egressServer: egress!.server });
        // Client du seul rôle `extract` (un client par essai : compteur de coût de l'essai) ; configuration refusée → `llm_not_configured`.
        const extractClient = (): LlmClient | null => {
          const role = config?.roles.extract;
          if (config === null || role === undefined) return null;
          try {
            return ports.client({ ...config, roles: { extract: role } });
          } catch {
            return refuse('code_error', 'llm_not_configured');
          }
        };
        const maxRequests = target.api.domainPacing.max_requests_per_run;
        const common = {
          outputSchema: target.api.outputSchema,
          signal: ctx.signal,
          maxCostUsd: target.api.maxCostUsd,
          cost,
          // robots.txt (1.11, INV11) : chaque requête de chaque Chromium de l'essai agentique (pool et Chromium dédié).
          access: robots.access,
          ...(pacer === undefined ? {} : { pacer }),
          ...(maxRequests === undefined ? {} : { maxRequests }),
          ...(deps.classify === undefined ? {} : { classify: deps.classify }),
        };
        try {
          let out: AgentOutcome;
          if (agentic.kind === 'agent_fetch') {
            const llm = extractClient();
            if (llm === null) return refuse('code_error', 'llm_not_configured');
            out = await runAgentFetchExecutor({
              ...common,
              spec: agentic.spec,
              llm,
              modelId: config?.roles.extract?.model ?? null,
              ...(session === undefined ? {} : { session }),
              ...(egress === undefined || deps.browsers === null ? {} : { browser: { pool: deps.browsers, egress, guard: deps.guard } }),
            });
          } else if (agentic.kind === 'hybrid') {
            out = await runHybridExecutor({
              ...common,
              spec: agentic.spec,
              guard: deps.guard,
              egress: egress!,
              pool: deps.browsers,
              agentBrowser,
              ...(config === null ? {} : { engineFor: ports.engineFor(config), llm: extractClient(), llmModelId: config.roles.extract?.model ?? null }),
              allowWriteActions: target.api.allowWriteActions,
            });
          } else {
            if (config === null || config.roles.agent === undefined) return refuse('code_error', 'llm_not_configured');
            out = await runAgentExecutor({
              ...common,
              spec: agentic.spec,
              guard: deps.guard,
              egress: egress!,
              agentBrowser,
              engineFor: ports.engineFor(config),
              pool: deps.browsers,
              allowWriteActions: target.api.allowWriteActions,
              taskId: ctx.runId,
              version: strategy.version,
            });
          }
          const exceeded = (egress?.budgetExceeded() ?? false) || (session?.budgetExceeded() ?? false);
          const usage = egress !== undefined && session !== undefined ? addUsage(egress.usage(), session.usage()) : (egress?.usage() ?? session?.usage() ?? null);
          const { result, ...agent } = out;
          return { result: budgetChecked(egress === undefined ? result : refineEgress(result, egress), exceeded), usage, agent };
        } finally {
          await session?.close().catch(() => undefined);
          await egress?.close().catch(() => undefined);
        }
      }
      default:
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
    // Extension hors ligne (04 §6, 05) : le run, resté en `waiting_tunnel`, se termine `skipped_tunnel_offline`. Aucun
    // essai (aucune commande n'a abouti, ce n'est pas un échec réseau), aucune classe d'échec, statut de l'API inchangé.
    const stop = outcome.stop;
    if (stop === 'tunnel_offline') {
      await ctx.log('warn', 'tunnel_offline', { network: 'tunnel' });
      return { state: 'skipped_tunnel_offline', stop_reason: 'tunnel_offline', error_detail: 'tunnel_offline', strategy_version: strategy.version };
    }
    // Défi en tunnel : l'essai est journalisé avec sa cause de fait (protection), le run s'arrête SANS classe d'échec
    // (04 §6) : `challenge_in_tunnel` → action_requise, la main revient à l'humain.
    const llm: LlmSpend | null = outcome.agent?.llm ?? null;
    // Prix absent : coût LLM inconnu, écrit null (jamais 0, 08 §1 ; INV4), avec avertissement.
    const llmUsd: number | null = llm === null ? 0 : llm.usd;
    if (llm !== null && llm.usd === null) await ctx.log('warn', 'llm_price_missing', { model: llm.modelId });
    if ((outcome.agent?.domainBlocked ?? 0) > 0) await ctx.log('warn', 'agent_domain_blocked', { count: outcome.agent?.domainBlocked });
    await ctx.recordAttempt({
      execution: strategy.execution,
      network: strategy.network,
      est_cost_usd: strategy.estCostUsd,
      result: stop === 'challenge_in_tunnel' ? 'blocked_by_protection' : guardedFailure === undefined ? 'ok' : guardedFailure.failure_class,
      ms: Math.max(0, Math.round(now() - started)),
      proxy_usd: proxyUsd,
      ...(llm === null
        ? {}
        : {
            llm_usd: llmUsd,
            tokens: llm.tokens,
            model_id: llm.modelId,
            prompt_version: llm.promptVersion,
            engine: llm.engine,
          }),
    });
    const version = strategy.version;
    if (stop !== undefined) {
      await ctx.log('warn', stop, { network: 'tunnel' });
      return { state: 'failed', failure_class: null, stop_reason: stop, retryable: false, error_detail: stop, strategy_version: version };
    }
    if (outcome.needsUser === true && !result.ok) {
      return { state: 'failed', failure_class: 'auth_required', retryable: false, error_detail: 'site_not_connected', strategy_version: version };
    }
    // Coût inconnu : le plafond n'a pas pu être tenu ; jamais un succès (04b « Schéma et coût »).
    if (llmUsd === null) {
      return { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: 'llm_price_missing', strategy_version: version };
    }
    if (proxyUsd + llmUsd > target.api.maxCostUsd) {
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
    // Compilation E6 → E5 vérifiée (04 §3.1) : nouvelle version `hybrid`, signal de baisse de coût journalisé.
    const compiled = outcome.agent?.compiled;
    if (compiled !== undefined) {
      try {
        const saved = await saveCompiledStrategy(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, parentVersion: version, network: strategy.network, spec: compiled, estCostUsd: proxyUsd });
        await ctx.log('info', 'strategy_compiled', { from_version: version, to_version: saved.version, promoted: saved.promoted, llm_usd_saved: llmUsd });
      } catch {
        await ctx.log('warn', 'strategy_compile_not_saved', {});
      }
    } else if (outcome.agent?.compileFailure !== undefined) {
      await ctx.log('info', 'strategy_compile_skipped', { reason: outcome.agent.compileFailure });
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
