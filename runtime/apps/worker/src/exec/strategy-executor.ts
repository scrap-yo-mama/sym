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
//    n'est collecté. `Crawl-delay` est un plancher de la cadence. User-Agent réel du moteur embarqué (sans `HeadlessChrome`),
//    imposé à chaque requête (une stratégie ne le remplace pas), le même pour le client HTTP et pour Chromium ; avec
//    `identify_instance` (désactivé par défaut), le jeton `compatible; Scrapyomama/<version>; +<contact>` s'y ajoute.
// 8. enquête (2.1) : `createStrategyRuntime(...).trial` exécute une stratégie CANDIDATE avec toutes ces gardes, sans
//    journaliser d'essai ni écrire de dataset (l'exécuteur d'enquête journalise un essai par couple).
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
  validateStepsSource,
  validateStepsSpec,
  compileHybridToSteps,
  agentToolRegistry,
  ruleOfTwoHolds,
  estimateInstructedRunUsd,
  instructedInstruction,
  STEP_REPAIR_DEFAULTS,
  validateInstructedSteps,
  canActivateInstructedMode,
  hybridUsesLlm,
  type StepFailure,
  type StepsSpec,
  ITEMS_REJECTED_DEFAULTS,
  partitionItems,
  quarantineSummary,
  rejectionVerdict,
  volumeAnomaly,
  type DegradedSignal,
  type Execution,
  type ItemPartition,
  type ItemPolicy,
  type JsonPatchOperation,
  type RejectionReason,
  type RejectionThresholds,
  type RejectionVerdict,
  type RepairStopCause,
  type SandboxViolation,
  type DeclarativeSpec,
  type FailureClass,
  type RunContext as RunCtx,
  type RunExecutor,
  type RunResult,
  type StatusEventInput,
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
import { deleteRejectedItems, loadRunTarget, readProxySettings, readVolumeHistory, saveCompiledStrategy, saveRejectedItems, saveRepairedStrategy, saveRunDataset, saveStepRepairedStrategy, markStrategyCompilable, countSucceededRuns, archivedRepairExists, type RunTarget } from '@runtime/db';
import type { LlmClient, LlmConfig } from '@runtime/llm';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import type { BrowserPool } from '../browser/pool.js';
import { runFetchInPageExecutor, runPlaywrightExecutor } from './browser-executors.js';
import { robotIdentity, type RobotIdentity } from './robot-identity.js';
import { runScriptExecutor, type ScriptPort } from './script-executor.js';
import type { AgentBrowser, AgentBrowserOptions } from '../browser/agent-browser.js';
import { runAgentExecutor, runAgentFetchExecutor, runHybridExecutor, type AgentOutcome, type EngineFactory, type LlmSpend } from './agent-executors.js';
import { AttemptCost } from './attempt-cost.js';
import { runTunnelExecutor, TunnelSession, type TunnelStop } from './tunnel-executor.js';
import { StepsHost, type StepPageTools, type StepsTrialInfo } from './steps-host.js';
import { STEPS_INTERPRETER_SOURCE } from './steps-interpreter.js';
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
  /** Seuil de casse des items non conformes (`ITEMS_REJECTED_MAX_SHARE`, `ITEMS_REJECTED_MIN_COUNT`, D-49). */
  readonly rejection?: RejectionThresholds;
  /** Journal du worker (violations du bac à sable, détail admin). */
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Cache des robots.txt du worker (24 h au plus) ; défaut : un cache propre à cet exécuteur. */
  readonly robotsCache?: RobotsCache;
  /** Contact de l'instance (réglage `instance_contact`, puis `INSTANCE_CONTACT`) pour le jeton et `From` ; `null` : aucun. */
  readonly instanceContact?: () => Promise<string | null>;
  /** Réglage `identify_instance` (relu à chaque run) : ajoute le jeton au User-Agent et `From` ; défaut : désactivé. */
  readonly identifyInstance?: () => Promise<boolean>;
  /** Version annoncée dans le jeton du User-Agent (`RUNTIME_VERSION`). */
  readonly version?: string;
};

/** Stratégie figée d'un run (version, exécution, réseau, spécification). */
type FrozenStrategy = NonNullable<RunTarget['strategy']>;

/**
 * Une stratégie candidate rejouée par la réparation, avec TOUTES les gardes du run (essai journalisé) : items triés
 * (conformes, écartés), verdict du seuil de casse (D-49), refus de la garde (un refus arrête la réparation, INV6).
 */
export type CandidateCheck = {
  readonly trial: StrategyTrial;
  readonly partition: ItemPartition<Record<string, unknown>>;
  readonly verdict: RejectionVerdict;
  /** Échec de l'essai (classe retenue par la garde), `null` s'il a réussi. */
  readonly failure: ExecFailure | null;
  /** Échec qui interdit tout agent (refus, défi, connexion, 429…) : la réparation s'arrête là. */
  readonly refusal: ExecFailure | null;
  /** Coût de l'essai (proxy + LLM) ; `null` : inconnu. */
  readonly costUsd: number | null;
};

/** Stratégie réparée (vN+1) : patch borné (ou `null` pour une escalade), sortie déjà rejouée et validée. */
export type RepairedStrategy = { readonly execution: Execution; readonly network: FrozenStrategy['network']; readonly spec: DeclarativeSpec | StepsSpec; readonly patch: JsonPatchOperation[] | null; readonly estCostUsd: number | null };

/**
 * Essai d'une stratégie `steps` (2.13) : arrêt de l'interprète AVANT une étape et action de l'hôte sur la page gardée
 * (agent d'étape, niveaux 2 et 3), sans que la page ne quitte l'hôte.
 */
type StepsTrialExtras = { readonly stopBefore?: number; readonly afterPause?: (tools: StepPageTools, host: StepsHost) => Promise<void> };

/** Issue d'une réparation (04 §5). */
export type RepairOutcome =
  /**
   * vN+1 conforme, déjà enregistrée par `commit` SOUS le bail (`saved`). `validated: false` (reprise par étape, V5 en
   * échec) : données livrées, vN+1 archivée non courante, raison `repair_not_validated` (12).
   */
  | { readonly kind: 'repaired'; readonly strategy: RepairedStrategy; readonly check: CandidateCheck; readonly saved: { readonly version: number; readonly promoted: boolean }; readonly validated?: boolean }
  /** Budget épuisé, correctif répété, cascade d'étapes, ou seule issue « agent à chaque run » : 13, stratégie gardée. */
  | { readonly kind: 'failed'; readonly cause: RepairStopCause | 'step_cascade' | 'not_compilable'; readonly detail: string }
  /** Reprise par étape arrêtée sans agent (2.13) : étape `write` ou run avec session : 14 (`action_requise`), brouillon proposé. */
  | { readonly kind: 'stopped'; readonly reason: 'write_step_broken' | 'session_step_broken'; readonly stepId: string }
  /** Un refus est survenu pendant la réparation : la garde l'emporte (14 ou 15). */
  | { readonly kind: 'refused'; readonly failure: ExecFailure }
  /** Une autre réparation tenait le bail et a produit vN+1 : le run la rejoue. */
  | { readonly kind: 'superseded'; readonly version: number };

/**
 * Port de réparation (2.3). `evidence` : preuves DÉJÀ passées par la garde (aucune n'est un refus ni une page de défi,
 * un signal faible en 2xx est retiré) puis MINIMISÉES par `minimizeEvidence` avec le registre du run (`ctx.personal`) :
 * squelette HTML (balises, id, class), squelette JSON (clés, types), texte libre masqué ; jamais le corps de la page,
 * ses valeurs, ses cookies ni sa requête (04 §5 « journaux masqués, diff de forme », 17 §6, RGPD). Les sujets effacés
 * (`ctx.excludeSubjects`) ne sont connus que par empreinte : d'où « aucune valeur de la page ». Le port doit encore
 * passer chaque texte par `assertPromptSafe` avant de l'inclure dans un prompt (04b §6). `reasons` : raisons de rejet des
 * items (sans valeur) quand la casse vient du seuil de D-49. `trial` rejoue une candidate (journalisée comme un essai).
 * `commit` enregistre vN+1 : le port l'appelle AVANT de libérer le bail de réparation, pour qu'un run qui attendait le bail
 * trouve vN+1 déjà courante (sinon il verrait le bail libre et la version d'origine, et échouerait sans raison).
 */
export type RepairPort = (request: {
  readonly ctx: RunCtx;
  readonly target: RunTarget;
  readonly strategy: FrozenStrategy;
  readonly failure: ExecFailure;
  readonly evidence: readonly AgentEvidence[];
  readonly reasons: readonly RejectionReason[];
  readonly trial: (candidate: FrozenStrategy, purpose: 'repair_patch' | 'repair_escalation') => Promise<CandidateCheck>;
  readonly commit: (repaired: RepairedStrategy) => Promise<{ version: number; promoted: boolean }>;
  /** Stratégie `steps` (2.13) : étape en échec (classe retenue par la garde). */
  readonly step?: StepFailure;
  /** Stratégie `steps` : essai d'une candidate, avec arrêt avant une étape et action de l'hôte (agent d'étape). */
  readonly stepTrial?: (candidate: FrozenStrategy, extras?: StepsTrialExtras) => Promise<CandidateCheck>;
  /** Stratégie `steps` : vN+1, courante seulement si `validated` (portes V0 à V5), sinon archivée non courante. */
  readonly commitSteps?: (repaired: { spec: StepsSpec; patch: JsonPatchOperation[]; validated: boolean }) => Promise<{ version: number; promoted: boolean }>;
  /** Stratégie `steps` : ce correctif a-t-il déjà été archivé non validé pour cette version (run précédent) ? */
  readonly repairedBefore?: (patch: JsonPatchOperation[]) => Promise<boolean>;
}) => Promise<RepairOutcome>;

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
  /** Stratégie `steps` (2.13) : étape en échec, effet observé, arrêt avant une étape. */
  steps?: StepsTrialInfo;
};

/** Un essai d'une stratégie, gardes comprises, avant journalisation (`runTrial`). */
export type StrategyTrial = {
  readonly outcome: Outcome;
  /** Résultat après registre de masquage et liste d'exclusion (D-28). */
  readonly result: DeclarativeRunResult;
  readonly evidence: readonly AgentEvidence[];
  /** Classe retenue par la garde de classification (1.7) : un refus prime sur l'échec vu par l'exécuteur. */
  readonly guardedFailure: ExecFailure | undefined;
  readonly proxyUsd: number;
  readonly llm: LlmSpend | null;
  /** `null` : prix du modèle absent, coût inconnu (jamais 0). */
  readonly llmUsd: number | null;
  readonly ms: number;
};

/** Exécuteur des runs et essai d'une stratégie candidate (enquête, tâche 2.1), avec les mêmes gardes. */
export type StrategyRuntime = {
  readonly executor: RunExecutor;
  /**
   * Un essai avec toutes les gardes. `itemPolicy` : `strict` (défaut, enquête : le moindre item non conforme fait échouer
   * l'essai) ou `quarantine` (runs, D-49 : les items non conformes restent dans `result.records`, à trier par l'appelant).
   */
  readonly trial: (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>, itemPolicy?: ItemPolicy) => Promise<StrategyTrial>;
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
  | { readonly kind: 'agent'; readonly spec: AgentSpec; readonly hosts: readonly string[] }
  | { readonly kind: 'steps'; readonly spec: StepsSpec; readonly hosts: readonly string[] };

/** Spécification d'une stratégie E4-E6, validée (liste fermée, domaines de l'API) ; refus `invalid_agent_spec`. */
function agenticSpecOf(execution: string, spec: unknown): AgenticSpec | undefined {
  if (execution === 'agent_fetch') {
    const c = validateAgentFetchSpec(spec);
    return c.ok ? { kind: 'agent_fetch', spec: c.spec, hosts: c.spec.request.allowed_hosts } : refuse('code_error', 'invalid_agent_spec');
  }
  if (execution === 'hybrid' && (spec as { kind?: unknown } | null)?.kind === 'steps') {
    // E5 au format `steps` (2.13) : interprété dans le bac à sable, reprise par étape.
    const c = validateStepsSpec(spec);
    return c.ok ? { kind: 'steps', spec: c.spec, hosts: c.spec.allowed_hosts } : refuse('code_error', 'invalid_agent_spec');
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

/**
 * Stratégie qui appelle un agent à CHAQUE run (19 §4) : E6, ou E5 hybride à étape ou extraction déléguée. Sans
 * `instructed_mode`, une telle version n'a droit qu'à son essai de compilation (`compilable = unknown`), puis plus rien.
 */
function agentEachRun(strategy: NonNullable<RunTarget['strategy']>): boolean {
  if (strategy.execution === 'agent') return true;
  if (strategy.execution !== 'hybrid' || (strategy.spec as { kind?: unknown } | null)?.kind === 'steps') return false;
  const c = validateHybridSpec(strategy.spec);
  return c.ok && hybridUsesLlm(c.spec);
}

export function createStrategyRuntime(deps: StrategyExecutorDeps): StrategyRuntime {
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

  /**
   * Identité du robot pour ce run (17 §5) : le User-Agent réel du moteur embarqué ; avec `identify_instance`, le jeton
   * (version, contact de l'instance) et `From` en plus ; contact absent journalisé.
   */
  const identity = robotIdentity({
    ...(deps.version === undefined ? {} : { version: deps.version }),
    ...(deps.instanceContact === undefined ? {} : { instanceContact: deps.instanceContact }),
    ...(deps.identifyInstance === undefined ? {} : { identifyInstance: deps.identifyInstance }),
    warn: (code) => logger.warn({ code }, "contact d'instance absent : identification de l'instance sans contact (17 §5 : requis avant la première enquête)"),
  });
  const userAgentFor = async (): Promise<RobotIdentity> => {
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
    base: { pool: BrowserPool; egress: BrowserEgress; session: NetworkSession; pacer?: RequestPacer; allowedHosts: readonly string[]; startUrl: string; robots: RobotsGate; userAgent: string; itemPolicy: ItemPolicy },
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
    // Politique `quarantine` (runs, D-49) : 0 item conforme casse ; sinon les items non conformes sont triés par l'appelant.
    const conforming = (r: unknown): boolean => validateOutput(target.api.outputSchema, r).ok;
    if (result.ok && (base.itemPolicy === 'quarantine' ? !result.records.some(conforming) : result.records.some((r) => !conforming(r)))) {
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
  const executeTunnel = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>, itemPolicy: ItemPolicy): Promise<Outcome> => {
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
      itemPolicy,
      signal: ctx.signal,
      ...(pacer === undefined ? {} : { pacer }),
      ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
    });
    if (session.refusedAfterStop > 0) await ctx.log('info', 'tunnel_commands_withheld', { count: session.refusedAfterStop, reason: session.stop });
    return { result: out.result, usage: null, ...(out.stop === null ? {} : { stop: out.stop }), ...(out.needsUser ? { needsUser: true } : {}) };
  };

  const execute = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>, itemPolicy: ItemPolicy, extras?: StepsTrialExtras): Promise<Outcome> => {
    // Agent à chaque run (19 §4, 2.13) : une version E6 non compilable en E5 ne tourne qu'en mode « agent instruit »
    // (opt-in explicite, étapes confirmées par un humain). Une version `unknown` a droit à son essai de compilation.
    const eachRun = agentEachRun(strategy);
    if (eachRun && strategy.compilable === 'no' && !target.api.instructedMode) return refuse('code_error', 'not_compilable');
    if (eachRun) {
      // Règle des deux (19 §7) : agent instruit ou essai de compilation E6 ; registre du code, aucun pont MCP par construction.
      const registry = agentToolRegistry(strategy.compilable === 'no' ? 'instructed' : 'e6');
      if (!ruleOfTwoHolds(registry)) return refuse('code_error', 'rule_of_two');
      await ctx.log('info', 'agent_tool_registry', { phase: registry.phase, tools: [...registry.tools], mcp: registry.mcp });
    }
    if (strategy.network === 'tunnel') return executeTunnel(ctx, target, strategy, itemPolicy);
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
    // Le format `steps` lit ses entrées par leur nom (`type`, `select` : entrées du run seulement), contrôlées par l'hôte.
    if (agentic !== undefined && agentic.kind !== 'steps' && hasInput(ctx.input)) return refuse('code_error', 'input_unsupported');
    const { rung, credentials } = await rungFor(target, strategy.network);
    const { userAgent, from } = await userAgentFor();
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
      ...(from === null ? {} : { from }),
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
      ...(from === null ? {} : { from }),
    });
    const pacer = pacerFor(target, robots);
    const common = {
      input: ctx.input,
      outputSchema: target.api.outputSchema,
      itemPolicy,
      signal: ctx.signal,
      access: robots.access,
      ...(pacer === undefined ? {} : { pacer }),
      ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
      ...(deps.classify === undefined ? {} : { classify: deps.classify }),
    };
    try {
      const outcome = await executeOn(strategy, { spec, script, agentic, setLlmSpent: (f) => (llmSpent = f), sessionOptions, common, pacer, robots, userAgent, ctx, target, setOther: (o) => (otherUsd = { ...otherUsd, ...o }), ...(extras === undefined ? {} : { extras }) });
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
    extras?: StepsTrialExtras;
  };

  /**
   * E5 au format `steps` (2.13, 19 §4) : interprète FIXE dans le bac à sable de 1.5 (comme un script E3 : mêmes ponts,
   * mêmes gardes), chaque action contrôlée par l'hôte contre sa copie de la stratégie (StepsHost) ; aucun LLM.
   */
  const executeSteps = async (strategy: NonNullable<RunTarget['strategy']>, stepsSpec: StepsSpec, args: ExecuteArgs): Promise<Outcome> => {
    const { sessionOptions, pacer, robots, userAgent, ctx, target } = args;
    const port = deps.script;
    if (port === undefined) return refuse('code_error', 'sandbox_unavailable');
    if (deps.browsers === null) return refuse('code_error', 'browser_disabled');
    const source = validateStepsSource(strategy.sourceSteps ?? [], stepsSpec);
    if (!source.ok) return refuse('code_error', 'invalid_steps_source');
    const host = new StepsHost({ spec: stepsSpec, source: source.steps, runInput: ctx.input, stopBefore: args.extras?.stopBefore ?? null, allowWriteActions: target.api.allowWriteActions });
    const egress = await openBrowserEgress(sessionOptions('egress'));
    args.setOther({ egress: () => egress.usage().costUsd });
    const session = openNetworkSession(sessionOptions('session'));
    args.setOther({ session: () => session.usage().costUsd });
    try {
      const afterPause = args.extras?.afterPause;
      const run = await runScriptExecutor({
        pool: deps.browsers,
        egress,
        guard: deps.guard,
        session,
        engine: port.engine,
        code: STEPS_INTERPRETER_SOURCE,
        allowedHosts: stepsSpec.allowed_hosts,
        startUrl: stepsSpec.start_url,
        input: host.interpreterInput(),
        signal: ctx.signal,
        logger: logger.child({ runId: ctx.runId }),
        ...(port.limits === undefined ? {} : { limits: port.limits }),
        ...(pacer === undefined ? {} : { pacer }),
        ...(target.api.domainPacing.max_requests_per_run === undefined ? {} : { maxRequests: target.api.domainPacing.max_requests_per_run }),
        allowWriteActions: target.api.allowWriteActions,
        ...(deps.classify === undefined ? {} : { classify: deps.classify }),
        robots: robots.access,
        userAgent,
        steps: { host, ...(afterPause === undefined ? {} : { afterPause: (tools: StepPageTools) => afterPause(tools, host) }) },
      });
      let result = run.result;
      const itemPolicy = args.common.itemPolicy ?? 'strict';
      const conforming = (r: unknown): boolean => validateOutput(target.api.outputSchema, r).ok;
      if (result.ok && host.info.paused === null && (itemPolicy === 'quarantine' ? !result.records.some(conforming) : result.records.some((r) => !conforming(r)))) {
        result = { ok: false, failure: { failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }, pages: result.pages, requests: result.requests };
      }
      const exceeded = egress.budgetExceeded() || session.budgetExceeded();
      return {
        result: budgetChecked(refineEgress(result, egress), exceeded),
        usage: addUsage(egress.usage(), session.usage()),
        violations: run.violations,
        scriptItems: run.items,
        ...(run.steps === undefined ? {} : { steps: run.steps }),
      };
    } finally {
      await session.close().catch(() => undefined);
      await egress.close().catch(() => undefined);
    }
  };

  const executeOn = async (strategy: NonNullable<RunTarget['strategy']>, args: ExecuteArgs): Promise<Outcome> => {
    const { spec, script, agentic, sessionOptions, common, pacer, robots, userAgent, ctx, target } = args;
    if (agentic?.kind === 'steps') return executeSteps(strategy, agentic.spec, args);
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
              const out = await runScript(ctx, target, strategy.scriptRef!, { pool: deps.browsers, egress, session, ...(pacer === undefined ? {} : { pacer }), ...script, robots, userAgent, itemPolicy: common.itemPolicy ?? 'strict' });
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
        const agentBrowser = (o: Omit<AgentBrowserOptions, 'egressServer'>) => ports.agentBrowser({ ...o, egressServer: egress!.server, userAgent });
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
          itemPolicy: args.common.itemPolicy ?? 'strict',
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
              ...(egress === undefined || deps.browsers === null ? {} : { browser: { pool: deps.browsers, egress, guard: deps.guard, userAgent } }),
            });
          } else if (agentic.kind === 'hybrid') {
            out = await runHybridExecutor({
              ...common,
              spec: agentic.spec,
              guard: deps.guard,
              egress: egress!,
              pool: deps.browsers,
              userAgent,
              agentBrowser,
              ...(config === null ? {} : { engineFor: ports.engineFor(config), llm: extractClient(), llmModelId: config.roles.extract?.model ?? null }),
              allowWriteActions: target.api.allowWriteActions,
            });
          } else {
            if (config === null || config.roles.agent === undefined) return refuse('code_error', 'llm_not_configured');
            // Agent instruit (2.13, 19 §4) : opt-in explicite, étapes CONFIRMÉES (déclencheur de 0018) rejouées par l'agent à
            // chaque run ; coût estimé journalisé avant le lancement ; compilation tentée après K runs réussis.
            let spec = agentic.spec;
            let compile = true;
            if (strategy.compilable === 'no' && target.api.instructedMode) {
              const steps = validateInstructedSteps(strategy.instructedSteps ?? []);
              // Revérifié AU RUN, sur la version exécutée : étapes confirmées par un humain sur leur empreinte exacte.
              if (!steps.ok || !canActivateInstructedMode({ compilable: strategy.compilable, steps: steps.steps, confirmation: strategy.instructedConfirmation }).ok) {
                return refuse('code_error', 'not_compilable');
              }
              spec = { ...spec, instruction: instructedInstruction(spec.instruction, steps.steps) };
              const succeeded = await countSucceededRuns(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: strategy.version });
              compile = succeeded >= STEP_REPAIR_DEFAULTS.instructedCompileAfter;
              await ctx.log('info', 'instructed_run', { estimated_usd: estimateInstructedRunUsd(steps.steps), steps: steps.steps.length, compile });
            }
            out = await runAgentExecutor({
              ...common,
              spec,
              compile,
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

  /**
   * Un essai d'une stratégie (figée ou candidate d'une enquête) avec TOUTES les gardes de l'exécution : robots.txt,
   * SSRF, verrou de domaines, cadence, plafond de coût, bac à sable, classification avant extraction (INV6), registre
   * de masquage et liste d'exclusion (D-28). Rien n'est journalisé dans `run_attempts` ni écrit en dataset ici.
   */
  const runTrial = async (ctx: RunCtx, target: RunTarget, strategy: NonNullable<RunTarget['strategy']>, started = now(), itemPolicy: ItemPolicy = 'strict', extras?: StepsTrialExtras): Promise<StrategyTrial> => {
    let outcome: Outcome;
    try {
      outcome = await execute(ctx, target, strategy, itemPolicy, extras);
    } catch (error) {
      if (!(error instanceof TargetError)) throw error;
      outcome = { result: { ok: false, failure: error.failure, pages: 0, requests: 0 }, usage: null };
    }
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
    const llm: LlmSpend | null = outcome.agent?.llm ?? null;
    return {
      outcome,
      result,
      evidence,
      guardedFailure,
      proxyUsd: outcome.usage?.costUsd ?? 0,
      llm,
      // Prix absent : coût LLM inconnu (jamais 0, 08 §1 ; INV4).
      llmUsd: llm === null ? 0 : llm.usd,
      ms: Math.max(0, Math.round(now() - started)),
    };
  };

  const thresholds: RejectionThresholds = deps.rejection ?? ITEMS_REJECTED_DEFAULTS;

  /** Machine à états du statut (04 §6), appliquée par le worker ; absente (tests) : aucun changement. */
  const applyStatus = async (ctx: RunCtx, event: StatusEventInput) => {
    try {
      return (await ctx.applyStatus?.(event)) ?? null;
    } catch (error) {
      logger.error({ runId: ctx.runId, err: error instanceof Error ? error.name : 'error' }, 'statut : événement non appliqué');
      return null;
    }
  };

  /** Un essai journalisé (INV2, INV4) : exécution, réseau, classe (casse D-49 comprise), durée, coûts. */
  const recordTrial = async (ctx: RunCtx, strategy: FrozenStrategy, trial: StrategyTrial, verdict: RejectionVerdict | null): Promise<void> => {
    const llm = trial.llm;
    await ctx.recordAttempt({
      execution: strategy.execution,
      network: strategy.network,
      est_cost_usd: strategy.estCostUsd,
      result:
        trial.outcome.stop === 'challenge_in_tunnel'
          ? 'blocked_by_protection'
          : trial.guardedFailure !== undefined
            ? trial.guardedFailure.failure_class
            : verdict === 'break'
              ? 'extraction'
              : 'ok',
      ms: trial.ms,
      proxy_usd: trial.proxyUsd,
      ...(llm === null ? {} : { llm_usd: trial.llmUsd, tokens: llm.tokens, model_id: llm.modelId, prompt_version: llm.promptVersion, engine: llm.engine }),
    });
  };

  /** Items d'un essai réussi triés contre `output_schema` (D-49) : conformes livrables, non conformes en quarantaine. */
  const sortItems = (target: RunTarget, trial: StrategyTrial): { partition: ItemPartition<Record<string, unknown>>; verdict: RejectionVerdict } | null => {
    if (!trial.result.ok) return null;
    const partition = partitionItems(target.api.outputSchema, trial.result.records);
    return { partition, verdict: rejectionVerdict(partition.conform.length, partition.rejected.length, thresholds) };
  };

  /** Runs en cours dont la quarantaine est déjà écrite (casse puis réparation : la quarantaine est remplacée ou retirée). */
  const quarantined = new Set<string>();
  /**
   * Quarantaine du run (D-49) : agrégats sans valeur et échantillon nettoyé, écrits comme l'appelant du run. Rend les raisons
   * MASQUÉES (motifs, registre du run) : les seules qui entrent dans le prompt de réparation (un nom de clé vient du site).
   */
  const quarantine = async (ctx: RunCtx, target: RunTarget, partition: ItemPartition<Record<string, unknown>>, verdict: RejectionVerdict): Promise<readonly RejectionReason[]> => {
    // Sortie (réparée) sans rejet : une quarantaine de diagnostic écrite à la casse ne décrit plus le run livré.
    if (partition.rejected.length === 0) {
      if (quarantined.delete(ctx.runId)) await deleteRejectedItems(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId });
      return [];
    }
    quarantined.add(ctx.runId);
    const summary = quarantineSummary(target.api.outputSchema, partition.rejected, ctx.personal);
    await saveRejectedItems(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, projectId: target.api.projectId, summary });
    await ctx.log('info', 'items_rejected', { count: summary.total_rejected, delivered: partition.conform.length, verdict, by_reason: summary.by_reason.slice(0, 10) });
    return summary.by_reason;
  };

  /** Une candidate de réparation rejouée avec toutes les gardes, journalisée comme un essai. */
  const checkCandidate = async (ctx: RunCtx, target: RunTarget, candidate: FrozenStrategy, extras?: StepsTrialExtras): Promise<CandidateCheck> => {
    const trial = await runTrial(ctx, target, candidate, now(), 'quarantine', extras);
    const sorted = sortItems(target, trial);
    await recordTrial(ctx, candidate, trial, sorted?.verdict ?? null);
    const failure = trial.result.ok ? null : (trial.guardedFailure ?? trial.result.failure);
    const stopped: ExecFailure | null = trial.outcome.stop === undefined ? null : { failure_class: 'blocked_by_protection', retryable: false, detail: trial.outcome.stop };
    return {
      trial,
      partition: sorted?.partition ?? { conform: [], rejected: [] },
      verdict: sorted?.verdict ?? 'break',
      failure: stopped ?? failure,
      refusal: stopped ?? (failure !== null && !failureRoute(failure.failure_class).agent ? failure : null),
      costUsd: trial.llmUsd === null ? null : Math.round((trial.proxyUsd + trial.llmUsd) * 1e6) / 1e6,
    };
  };

  /**
   * Signal `volume_anomaly` (04 §6) compté sur les items EXTRAITS (livrés + écartés, D-49) : moins de la moitié de la
   * médiane des runs réussis à même entrée, après 5 runs au moins.
   */
  const volumeSignal = async (ctx: RunCtx, extracted: number): Promise<boolean> => {
    try {
      const history = await readVolumeHistory(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, input: ctx.input, excludeRunId: ctx.runId });
      if (history.length === 0) return false;
      const sorted = [...history].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
      return volumeAnomaly(extracted, median, history.length);
    } catch {
      return false;
    }
  };

  /** Livraison d'une sortie conforme : dataset (items conformes seuls), quarantaine, signaux et statut (5, 8, 9, 12). */
  const deliver = async (
    ctx: RunCtx,
    target: RunTarget,
    args: { version: number; sorted: { partition: ItemPartition<Record<string, unknown>>; verdict: RejectionVerdict }; escalated: boolean; truncated: boolean; repaired: boolean; entered: boolean; validated?: boolean },
  ): Promise<RunResult> => {
    const { partition, verdict } = args.sorted;
    await quarantine(ctx, target, partition, verdict);
    const saved = await saveRunDataset(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, projectId: target.api.projectId, items: partition.conform });
    const volume = await volumeSignal(ctx, partition.conform.length + partition.rejected.length);
    const signals: DegradedSignal[] = [];
    if (args.repaired) signals.push('repaired');
    if (args.escalated) signals.push('escalated');
    if (args.truncated) signals.push('pagination_short');
    if (partition.rejected.length > 0) signals.push('items_rejected');
    if (volume) signals.push('volume_anomaly');
    // Réparation conforme : transition 12 (le signal `repaired` est sa raison) ; sinon run réussi (5, 8 ou 9).
    if (args.repaired) {
      if (args.entered) await applyStatus(ctx, { type: 'repair_succeeded', ...(args.validated === false ? { validated: false } : {}) });
    } else {
      await applyStatus(ctx, { type: 'run_succeeded', signals });
    }
    return {
      state: 'succeeded',
      outcome: signals.length > 0 ? 'degraded' : 'clean',
      degraded_reasons: signals,
      items: partition.conform.length,
      items_rejected: partition.rejected.length,
      dataset_id: saved.datasetId,
      strategy_version: args.version,
    };
  };

  /**
   * Échec d'un rejeu (04 §5, §6) : statut d'abord (10 ou 11 vers `reparation`, puis 14 ou 15 dans le même run pour un
   * refus ; 6 ou 8 pour `transient`), puis réparation par la SEULE porte de la garde (`invokeAgentGuarded`) : 12 si vN+1
   * est conforme, 13 si le budget est épuisé ou le correctif répété (stratégie précédente conservée).
   */
  const onFailure = async (
    ctx: RunCtx,
    target: RunTarget,
    strategy: FrozenStrategy,
    args: { original: ExecFailure; failure: ExecFailure; evidence: readonly AgentEvidence[]; reasons: readonly RejectionReason[]; rejected: number; step?: StepFailure },
  ): Promise<RunResult> => {
    const version = strategy.version;
    const failed = (f: ExecFailure, v: number = version): RunResult => ({
      state: 'failed',
      failure_class: f.failure_class,
      retryable: f.retryable,
      error_detail: f.detail,
      strategy_version: v,
      ...(args.rejected > 0 ? { items_rejected: args.rejected } : {}),
    });
    const { original, failure } = args;
    const entry = await applyStatus(ctx, { type: 'run_failed', failureClass: failure.failure_class, ...(failure.status === undefined ? {} : { httpStatus: failure.status }) });
    // Ce run a fait entrer l'API en `reparation` (10 ou 11) : il doit l'en faire sortir (12, 13, 14 ou 15).
    const entered = entry?.ok === true && entry.status === 'reparation';
    // Stratégie à agent à chaque run sans `instructed_mode` (2.13) : aucune réparation, seule issue un agent → 13.
    if (failure.detail === 'not_compilable') {
      await ctx.log('info', 'failure_route', { failure_class: failure.failure_class, next: 'not_compilable', agent_invoked: false });
      if (entered) await applyStatus(ctx, { type: 'repair_failed', cause: 'not_compilable' });
      return failed(failure);
    }
    const repair = deps.repair;
    const guarded =
      repair === undefined
        ? null
        : await invokeAgentGuarded(original, args.evidence, (f, shown) =>
            repair({
              ctx,
              target,
              strategy,
              failure: f,
              evidence: shown.map((item) => minimizeEvidence(item, ctx.personal)),
              reasons: args.reasons,
              trial: (candidate) => checkCandidate(ctx, target, candidate),
              commit: (repaired) => saveRepairedStrategy(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, parentVersion: version, ...repaired }),
              ...(args.step === undefined
                ? {}
                : {
                    step: args.step,
                    stepTrial: (candidate: FrozenStrategy, extras?: StepsTrialExtras) => checkCandidate(ctx, target, candidate, extras),
                    commitSteps: (repaired: { spec: StepsSpec; patch: JsonPatchOperation[]; validated: boolean }) =>
                      saveStepRepairedStrategy(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, parentVersion: version, network: strategy.network, ...repaired }),
                    repairedBefore: (patch: JsonPatchOperation[]) => archivedRepairExists(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, parentVersion: version, patch }),
                  }),
            }),
          );
    const route = failureRoute(failure.failure_class);
    await ctx.log('info', 'failure_route', {
      failure_class: failure.failure_class,
      next: route.next,
      agent_invoked: guarded?.invoked ?? false,
      ...(failure.failure_class === original.failure_class ? {} : { reclassified_from: original.failure_class }),
    });
    if (guarded === null || !guarded.invoked) {
      // Aucune réparation possible (classe sans agent ou port absent) : une API laissée en `reparation` passe en `erreur`.
      if (entered) await applyStatus(ctx, { type: 'repair_failed', cause: 'budget_exhausted' });
      return failed(failure);
    }
    const out = guarded.value;
    switch (out.kind) {
      case 'repaired': {
        const saved = out.saved;
        await ctx.log('info', 'strategy_repaired', {
          from_version: version,
          to_version: saved.version,
          promoted: saved.promoted,
          execution: out.strategy.execution,
          network: out.strategy.network,
          patch_ops: out.strategy.patch?.length ?? 0,
        });
        const result = out.check.trial.result;
        return deliver(ctx, target, {
          version: saved.version,
          sorted: { partition: out.check.partition, verdict: out.check.verdict },
          escalated: (result.ok && result.escalated) || out.strategy.execution !== strategy.execution,
          truncated: result.ok && result.truncated,
          repaired: true,
          entered,
          ...(out.validated === false ? { validated: false } : {}),
        });
      }
      case 'stopped': {
        // Étape `write` ou run avec session (2.13) : aucun agent, la main revient à l'humain (14) ; un brouillon est
        // proposé (journal : l'itération sur brouillon de 3.14 le matérialise).
        await ctx.log('warn', 'step_draft_proposed', { reason: out.reason, step_id: out.stepId });
        await applyStatus(ctx, { type: 'run_stopped', reason: out.reason });
        return { state: 'failed', failure_class: null, stop_reason: out.reason, retryable: false, error_detail: out.reason, strategy_version: version };
      }
      case 'refused': {
        // La garde l'emporte : refus servi pendant la réparation → 15 ou 14 depuis `reparation`, sans autre agent.
        const step = await applyStatus(ctx, { type: 'run_failed', failureClass: out.failure.failure_class, ...(out.failure.status === undefined ? {} : { httpStatus: out.failure.status }) });
        if (entered && step?.status === 'reparation') await applyStatus(ctx, { type: 'repair_failed', cause: 'budget_exhausted' });
        return failed(out.failure);
      }
      case 'failed': {
        if (entered) await applyStatus(ctx, { type: 'repair_failed', cause: out.cause });
        return failed({ failure_class: failure.failure_class, retryable: false, detail: out.detail });
      }
      case 'superseded': {
        // Une autre réparation a produit vN+1 pendant l'attente du bail : le run la rejoue, sans nouvelle réparation.
        const next = await loadRunTarget(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: out.version });
        if (next === null || next.strategy === null) return failed(failure);
        const trial = await runTrial(ctx, next, next.strategy, now(), 'quarantine');
        const sorted = sortItems(next, trial);
        await recordTrial(ctx, next.strategy, trial, sorted?.verdict ?? null);
        if (!trial.result.ok || sorted === null || sorted.verdict === 'break') {
          await ctx.log('warn', 'repair_superseded_failed', { version: out.version });
          return failed(trial.result.ok ? failure : (trial.guardedFailure ?? trial.result.failure), out.version);
        }
        return deliver(ctx, next, { version: out.version, sorted, escalated: trial.result.escalated, truncated: trial.result.truncated, repaired: false, entered: false });
      }
    }
  };

  const executeRun = async (ctx: RunCtx): Promise<RunResult> => {
    const started = now();
    const target = await loadRunTarget(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: ctx.strategyVersion });
    if (target === null) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'api_not_found' };
    const strategy = target.strategy;
    if (strategy === null) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'no_strategy_version' };

    // Runs : politique `quarantine` (D-49) — chaque item est trié contre `output_schema`, les non conformes ne sont jamais livrés.
    const trial = await runTrial(ctx, target, strategy, started, 'quarantine');
    const { outcome, evidence, guardedFailure, proxyUsd, llm, llmUsd } = trial;
    const result = trial.result;
    // Extension hors ligne (04 §6, 05) : le run, resté en `waiting_tunnel`, se termine `skipped_tunnel_offline`. Aucun
    // essai (aucune commande n'a abouti, ce n'est pas un échec réseau), aucune classe d'échec, statut de l'API inchangé.
    const stop = outcome.stop;
    if (stop === 'tunnel_offline') {
      await ctx.log('warn', 'tunnel_offline', { network: 'tunnel' });
      return { state: 'skipped_tunnel_offline', stop_reason: 'tunnel_offline', error_detail: 'tunnel_offline', strategy_version: strategy.version };
    }
    // Défi en tunnel : l'essai est journalisé avec sa cause de fait (protection), le run s'arrête SANS classe d'échec
    // (04 §6) : `challenge_in_tunnel` → action_requise, la main revient à l'humain.
    // Prix absent : coût LLM inconnu, écrit null (jamais 0, 08 §1 ; INV4), avec avertissement.
    if (llm !== null && llm.usd === null) await ctx.log('warn', 'llm_price_missing', { model: llm.modelId });
    if ((outcome.agent?.domainBlocked ?? 0) > 0) await ctx.log('warn', 'agent_domain_blocked', { count: outcome.agent?.domainBlocked });
    const sorted = sortItems(target, trial);
    await recordTrial(ctx, strategy, trial, sorted?.verdict ?? null);
    const version = strategy.version;
    // Agent à chaque run (2.13) : un essai sans compilation, réussi ou non, rend la version `compilable = no` ; sans
    // `instructed_mode`, elle ne tourne plus (`not_compilable`), jamais un agent à chaque run sans opt-in explicite.
    if (agentEachRun(strategy) && strategy.compilable === 'unknown' && outcome.agent?.compiled === undefined && outcome.agent !== undefined) {
      try {
        await markStrategyCompilable(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version, compilable: 'no' });
        await ctx.log('info', 'strategy_not_compilable', { version });
      } catch (error) {
        logger.error({ runId: ctx.runId, err: error instanceof Error ? error.name : 'error' }, 'compilable : marquage impossible');
      }
    }
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
    // Stratégie `steps` (2.13) : l'étape en échec, avec la classe retenue par la garde (un refus n'atteint pas l'échelle).
    const stepFailed = (failure: ExecFailure): StepFailure | undefined => {
      const info = outcome.steps;
      if (info === undefined) return undefined;
      if (info.observedWriteAt !== null) return { index: info.observedWriteAt, failure };
      if (info.failure !== null) return { index: info.failure.index, failure: { ...info.failure.failure, failure_class: failure.failure_class } };
      // Sortie hors schéma (D-49) : l'étape d'extraction est en cause.
      const spec = strategy.spec as { steps?: { op?: unknown }[] } | null;
      const last = (spec?.steps ?? []).map((st) => st.op).lastIndexOf('extract');
      return last < 0 ? undefined : { index: last, failure };
    };
    if (!result.ok) {
      const failure = guardedFailure ?? result.failure;
      const step = stepFailed(failure);
      return onFailure(ctx, target, strategy, { original: result.failure, failure, evidence, reasons: [], rejected: 0, ...(step === undefined ? {} : { step }) });
    }
    // Casse par les items non conformes (D-49) : 0 item conforme, ou au-delà du seuil (part ET nombre). Rien n'est livré ;
    // la quarantaine est écrite pour le diagnostic, puis réparation dans le même run (classe `extraction`, INV1).
    if (sorted !== null && sorted.verdict === 'break') {
      const reasons = await quarantine(ctx, target, sorted.partition, sorted.verdict);
      const failure: ExecFailure = { failure_class: 'extraction', retryable: false, detail: sorted.partition.conform.length === 0 ? 'schema_mismatch' : 'items_rejected' };
      await ctx.log('warn', 'schema_mismatch', { conform: sorted.partition.conform.length, rejected: sorted.partition.rejected.length });
      const step = stepFailed(failure);
      return onFailure(ctx, target, strategy, { original: failure, failure, evidence: [], reasons, rejected: sorted.partition.rejected.length, ...(step === undefined ? {} : { step }) });
    }
    // Compilation E6 → E5 vérifiée (04 §3.1), au grain de l'étape (2.13, 19 §4) : nouvelle version `hybrid` au format
    // `steps` avec sa source (intention écrite par le code, `post` tirée de la trace), signal de baisse de coût journalisé.
    const compiled = outcome.agent?.compiled;
    if (compiled !== undefined) {
      try {
        const steps = compileHybridToSteps(compiled, { modelId: llm?.modelId ?? null, at: new Date(now()).toISOString(), ...(outcome.agent?.trace === undefined ? {} : { trace: outcome.agent.trace }) });
        const saved = await saveCompiledStrategy(deps.pool, {
          apiId: ctx.apiId,
          ownerId: ctx.ownerId,
          parentVersion: version,
          network: strategy.network,
          spec: steps?.spec ?? compiled,
          estCostUsd: proxyUsd,
          ...(steps === null ? {} : { sourceSteps: steps.source }),
        });
        await ctx.log('info', 'strategy_compiled', { from_version: version, to_version: saved.version, promoted: saved.promoted, llm_usd_saved: llmUsd, format: steps === null ? 'hybrid' : 'steps' });
      } catch {
        await ctx.log('warn', 'strategy_compile_not_saved', {});
      }
    } else if (outcome.agent?.compileFailure !== undefined) {
      await ctx.log('info', 'strategy_compile_skipped', { reason: outcome.agent.compileFailure });
    }
    return deliver(ctx, target, { version, sorted: sorted!, escalated: result.escalated, truncated: result.truncated, repaired: false, entered: false });
  };
  const executor: RunExecutor = async (ctx) => {
    try {
      return await executeRun(ctx);
    } finally {
      quarantined.delete(ctx.runId);
    }
  };
  return { executor, trial: (ctx, target, strategy, itemPolicy) => runTrial(ctx, target, strategy, now(), itemPolicy ?? 'strict') };
}

/** Exécuteur des runs de stratégie (E1-E6, tunnel) : `createStrategyRuntime(deps).executor`. */
export function createStrategyExecutor(deps: StrategyExecutorDeps): RunExecutor {
  return createStrategyRuntime(deps).executor;
}
