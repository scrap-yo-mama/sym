// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur des runs d'enquête (`runs.kind = investigation`, tâche 2.1, 04 §2-§4, figure 1). Une enquête tient en un
// ou deux runs : premier appel (étape 0, reconnaissance, schéma proposé ; s'arrête en `awaiting_schema_validation` sauf
// `auto_validate`), puis, après `validate_schema`, les essais. Chaque run refait l'étape 0 : la base refuse tout essai
// sans rapport d'accès favorable antérieur (0015).
// 0. Rapport d'accès (1.11) : sonde de la page (signaux, 402, CGU, voies déclarées), `llms.txt` et `sitemap.xml` en
//    sondes passives ; le robots.txt n'est pas lu (D-91). Contact d'instance exigé (17 §5) ; identité des runs (D-33) :
//    User-Agent réel du moteur, jeton d'instance et `From` seulement avec `identify_instance`. Refus → `bloquee` /
//    `action_requise` (transitions 3, 4), aucune autre requête.
// 1. Reconnaissance : une passe E3 sur N1 (Chromium : trafic XHR / fetch capturé et classé, document servi et rendu), ou,
//    sans navigateur, la page et les URL de données que ses scripts en ligne appellent ; EN TUNNEL (page et URL de données
//    lues par l'extension du propriétaire, `page_fetch`) quand la session est requise ou que la politique réseau n'admet
//    que le tunnel (04 §4, 07). Blobs embarqués cherchés avant de conclure « pas d'API ». Une signature calculée côté
//    client rend la voie `unsupported`, sans tentative (INV6). Domaines de l'API : la page et ses sous-domaines (ou ceux
//    du domaine sans `www.`, 04b §2). Refaite à chaque run : l'état de l'API ne garde aucune valeur du site (17 §6).
// 2. Schéma de SORTIE d'abord (rôle `investigate`, squelettes seulement, coût d'un appel borné AVANT l'envoi) : proposé
//    avec un échantillon extrait par le code, passé par la liste d'exclusion des personnes effacées (17 §6) ; validé par
//    l'appelant (`validate_schema`) ou, avec `auto_validate`, par l'agent, journalisé.
// 3. Essais par coût estimé croissant (`buildTrialPlan`, `runTrials`), élagués par le classifieur, N = 3 exécutions
//    conformes dont une en page 2 si la stratégie pagine ; chaque exécution passe par l'exécuteur de stratégie et TOUTES
//    ses gardes (SSRF, verrou de domaines, cadence, plafonds, classification avant extraction). Un couple = un
//    essai journalisé (`run_attempts`, INV2, INV4) et un `attempt.finished` ; un élagage = un `attempt.pruned`.
// 4. Fin : stratégie v1 (`created_by = investigation` ; une trace E6 n'est gardée que compilée en E5, 04 §3.1) ; un essai E4
//    conforme est compilé en déclaratif `html` vérifié sans LLM (UX-20, 04b §2) : retenu, il devient la version courante et
//    la version E4 reste le repli ; sinon E4 est retenu, avec la raison au récit (`strategy.compiled`). Schéma de
//    sortie validé et schéma d'entrée proposé posés sur l'API, résultat livré (dataset du run), statut `sain` (1) ; sinon
//    `bloquee`, `action_requise` ou `erreur` (2, 3, 21). Toute fin ferme la phase et le récit.
// Règles Markdown (tâche 2.10, 18 §4) : résolues pour l'API (propriétaire et instance seulement), injectées dans le préfixe
// stable du prompt `investigate` (<trusted_rules>, <skills>, skills lus par `read_skill`), avec l'ensemble des couples
// autorisés et leur coût estimé ; le plan rendu (`plan[]`, `excluded[]`, `rule_refs`) ne fait que réordonner ou restreindre
// cet ensemble (`applyRulePlan` : `pruned_by_rule`, `rule_widening_ignored`), puis le rattrapage du moins cher (code). La
// version retenue enregistre sa source (`source.rules`, `strategy_version_rules`) ; une recompilation (`reason: recompile`)
// garde le schéma de sortie et crée une version `created_by = recompile`.
// Dossier d'enquête (tâche 2.14, 19c § 3) : lu APRÈS les refus passés, filtré sur le propriétaire ; digest du code, sonde GET
// par le pipeline d'accès (5 indices, 25 % du budget, coupe-circuit, jamais avec session ni en tunnel), réponses confirmées
// versées à la reconnaissance (réduite à ce qui manque), section <untrusted_agent_brief> du prompt, sources confirmées en
// tête du plan DANS l'ensemble autorisé (rattrapage du moins cher), `source.brief` et faits du code sur la version retenue.
// Plafonds : `investigation_budget_usd` (coût imputé de tout le run d'enquête, cumulé sur ses runs ; chaque exécution
// d'un couple sous le plus petit de `max_cost_usd` et du budget restant) et `investigation_timeout_s` (échéance de chaque
// phase : étape 0, reconnaissance, appel LLM, essais), nombre d'essais. Rien ne s'élargit : réseaux de la politique de
// l'API et proxys de l'admin seulement, jamais de tunnel ni de proxy après un refus (X3, X4), jamais de valeur du site
// dans un prompt.
import {
  buildCatalogDossier,
  E4_SAMPLE_INPUT_CHARS,
  DslError,
  validateAgentFetchSpec,
  computeSignature,
  minimalContentCheck,
  priorRefusalDecision,
  profileItems,
  registrableDomain,
  renderCatalogMemory,
  type CatalogDossier,
  type CostCaps,
  type DeclarativeSpec,
  type FailureClass,
  type InvestigationFailureCause,
  type InvestigationPhase,
  type RunContext as RunCtx,
  type RunExecutor,
  type RunResult,
  type StatusEventInput,
} from '@runtime/core';
import {
  accessFactsForPrompt,
  accessReportEventPayload,
  buildAccessReport,
  InstanceContactError,
  requireInstanceContact,
  sessionAccessProbe,
  type AccessProbe,
  type AccessReport,
} from '@runtime/core/access';
import { classifyExchange, classifyTransportError, domainRequestPacer, failureRoute, isGeoRestrictionDetail, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import {
  analyzeCapture,
  buildFromProposal,
  buildImportedPlan,
  estimateCostUsd,
  orderTrials,
  buildTrialPlan,
  compileEstimateUsd,
  detectAmbiguity,
  detectCostGate,
  discoverScriptEndpoints,
  INVESTIGATION_DEFAULTS,
  INVESTIGATION_EVENTS as EV,
  isActionUrl,
  milestoneLogEntry,
  narrativeUrl,
  PROPOSAL_HARD_MAX_PAGES,
  rematchCandidates,
  retainedStrategy,
  runTrials,
  siteScope,
  storedCandidate,
  withinSiteScope,
  type BuiltStrategy,
  type CapturedExchange,
  type DataCandidate,
  type GateReason,
  type InvestigationGate,
  type InvestigationMilestone,
  type PairOutcome,
  type PlanEntry,
  type PlanNetwork,
  type ReconCapture,
  type StepsCompileContext,
  type TokenPrice,
  type TrialExecution,
  type TrialPair,
  type TrialPurpose,
  type TrialsOutcome,
  detectHtmlPagination,
  htmlCompileSupport,
  paginateHtmlSpec,
  capturedBody,
  fidelityCheck,
  fidelityDiff,
  fixFieldMapping,
  fidelitySamples,
  missingRequiredFields,
  relaxRequired,
  relaxSpecRequired,
  type FidelityIssue,
  hardMaxPagesFor,
  sourceViews,
} from '@runtime/core/investigation';
import {
  buildNetworkRungs,
  checkSiteDomain,
  createStaticAssetAllowance,
  loadProxyCredentials,
  openBrowserEgress,
  openNetworkSession,
  parseNetworkPolicy,
  parseProxyDefinitions,
  policyAllowsTunnel,
  type NetworkRung,
  type NetworkSession,
  type ProxyCredentials,
  type Resolver,
  type SecretReader,
  type SsrfGuard,
} from '@runtime/core/net';
import {
  applyRulePlan,
  buildInputSchema,
  compiledWithRules,
  DEFAULT_POLICY_NAME,
  DEFAULT_POLICY_SHA256,
  embeddedRulesOf,
  jsonSha256,
  renderRulesPrompt,
  SkillReader,
  sourceRuleRows,
  type DomainPacer,
  type ResolvedRules,
  type SkillRead,
  type StrategyRuleRow,
} from '@runtime/core';
import {
  briefLogPayload,
  briefPreferredSources,
  buildBriefDigest,
  DEFAULT_BRIEF_CONFIG,
  finalizeBriefHints,
  hintIdentityKey,
  matchBriefHints,
  matchTemplate,
  orderWithBrief,
  renderAgentBrief,
  runBriefProbes,
  sourceBriefOf,
  verifiedForPromotion,
  type BriefConfig,
  type BriefDigest,
  type BriefMatch,
  type BriefProbePorts,
  type HintOutcomeFact,
  type ProbeRun,
} from '@runtime/core';
import {
  compileHtmlStrategy,
  fidelityJudgePromptVersion,
  judgeFidelity,
  htmlCompilePromptVersion,
  investigateCallCeilingUsd,
  investigateMessages,
  investigatePromptVersion,
  proposeInvestigation,
  readSkillsPhase,
  renderSkillBodies,
  type HtmlCompileOutcome,
} from '@runtime/agent';
import {
  appendInvestigationEvent,
  buildStrategySource,
  claimHintVerifiedEvent,
  readBriefForApi,
  saveHintOutcomes,
  type StoredBrief,
  inputHash,
  loadInvestigation,
  loadRunTarget,
  readBaselineItem,
  readCatalogMemory,
  readProxySettings,
  recordAccessReport,
  recordMemoryRefs,
  resolveRulesForApi,
  saveInvestigationState,
  saveInvestigationStrategy,
  saveRunDataset,
  saveRunJudge,
  saveRunProfile,
  saveStrategySignature,
  schemaColumns,
  type CatalogMemory,
  type InvestigationState,
  type RunTarget,
} from '@runtime/db';
import { LlmError, roleTarget, toFailureClass, type LlmClient, type LlmConfig } from '@runtime/llm';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import { ChromiumLaunchError } from '../browser/agent-browser.js';
import type { BrowserPool } from '../browser/pool.js';
import type { TunnelPort } from '../tunnel/client.js';
import { runReconnaissancePass } from './browser-executors.js';
import { flaggedFields, judgeItems, settingsQualityPorts, type QualityPorts } from './quality-job.js';
import { robotIdentity } from './robot-identity.js';
import type { StrategyRuntime, StrategyTrial } from './strategy-executor.js';
import { pageFetchTransport, TunnelSession } from './tunnel-executor.js';
import { hostWithinDomain } from '@runtime/core/tunnel';

/** Couche LLM de l'enquête : configuration relue à chaque run (rôles `investigate`, `extract`, `agent`), client par run. */
type InvestigationLlmPorts = {
  readonly config: () => Promise<LlmConfig | null>;
  readonly client: (config: LlmConfig) => LlmClient;
};

export type InvestigationExecutorDeps = {
  readonly pool: pg.Pool;
  readonly guard: SsrfGuard;
  readonly pacer?: DomainPacer;
  /** Pool Chromium ; `null` : `DISABLE_BROWSER` (reconnaissance statique, ni E2 ni E3 ni E6). */
  readonly browsers: BrowserPool | null;
  readonly secrets?: SecretReader;
  readonly proxyResolver?: Resolver;
  /** Exécuteur de stratégie : chaque exécution d'un couple candidat passe par lui (mêmes gardes qu'un run). */
  readonly strategy: StrategyRuntime;
  /** Client du tunnel (2.7) : étape 0 et reconnaissance d'une enquête à session ou en tunnel seul ; absent : `tunnel_offline`. */
  readonly tunnel?: TunnelPort;
  readonly llm?: InvestigationLlmPorts;
  /** Exécuteurs agentiques E4-E6 branchés dans l'exécuteur de stratégie : leurs couples entrent alors dans le plan. */
  readonly agentic?: boolean;
  readonly instanceContact?: () => Promise<string | null>;
  /** Réglage `identify_instance` (désactivé par défaut) : jeton d'instance et `From`, comme les runs (D-33, 17 §5). */
  readonly identifyInstance?: () => Promise<boolean>;
  readonly version?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Exécutions conformes exigées par couple (défaut `INVESTIGATION_SAMPLES` = 3). */
  readonly samples?: number;
  /**
   * `CONFIRM_ABOVE_USD` (CDC UX, 09 § 9) : au-delà de cette dépense estimée des essais (essai retenu et compilation), la
   * validation automatique s'arrête sur la porte du schéma et la personne confirme avant tout appel facturé. Absent : aucune
   * porte de coût (les tests du moteur ne la subissent pas) ; le worker de production la fixe (`confirmAboveUsd` de la config).
   */
  readonly confirmAboveUsd?: number;
  /**
   * Mémoire du catalogue (tâche 2.12, 19 §2) : lue au départ de chaque run d'enquête (mémoire négative AVANT tout appel
   * LLM et toute requête, puis dossier du prompt). Défaut : `readCatalogMemory` (RLS et filtre `owner_id`).
   */
  readonly memory?: { readonly read: (args: { ownerId: string; apiId: string | null; domain: string }) => Promise<CatalogMemory> };
  /** Juge consultatif (défaut : réglages `settings.llm`). */
  readonly quality?: QualityPorts;
  /**
   * Rôle `judge` résolu À PART de la configuration de l'enquête (revue 2.12) : une erreur de ses réglages (fournisseur
   * inconnu, clé illisible) est ignorée et l'enquête se fait sans avis. Absent : rôle `judge` de la configuration `llm`.
   */
  readonly judgeLlm?: InvestigationLlmPorts;
  /**
   * Dossier d'enquête (tâche 2.14, 19c § 3) : lu APRÈS les refus passés, filtré sur le propriétaire de l'API (même par le
   * rôle de service). Défaut : `readBriefForApi` (dernière version, ou celle de la source de la version courante).
   */
  readonly briefs?: { readonly read: (args: { apiId: string; ownerId: string; preferVersion: number | null }) => Promise<{ brief: StoredBrief; outcomes: Map<string, HintOutcomeFact> } | null> };
  /** Bornes `BRIEF_*` (défaut : 19c § 9.2). */
  readonly briefConfig?: BriefConfig;
  /** Plafonds d'instance (PA-02) : `MAX_COST_USD_PER_RUN` borne le coût d'un essai, `USER_BUDGET_DAILY_USD` le budget de l'enquête. */
  readonly costCaps?: CostCaps;
};

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const BLOCKING = new Set<FailureClass>(['blocked_by_protection', 'forbidden']);
const ACTION = new Set<FailureClass>(['auth_required', 'payment_required', 'account_limit']);
/** Corps d'une page lue par la reconnaissance statique. */
const STATIC_MAX_BYTES = 5_000_000;
const STATIC_MAX_ENDPOINTS = 3;

/** Prix d'un rôle en USD par million de jetons ; `undefined` : rôle non configuré, `null` : prix inconnu. */
function rolePrice(config: LlmConfig | null, role: 'extract' | 'agent' | 'investigate'): TokenPrice | null | undefined {
  if (config === null) return undefined;
  const target = roleTarget(config, role);
  if (target === undefined) return undefined;
  const price = 'price' in target.model ? target.model.price : undefined;
  return price === undefined ? null : { in: price.in, out: price.out };
}

/**
 * Premier modèle SANS prix du rôle : le titulaire, puis son repli (LlmClient#resolve l'appelle quand le titulaire échoue :
 * un repli sans prix rendrait le coût d'un appel réel inconnu). `null` : tous ont un prix, ou le rôle n'est pas configuré.
 */
function unpricedModel(config: LlmConfig | null, role: 'extract' | 'agent' | 'investigate'): string | null {
  const configured = config?.roles[role];
  if (config === null || configured === undefined) return null;
  for (const target of [configured, ...(configured.fallback === undefined ? [] : [configured.fallback])]) {
    const model = config.providers.find((p) => p.id === target.provider)?.models.find((m) => m.id === target.model);
    if (model === undefined || model.price === undefined) return target.model;
  }
  return null;
}

/** Plafond dur de pages d'une spécification (`pagination.limits.hard_max_pages`), sinon celui d'une stratégie proposée. */
function hardMaxPagesOf(spec: unknown): number {
  const hard = (spec as { pagination?: { limits?: { hard_max_pages?: unknown } } } | null)?.pagination?.limits?.hard_max_pages;
  return typeof hard === 'number' && Number.isInteger(hard) && hard >= 1 ? hard : PROPOSAL_HARD_MAX_PAGES;
}

/**
 * Entrée d'une exécution d'essai : les N exécutions d'échantillon lisent au plus 2 pages (la page 2 est exigée, 04 §4) ;
 * l'exécution de vérification de la règle d'arrêt va jusqu'au plafond dur de pages de la spécification (tâche 2.2 ; 200
 * pour une liste HTML, dont la dernière page est souvent au-delà de 50), borné à `STOP_CHECK_MAX_PAGES` (R13 : 259 pages au
 * rythme du domaine dépassent l'échéance de l'enquête ; au-delà, la règle d'arrêt est dite « non vérifiée », 04 §4).
 */
const STOP_CHECK_MAX_PAGES = 60;
const trialInput = (paginated: boolean, purpose: TrialPurpose, hardMaxPages: number = PROPOSAL_HARD_MAX_PAGES): Record<string, unknown> =>
  paginated ? { max_pages: purpose === 'stop_check' ? Math.min(hardMaxPages, STOP_CHECK_MAX_PAGES) : 2 } : {};

/** Fins de liste naturelles d'une exécution (règle d'arrêt atteinte, pas un plafond). */
const NATURAL_STOPS = new Set(['records_empty', 'path_equals', 'path_missing', 'no_next', 'repeated_cursor', 'no_pagination']);
/**
 * Complétude contre le compteur affiché (R13 : « 6197 annonces », 24 livrées, statut « sain ») : une liste lue jusqu'à sa
 * fin naturelle qui sert moins de 80 % du compteur (et au moins 10 de moins) n'est pas conforme ; SYM essaie le niveau
 * suivant (navigateur, cookies du site). Les cartes servies comptent les doublons écartés d'une liste HTML (R02 : le compteur
 * « 359 annonces » compte les lots, 350 cartes servies pour 268 fiches distinctes : conforme, écart dit au journal du run).
 */
const COMPLETENESS_MIN_SHARE = 0.8;
export function incompleteVsCounter(counter: number | undefined, runs: readonly { readonly records: number; readonly stop: string | null }[]): { counter: number; delivered: number } | null {
  if (counter === undefined) return null;
  const natural = runs.filter((r) => r.stop !== null && NATURAL_STOPS.has(r.stop));
  if (natural.length === 0) return null;
  const delivered = Math.max(...natural.map((r) => r.records));
  return delivered < counter * COMPLETENESS_MIN_SHARE && counter - delivered >= 10 ? { counter, delivered } : null;
}

/** Récit de la vérification de la règle d'arrêt (codes et nombres, aucune valeur du site). */
const stopCheckView = (o: PairOutcome) => (o.stop_check === null ? undefined : { verified: o.stop_check.verified, stop: o.stop_check.stop, pages: o.stop_check.pages, ...(o.stop_check.reason === undefined ? {} : { reason: o.stop_check.reason }) });

/** Transport de l'étape 0 et de la reconnaissance : réseau serveur (N1-N3) ou tunnel de l'extension (session requise). */
type AccessPorts = {
  readonly mode: 'server' | 'tunnel';
  readonly probe: AccessProbe;
  /** Sonde de la reconnaissance sans navigateur (corps bornés plus largement). */
  readonly reconProbe: AccessProbe;
  readonly pacer: RequestPacer | undefined;
  /** Coût proxy de l'étape 0 et des sondes (0 en tunnel). */
  readonly proxyUsd: () => number;
  readonly tunnel: TunnelSession | null;
  /** Session réseau serveur et ce qu'il faut pour ouvrir le proxy d'egress de la passe Chromium. */
  readonly server: { readonly sessionBase: SessionBase; readonly ceiling: number } | null;
  close(): Promise<void>;
};

type SessionBase = Omit<Parameters<typeof openNetworkSession>[0], 'allowedHosts' | 'allowedHostSuffixes' | 'costCeiling'>;

/**
 * Cause lisible d'une exception inattendue de l'enquête : la classe de l'erreur et son code, jamais son message (il peut
 * porter une valeur du site ou un secret).
 */
function internalErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'internal_error';
  const name = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name) ? error.name : 'Error';
  const code = error instanceof DslError ? error.code : (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z0-9_]{1,40}$/i.test(code) ? `internal_error:${name}:${code}` : `internal_error:${name}`;
}

/** Champs du journal d'un essai en erreur : classe, code borné, et pour un lancement Chromium raté son code fermé et la fin du stderr. */
function trialErrorLog(runId: string, execution: string, error: unknown): Record<string, unknown> {
  if (error instanceof ChromiumLaunchError) return { runId, execution, err: error.name, detail: error.message, stderr: error.stderr };
  return { runId, execution, err: internalErrorDetail(error) };
}

/**
 * Fin d'échec d'une enquête sortie hors des fins prévues (exception inattendue, état d'enquête absent : UX-24). Même issue
 * que `finishFailed` pour `code_error` : phase close, `investigation_failed` (`erreur`, ou le statut d'avant une
 * ré-enquête), récit fermé avec la cause. Chaque étape est au mieux : une base indisponible ne masque pas la cause du run.
 */
async function closeInvestigation(deps: InvestigationExecutorDeps, ctx: RunCtx, logger: Logger, detail: string): Promise<RunResult> {
  const ids = { apiId: ctx.apiId, ownerId: ctx.ownerId };
  let at: string = 'setup';
  await ctx.log('error', 'investigation_internal_error', { detail }).catch(() => undefined);
  try {
    const inv = await loadInvestigation(deps.pool, ids);
    if (inv !== null && inv.state !== null) {
      at = inv.phase ?? 'setup';
      if (inv.phase !== 'done') await saveInvestigationState(deps.pool, { ...ids, state: inv.state, phase: 'done' });
    }
  } catch (error) {
    logger.warn({ runId: ctx.runId, err: internalErrorDetail(error) }, 'enquête : phase non close');
  }
  try {
    const step = (await ctx.applyStatus?.({ type: 'investigation_failed', cause: 'error' })) ?? null;
    if (step?.ok === true) await appendInvestigationEvent(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, kind: EV.statusChanged, payload: { run_id: ctx.runId, status: step.status, status_reason: step.reason } });
  } catch (error) {
    logger.warn({ runId: ctx.runId, err: internalErrorDetail(error) }, 'enquête : statut non appliqué');
  }
  try {
    await appendInvestigationEvent(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, kind: EV.finished, payload: { run_id: ctx.runId, outcome: 'failed', failure_class: 'code_error', detail, at } });
  } catch (error) {
    logger.warn({ runId: ctx.runId, err: internalErrorDetail(error) }, 'enquête : récit non fermé');
  }
  return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: detail };
}

/** Détail d'une fin d'enquête → cause exacte de `investigation_failed` (constats UX-29, UX-32) ; tout autre détail : `error`. */
const FAILURE_CAUSE_BY_DETAIL: Readonly<Record<string, InvestigationFailureCause>> = {
  not_compilable: 'not_compilable',
  trial_cost_over_cap: 'trial_cost_over_cap',
  no_conformant_strategy: 'no_conformant_strategy',
  // Plafond du nombre d'essais, ou aucune source exploitable : essais (ou reconnaissance) finis sans stratégie conforme.
  max_attempts: 'no_conformant_strategy',
  no_data_source: 'no_conformant_strategy',
  client_signature: 'no_conformant_strategy',
  investigation_budget_usd: 'budget_exhausted',
  investigation_timeout_s: 'timeout',
};

/**
 * Événement de statut d'une fin d'enquête en échec (04 §6) : refus et défis (4), connexion, paiement, limite de compte (3)
 * par `run_failed` ; sinon `investigation_failed` (2, ou 21 pour une ré-enquête) avec la cause EXACTE du détail : budget
 * d'enquête, durée, essai au-dessus du plafond par run, aucune stratégie conforme, trace non compilable (2.13, 19 §4), ou
 * erreur de mise en route. Jamais « budget épuisé » par défaut (UX-05, UX-12, UX-29, UX-32).
 */
export function investigationFailureEvent(failure: ExecFailure): StatusEventInput {
  const cls = failure.failure_class;
  if (BLOCKING.has(cls) || ACTION.has(cls)) return { type: 'run_failed', failureClass: cls, ...(failure.status === undefined ? {} : { httpStatus: failure.status }) };
  return { type: 'investigation_failed', cause: FAILURE_CAUSE_BY_DETAIL[failure.detail] ?? 'error' };
}

/**
 * Exécuteur d'enquête. Une enquête finit TOUJOURS dans un état terminal avec une cause (INV3, UX-24) : toute exception qui
 * échappe aux fins prévues passe par `closeInvestigation`. Seul un run interrompu (bail perdu, arrêt, échéance du job)
 * laisse l'exception au worker, qui le remet en file ou le clôt.
 */
export function createInvestigationExecutor(deps: InvestigationExecutorDeps): RunExecutor {
  const logger = deps.logger ?? pino({ enabled: false });
  const investigate = investigationRun(deps);
  return async (ctx: RunCtx): Promise<RunResult> => {
    try {
      return await investigate(ctx);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const detail = internalErrorDetail(error);
      logger.error({ runId: ctx.runId, err: detail }, 'enquête : erreur interne');
      return closeInvestigation(deps, ctx, logger, detail);
    }
  };
}

function investigationRun(deps: InvestigationExecutorDeps): RunExecutor {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? pino({ enabled: false });
  const quality = deps.quality ?? settingsQualityPorts(deps.pool);

  return async (ctx: RunCtx): Promise<RunResult> => {
    const started = now();
    const inv = await loadInvestigation(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId });
    const target = await loadRunTarget(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: null, ...(deps.costCaps === undefined ? {} : { caps: deps.costCaps }) });
    // Sorties précoces : même fin d'échec que les autres (statut quitté, récit fermé avec la cause), jamais un run muet.
    if (inv === null || target === null) return closeInvestigation(deps, ctx, logger, 'api_not_found');
    if (inv.state === null) return closeInvestigation(deps, ctx, logger, 'investigation_not_started');
    let state: InvestigationState = inv.state;
    let phase: InvestigationPhase | null = inv.phase;
    const request = state.request;
    // `investigation_budget_usd` ; une tentative du mode « SYM ne lâche pas » (2.16) le borne encore au reste de son
    // plafond et du budget du jour (`budget_cap_usd`) : le plafond annoncé est strict.
    const budgetUsd = Math.min(request.budget_usd, state.budget_cap_usd ?? Number.POSITIVE_INFINITY, deps.costCaps?.userBudgetDailyUsd ?? Number.POSITIVE_INFINITY);
    // Plafond par run de l'API pour chaque essai : `costCapUsd` s'il est fixé ; sinon aucun (D-123), le budget d'enquête restant
    // (fini, réservé dans le budget du jour à l'admission) est la seule borne. Jamais `target.api.maxCostUsd` : pour une
    // enquête, ce reste du budget du jour compte déjà sa propre réservation.
    const runCapUsd = target.api.costCapUsd ?? Number.POSITIVE_INFINITY;
    // Page de la demande ; l'étape 0 peut adopter l'URL finale d'une redirection permanente vers un autre site (R09).
    let pageUrl = new URL(request.url).href;
    let host = new URL(pageUrl).hostname.toLowerCase();
    // Domaines de l'API (04b §2) : la page et ses sous-domaines (ou ceux du domaine sans `www.`), jamais un voisin.
    let scope = siteScope(host);
    /** URL de la demande quand l'étape 0 a adopté sa redirection permanente (dit dans le récit). */
    let redirectedFrom: string | null = null;
    const baseElapsed = state.elapsed_ms;
    const deadlineMs = started + Math.max(0, request.timeout_s * 1000 - baseElapsed);
    // `investigation_timeout_s` borne CHAQUE phase (étape 0, reconnaissance, appel LLM, essais), pas seulement les essais.
    const deadline = AbortSignal.timeout(Math.max(1, deadlineMs - now()));
    const signal = AbortSignal.any([ctx.signal, deadline]);
    const timedOut = () => !ctx.signal.aborted && (deadline.aborted || now() >= deadlineMs);
    let spent = state.spent_usd;
    const budgetView = () => ({ spent_usd: spent, max_usd: budgetUsd, elapsed_s: Math.round((baseElapsed + now() - started) / 1000), timeout_s: request.timeout_s });
    // Garde « codes seulement » en mode scrub (21b § 1) : une prose de tiers (détail d'erreur d'un script, texte de site) qui
    // recoupe le catalogue est remplacée par un code et le refus est journalisé (noms de chemins) ; l'enquête ne s'arrête pas.
    const codesOnlyRefused = async (kind: string, paths: readonly string[]): Promise<void> => {
      if (paths.length > 0) await ctx.log('warn', 'codes_only_refused', { table: 'investigation_events', kind, paths });
    };
    const event = async (kind: string, payload: Record<string, unknown> = {}) => {
      const written = await appendInvestigationEvent(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, kind, payload: { run_id: ctx.runId, ...payload } }, { onRenderedSentence: 'scrub' });
      await codesOnlyRefused(kind, written.scrubbed ?? []);
      return written;
    };
    /** Jalon atteint, écrit dans les journaux du run avec la clé et l'intitulé du noyau (`assert_milestones_same_labels`). */
    const milestone = (key: InvestigationMilestone) => ctx.log('info', 'milestone', milestoneLogEntry(key));
    // `compile_est_usd` : coût estimé de la compilation de l'essai agentique en stratégie déclarative (UX-38), annoncé avec le plan.
    const planView = (entries: readonly PlanEntry[]) =>
      entries.map((p) => ({ execution: p.execution, network: p.network, source: p.source, est_cost_usd: p.est_cost_usd, ...(compileEstimateUsd(p) > 0 ? { compile_est_usd: compileEstimateUsd(p) } : {}) }));
    /** Décisions de l'enquête (source de la version, 18 §4.6) : événements qui les portent, `run:seq`. */
    const decisions: string[] = [];
    const decide = async (kind: string, payload: Record<string, unknown> = {}) => {
      const { seq } = await event(kind, payload);
      decisions.push(`${ctx.runId}:${seq}`);
    };
    const save = async (next: InvestigationPhase | null, patch: Partial<InvestigationState> = {}) => {
      state = { ...state, ...patch, spent_usd: spent, elapsed_ms: baseElapsed + Math.max(0, now() - started) };
      phase = next;
      await saveInvestigationState(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, state, phase });
    };
    const applyStatus = async (statusEvent: StatusEventInput) => {
      const step = (await ctx.applyStatus?.(statusEvent)) ?? null;
      if (step?.ok === true) await event(EV.statusChanged, { status: step.status, status_reason: step.reason });
      return step;
    };
    /**
     * Fin d'enquête en échec : statut visé par la classe (04 §6), TOUJOURS phase close et récit fermé. Refus et défis →
     * `bloquee` (4), connexion, paiement, limite de compte → `action_requise` (3) ;
     * toute autre classe (essais épuisés sans conforme quelle que soit la classe du dernier, 429, 5xx persistants, LLM
     * sans repli, configuration) → `investigation_failed` : `erreur` (2), ou le statut d'avant une ré-enquête (21). Aucun
     * worker ne relance une enquête : la laisser ouverte la figerait en `enquete` sans run actif (INV3). La relance est
     * une ré-enquête (16-20), hors de 2.1.
     */
    const finishFailed = async (failure: ExecFailure, at: string): Promise<RunResult> => {
      const cls = failure.failure_class;
      const statusEvent = investigationFailureEvent(failure);
      await save('done');
      if (ACTION.has(cls)) await event(EV.actionRequired, { cause: cls, domain: host });
      await applyStatus(statusEvent);
      await event(EV.finished, { outcome: 'failed', failure_class: cls, detail: failure.detail, at, budget: budgetView() });
      return { state: 'failed', failure_class: cls, retryable: failure.retryable, error_detail: failure.detail };
    };
    /**
     * Arrêt sans classe d'échec (04 §6, transition 3) : proxy requis non configuré, extension hors ligne. Phase close, récit
     * fermé ; le worker applique `run_stopped` (→ `action_requise`).
     */
    const finishStopped = async (reason: 'proxy_not_configured' | 'tunnel_offline' | 'instance_contact_missing' | 'llm_price_missing', detail: string, at: string, model?: string): Promise<RunResult> => {
      await save('done');
      await event(EV.actionRequired, { cause: reason, domain: host, ...(model === undefined ? {} : { model }) });
      await event(EV.finished, { outcome: 'stopped', stop_reason: reason, detail, at, budget: budgetView() });
      return { state: 'failed', failure_class: null, stop_reason: reason, retryable: false, error_detail: detail };
    };
    /** Budget, durée ou nombre d'essais épuisés sans stratégie conforme : `erreur` (2) ou statut précédent (21), cause exacte. */
    const budgetExhausted = async (reason: string): Promise<RunResult> => {
      await save('done');
      await applyStatus({ type: 'investigation_failed', cause: FAILURE_CAUSE_BY_DETAIL[reason] ?? 'budget_exhausted' });
      await event(EV.finished, { outcome: 'budget_exhausted', reason, budget: budgetView() });
      return { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: reason };
    };

    /**
     * Juge consultatif à l'enquête (19 §3) : avis posé sur la fiche du run, coût imputé au run sous le budget restant de
     * l'enquête ; il ne change rien d'autre (le statut suit son cours), et une erreur du juge n'arrête jamais l'enquête.
     */
    const judgeInvestigation = async (records: readonly unknown[], schema: unknown, profile: ReturnType<typeof profileItems>, config: LlmConfig | null, hash: string): Promise<void> => {
      if (!(await quality.judgeEnabled().catch(() => false))) return;
      const judge = deps.judgeLlm ?? deps.llm;
      if (judge === undefined) return;
      try {
        const judgeConfig = deps.judgeLlm === undefined ? config : await deps.judgeLlm.config().catch(() => null);
        if (judgeConfig === null) return;
        const baselineItem = await readBaselineItem(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, inputHash: hash }).catch(() => null);
        const out = await judgeItems({ config: judgeConfig, client: judge.client, trigger: 'investigation', schema, profile, items: records, baselineItem, maxUsd: Math.max(0, budgetUsd - spent), signal });
        if (out === null) return;
        await charge(ctx, 0, out.costUsd, { ...out.tokens, estimated: false });
        if (out.costUsd !== null) spent = round6(spent + out.costUsd);
        await saveRunJudge(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, judge: out.judge, costUsd: 0 });
        if (out.judge.flag) await ctx.log('info', 'judge_flag', { trigger: 'investigation', fields: flaggedFields(out.judge), seed: out.seed });
      } catch {
        await ctx.log('warn', 'judge_failed', { trigger: 'investigation' });
      }
    };

    // --- mémoire du catalogue : un refus est un arrêt (2.12, 19 §2, r1 R14) -----------------------------------------
    // Lue AVANT tout appel LLM et toute requête sortante : un domaine qui a déjà refusé l'accès arrête l'enquête (0 requête).
    let domain: string;
    try {
      domain = registrableDomain(host);
    } catch {
      domain = host;
    }
    const memory: CatalogMemory = await (deps.memory?.read ?? ((a) => readCatalogMemory(deps.pool, a)))({ ownerId: ctx.ownerId, apiId: ctx.apiId, domain });
    const refusal = priorRefusalDecision(memory.refusals, domain, memory.statusReason);
    if (refusal.action === 'stop') {
      await save('done');
      await ctx.log('warn', 'prior_refusal', { domain, at: refusal.refusal.at, reason: refusal.reason });
      await event(EV.finished, { outcome: 'failed', failure_class: 'forbidden', detail: 'prior_refusal', at: 'memory', budget: budgetView() });
      // `forbidden` ou `bloquee` : arrêt préventif (transition 4, `prior_refusal`).
      await applyStatus({ type: 'prior_refusal' });
      return { state: 'failed', failure_class: 'forbidden', retryable: false, error_detail: 'prior_refusal' };
    }
    // Ré-enquête manuelle (18) d'un domaine refusé : un seul essai de confirmation au couple le moins cher, sans changement
    // de réseau (premier réseau de la politique, jamais le tunnel ni un proxy de plus).
    const confirmOnce = refusal.action === 'confirm_once';
    if (confirmOnce) await ctx.log('info', 'prior_refusal_confirmation', { domain, at: refusal.refusal.at });
    // --- dossier d'enquête (2.14, 19c § 3) : lu APRÈS les refus passés (un domaine refusé s'arrête plus haut sans le lire) ;
    // jamais pour un import (stratégie du fichier) ni pour la confirmation unique d'un refus. Filtré sur le propriétaire.
    const briefConfig = deps.briefConfig ?? DEFAULT_BRIEF_CONFIG;
    const briefRead =
      confirmOnce || state.imported !== undefined
        ? null
        : await (deps.briefs?.read ?? ((a) => readBriefForApi(deps.pool, a)))({ apiId: ctx.apiId, ownerId: ctx.ownerId, preferVersion: state.brief?.version ?? null }).catch(() => null);
    let briefDigest: BriefDigest | null = null;
    let briefProbes: ProbeRun | null = null;
    let briefMatch: BriefMatch = { confirmed: new Map() };
    let briefPreferred = new Set<string>();
    /** Run des essais : indices non confirmés au premier run, écartés sans nouvelle sonde ; leurs faits du premier run restent. */
    const briefCarried = new Set<string>();
    let dossier: CatalogDossier | null = null;
    /** HTML de la page vue à la reconnaissance de ce passage (signature de la version retenue) ; null sinon. */
    let reconHtml: string | null = null;
    /** Gisements et capture de la reconnaissance de ce passage : contrôle de fidélité (emplacements, fragments du juge). */
    let reconCandidates: readonly DataCandidate[] = [];
    let reconCapture: ReconCapture | null = null;

    // --- réseau autorisé (politique de l'API, proxys de l'admin) et identité du robot ------------------------------
    let rungs: NetworkRung[];
    let tunnelChosen: boolean;
    try {
      rungs = buildNetworkRungs(parseNetworkPolicy(target.api.networkPolicy), parseProxyDefinitions(await readProxySettings(deps.pool)));
      tunnelChosen = policyAllowsTunnel(target.api.networkPolicy);
    } catch {
      return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'network_config' }, 'setup');
    }
    // 04 §4 : reconnaissance « en tunnel si la session est requise » ; aussi quand la politique n'admet que le tunnel.
    const sessionRequired = target.api.requiresSession || target.api.requires.tunnel === true;
    const tunnelMode = sessionRequired || (rungs.length === 0 && tunnelChosen);
    const first = rungs[0];
    // Session requise (04 §3.2, C2) : seul le tunnel porte l'identité de l'utilisateur. Le serveur n'utilise aucun
    // cookie de session en V1 : un essai N1/N2 partirait sans la session (401/403 → arrêt, puis tunnel élagué, X3)
    // ou retiendrait une stratégie serveur sans session pour une API à session. Le plan se limite donc au tunnel.
    const allNetworks: PlanNetwork[] = sessionRequired
      ? [{ mode: 'tunnel', perGbUsd: 0 }]
      : [...rungs.map((r) => ({ mode: r.mode, perGbUsd: r.mode === 'direct' ? 0 : r.proxy.price.perGbUsd })), ...(tunnelChosen ? [{ mode: 'tunnel' as const, perGbUsd: 0 }] : [])];
    const networks = confirmOnce ? allNetworks.slice(0, 1) : allNetworks;
    // Politique sans réseau serveur ni tunnel : un proxy requis manque (transition 3).
    if (!tunnelMode && first === undefined) return await finishStopped('proxy_not_configured', 'proxy_not_configured', 'setup');
    let userAgent: string;
    let from: string | null;
    try {
      // 17 §5 : le contact de l'instance est requis avant toute enquête, que l'identification soit activée ou non.
      const contact = requireInstanceContact((await deps.instanceContact?.()) ?? null);
      // Identité des runs (D-33) : User-Agent réel du moteur, jeton d'instance et `From` seulement avec `identify_instance`.
      ({ userAgent, from } = await robotIdentity({
        ...(deps.version === undefined ? {} : { version: deps.version }),
        instanceContact: async () => contact,
        ...(deps.identifyInstance === undefined ? {} : { identifyInstance: deps.identifyInstance }),
        warn: () => undefined,
      })());
    } catch (error) {
      // Contact absent ou illisible : une tâche pour l'opérateur (transition 3, `action_requise`, raison `instance_contact_missing` :
      // aucun contact utilisable), jamais un échec ni un budget épuisé (UX-05). Le détail (`instance_contact_invalid`) dit lequel.
      if (error instanceof InstanceContactError) return await finishStopped('instance_contact_missing', error.code, 'setup');
      throw error;
    }
    const pacer: RequestPacer | undefined =
      deps.pacer === undefined
        ? undefined
        : domainRequestPacer(deps.pacer, {
            ...(target.api.domainPacing.min_delay_ms === undefined ? {} : { minDelayMs: target.api.domainPacing.min_delay_ms }),
            ...(target.api.domainPacing.max_wait_ms === undefined ? {} : { maxWaitMs: target.api.domainPacing.max_wait_ms }),
          });

    let ports: AccessPorts;
    if (tunnelMode) {
      if (deps.tunnel === undefined) return await finishStopped('tunnel_offline', 'tunnel_unavailable', 'setup');
      const declared = target.api.requires.session_domain;
      const verdict = checkSiteDomain(typeof declared === 'string' && declared !== '' ? declared : host);
      if (!verdict.ok) return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' }, 'setup');
      const tunnel = new TunnelSession(
        deps.tunnel,
        { runId: ctx.runId, ownerId: ctx.ownerId, domain: verdict.domain, allowWriteActions: false, execution: 'fetch' },
        signal,
        ctx.waitingTunnel === undefined ? undefined : (waiting) => ctx.waitingTunnel!(waiting),
      );
      ports = {
        mode: 'tunnel',
        // Corps borné comme la reconnaissance : en tunnel, une page plus grosse que la borne serait refusée, pas tronquée.
        probe: tunnelProbe(tunnel, STATIC_MAX_BYTES),
        reconProbe: tunnelProbe(tunnel, STATIC_MAX_BYTES),
        pacer,
        proxyUsd: () => 0,
        tunnel,
        server: null,
        close: async () => undefined,
      };
    } else {
      const rung = first!;
      let credentials: ProxyCredentials | undefined;
      if (rung.mode !== 'direct' && rung.proxy.credentialsSecretId !== undefined) {
        // Identifiants du proxy requis illisibles : proxy requis non configuré (transition 3).
        if (deps.secrets === undefined) return await finishStopped('proxy_not_configured', 'proxy_credentials_unavailable', 'setup');
        try {
          credentials = await loadProxyCredentials(deps.secrets, rung.proxy);
        } catch {
          return await finishStopped('proxy_not_configured', 'proxy_credentials_unavailable', 'setup');
        }
      }
      // Étape 0 et reconnaissance sous le plus petit de `max_cost_usd` (s'il est fixé, D-123) et du budget restant de l'enquête.
      const ceiling = Math.max(0, Math.min(runCapUsd, budgetUsd - spent));
      const sessionBase: SessionBase = {
        rung,
        guard: deps.guard,
        ...(credentials === undefined ? {} : { credentials }),
        ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
        userAgent,
        ...(from === null ? {} : { from }),
      };
      ports = serverAccessPorts({ sessionBase, ceiling }, host, scope, pacer);
    }
    /** Arrêt du tunnel (extension hors ligne, défi, site non connecté) : il prime sur l'échec vu par l'étape. */
    const tunnelOutcome = async (at: string): Promise<RunResult | null> => {
      const t = ports.tunnel;
      if (t === null) return null;
      if (t.stop === 'tunnel_offline') return finishStopped('tunnel_offline', 'tunnel_offline', at);
      if (t.stop === 'challenge_in_tunnel') return finishFailed({ failure_class: 'blocked_by_protection', retryable: false, detail: 'challenge_in_tunnel' }, at);
      if (t.needsUser) return finishFailed({ failure_class: 'auth_required', retryable: false, detail: 'site_not_connected' }, at);
      return null;
    };

    try {
      await event(EV.started, { phase, url: narrativeUrl(pageUrl), domain: host, network: ports.mode === 'tunnel' ? 'tunnel' : first?.mode, budget: budgetView() });

      // --- 0. Rapport d'accès -------------------------------------------------------------------------------------
      // En tunnel, la sonde part du Chrome de l'utilisateur : sa langue réelle, non relevée (21 § 6.4, § 6.6).
      let report: AccessReport = await buildAccessReport({ url: pageUrl, probe: ports.probe, requestsFrom: ports.mode === 'tunnel' ? 'user_browser' : 'engine', ...(pacer === undefined ? {} : { pacer }), signal, now });
      const stopped0 = await tunnelOutcome('access_check');
      if (stopped0 !== null) return stopped0;
      // Page qui sort du site par redirection (banc R09 : `lu.ma/paris` répond 301 vers `luma.com/paris`) : si la redirection
      // est PERMANENTE et que la garde SSRF admet l'hôte final, il devient le domaine de l'API (essais, stratégie, cadence),
      // sa mémoire de refus est relue, et l'étape 0 est refaite sur l'URL finale ; le récit le dit (`redirected_from`).
      const server0 = ports.server;
      if (!report.verdict.proceed && report.verdict.failure?.detail === 'domain_not_allowed' && server0 !== null && state.imported === undefined) {
        const moved = await permanentRedirectTarget({ sessionBase: server0.sessionBase, guard: deps.guard, url: pageUrl, ceiling: server0.ceiling, signal, ...(pacer === undefined ? {} : { pacer }) });
        if (moved.proxyUsd > 0) {
          await charge(ctx, moved.proxyUsd);
          spent = round6(spent + moved.proxyUsd);
        }
        if (moved.url !== null) {
          redirectedFrom = pageUrl;
          pageUrl = moved.url;
          host = new URL(pageUrl).hostname.toLowerCase();
          scope = siteScope(host);
          await ctx.log('info', 'start_url_redirect_adopted', { from_host: new URL(redirectedFrom).hostname, to_host: host });
          let movedDomain: string;
          try {
            movedDomain = registrableDomain(host);
          } catch {
            movedDomain = host;
          }
          if (movedDomain !== domain) {
            domain = movedDomain;
            const movedMemory = await (deps.memory?.read ?? ((a) => readCatalogMemory(deps.pool, a)))({ ownerId: ctx.ownerId, apiId: ctx.apiId, domain });
            const movedRefusal = priorRefusalDecision(movedMemory.refusals, domain, movedMemory.statusReason);
            if (movedRefusal.action === 'stop') {
              await save('done');
              await ctx.log('warn', 'prior_refusal', { domain, at: movedRefusal.refusal.at, reason: movedRefusal.reason });
              await event(EV.finished, { outcome: 'failed', failure_class: 'forbidden', detail: 'prior_refusal', at: 'memory', budget: budgetView() });
              await applyStatus({ type: 'prior_refusal' });
              return { state: 'failed', failure_class: 'forbidden', retryable: false, error_detail: 'prior_refusal' };
            }
          }
          // Session de l'étape 0 rouverte sur le domaine adopté (coût de la première imputé avant sa fermeture).
          await charge(ctx, ports.proxyUsd());
          spent = round6(spent + ports.proxyUsd());
          await ports.close();
          ports = serverAccessPorts(server0, host, scope, pacer);
          report = await buildAccessReport({ url: pageUrl, probe: ports.probe, requestsFrom: 'engine', ...(pacer === undefined ? {} : { pacer }), signal, now });
        }
      }
      const accessWritten = await recordAccessReport(
        deps.pool,
        { runId: ctx.runId, ownerId: ctx.ownerId, payload: { ...accessReportEventPayload(report), ...(redirectedFrom === null ? {} : { redirected_from: narrativeUrl(redirectedFrom), url: narrativeUrl(pageUrl), domain: host }) } },
        { onRenderedSentence: 'scrub' },
      );
      await codesOnlyRefused('access_report', accessWritten.scrubbed ?? []);
      if (!report.verdict.proceed) {
        await charge(ctx, ports.proxyUsd());
        spent = round6(spent + ports.proxyUsd());
        return await finishFailed(report.verdict.failure, 'access_check');
      }
      if (timedOut()) return await budgetExhausted('investigation_timeout_s');

      // --- Import (3.12, 16 § 6) : la stratégie du fichier est essayée telle quelle après l'étape 0 ------------------
      // Ni reconnaissance ni appel LLM : le schéma de sortie validé et la spécification viennent du fichier, relus et
      // contrôlés à l'import (INV1). Domaines : ceux de la page de la demande, jamais un voisin (INV10).
      const imported = state.imported;
      if (imported !== undefined) {
        const hosts = (imported.spec['request'] as { allowed_hosts?: unknown } | undefined)?.allowed_hosts;
        if (!Array.isArray(hosts) || !hosts.every((h) => typeof h === 'string' && withinSiteScope(h, scope))) {
          return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'imported_hosts_out_of_scope' }, 'setup');
        }
      }
      // Plan restreint par l'appelant (`exclude_executions`, 06 § 2) : des niveaux retirés, jamais ajoutés.
      const excluded = new Set<string>(state.excluded_executions ?? []);
      /** Plan d'essais chiffré (pur, sans requête) : annoncé AVEC la porte du schéma (20 § 5.3), puis rejoué tel quel au lancement des essais. */
      const planFor = (strategies: readonly BuiltStrategy[]): PlanEntry[] =>
      (
        imported !== undefined
          ? buildImportedPlan({ execution: imported.execution, spec: imported.spec, networks, browser: deps.browsers !== null })
          : buildTrialPlan({
              strategies,
              networks,
              browser: deps.browsers !== null,
              agentic: deps.agentic === true ? { ...(rolePrice(config, 'extract') === undefined ? {} : { extract: rolePrice(config, 'extract')! }), ...(rolePrice(config, 'agent') === undefined ? {} : { agent: rolePrice(config, 'agent')! }) } : {},
              pageUrl,
              pageHost: host,
              instruction: agenticInstruction(request.description, state.validated_by === 'user' ? state.validation?.instructions : undefined),
              documentBytes: state.page?.document_bytes ?? 0,
              totalBytes: state.page?.total_bytes ?? 0,
            })
      ).filter((p) => !excluded.has(p.execution));
      let config: LlmConfig | null = null;
      let builtStrategies: readonly BuiltStrategy[] = [];
      let proposal = state.proposal;
      let rulesUsed = state.rules;
      let outputSchema: Record<string, unknown>;
      if (imported !== undefined && state.validated_schema !== undefined) {
        outputSchema = state.validated_schema;
      } else {
        // --- 1. Reconnaissance (à chaque run : l'état ne garde aucune valeur du site, 17 §6) ------------------------
        // Premier run (ou import sans stratégie : schéma validé par le fichier, aucun gisement relevé) : gisements frais.
        // Run des essais (schéma validé) : mêmes gisements, retrouvés sous leurs identifiants.
        const firstRun = state.validated_schema === undefined || state.candidates === undefined;
        if (firstRun) {
          await save('reconnaissance');
          await milestone('reconnaissance');
          await event(EV.phase, { phase: 'reconnaissance', budget: budgetView() });
        }
        // Dossier d'enquête (19c § 3) : digest du code, puis sonde GET par le pipeline d’accès (portée, garde SSRF,
        // cadence, classifieur, coût imputé au budget d'enquête), jamais en tunnel ni avec session. Un refus pendant une sonde
        // arrête l'enquête par la classe (aucune escalade) ; deux sondes en échec : l'enquête continue sans le dossier.
        let briefExchanges: CapturedExchange[] = [];
        if (briefRead !== null) {
          const sessionOrTunnel = ports.mode === 'tunnel' || sessionRequired;
          briefDigest = buildBriefDigest(briefRead.brief.content, { pageUrl, scope, now: new Date(now()), sessionOrTunnel, outcomes: briefRead.outcomes, subjectExcluded: briefRead.brief.subject_excluded, config: briefConfig });
          await event('brief.read', briefLogPayload({
            sha256: briefRead.brief.sha256,
            bytes: briefRead.brief.size_bytes,
            version: briefRead.brief.version,
            hints: briefDigest.hints.map((h) => ({ id: h.id, kind: h.kind, state: h.decision, reason: h.reason })),
            tried: briefDigest.tried,
            open_questions: briefDigest.open_questions,
          }));
          if (briefDigest.widening.length > 0 || briefDigest.hints.some((h) => h.widening.length > 0)) {
            await ctx.log('warn', 'brief_widening_ignored', { guards: [...new Set([...briefDigest.widening, ...briefDigest.hints.flatMap((h) => h.widening)])] });
          }
          if (ports.mode === 'server') {
            const probePorts = briefProbePorts(ports, scope, pacer, signal, now);
            // Run des essais (après validate_schema) : les indices confirmés au premier run deviennent des gabarits déclarés,
            // relus par le même pipeline ; aucune nouvelle sonde.
            const digestForRun: BriefDigest = firstRun
              ? briefDigest
              : {
                  ...briefDigest,
                  hints: briefDigest.hints.map((h) => {
                    if (h.decision !== 'probe' || (state.brief?.confirmed ?? []).includes(h.id)) return h;
                    briefCarried.add(h.id);
                    const fact = briefRead.outcomes.get(h.identity_key);
                    return { ...h, decision: 'ignored' as const, reason: fact?.state === 'probe_failed' ? ('brief_probe_failed' as const) : ('brief_unverifiable' as const) };
                  }),
                };
            briefDigest = digestForRun;
            briefProbes = await runBriefProbes(digestForRun, probePorts, { budgetUsd: request.budget_usd, config: firstRun ? briefConfig : { ...briefConfig, probeBudgetShare: 1 } });
            await event('brief.probes', {
              requests: briefProbes.requests,
              breaker_open: briefProbes.breakerOpen,
              results: briefProbes.results.map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason, http_class: r.probe?.http_class ?? null, items: r.probe?.items_conform ?? null, cost_usd: r.probe?.cost_usd ?? null })),
            });
            if (firstRun) {
              const failed = finalizeBriefHints(briefDigest, briefProbes, { confirmed: new Map() }, null).filter((h) => h.state === 'probe_failed');
              if (failed.length > 0) await saveHintOutcomes(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: briefRead.brief.version, hints: failed, now: new Date(now()) });
            }
            if (briefProbes.blocking !== null) {
              await charge(ctx, ports.proxyUsd());
              spent = round6(spent + ports.proxyUsd());
              return await finishFailed(briefProbes.blocking, 'brief_probe');
            }
            briefExchanges = briefProbes.results.flatMap((r) => (r.outcome === 'verified' && r.exchange !== null ? [briefCaptured(r.exchange)] : []));
          }
        }
        const recon =
          ports.mode === 'tunnel'
            ? await staticRecon(ports.reconProbe, { url: pageUrl, allowHost: (h) => withinSiteScope(h, scope) && hostWithinDomain(h, ports.tunnel!.domain), signal, mode: 'tunnel', ...(pacer === undefined ? {} : { pacer }) })
            : deps.browsers !== null
              ? await browserRecon(deps, { url: pageUrl, host, scope, signal, userAgent, sessionBase: ports.server!.sessionBase, ceiling: ports.server!.ceiling, otherUsd: ports.proxyUsd, ...(pacer === undefined ? {} : { pacer }) })
              : await staticRecon(ports.reconProbe, { url: pageUrl, allowHost: (h) => withinSiteScope(h, scope), signal, mode: 'static', skipDiscovery: briefExchanges.length > 0, ...(pacer === undefined ? {} : { pacer }) });
        await charge(ctx, ports.proxyUsd() + recon.proxyUsd);
        spent = round6(spent + ports.proxyUsd() + recon.proxyUsd);
        const stopped1 = await tunnelOutcome('reconnaissance');
        if (stopped1 !== null) return stopped1;
        // Réponses des indices confirmés par le code : gabarits déclarés, ajoutés à ce que la reconnaissance a vu (19c § 3).
        const capture: ReconCapture =
          briefExchanges.length === 0 ? recon.capture : { ...recon.capture, exchanges: [...briefExchanges, ...recon.capture.exchanges], totalBytes: recon.capture.totalBytes + briefExchanges.reduce((n, e) => n + e.bytes, 0) };
        reconHtml = capture.document?.renderedHtml ?? capture.document?.html ?? null;
        const fresh = recon.failure === null ? analyzeCapture(capture, apiHostsOf(capture, host, scope)) : [];
        const candidates: readonly DataCandidate[] = firstRun ? fresh : rematchCandidates(state.candidates ?? [], fresh);
        reconCandidates = candidates;
        reconCapture = capture;
        if (briefDigest !== null) {
          briefMatch = matchBriefHints(briefDigest, briefProbes, {
            candidates: candidates.map((c) => ({ id: c.id, from: c.from, method: c.request.method, url: c.request.url, locator: c.locator?.kind ?? null, ...(c.from === 'dom' ? { records: c.records } : {}) })),
            exchanges: capture.exchanges.map((e) => ({ url: e.url, method: e.method })),
            html: capture.document?.renderedHtml ?? capture.document?.html ?? null,
            pageUrl: capture.document?.url ?? pageUrl,
          });
          briefPreferred = briefPreferredSources(briefMatch);
          await event('brief.checked', {
            hints: finalizeBriefHints(briefDigest, briefProbes, briefMatch, null).map((h) => ({ id: h.id, kind: h.kind, state: h.state, reason: h.reason, provenance: h.provenance })),
            preferred: [...briefPreferred],
          });
          if (firstRun && briefRead !== null) {
            await save(phase, { brief: { version: briefRead.brief.version, sha256: briefRead.brief.sha256, confirmed: (briefProbes?.results ?? []).filter((r) => r.outcome === 'verified').map((r) => r.id) } });
          }
        }
        const views = sourceViews(candidates, capture);
        await event(EV.reconnaissance, {
          mode: capture.mode,
          ...(recon.failure === null ? {} : { failure_class: recon.failure.failure_class, detail: recon.failure.detail }),
          // Sources candidates (D-124) : type, compteur, aperçu de 3 éléments (pour le client, jamais pour le LLM), pagination.
          candidates: candidates.map((c, i) => ({
            ...views[i],
            id: c.id,
            from: c.from,
            request: { method: c.request.method, url: narrativeUrl(c.request.url) },
            ...(c.locator === undefined ? {} : { locator: c.locator.kind }),
            records: c.records,
            count: c.count,
            bytes: c.bytes,
            fields: Object.keys(c.skeleton).length,
            ...(c.unsupported === undefined ? {} : { unsupported: c.unsupported }),
          })),
          document_bytes: capture.document?.bytes ?? 0,
          total_bytes: capture.totalBytes,
          ...(capture.assets === undefined || capture.assets.requests === 0 ? {} : { third_party_assets: capture.assets }),
          ...(capture.data === undefined || capture.data.seen === 0 ? {} : { data_responses: capture.data }),
          ...(recon.requests === undefined ? {} : { requests: recon.requests }),
          budget: budgetView(),
        });
        if (recon.failure !== null) return await finishFailed(recon.failure, 'reconnaissance');
        // État : gisements SANS valeur (origine, chemin, noms de paramètres) ; ceux du premier run gardent leurs identifiants.
        await save(firstRun ? 'reconnaissance' : phase, {
          candidates: firstRun ? fresh.map(storedCandidate) : (state.candidates ?? []),
          page: { url: pageUrl, host, document_bytes: capture.document?.bytes ?? 0, total_bytes: capture.totalBytes, mode: capture.mode },
        });
        if (spent >= budgetUsd) return await budgetExhausted('investigation_budget_usd');
        if (timedOut()) return await budgetExhausted('investigation_timeout_s');

        // --- 2. Schéma de sortie d'abord ------------------------------------------------------------------------------
        config = deps.llm === undefined ? null : await deps.llm.config().catch(() => null);
        // Voies agentiques essayables (E4 par le réseau, E6 avec Chromium) : un schéma sans gisement de données leur reste ouvert.
        const agenticOnly = deps.agentic === true && (rolePrice(config, 'extract') !== undefined || (deps.browsers !== null && rolePrice(config, 'agent') !== undefined));
        const fixed = state.validated_schema;
        // Validation par l'appelant (constat Barnes) : schéma corrigé, consignes ou source choisie refont l'affectation des
        // champs (rôle `investigate`, schéma validé) ; la source choisie limite les gisements montrés au modèle et construits.
        const validation = !firstRun && state.validated_by === 'user' ? state.validation : undefined;
        const mapCandidates = validation?.source_id === undefined ? candidates : candidates.filter((c) => c.id === validation.source_id);
        if (validation !== undefined) {
          await decide(EV.schemaValidated, {
            by: 'user',
            corrected: validation.corrected,
            changes: validation.changes,
            not_applied: validation.not_applied,
            instructions: validation.instructions !== undefined,
            ...(validation.source_id === undefined ? {} : { source_id: validation.source_id, source_found: mapCandidates.length > 0 }),
          });
        }
        const remap =
          proposal !== undefined && fixed !== undefined && (JSON.stringify(fixed) !== JSON.stringify(state.proposed_schema) || validation?.instructions !== undefined || validation?.source_id !== undefined);
        if (proposal === undefined || remap) {
          if (deps.llm === undefined || config === null || config.roles.investigate === undefined) {
            return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }, 'setup');
          }
          if (!agenticOnly && mapCandidates.filter((c) => c.unsupported === undefined).length === 0) {
            return await finishFailed({ failure_class: 'extraction', retryable: false, detail: mapCandidates.length > 0 ? 'client_signature' : 'no_data_source' }, 'reconnaissance');
          }
          let client: LlmClient;
          try {
            client = deps.llm.client({ ...config, roles: { investigate: config.roles.investigate } });
          } catch {
            return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }, 'setup');
          }
          const model = config.roles.investigate.model;
          const exampleOutput = (ctx.input as { example_output?: unknown } | null)?.example_output;
          // Dossier de mémoire (19 §2) : calculé par le code, valeurs du même domaine seulement, masqué, sous son plafond.
          const signature = computeSignature({ pageUrl, html: capture.document?.renderedHtml ?? capture.document?.html ?? null, outputSchema: fixed ?? {}, execution: 'fetch', network: first?.mode ?? 'tunnel' });
          dossier = buildCatalogDossier({ ownerId: ctx.ownerId, apiId: ctx.apiId, domain, signature, description: request.description, mode: 'investigate', refusals: memory.refusals, now: new Date(now()) }, memory.entries);
          const catalogMemory = renderCatalogMemory(dossier);
          // Règles et skills applicables (18 §4.3) : propriétaire de l'API et instance seulement ; plafonds journalisés.
          const ruled = await resolveRulesForApi(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, role: 'investigate', host });
          await logRuleBudgets(ctx, ruled.resolved);
          const reader = new SkillReader(ruled.resolved.skills);
          let args: Parameters<typeof investigateMessages>[0] = {
            description: request.description,
            ...(exampleOutput === undefined ? {} : { exampleOutput }),
            candidates: mapCandidates,
            accessFacts: accessFactsForPrompt(report),
            ...(fixed === undefined ? {} : { fixedSchema: fixed }),
            ...(validation?.instructions === undefined ? {} : { ownerCorrections: validation.instructions }),
            ...(ctx.proseLocale === undefined ? {} : { proseLocale: ctx.proseLocale }),
            rules: renderRulesPrompt(ruled.resolved),
            ...(catalogMemory === '' ? {} : { catalogMemory }),
            ...(briefRead === null || briefDigest === null ? {} : (() => {
              const memoryKeys = new Set<string>();
              for (const e of [...(dossier.same_api === null ? [] : [dossier.same_api]), ...dossier.similar]) {
                const endpoint = (e as { endpoint?: unknown }).endpoint;
                if (typeof endpoint !== 'string') continue;
                try {
                  memoryKeys.add(hintIdentityKey('endpoint', `GET ${matchTemplate(new URL(endpoint.replace(/\{(\w+)\}/g, '%7B$1%7D')))}`));
                } catch {
                  // gabarit illisible : aucune ligne commune
                }
              }
              const rendered = renderAgentBrief({ brief: briefRead.brief.content, digest: briefDigest, states: finalizeBriefHints(briefDigest, briefProbes, briefMatch, null), receivedAt: briefRead.brief.created_at, memoryKeys, maxTokens: briefConfig.maxTokens });
              return rendered.text === '' ? {} : { agentBrief: rendered.text };
            })()),
            allowedCouples: previewCouples({ networks, browser: deps.browsers !== null, agentic: deps.agentic === true ? agenticPrices(config) : {}, candidates: mapCandidates, documentBytes: state.page?.document_bytes ?? capture.document?.bytes ?? 0, totalBytes: state.page?.total_bytes ?? capture.totalBytes }),
          };
          // Coût d'un appel borné AVANT l'envoi (sortie plafonnée, entrée estimée par excès) : jamais un appel qui
          // ferait dépasser `investigation_budget_usd` ; prix inconnu → aucun appel (08 §1, jamais 0).
          const price = rolePrice(config, 'investigate');
          // Le repli est appelé quand le titulaire échoue : son prix compte avant l'envoi, et c'est lui que le détail nomme.
          const unpriced = price === null || price === undefined ? model : unpricedModel(config, 'investigate');
          if (price === null || price === undefined || unpriced !== null) {
            await ctx.log('warn', 'llm_price_missing', { model: unpriced ?? model, role: 'investigate' });
            return await finishStopped('llm_price_missing', `llm_price_missing:${unpriced ?? model}`, 'schema', unpriced ?? model);
          }
          let callCeiling = investigateCallCeilingUsd(args, price);
          const beforeCall = () => {
            if (spent + (client.meter.snapshot().cost_usd_known ?? 0) + callCeiling > budgetUsd) throw new BudgetGuardError();
          };
          let llmFailure: ExecFailure | null = null;
          try {
            // Chargement progressif (18 §4.4) : le corps d'un skill n'entre qu'après `read_skill`, exécuté ici.
            const bodies = await readSkillsPhase(client, 'investigate', { messages: investigateMessages(args), reader, signal, beforeCall });
            for (const read of reader.reads) await event('skill.read', { ref: read.ref, name: read.name, version: read.version, sha256: read.sha256 });
            if (bodies.length > 0) {
              args = { ...args, skills: renderSkillBodies(bodies) };
              callCeiling = investigateCallCeilingUsd(args, price);
            }
            const out = await proposeInvestigation(client, { ...args, signal, beforeCall });
            proposal = out.proposal;
            rulesUsed = { rows: sourceRuleRows(ruled.resolved, reader.reads), effective: effectiveRefs(ruled.resolved) };
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            if (timedOut()) llmFailure = { failure_class: 'run_budget_exceeded', retryable: false, detail: 'investigation_timeout_s' };
            else if (error instanceof BudgetGuardError) llmFailure = { failure_class: 'run_budget_exceeded', retryable: false, detail: 'investigation_budget_usd' };
            else if (error instanceof LlmError) llmFailure = { failure_class: toFailureClass(error.class), retryable: false, detail: `llm_${error.class}` };
            else llmFailure = { failure_class: 'extraction', retryable: false, detail: 'proposal_unreadable' };
          }
          // Coût du rôle `investigate` (tentatives échouées comprises), imputé au run : inconnu si le prix manque.
          const usage = client.meter.snapshot();
          await charge(ctx, 0, usage.cost_usd, { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning, estimated: usage.usage_estimated });
          if (usage.cost_usd === null) {
            // Après l'appel : le modèle a été appelé, son coût est inconnu (null). Détail SANS modèle : jamais « aucun appel ».
            await ctx.log('warn', 'llm_price_missing', { role: 'investigate', after_call: true });
            return await finishStopped('llm_price_missing', 'llm_price_missing', 'schema');
          }
          spent = round6(spent + usage.cost_usd);
          if (llmFailure !== null) {
            if (llmFailure.failure_class === 'run_budget_exceeded') return await budgetExhausted(llmFailure.detail);
            return await finishFailed(llmFailure, 'schema');
          }
          await ctx.log('info', 'investigate_call', { model, prompt_version: investigatePromptVersion, llm_usd: usage.cost_usd, calls: usage.calls });
          // Entrées consultées (identifiants et sha256 seulement), gardées dans l'état jusqu'à la version retenue.
          if (dossier.refs.length > 0) {
            await save(phase, { memory: { sha256: dossier.sha256, refs: dossier.refs } });
            await ctx.log('info', 'catalog_memory', { entries: dossier.refs.length, tokens: dossier.tokens, truncated: dossier.truncated, sha256: dossier.sha256 });
          }
        }
        const built = buildFromProposal(proposal!, mapCandidates, fixed === undefined ? capture : null, { ...(fixed === undefined ? {} : { fixedSchema: fixed }), agenticOnly });
        if (!built.ok) {
          await event(EV.schemaProposed, { ok: false, reason: built.reason, rejected: built.rejected, budget: budgetView() });
          return await finishFailed({ failure_class: 'extraction', retryable: false, detail: built.reason }, 'schema');
        }
        const gatePlan = planFor(built.strategies);
        if (fixed === undefined) {
          // Échantillon : données de l'utilisateur, inscrites au registre de masquage du run, puis passées par la liste
          // d'exclusion des personnes effacées AVANT toute écriture (17 §6, assert_erasure_complete) : une personne effacée
          // n'est jamais réécrite dans le récit ni montrée à l'appelant.
          for (const item of built.sample) ctx.personal.addFromItem(built.outputSchema, item);
          const { kept: sample, dropped } = ctx.excludeSubjects(built.outputSchema, built.sample);
          if (dropped > 0) await ctx.log('info', 'subjects_excluded', { dropped, at: 'schema_sample' });
          await event(EV.schemaProposed, {
            ok: true,
            output_schema: built.outputSchema,
            sample,
            sources: built.strategies.map((s) => s.candidate.id),
            rejected: built.rejected,
            llm: { prompt_version: investigatePromptVersion },
            budget: budgetView(),
          });
          if (spent >= budgetUsd) return await budgetExhausted('investigation_budget_usd');
          // Porte (CDC UX, 03 § 4 et § 9) : la validation automatique ne s'arrête que sur une ambiguïté réelle ou un coût annoncé
          // au-delà du seuil ; les raisons sont MESURÉES par le code (`detectAmbiguity`, `detectCostGate`) et gardées avec la phase.
          const exampleForGate = (ctx.input as { example_output?: unknown } | null)?.example_output;
          const gateReasons: GateReason[] = request.auto_validate
            ? [
                ...detectAmbiguity({ proposal: proposal!, candidates, outputSchema: built.outputSchema, ...(exampleForGate === undefined ? {} : { exampleOutput: exampleForGate }) }),
                ...(() => {
                  const cost = detectCostGate(gatePlan, deps.confirmAboveUsd);
                  return cost === null ? [] : [cost];
                })(),
              ]
            : [];
          if (!request.auto_validate || gateReasons.length > 0) {
            const gate: InvestigationGate | null =
              gateReasons.length === 0
                ? null
                : { reasons: gateReasons, estimate_usd: gateReasons.find((r) => r.reason === 'cost_above_cap')?.estimate_usd ?? null, confirm_above_usd: deps.confirmAboveUsd ?? null };
            await ctx.log('info', 'schema_gate', { reasons: gateReasons.map((r) => r.reason) });
            await save('awaiting_schema_validation', { proposal: proposal!, proposed_schema: built.outputSchema, proposed_columns: schemaColumns(built.outputSchema), gate, ...(rulesUsed === undefined ? {} : { rules: rulesUsed }) });
            await milestone('schema');
            // Coût d'un rejeu estimé : celui de la méthode la moins chère du plan (ce que retiendrait un premier essai conforme).
            const cheapest = gatePlan.reduce<number | null>((min, p) => (p.est_cost_usd !== null && (min === null || p.est_cost_usd < min) ? p.est_cost_usd : min), null);
            await event(EV.phase, { phase: 'awaiting_schema_validation', plan: planView(gatePlan), budget: { ...budgetView(), ...(cheapest === null ? {} : { retained_est_usd: cheapest }) } });
            return { state: 'succeeded', outcome: 'clean', degraded_reasons: [], items: 0 };
          }
          await milestone('schema');
          const columns = schemaColumns(built.outputSchema);
          await save('testing', { proposal: proposal!, proposed_schema: built.outputSchema, validated_schema: built.outputSchema, proposed_columns: columns, validated_columns: columns, validated_by: 'auto', ...(rulesUsed === undefined ? {} : { rules: rulesUsed }) });
          await decide(EV.schemaValidated, { by: 'auto' });
          await ctx.log('info', 'schema_auto_validated', {});
        } else if (remap) {
          await save(phase, { proposal: proposal!, ...(rulesUsed === undefined ? {} : { rules: rulesUsed }) });
        }
        builtStrategies = built.strategies;
        outputSchema = built.outputSchema;
      }
      if (spent >= budgetUsd) return await budgetExhausted('investigation_budget_usd');
      if (timedOut()) return await budgetExhausted('investigation_timeout_s');

      // --- 3. Essais du moins cher au plus cher --------------------------------------------------------------------
      await save('testing');
      await milestone('trials');
      // Confirmation d'un refus passé : le couple le moins cher seulement (le plan est déjà trié par coût croissant).
      const fullPlan = planFor(builtStrategies);
      const plan = confirmOnce ? fullPlan.slice(0, 1) : fullPlan;
      // Règles embarquées dans les prompts figés E4-E6 (18 §4.5, RULES_MAX_TOKENS de 1 000) : la spec ne porte que leurs
      // RÉFÉRENCES (`nom@version#sha256`, jamais le texte : INV12, spec lisible des membres d'une API partagée) ; l'essai et
      // le rejeu reconstruisent le texte depuis ces versions épinglées (strategy-executor). E6 reçoit aussi la liste des
      // skills (`read_skill`, 18 §4.4) ; E4, sans outil, seulement les règles.
      const embedded = plan.some((p) => p.execution === 'agent_fetch' || p.execution === 'agent') ? (await resolveRulesForApi(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, role: 'embedded', host })).resolved : null;
      if (embedded !== null) await logRuleBudgets(ctx, embedded);
      const embeddedRows = embedded === null ? [] : sourceRuleRows({ rules: embedded.rules, skills: [], truncated: [] }, [], { embedded: true });
      if (embedded !== null) {
        for (const [i, p] of plan.entries()) {
          if (p.execution !== 'agent_fetch' && p.execution !== 'agent') continue;
          const rules = embeddedRulesOf(embedded, { skills: p.execution === 'agent' });
          if (rules.rules.length > 0 || rules.skills.length > 0) plan[i] = { ...p, spec: { ...p.spec, rules } };
        }
      }
      /** Skills lus par l'agent pendant les essais (`read_skill`), par couple : journalisés, versés dans la source du retenu. */
      const skillReads = new Map<TrialPair, SkillRead[]>();
      // Plan guidé par les règles (18 §4.5) : réordonner ou restreindre DANS l'ensemble autorisé, jamais élargir.
      const guided = applyRulePlan(plan, proposal, new Set(rulesUsed?.effective ?? []));
      for (const ignored of guided.ignored) await ctx.log('warn', 'rule_widening_ignored', { execution: ignored.execution, network: ignored.network, rule_refs: ignored.rule_refs, reason: ignored.reason });
      for (const { pair, rule_refs } of guided.prunedByRule) {
        await decide(EV.attemptPruned, { by: null, reason: 'pruned_by_rule', rule_refs, pruned: [{ execution: pair.execution, network: pair.network, source: pair.source, est_cost_usd: pair.est_cost_usd }] });
      }
      // Dossier d'enquête (19c § 3) : les couples des sources confirmées par le code d'abord, DANS l'ensemble autorisé
      // (permutation du plan) ; le rattrapage du moins cher garde la stratégie retenue (INV2).
      const ordered = orderWithBrief(guided.ordered, briefPreferred);
      await event(EV.phase, {
        phase: 'testing',
        plan: ordered.map((p) => ({ execution: p.execution, network: p.network, source: p.source, est_cost_usd: p.est_cost_usd, ...(compileEstimateUsd(p) > 0 ? { compile_est_usd: compileEstimateUsd(p) } : {}), ...(guided.placed.has(p) ? { rule_refs: guided.placed.get(p) } : {}), ...(briefPreferred.has(p.source) ? { brief: true } : {}) })),
        budget: budgetView(),
      });
      const entries = new Map<TrialPair, PlanEntry>(ordered.map((p) => [p, p]));
      const lastRecords = new Map<TrialPair, Record<string, unknown>[]>();
      /** Sorties des N exécutions d'échantillon de chaque couple (contenu minimal, r4 R5). */
      const sampleOutputs = new Map<TrialPair, Record<string, unknown>[][]>();
      /** Toutes les exécutions conformes d'un couple (échantillon et règle d'arrêt) : éléments lus et raison d'arrêt (complétude, R13). */
      const runsFor = new Map<TrialPair, { records: number; stop: string | null }[]>();
      /** Écart au compteur d'un couple refusé (`incomplete_vs_counter`) : paramètres du motif de l'essai. */
      const incompleteFor = new Map<TrialPair, { counter: number; delivered: number }>();
      /** Trace E6 compilée en E5 par la dernière exécution conforme du couple (04 §3.1). */
      const compiledFor = new Map<TrialPair, unknown>();
      /** Contexte de la compilation au grain de l'étape (2.13) : trace de l'E6 conforme, modèle, date. */
      const compileContextFor = new Map<TrialPair, StepsCompileContext>();
      /** Dernière page servie à un essai E4 réussi et ses éléments : source de la compilation en déclaratif `html`. */
      const pageFor = new Map<TrialPair, { html: string; url: string; items: readonly unknown[] }>();
      /** Motifs de la garde des requêtes de l'agent par couple (codes seulement) : publiés avec `agent_request_blocked` (UX-33). */
      const blockedFor = new Map<TrialPair, readonly string[]>();
      const spend = new Map<TrialPair, { proxy: number; llm: number | null; tokens: { in: number; cached: number; out: number; reasoning: number; estimated: boolean }; model: string | null; prompt: string | null; engine: string | null }>();
      const spentBeforeTrials = spent;
      let trialsUsd = 0;
      /**
       * Compilation de l'essai E4 conforme en stratégie déclarative `html` (constat UX-20, 04b §2, 19 §1 « Rejeu E1-E3 :
       * 0 LLM »), sur le modèle de E6 → E5 : un appel du rôle `investigate` sur le HTML capturé et les éléments de l'agent
       * (données non fiables), plafonné AVANT l'envoi par le budget d'enquête ; vérification SANS LLM sur le même HTML ;
       * une nouvelle tentative au plus. Coût imputé au run d'enquête ; prix inconnu : aucun appel (jamais 0, 08 §1). Un refus
       * est dit au récit (`strategy.compiled`, E4 gardé, avec sa raison) ; une réussite est dite par l'appelant, qui y ajoute
       * la pagination vérifiée. `live` : dépense courante de l'enquête (pendant les essais : exécutions et compilations) ;
       * `account` : impute le coût de l'appel.
       */
      const compileHtml = async (
        pair: TrialPair,
        entry: PlanEntry,
        live: () => number,
        account: (usd: number) => void,
      ): Promise<{ spec: DeclarativeSpec; estCostUsd: number | null; proposals: number; records: number; ratio: number; costUsd: number } | null> => {
        const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
          await decide(EV.strategyCompiled, { from: 'agent_fetch', to: 'fetch', ok: false, reason, ...extra, budget: budgetView() });
          await ctx.log('info', 'html_compile_skipped', { reason });
          return null;
        };
        const page = pageFor.get(pair);
        if (page === undefined) return refuse('no_page');
        // Types du schéma vérifiés AVANT tout appel (constat UX-31) : une compilation impossible n'est jamais payée.
        const support = htmlCompileSupport(outputSchema);
        if (!support.ok) return refuse('unsupported_field_type', { fields: support.fields.slice(0, 10) });
        config ??= deps.llm === undefined ? null : await deps.llm.config().catch(() => null);
        const role = config?.roles.investigate;
        if (deps.llm === undefined || config === null || role === undefined) return refuse('llm_not_configured');
        const price = rolePrice(config, 'investigate');
        if (price === null || price === undefined) {
          await ctx.log('warn', 'llm_price_missing', { model: role.model, role: 'investigate' });
          return refuse('llm_price_missing');
        }
        if (live() >= budgetUsd) return refuse('investigation_budget_usd');
        if (timedOut()) return refuse('investigation_timeout_s');
        let client: LlmClient;
        try {
          client = deps.llm.client({ ...config, roles: { investigate: role } });
        } catch {
          return refuse('llm_not_configured');
        }
        // Spec E4 de l'essai (défauts posés par la validation) : page, hôtes et limite d'entrée de la compilation.
        const e4 = validateAgentFetchSpec(entry.spec);
        if (!e4.ok) return refuse('invalid_agent_fetch_spec');
        let out: HtmlCompileOutcome | null = null;
        let failure: string | null = null;
        try {
          out = await compileHtmlStrategy(client, {
            description: request.description,
            outputSchema,
            html: page.html,
            pageUrl: e4.spec.request.url,
            allowedHosts: e4.spec.request.allowed_hosts,
            items: page.items,
            // Essai en échantillon (banc R06, R08) : les éléments sont les premiers de la page ; la recette doit les rendre en tête.
            ...(e4.spec.limits.sample_items === undefined ? {} : { sampled: true }),
            maxInputChars: e4.spec.limits.max_input_chars,
            price,
            signal,
            beforeCall: (ceiling) => {
              if (live() + (client.meter.snapshot().cost_usd_known ?? 0) + ceiling > budgetUsd) throw new BudgetGuardError();
            },
          });
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          if (timedOut()) failure = 'investigation_timeout_s';
          else if (error instanceof BudgetGuardError) failure = 'investigation_budget_usd';
          else if (error instanceof LlmError) failure = `llm_${error.class}`;
          else failure = 'proposal_unreadable';
        }
        // Coût de la compilation (tentatives échouées comprises), imputé au run d'enquête : inconnu si le prix manque.
        const usage = client.meter.snapshot();
        await charge(ctx, 0, usage.cost_usd, { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning, estimated: usage.usage_estimated });
        await ctx.log('info', 'html_compile_call', { model: role.model, prompt_version: htmlCompilePromptVersion, llm_usd: usage.cost_usd, calls: usage.calls });
        if (usage.cost_usd === null) {
          await ctx.log('warn', 'llm_price_missing', { model: role.model, role: 'investigate' });
          return refuse('llm_price_missing', { cost_usd: null });
        }
        account(usage.cost_usd);
        if (out === null) return refuse(failure ?? 'proposal_unreadable', { cost_usd: usage.cost_usd });
        if (!out.ok) {
          return refuse(out.reason, { proposals: out.proposals, cost_usd: usage.cost_usd, ...(out.diff === null ? {} : { expected: out.diff.expected, got: out.diff.got, ratio: out.diff.ratio }) });
        }
        // Coût d'un rejeu : E1 sans LLM (octets de la page au prix du réseau du couple, calcul).
        const perGbUsd = networks.find((n) => n.mode === entry.network)?.perGbUsd ?? 0;
        const estCostUsd = estimateCostUsd('fetch', entry.network, { bytes: Buffer.byteLength(page.html), pages: 1, perGbUsd, llmPrice: null });
        return { spec: out.spec, estCostUsd, proposals: out.proposals, records: out.diff.got, ratio: out.diff.ratio, costUsd: usage.cost_usd };
      };


      /**
       * Essai E4 compilé : paginé et vérifié en page 2 si la page en a une, sinon vérifié sur sa page ; `verified` : une
       * exécution E1 de la compilée, sans LLM, a été conforme (elle tient lieu des exécutions LLM suivantes, banc R06 et R08).
       * `null` : compilation refusée (E4 gardé).
       */
      type Promoted = { spec: unknown; estCostUsd: number | null; paginated: boolean; records: Record<string, unknown>[] | null; verified: boolean };
      const promotedFor = new Map<TrialPair, Promoted | null>();
      /** Coût des compilations et vérifications de page 2 faites PENDANT les essais (hors exécutions des couples). */
      let promotionUsd = 0;
      const liveTrialSpent = () => round6(spentBeforeTrials + trialsUsd + promotionUsd);
      /**
       * Essai E4 conforme sur la page 1 (constat Janssens : 10 éléments corrects, jetés en `minimal_content` puis escalade
       * vers le navigateur) : compilé en déclaratif `html` (sans LLM au rejeu), augmenté de la pagination détectée par le
       * CODE sur la page de l'essai (`/page/N/`, `?page=N`, `rel=next`…, même hôte), puis vérifié par UNE exécution E1 de la
       * stratégie compilée (2 pages si elle pagine, sinon sa page), sous toutes les gardes d'un run : page 2 atteinte (ou liste
       * finie dès la page 1), au moins autant d'éléments que l'essai E4 (un échantillon des premiers, banc R06 et R08), sortie
       * conforme au schéma (INV1) et contenu minimal. Réussi, la stratégie compilée sera retenue (paginée ou non) ; sinon la
       * compilée d'une page (si la compilation a réussi) ou E4.
       */
      const promote = async (pair: TrialPair): Promise<Promoted | null> => {
        if (promotedFor.has(pair)) return promotedFor.get(pair)!;
        const entry = entries.get(pair)!;
        const compiled = await compileHtml(pair, entry, liveTrialSpent, (usd) => {
          promotionUsd = round6(promotionUsd + usd);
        });
        if (compiled === null) {
          promotedFor.set(pair, null);
          return null;
        }
        const page = pageFor.get(pair)!;
        const single: Promoted = { spec: compiled.spec, estCostUsd: compiled.estCostUsd, paginated: false, records: null, verified: false };
        const report = async (pagination: Record<string, unknown> | null) => {
          await decide(EV.strategyCompiled, { from: 'agent_fetch', to: 'fetch', ok: true, proposals: compiled.proposals, records: compiled.records, ratio: compiled.ratio, cost_usd: compiled.costUsd, est_cost_usd: compiled.estCostUsd, ...(pagination === null ? {} : { pagination }), budget: budgetView() });
          await ctx.log('info', 'html_strategy_compiled', { proposals: compiled.proposals, records: compiled.records, ratio: compiled.ratio, llm_usd: compiled.costUsd, ...(pagination === null ? {} : { pagination: pagination['type'], verified: pagination['verified'] }) });
        };
        const detected = detectHtmlPagination(page.html, page.url, page.items.length);
        const paginatedSpec = detected === null ? null : paginateHtmlSpec(compiled.spec, detected, outputSchema);
        const paginates = detected !== null && paginatedSpec !== null;
        const view = (extra: Record<string, unknown>): Record<string, unknown> | null =>
          detected === null ? null : { type: detected.type, ...(paginates ? extra : { verified: false, reason: 'not_applicable' }) };
        if (liveTrialSpent() >= budgetUsd || timedOut()) {
          await report(view({ verified: false, reason: timedOut() ? 'investigation_timeout_s' : 'investigation_budget_usd' }));
          promotedFor.set(pair, single);
          return single;
        }
        // Une exécution E1 de la stratégie compilée (2 pages si elle pagine), plafond = le plus petit de max_cost_usd (s'il est fixé) et du
        // budget restant ; aucun LLM.
        const checkSpec = paginates ? paginatedSpec : compiled.spec;
        const ceilingUsd = Math.max(0, Math.min(runCapUsd, budgetUsd - liveTrialSpent()));
        const checkTarget: RunTarget = {
          api: { ...target.api, outputSchema, maxCostUsd: ceilingUsd },
          strategy: { version: 0, execution: 'fetch', network: entry.network, spec: checkSpec, scriptRef: null, estCostUsd: compiled.estCostUsd, compilable: 'unknown', sourceSteps: null, instructedSteps: null, instructedConfirmation: null },
        };
        let checked: StrategyTrial | null = null;
        try {
          const timeout = AbortSignal.timeout(Math.max(1, deadlineMs - now()));
          checked = await deps.strategy.trial({ ...ctx, signal: AbortSignal.any([ctx.signal, timeout]), input: paginates ? { max_pages: 2 } : {} }, checkTarget, checkTarget.strategy!);
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          logger.warn(trialErrorLog(ctx.runId, 'fetch', error), 'enquête : vérification de la stratégie compilée en erreur');
        }
        if (checked !== null) promotionUsd = round6(promotionUsd + checked.proxyUsd + (checked.llmUsd ?? 0));
        const r = checked?.result;
        const natural = r?.ok === true && r.pages === 1 && (r.stop === 'records_empty' || r.stop === 'no_next' || r.stop === 'no_pagination');
        const content = r?.ok === true ? minimalContentCheck([r.records], outputSchema) : null;
        const enough = r?.ok === true && r.records.length > 0 && r.records.length >= page.items.length;
        const verified = r?.ok === true && enough && (!paginates || r.pages >= 2 || natural) && content?.ok === true;
        await report(
          view({
            verified,
            pages: r?.pages ?? 0,
            items: r?.ok === true ? r.records.length : 0,
            ...(verified ? {} : { reason: r === undefined ? 'trial_error' : !r.ok ? (r.failure.detail ?? r.failure.failure_class) : content?.ok === false ? content.detail : !enough ? 'count' : 'pagination_page2' }),
          }),
        );
        const promoted: Promoted = verified && r?.ok === true ? { spec: checkSpec, estCostUsd: compiled.estCostUsd, paginated: paginates, records: r.records, verified: true } : single;
        promotedFor.set(pair, promoted);
        return promoted;
      };

      // --- Contrôle de fidélité (banc réel, passage 1) --------------------------------------------------------------------
      // Une stratégie déclarative conforme au schéma n'est retenue que si ses valeurs sont fidèles à la page : (a) contrôle
      // déterministe (remplissage, doublons, formes), puis (b), pour une liste HTML, un juge LLM court sur 3 cartes et leur
      // fragment HTML, appelé seulement si (a) passe, au plus 0,01 $ par appel. Refus : UNE nouvelle proposition des emplacements avec le
      // différentiel (codes seulement), essayée par une exécution du même couple ; sinon l'échelon suivant. Coûts imputés à
      // l'enquête (compte « hors couples » des essais).
      const declarativeExecutions = new Set(['fetch', 'fetch_in_page', 'playwright']);
      const fidelityBySpec = new Map<string, { ok: boolean; issues: readonly FidelityIssue[] }>();
      const remapped = new Set<string>();
      const autoValidated = state.validated_by === 'auto';
      const investigateClient = async (): Promise<{ client: LlmClient; price: TokenPrice; model: string } | null> => {
        config ??= deps.llm === undefined ? null : await deps.llm.config().catch(() => null);
        const role = config?.roles.investigate;
        if (deps.llm === undefined || config === null || role === undefined) return null;
        const price = rolePrice(config, 'investigate');
        if (price === null || price === undefined) return null;
        try {
          return { client: deps.llm.client({ ...config, roles: { investigate: role } }), price, model: role.model };
        } catch {
          return null;
        }
      };
      const chargeOutside = async (client: LlmClient): Promise<number | null> => {
        const usage = client.meter.snapshot();
        await charge(ctx, 0, usage.cost_usd, { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning, estimated: usage.usage_estimated });
        if (usage.cost_usd !== null) promotionUsd = round6(promotionUsd + usage.cost_usd);
        return usage.cost_usd;
      };
      /** Contrôle de fidélité d'une stratégie déclarative sur ses éléments ; verdict gardé par spécification (même spec, même verdict). */
      const fidelityOf = async (spec: DeclarativeSpec, source: string, records: readonly Record<string, unknown>[]): Promise<{ ok: boolean; issues: readonly FidelityIssue[] }> => {
        const key = JSON.stringify(spec);
        const known = fidelityBySpec.get(key);
        if (known !== undefined) return known;
        const candidate = reconCandidates.find((c) => c.id === source) ?? null;
        const det = fidelityCheck({ records, outputSchema, spec, candidate });
        let verdict: { ok: boolean; issues: readonly FidelityIssue[] } = det;
        let judged: string = 'not_needed';
        // Juge LLM : cartes HTML seulement (le fragment montré est le bloc de la carte) ; une source JSON a ses clés pour
        // le contrôle déterministe (clé au nom du champ laissée de côté, forme des valeurs).
        if (det.ok && spec.sources[0]?.from !== 'html') judged = 'json_source';
        else if (det.ok) {
          const body = candidate === null || reconCapture === null ? undefined : capturedBody(candidate, reconCapture);
          const samples = body === undefined ? [] : fidelitySamples(spec, body, outputSchema);
          const llm = samples.length === 0 ? null : await investigateClient();
          if (samples.length === 0) judged = 'no_samples';
          else if (llm === null) judged = 'llm_unavailable';
          else if (liveTrialSpent() >= budgetUsd || timedOut()) judged = 'investigation_budget_usd';
          else {
            try {
              const out = await judgeFidelity(llm.client, {
                description: request.description,
                outputSchema,
                samples,
                price: llm.price,
                signal,
                beforeCall: (ceiling) => {
                  if (liveTrialSpent() + (llm.client.meter.snapshot().cost_usd_known ?? 0) + ceiling > budgetUsd) throw new BudgetGuardError();
                },
              });
              judged = out.judged ? 'judged' : out.reason;
              if (out.judged) verdict = { ok: out.issues.length === 0, issues: out.issues };
            } catch (error) {
              if (ctx.signal.aborted) throw error;
              // Juge indisponible (erreur du fournisseur, budget) : le contrôle déterministe a passé, l'essai suit son cours.
              judged = error instanceof BudgetGuardError ? 'investigation_budget_usd' : 'judge_failed';
            }
            const cost = await chargeOutside(llm.client);
            await ctx.log('info', 'fidelity_judge_call', { model: llm.model, prompt_version: fidelityJudgePromptVersion, llm_usd: cost, outcome: judged });
          }
        }
        await ctx.log(verdict.ok ? 'info' : 'warn', 'fidelity_check', { source, ok: verdict.ok, judge: judged, issues: verdict.issues.map((i) => ({ field: i.field, code: i.code, ...(i.share === undefined ? {} : { share: i.share }), ...(i.other === undefined ? {} : { other: i.other }) })) });
        fidelityBySpec.set(key, verdict);
        return verdict;
      };
      /**
       * Une nouvelle carte des champs d'un couple, essayée par UNE exécution du même couple (2 pages si elle pagine), puis jugée
       * comme la première (contenu minimal, fidélité). Acceptée, elle remplace la spécification du couple (retenue avec lui).
       * `event` : code du journal (`fidelity_remap`, `fidelity_fix`).
       */
      const tryMapping = async (pair: TrialPair, entry: PlanEntry, spec: Record<string, unknown>, paginated: boolean, event: string): Promise<boolean> => {
        const strategy = { spec: spec as unknown as DeclarativeSpec, paginated };
        const ceilingUsd = Math.max(0, Math.min(runCapUsd, budgetUsd - liveTrialSpent()));
        const checkTarget: RunTarget = {
          api: { ...target.api, outputSchema, maxCostUsd: ceilingUsd },
          strategy: { version: 0, execution: entry.execution, network: entry.network, spec, scriptRef: null, estCostUsd: entry.est_cost_usd, compilable: 'unknown', sourceSteps: null, instructedSteps: null, instructedConfirmation: null },
        };
        let checked: StrategyTrial | null = null;
        try {
          const timeout = AbortSignal.timeout(Math.max(1, deadlineMs - now()));
          checked = await deps.strategy.trial({ ...ctx, signal: AbortSignal.any([ctx.signal, timeout]), input: trialInput(strategy.paginated, 'sample') }, checkTarget, checkTarget.strategy!);
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          logger.warn(trialErrorLog(ctx.runId, entry.execution, error), 'enquête : essai de la nouvelle carte en erreur');
        }
        if (checked !== null) promotionUsd = round6(promotionUsd + checked.proxyUsd + (checked.llmUsd ?? 0));
        const r = checked?.result;
        const natural = r?.ok === true && r.pages === 1 && (r.stop === 'records_empty' || r.stop === 'no_next' || r.stop === 'no_pagination');
        const pagesOk = r?.ok === true && (!strategy.paginated || r.pages >= 2 || natural);
        const minimal = r?.ok === true ? minimalContentCheck([r.records], outputSchema) : null;
        const verdict = r?.ok === true && pagesOk && minimal?.ok === true ? await fidelityOf(strategy.spec, entry.source, r.records) : null;
        const ok = verdict?.ok === true && r?.ok === true;
        await ctx.log('info', event, { source: entry.source, ok, reason: ok ? null : r === undefined ? 'trial_error' : !r.ok ? (r.failure.detail ?? r.failure.failure_class) : !pagesOk ? 'pagination_page2' : minimal?.ok === false ? minimal.detail : 'fidelity' });
        if (!ok || r?.ok !== true) return false;
        entries.set(pair, { ...entry, spec, paginated });
        lastRecords.set(pair, r.records);
        sampleOutputs.set(pair, [r.records]);
        return true;
      };
      /**
       * Avant TOUTE escalade vers une voie à LLM (banc réel R09 : `start_date` recevait l'organisateur, puis `agent_fetch` et `agent`
       * brûlaient le budget), une nouvelle tentative BON MARCHÉ de la voie déterministe ou JSON : le code corrige l'affectation
       * du champ refusé d'après le différentiel du contrôle de fidélité (date : champ ISO de la réponse ; libellé : chemin joint),
       * vérifiée sur les données capturées, puis par une exécution du même couple. Aucun LLM ; une fois par gisement.
       */
      const fixed = new Set<string>();
      const fixMapping = async (pair: TrialPair, entry: PlanEntry, issues: readonly FidelityIssue[]): Promise<boolean> => {
        if (fixed.has(entry.source)) return false;
        fixed.add(entry.source);
        const candidate = reconCandidates.find((c) => c.id === entry.source) ?? null;
        const body = candidate === null || reconCapture === null ? undefined : capturedBody(candidate, reconCapture);
        const fix = fixFieldMapping({ spec: entry.spec as unknown as DeclarativeSpec, candidate, issues, outputSchema, body });
        if (fix === null) {
          await ctx.log('info', 'fidelity_fix', { source: entry.source, ok: false, reason: 'no_fix' });
          return false;
        }
        const ok = await tryMapping(pair, entry, fix.spec as unknown as Record<string, unknown>, entry.paginated, 'fidelity_fix');
        if (ok) await ctx.log('info', 'fidelity_fix_applied', { source: entry.source, fields: fix.changes.map((c) => c.field) });
        return ok;
      };
      /**
       * Nouvelle proposition des emplacements d'UN gisement après un refus de fidélité (une fois par gisement) : rôle
       * `investigate` avec le schéma validé, la carte précédente et le différentiel (codes) ; la nouvelle stratégie est
       * essayée par UNE exécution du même couple (2 pages si elle pagine), puis jugée comme la première. Acceptée, elle
       * remplace la spécification du couple (retenue avec lui).
       */
      const remap = async (pair: TrialPair, entry: PlanEntry, issues: readonly FidelityIssue[]): Promise<boolean> => {
        if (remapped.has(entry.source)) return false;
        remapped.add(entry.source);
        const llm = await investigateClient();
        if (llm === null || proposal === undefined) return false;
        const previous = proposal.sources.find((s) => s.candidate === entry.source);
        const args: Parameters<typeof proposeInvestigation>[1] = {
          description: request.description,
          candidates: reconCandidates,
          accessFacts: accessFactsForPrompt(report),
          fixedSchema: outputSchema,
          ...(state.validated_by === 'user' && state.validation?.instructions !== undefined ? { ownerCorrections: state.validation.instructions } : {}),
          ...(ctx.proseLocale === undefined ? {} : { proseLocale: ctx.proseLocale }),
          previousMapping: { paths: (previous?.paths ?? []).map((p) => ({ candidate: entry.source, field: p.field, path: p.path })), diff: fidelityDiff(issues) },
        };
        const ceiling = investigateCallCeilingUsd(args, llm.price);
        if (liveTrialSpent() + ceiling > budgetUsd || timedOut()) {
          await ctx.log('info', 'fidelity_remap_skipped', { source: entry.source, reason: timedOut() ? 'investigation_timeout_s' : 'investigation_budget_usd' });
          return false;
        }
        let next: typeof proposal | undefined;
        try {
          next = (await proposeInvestigation(llm.client, { ...args, signal, beforeCall: () => {
            if (liveTrialSpent() + (llm.client.meter.snapshot().cost_usd_known ?? 0) + ceiling > budgetUsd) throw new BudgetGuardError();
          } })).proposal;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          next = undefined;
        }
        const cost = await chargeOutside(llm.client);
        await ctx.log('info', 'investigate_call', { model: llm.model, prompt_version: investigatePromptVersion, llm_usd: cost, purpose: 'fidelity_remap' });
        if (next === undefined) return false;
        const built = buildFromProposal(next, reconCandidates, null, { fixedSchema: outputSchema });
        const strategy = built.ok ? built.strategies.find((s) => s.candidate.id === entry.source) : undefined;
        if (strategy === undefined || JSON.stringify(strategy.spec) === JSON.stringify(entry.spec)) {
          await ctx.log('info', 'fidelity_remap', { source: entry.source, ok: false, reason: strategy === undefined ? 'no_strategy' : 'same_mapping' });
          return false;
        }
        const spec = strategy.spec as unknown as Record<string, unknown>;
        const tried = await tryMapping(pair, entry, spec, strategy.paginated, 'fidelity_remap');
        if (!tried) return false;
        proposal = next;
        await save(phase, { proposal: next });
        return true;
      };
      /**
       * Règle d'arrêt vérifiée en politique `quarantine` : un champ requis absent d'éléments des pages suivantes (second
       * gabarit de carte, R02) devient facultatif si le schéma a été validé par l'agent (`auto_validate`) : schéma et
       * spécifications du plan relâchés, état enregistré. Un schéma validé par l'appelant reste le contrat (refus
       * `missing_required`).
       */
      const relaxMissing = async (records: readonly Record<string, unknown>[]): Promise<boolean> => {
        const missing = missingRequiredFields(records, outputSchema);
        if (missing.length === 0) return true;
        if (!autoValidated) return false;
        const fields = missing.map((m) => m.field);
        outputSchema = relaxRequired(outputSchema, fields);
        for (const [p, e] of entries) if ((e.spec as { kind?: unknown }).kind === 'declarative') entries.set(p, { ...e, spec: relaxSpecRequired(e.spec as unknown as DeclarativeSpec, fields) as unknown as Record<string, unknown> });
        const columns = schemaColumns(outputSchema);
        await save(phase, { validated_schema: outputSchema, proposed_schema: outputSchema, validated_columns: columns, proposed_columns: columns });
        await ctx.log('info', 'required_relaxed', { fields: missing.map((m) => ({ field: m.field, records: m.records })), of: records.length });
        return true;
      };

      let outcome: TrialsOutcome;
      try {
        outcome = await runTrials(
          ordered,
          {
            now,
            execute: async (pair, index, limits, purpose = 'sample') => {
              const entry = entries.get(pair)!;
              const trialTarget: RunTarget = {
                api: { ...target.api, outputSchema, maxCostUsd: limits.ceilingUsd },
                strategy: { version: 0, execution: entry.execution, network: entry.network, spec: entry.spec, scriptRef: null, estCostUsd: entry.est_cost_usd, compilable: 'unknown', sourceSteps: null, instructedSteps: null, instructedConfirmation: null },
              };
              // Rôle agentique sans prix (E4 : `extract`, E6 : `agent`) : aucun essai, une raison par cause (UX-12).
              const roleOfEntry = entry.execution === 'agent_fetch' ? 'extract' : entry.execution === 'agent' ? 'agent' : null;
              const unpricedRole = roleOfEntry === null ? null : unpricedModel(config, roleOfEntry);
              if (unpricedRole !== null) throw new LlmPriceStop(unpricedRole);
              const timeout = AbortSignal.timeout(Math.max(1, limits.deadlineMs - now()));
              const trialCtx: RunCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, timeout]), input: trialInput(entry.paginated, purpose, hardMaxPagesOf(entry.spec)), ...(purpose === 'stop_check' ? { pageSampling: true } : {}) };
              let trial: StrategyTrial;
              // Règle d'arrêt d'une stratégie déclarative : lue en politique `quarantine` (des pages suivantes peuvent servir un
              // second gabarit sans un champ requis : R02) ; les champs requis absents sont jugés par `relaxMissing`.
              const quarantineStop = purpose === 'stop_check' && declarativeExecutions.has(entry.execution);
              try {
                trial = await deps.strategy.trial(trialCtx, trialTarget, trialTarget.strategy!, quarantineStop ? 'quarantine' : undefined);
              } catch (error) {
                if (ctx.signal.aborted) throw error;
                if (timeout.aborted) return execution(false, 'run_budget_exceeded', 'investigation_timeout_s', 0, null, 0, null);
                // Journal de l'opérateur : la classe et un code borné, JAMAIS le message (valeur du site ou personnelle : le logger ne
                // masque que les secrets, INV8, pas le registre des valeurs personnelles du run). Seul un lancement Chromium raté
                // (messages construits par agent-browser.ts : code fermé, stderr de Chromium) garde son diagnostic (UX-23).
                logger.warn(trialErrorLog(ctx.runId, entry.execution, error), 'enquête : essai en erreur');
                return execution(false, 'code_error', 'trial_error', 0, 0, 0, null);
              }
              const acc = spend.get(pair) ?? { proxy: 0, llm: 0, tokens: { in: 0, cached: 0, out: 0, reasoning: 0, estimated: false }, model: null, prompt: null, engine: null };
              acc.proxy = round6(acc.proxy + trial.proxyUsd);
              acc.llm = acc.llm === null || trial.llmUsd === null ? null : round6(acc.llm + trial.llmUsd);
              if (trial.llm !== null) {
                const t = trial.llm.tokens;
                acc.tokens = { in: acc.tokens.in + t.in, cached: acc.tokens.cached + t.cached, out: acc.tokens.out + t.out, reasoning: acc.tokens.reasoning + t.reasoning, estimated: acc.tokens.estimated || t.estimated };
                acc.model = trial.llm.modelId ?? acc.model;
                acc.prompt = trial.llm.promptVersion ?? acc.prompt;
                acc.engine = trial.llm.engine ?? acc.engine;
              }
              spend.set(pair, acc);
              // Requêtes de l'agent refusées par la garde (19 §7) : le code et les motifs au journal, jamais l'URL ni la valeur ;
              // le motif part aussi dans le récit de l'essai (`why.params.reason`, constat UX-33 : refus « sans motif »).
              const policy = trial.outcome.agent?.requestPolicy;
              if (policy !== undefined && policy.blocked > 0) {
                const reasons = [...new Set(policy.reasons)];
                blockedFor.set(pair, [...new Set([...(blockedFor.get(pair) ?? []), ...reasons])]);
                await ctx.log('warn', 'agent_request_blocked', { code: 'agent_request_blocked', execution: entry.execution, count: policy.blocked, reasons });
              }
              for (const read of trial.outcome.skillReads ?? []) {
                const seen = skillReads.get(pair) ?? [];
                if (seen.some((r) => r.ref === read.ref)) continue;
                skillReads.set(pair, [...seen, read]);
                await event('skill.read', { ref: read.ref, name: read.name, version: read.version, sha256: read.sha256, execution: entry.execution });
              }
              const cost = trial.llmUsd === null ? null : round6(trial.proxyUsd + trial.llmUsd);
              trialsUsd = round6(trialsUsd + (cost ?? 0));
              const r = trial.result;
              const stop = trial.outcome.stop;
              // Extension hors ligne (04 §6, transition 3) : arrêt SANS classe d'échec, aucun essai journalisé (comme un run).
              if (stop === 'tunnel_offline') throw new TunnelOfflineStop();
              if (stop === 'challenge_in_tunnel') return execution(false, 'blocked_by_protection', 'challenge_in_tunnel', r.pages, cost, trial.ms, null);
              if (trial.outcome.needsUser === true && !r.ok) return execution(false, 'auth_required', 'site_not_connected', r.pages, cost, trial.ms, null);
              if (cost === null) return execution(false, 'run_budget_exceeded', 'llm_price_missing', r.pages, null, trial.ms, null);
              // Plafond de l'essai : `max_cost_usd` de l'API, ou le RESTE du budget d'enquête s'il est plus petit. Le motif dit lequel
              // a coupé (constat Janssens : agent arrêté à 0,72 $ « max_cost_usd » alors que max_cost_usd valait 3 $). Sans plafond
              // par run (D-123), seul le budget d'enquête coupe : jamais « max_cost_usd ».
              const capDetail = limits.ceilingUsd < runCapUsd ? 'investigation_budget_usd' : 'max_cost_usd';
              if (cost > limits.ceilingUsd) return execution(false, 'run_budget_exceeded', capDetail, r.pages, cost, trial.ms, null);
              if (!r.ok) {
                const f = trial.guardedFailure ?? r.failure;
                const detail = f.failure_class === 'run_budget_exceeded' && f.detail === 'max_cost_usd' ? capDetail : f.detail;
                return execution(false, f.failure_class, detail, r.pages, cost, trial.ms, null);
              }
              if (quarantineStop && !(await relaxMissing(r.records))) return execution(false, 'extraction', 'missing_required', r.pages, cost, trial.ms, null);
              // E6 réussi sans trace compilable en E5 : jamais retenu (04 §3.1, pas d'agent à chaque run sans `instructed_mode`).
              if (entry.execution === 'agent') {
                const compiled = trial.outcome.agent?.compiled;
                if (compiled === undefined) return execution(false, 'extraction', 'not_compilable', r.pages, cost, trial.ms, null);
                compiledFor.set(pair, compiled);
                const trace = trial.outcome.agent?.trace;
                compileContextFor.set(pair, { modelId: trial.llm?.modelId ?? null, at: new Date(now()).toISOString(), ...(trace === undefined ? {} : { trace }) });
              }
              // E4 réussi : page servie et éléments de l'agent (avant la liste d'exclusion, comme le rejeu du HTML), gardés en
              // mémoire pour la compilation en déclaratif `html` (constat UX-20). Jamais écrits ni journalisés.
              const page = trial.outcome.agent?.page;
              if (entry.execution === 'agent_fetch' && purpose === 'sample' && page !== undefined) {
                pageFor.set(pair, { html: page.html, url: page.url, items: trial.outcome.result.ok ? trial.outcome.result.records : r.records });
              }
              lastRecords.set(pair, r.records);
              // Cartes SERVIES (doublons d'une liste HTML compris, R02 : 350 cartes pour « 359 annonces », 268 fiches distinctes).
              // Une lecture par échantillon de pages (vérification de la règle d'arrêt, R01) ne dit rien de la complétude.
              if (r.sampled !== true) runsFor.set(pair, [...(runsFor.get(pair) ?? []), { records: r.records.length + (r.duplicates ?? 0), stop: r.stop }]);
              if (purpose === 'sample') sampleOutputs.set(pair, [...(sampleOutputs.get(pair) ?? []), r.records]);
              return { ...execution(true, null, null, r.pages, cost, trial.ms, r.stop), records: r.records.length };
            },
            finished: async (o: PairOutcome) => {
              const acc = spend.get(o.pair);
              await ctx.recordAttempt({
                execution: o.pair.execution,
                network: o.pair.network,
                est_cost_usd: o.pair.est_cost_usd,
                result: o.result,
                ms: o.ms,
                proxy_usd: acc?.proxy ?? 0,
                ...(acc === undefined || (acc.model === null && acc.llm === 0)
                  ? {}
                  : { llm_usd: acc.llm, tokens: acc.tokens, model_id: acc.model, prompt_version: acc.prompt, engine: acc.engine }),
                ...(guided.placed.has(o.pair as PlanEntry) ? { rule_refs: guided.placed.get(o.pair as PlanEntry) } : {}),
              });
              await decide(EV.attemptFinished, {
                attempt: { execution: o.pair.execution, network: o.pair.network, est_cost_usd: o.pair.est_cost_usd, result: o.result, cost_usd: o.cost_usd, ms: o.ms },
                source: o.pair.source,
                ...(o.detail === null ? {} : { why: { code: o.detail, params: o.detail === 'agent_request_blocked' ? blockedParams(blockedFor.get(o.pair)) : o.detail === 'incomplete_vs_counter' ? { ...incompleteFor.get(o.pair) } : {} } }),
                executions: o.executions.map((e) => ({ ok: e.ok, records: e.records, pages: e.pages, stop: e.stop, cost_usd: e.cost_usd, ms: e.ms })),
                ...(stopCheckView(o) === undefined ? {} : { pagination: stopCheckView(o) }),
                budget: budgetView(),
              });
            },
            // Essai E4 en échantillon conforme dès sa 1re exécution : compilé et vérifié sans LLM, il n'en paie pas d'autre.
            acceptEarly: async (pair) => entries.get(pair)?.execution === 'agent_fetch' && pageFor.has(pair) && (await promote(pair))?.verified === true,
            contentCheck: async (pair) => {
              const check = minimalContentCheck(sampleOutputs.get(pair) ?? [], outputSchema);
              // Essai E4 conforme : compilé en `html`, paginé et vérifié en page 2 (ou sur sa page) avant d'être jugé (Janssens).
              if (entries.get(pair)?.execution === 'agent_fetch' && pageFor.has(pair)) {
                const promoted = await promote(pair);
                if (promoted?.verified === true) return null;
              }
              if (!check.ok) return { failure_class: check.failure_class, detail: check.detail };
              // Stratégie déclarative née d'un gisement : contrôle de fidélité, puis une nouvelle carte au plus (banc réel).
              const entry = entries.get(pair)!;
              // Complétude contre le compteur affiché par la page (R13) : une liste finie bien en deçà n'est pas conforme.
              if (declarativeExecutions.has(entry.execution)) {
                const gap = incompleteVsCounter(reconCandidates.find((c) => c.id === entry.source)?.counter, runsFor.get(pair) ?? []);
                if (gap !== null) {
                  incompleteFor.set(pair, gap);
                  await ctx.log('warn', 'completeness_check', { source: entry.source, execution: entry.execution, counter: gap.counter, delivered: gap.delivered });
                  return { failure_class: 'extraction', detail: 'incomplete_vs_counter' };
                }
              }
              if (!declarativeExecutions.has(entry.execution) || (entry.spec as { kind?: unknown }).kind !== 'declarative' || !reconCandidates.some((c) => c.id === entry.source)) return null;
              const records = (sampleOutputs.get(pair) ?? []).flat();
              const verdict = await fidelityOf(entry.spec as unknown as DeclarativeSpec, entry.source, records);
              if (verdict.ok) return null;
              if (await fixMapping(pair, entry, verdict.issues)) return null;
              if (await remap(pair, entry, verdict.issues)) return null;
              return { failure_class: 'extraction', detail: 'fidelity' };
            },
            spentOutside: () => promotionUsd,
            pruned: async (pairs, by, cls) => {
              await decide(EV.attemptPruned, {
                by: { execution: by.execution, network: by.network, source: by.source },
                reason: cls,
                pruned: pairs.map((p) => ({ execution: p.execution, network: p.network, source: p.source, est_cost_usd: p.est_cost_usd })),
              });
            },
          },
          { maxUsd: budgetUsd, spentUsd: spent, deadlineMs, maxAttempts: INVESTIGATION_DEFAULTS.maxAttempts, maxCostPerRunUsd: target.api.costCapUsd },
          { ...(deps.samples === undefined ? {} : { samples: deps.samples }), paginated: (p) => entries.get(p)?.paginated === true, catchUp: true },
        );
      } catch (error) {
        if (error instanceof LlmPriceStop) {
          spent = round6(spentBeforeTrials + trialsUsd);
          await ctx.log('warn', 'llm_price_missing', { model: error.model, role: 'trial' });
          return await finishStopped('llm_price_missing', `llm_price_missing:${error.model}`, 'testing', error.model);
        }
        if (!(error instanceof TunnelOfflineStop)) throw error;
        spent = round6(spentBeforeTrials + trialsUsd);
        await ctx.log('warn', 'tunnel_offline', { network: 'tunnel' });
        return await finishStopped('tunnel_offline', 'tunnel_offline', 'testing');
      }
      spent = outcome.spentUsd;

      switch (outcome.kind) {
        case 'conformant': {
          const pair = outcome.outcome.pair;
          const entry = entries.get(pair)!;
          const runs = Math.max(1, outcome.outcome.executions.length);
          const kept = retainedStrategy(entry, compiledFor.get(pair), round6((spend.get(pair)?.proxy ?? 0) / runs), compileContextFor.get(pair));
          if (!kept.ok) return await finishFailed({ failure_class: 'extraction', retryable: false, detail: kept.reason }, 'testing');
          // Essai E4 conforme : compilé en déclaratif `html` rejoué sans LLM si la vérification passe ; E4 reste la version de
          // repli (écrite avant la compilée, retour de version). Sinon E4 est retenu tel quel (UX-20).
          let html: Promoted | null = null;
          if (entry.execution === 'agent_fetch') {
            if (promotedFor.has(pair)) html = promotedFor.get(pair)!;
            else {
              const compiled = await compileHtml(pair, entry, () => spent, (usd) => {
                spent = round6(spent + usd);
              });
              html = compiled === null ? null : { spec: compiled.spec, estCostUsd: compiled.estCostUsd, paginated: false, records: null, verified: false };
              if (compiled !== null) {
                await decide(EV.strategyCompiled, { from: 'agent_fetch', to: 'fetch', ok: true, proposals: compiled.proposals, records: compiled.records, ratio: compiled.ratio, cost_usd: compiled.costUsd, est_cost_usd: compiled.estCostUsd, budget: budgetView() });
                await ctx.log('info', 'html_strategy_compiled', { proposals: compiled.proposals, records: compiled.records, ratio: compiled.ratio, llm_usd: compiled.costUsd });
              }
            }
          }
          const retained = html === null ? { execution: kept.execution, network: kept.network, spec: kept.spec, estCostUsd: kept.estCostUsd } : { execution: 'fetch' as const, network: kept.network, spec: html.spec, estCostUsd: html.estCostUsd };
          // Stratégie retenue paginée : la sienne (déclarative), ou la compilée d'E4 vérifiée en page 2.
          const retainedPaginated = html === null ? entry.paginated : html.paginated;
          // Liste dont la page affiche un compteur (R13 : 6197 biens à 24 par page) : le plafond de requêtes d'un run suit le
          // nombre de pages annoncé (borné par le format, 1000), sinon le run serait tronqué à 200 pages. La cadence reste.
          const sourceCandidate = reconCandidates.find((c) => c.id === entry.source);
          const requestsPerRun = retainedPaginated && sourceCandidate?.counter !== undefined ? hardMaxPagesFor(sourceCandidate.counter, sourceCandidate.count) + 2 : undefined;
          // Source (18 §4.6) : règles injectées et skills lus ; règles embarquées si le compilé porte un prompt (E4) ou vient
          // d'une trace E6 (E5 : `compiled_with` par étape, 19 §4).
          const agentic = entry.execution === 'agent_fetch' || entry.execution === 'agent';
          // Skills lus par l'agent pendant les essais de ce couple : `skill_read`, à leur version servie (épinglée).
          const agentReads = agentic && embedded !== null ? sourceRuleRows({ rules: [], skills: embedded.skills, truncated: [] }, skillReads.get(pair) ?? []) : [];
          const known = (rows: readonly StrategyRuleRow[], id: string) => rows.some((r) => r.rule_file_id === id);
          const rows: StrategyRuleRow[] = [...(rulesUsed?.rows ?? [])];
          for (const extra of agentic ? [...agentReads, ...embeddedRows] : []) if (!known(rows, extra.rule_file_id)) rows.push(extra);
          const spec = kept.execution === 'hybrid' ? withCompiledWith(kept.spec, compiledWithRules(agentic ? [...embeddedRows, ...agentReads] : rows), spend.get(pair)?.model ?? null, now()) : kept.spec;
          const recompile = state.reason === 'recompile';
          // Dossier : états finaux (used si la source retenue est celle d'un indice confirmé), source de la version.
          const briefFinals = briefDigest === null ? null : finalizeBriefHints(briefDigest, briefProbes, briefMatch, entry.source);
          const briefRef = briefRead === null ? null : { version: briefRead.brief.version, sha256: briefRead.brief.sha256 };
          const saved = await saveInvestigationStrategy(deps.pool, {
            apiId: ctx.apiId,
            ownerId: ctx.ownerId,
            execution: kept.execution,
            network: kept.network,
            spec,
            estCostUsd: kept.estCostUsd,
            ...(kept.compilable === undefined ? {} : { compilable: kept.compilable }),
            ...(kept.sourceSteps === undefined ? {} : { sourceSteps: kept.sourceSteps }),
            outputSchema,
            ...(state.validated_columns === undefined ? {} : { outputColumns: state.validated_columns }),
            // Import : le schéma d'entrée du fichier (contrôlé à l'import) ; sinon celui que propose l'enquête (2.2).
            inputSchema: imported !== undefined ? imported.input_schema : buildInputSchema({ paginated: retainedPaginated, maxPages: hardMaxPagesOf(retained.spec) }),
            state: { ...state, spent_usd: spent, elapsed_ms: baseElapsed + Math.max(0, now() - started) },
            createdBy: state.validated_by === 'import' ? 'import' : recompile ? 'recompile' : 'investigation',
            source: buildStrategySource({
              reason: recompile ? 'recompile' : 'investigation',
              description: request.description,
              url: request.url,
              outputSchemaSha256: jsonSha256(outputSchema),
              investigationId: ctx.runId,
              decisions,
              rows,
              ...(briefRef === null || briefFinals === null ? {} : { brief: sourceBriefOf(briefRef, briefFinals) }),
            }),
            rules: rows,
            ...(html === null ? {} : { compiled: { execution: retained.execution, spec: retained.spec, estCostUsd: retained.estCostUsd } }),
            ...(requestsPerRun === undefined ? {} : { minRequestsPerRun: requestsPerRun }),
          });
          if (briefRef !== null && briefFinals !== null) await recordBriefOutcome(deps.pool, ctx, briefRef.version, briefFinals.filter((h) => !briefCarried.has(h.id)), now, event);
          phase = 'done';
          // Signature calculée par le code (r1 R10) et entrées de mémoire consultées (sha256 du dossier) sur la version.
          const keptSpec = retained.spec as { request?: { url?: unknown }; pagination?: { type?: unknown } };
          await saveStrategySignature(deps.pool, {
            ownerId: ctx.ownerId,
            apiId: ctx.apiId,
            version: saved.version,
            signature: computeSignature({
              pageUrl,
              requestUrl: typeof keptSpec.request?.url === 'string' ? keptSpec.request.url : null,
              html: reconHtml,
              outputSchema,
              execution: retained.execution,
              network: retained.network,
              pagination: typeof keptSpec.pagination?.type === 'string' ? keptSpec.pagination.type : null,
            }),
          });
          const consulted = dossier !== null ? { sha256: dossier.sha256, refs: dossier.refs } : state.memory;
          if (consulted !== undefined && consulted.refs.length > 0) await recordMemoryRefs(deps.pool, { ownerId: ctx.ownerId, apiId: ctx.apiId, version: saved.version, refs: consulted.refs, sha256: consulted.sha256 });
          // Résultat livré (figure 1, étape I) : la sortie de la dernière exécution conforme (celle de la vérification de page 2
          // pour un E4 compilé paginé), écrite comme le propriétaire.
          const records = html?.records ?? lastRecords.get(pair) ?? [];
          const dataset = await saveRunDataset(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, projectId: target.api.projectId, items: records });
          // Profil du run (après Ajv et la garde de classification : sortie conforme), puis juge CONSULTATIF avant `sain`.
          const profile = profileItems(records, outputSchema);
          const hash = inputHash(trialInput(entry.paginated, 'sample'));
          await saveRunProfile(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, strategyVersion: saved.version, inputHash: hash, profile });
          await judgeInvestigation(records, outputSchema, profile, config, hash);
          await applyStatus({ type: 'investigation_succeeded' });
          await event(EV.finished, {
            outcome: 'conformant',
            strategy: {
              version: saved.version,
              execution: retained.execution,
              network: retained.network,
              source: entry.source,
              est_cost_usd: retained.estCostUsd,
              ...(retained.execution !== entry.execution ? { compiled_from: entry.execution } : {}),
              ...(saved.fallbackVersion === undefined ? {} : { fallback_version: saved.fallbackVersion }),
            },
            items: records.length,
            ...(stopCheckView(outcome.outcome) === undefined ? {} : { pagination: stopCheckView(outcome.outcome) }),
            // Complétude contre le compteur affiché (R13) : éléments lus par la vérification de la règle d'arrêt (ou la dernière
            // exécution) ; `verified: false` : la liste dépasse la vérification bornée, le rejeu dira le reste.
            ...(sourceCandidate?.counter === undefined
              ? {}
              : { completeness: { counter: sourceCandidate.counter, read: outcome.outcome.stop_check?.records ?? records.length, verified: outcome.outcome.stop_check?.verified ?? null, ...(requestsPerRun === undefined ? {} : { requests_per_run: requestsPerRun }) } }),
            budget: budgetView(),
          });
          return { state: 'succeeded', outcome: 'clean', degraded_reasons: [], items: records.length, dataset_id: dataset.datasetId, strategy_version: saved.version };
        }
        case 'stopped':
        case 'action_required': {
          const f = outcome.outcome;
          return await finishFailed({ failure_class: f.result === 'ok' ? 'code_error' : f.result, retryable: false, detail: f.detail ?? 'refused' }, 'testing');
        }
        case 'budget_exhausted':
          return await budgetExhausted(outcome.reason);
        case 'exhausted': {
          // Une géo-restriction (451, redirection de pays : `geo_*`, 04 §7) rencontrée par un essai est un « non » : elle
          // reste lisible dans l'issue (`network`, son code), jamais fondue dans `no_conformant_strategy` (D-49 : le mode
          // « SYM ne lâche pas » s'arrête dessus, sans ré-enquête le lendemain).
          const geo = outcome.tried.find((t) => t.result === 'network' && isGeoRestrictionDetail(t.detail));
          if (geo !== undefined) return await finishFailed({ failure_class: 'network', retryable: false, detail: geo.detail! }, 'testing');
          const last = outcome.tried.at(-1);
          const lastClass = last?.result;
          // Un essai coupé par le plafond par run de l'API (`max_cost_usd`, seulement s'il est fixé : D-123) : cause propre, distincte
          // du budget d'enquête et de l'absence de stratégie conforme (UX-32) ; la suite proposée est de relever ou de retirer ce plafond.
          const detail = last?.detail === 'not_compilable' ? 'not_compilable' : outcome.tried.some((t) => t.detail === 'max_cost_usd') ? 'trial_cost_over_cap' : 'no_conformant_strategy';
          return await finishFailed({ failure_class: lastClass === undefined || lastClass === 'ok' ? 'extraction' : lastClass, retryable: false, detail }, 'testing');
        }
      }
    } catch (error) {
      // Échéance de l'enquête atteinte pendant une phase (étape 0, reconnaissance, appel LLM) : budget épuisé.
      if (timedOut()) return await budgetExhausted('investigation_timeout_s');
      // Extension hors ligne ou défi pendant l'étape 0 ou la reconnaissance (commande refusée localement après l'arrêt).
      if (!ctx.signal.aborted) {
        const stopped = await tunnelOutcome('tunnel');
        if (stopped !== null) return stopped;
      }
      throw error;
    } finally {
      await ports.close();
    }
  };
}

/** Paramètres du motif `agent_request_blocked` d'un essai : premier motif de la garde et liste des motifs (codes seulement). */
function blockedParams(reasons: readonly string[] | undefined): Record<string, string> {
  return reasons === undefined || reasons.length === 0 ? {} : { reason: reasons[0]!, reasons: reasons.join(',') };
}

/** Prix des rôles agentiques (E4 : `extract`, E6 : `agent`) pour l'ensemble des couples autorisés. */
/**
 * Consigne des voies agentiques (E4, E6) : la demande, puis les consignes du client données à la validation du schéma
 * (`validate_schema` `instructions`, constat Barnes), traitées comme elle ; la demande est raccourcie au besoin pour que les
 * consignes tiennent sous le plafond de la spécification (2 000 caractères).
 */
function agenticInstruction(description: string, instructions: string | undefined): string {
  if (instructions === undefined) return description;
  const suffix = `\nOwner corrections: ${instructions}`.slice(0, 1_500);
  return `${description.slice(0, Math.max(0, 2_000 - suffix.length))}${suffix}`;
}

function agenticPrices(config: LlmConfig | null): { extract?: TokenPrice | null; agent?: TokenPrice | null } {
  const extract = rolePrice(config, 'extract');
  const agent = rolePrice(config, 'agent');
  return { ...(extract === undefined ? {} : { extract }), ...(agent === undefined ? {} : { agent }) };
}

/**
 * Ensemble des couples autorisés montré au rôle `investigate` (18 §4.5) : mêmes règles que `buildTrialPlan` (réseaux de la
 * politique et proxys de l'admin, niveaux servis par le worker, rôles configurés), coût estimé indicatif (plus petit
 * gisement). Le plan exécuté est recalculé après la proposition ; rien de ce qui manque ici n'y entre.
 */
function previewCouples(input: {
  networks: readonly PlanNetwork[];
  browser: boolean;
  agentic: { extract?: TokenPrice | null; agent?: TokenPrice | null };
  candidates: readonly DataCandidate[];
  documentBytes: number;
  totalBytes: number;
}): { execution: string; network: string; est_cost_usd: number | null }[] {
  const usable = input.candidates.filter((c) => c.unsupported === undefined);
  const bytes = usable.length === 0 ? 0 : Math.min(...usable.map((c) => c.bytes));
  const out: TrialPair[] = [];
  const add = (execution: TrialPair['execution'], network: PlanNetwork, b: number, llm: TokenPrice | null, tokensIn?: number) =>
    out.push({ execution, network: network.mode, source: '', est_cost_usd: estimateCostUsd(execution, network.mode, { bytes: b, pages: 1, perGbUsd: network.perGbUsd, llmPrice: llm, ...(tokensIn === undefined ? {} : { tokensIn }) }) });
  for (const network of input.networks) {
    const tunnel = network.mode === 'tunnel';
    if (usable.length > 0) {
      add('fetch', network, bytes, null);
      if (input.browser || tunnel) {
        add('fetch_in_page', network, input.documentBytes + bytes, null);
        add('playwright', network, Math.max(input.totalBytes, bytes), null);
      }
    }
    if (input.agentic.extract !== undefined && !tunnel) add('agent_fetch', network, input.documentBytes, input.agentic.extract, Math.ceil(Math.min(input.documentBytes, E4_SAMPLE_INPUT_CHARS) / 4));
    if (input.agentic.agent !== undefined && input.browser && !tunnel) add('agent', network, input.totalBytes * 3, input.agentic.agent);
  }
  return orderTrials(out).map((p) => ({ execution: p.execution, network: p.network, est_cost_usd: p.est_cost_usd }));
}

/** Références effectives du plan : règles injectées, hors politique par défaut telle que livrée (ordre de 04 §3.3). */
function effectiveRefs(resolved: ResolvedRules): string[] {
  return resolved.rules.filter((r) => !(r.name === DEFAULT_POLICY_NAME && r.sha256 === DEFAULT_POLICY_SHA256)).map((r) => r.ref);
}

/** Plafonds de règles et de skills atteints (19 §2) : journalisés, sans contenu. */
async function logRuleBudgets(ctx: RunCtx, resolved: ResolvedRules): Promise<void> {
  if (resolved.truncated.length > 0) await ctx.log('warn', 'rules_truncated', { removed: resolved.truncated.map((r) => r.ref), budget_tokens: resolved.budget.rules });
  if (resolved.skillsListingTruncated) await ctx.log('warn', 'skills_listing_truncated', { without_description: resolved.skillsWithoutDescription, budget_tokens: resolved.budget.skills });
}

/** Empreinte `compiled_with` de chaque étape d'une trace E6 compilée en E5 (19 §4, 19b §1). */
function withCompiledWith(spec: unknown, rules: readonly string[], modelId: string | null, at: number): unknown {
  const s = spec as { steps?: unknown[] } | null;
  if (s === null || typeof s !== 'object' || !Array.isArray(s.steps)) return spec;
  const compiled_with = { rules: [...rules], model_id: modelId, at: new Date(at).toISOString() };
  return { ...s, steps: s.steps.map((step) => (typeof step === 'object' && step !== null ? { ...step, compiled_with } : step)) };
}

/** Garde du budget avant un appel du rôle `investigate` (levée par `beforeCall`, jamais réessayée). */
class BudgetGuardError extends Error {
  override name = 'BudgetGuardError';
}

/** Extension hors ligne pendant un essai : arrêt des essais sans classe d'échec. */
class TunnelOfflineStop extends Error {
  override name = 'TunnelOfflineStop';
}

/** Prix du modèle d'un rôle agentique absent au moment d'un essai : arrêt des essais, `action_requise` (llm_price_missing). */
class LlmPriceStop extends Error {
  override name = 'LlmPriceStop';
  readonly model: string;
  constructor(model: string) {
    super('llm_price_missing');
    this.model = model;
  }
}

/** Exécution d'un couple (forme de `TrialExecution`). */
function execution(ok: boolean, cls: FailureClass | null, detail: string | null, pages: number, cost: number | null, ms: number, stop: string | null): TrialExecution {
  return { ok, failure_class: cls, detail, records: 0, pages, stop, cost_usd: cost, ms };
}

/** Impute au run un coût hors couple (étape 0, reconnaissance, rôle `investigate`). */
async function charge(ctx: RunCtx, proxyUsd: number, llmUsd: number | null = 0, tokens?: { in: number; cached: number; out: number; reasoning: number; estimated: boolean }): Promise<void> {
  if (ctx.chargeCost === undefined) return;
  if (proxyUsd === 0 && llmUsd === 0 && tokens === undefined) return;
  await ctx.chargeCost({ proxy_usd: round6(proxyUsd), llm_usd: llmUsd, ...(tokens === undefined ? {} : { tokens }) });
}

/** Ports de l'étape 0 et de la reconnaissance par le serveur : session réseau de l'enquête sur les domaines de l'API. */
function serverAccessPorts(server: { readonly sessionBase: SessionBase; readonly ceiling: number }, host: string, scope: string, pacer: RequestPacer | undefined): AccessPorts {
  const session: NetworkSession = openNetworkSession({
    ...server.sessionBase,
    allowedHosts: [host],
    allowedHostSuffixes: [scope],
    costCeiling: { maxUsd: server.ceiling },
  });
  return {
    mode: 'server',
    probe: sessionAccessProbe(session),
    reconProbe: sessionAccessProbe(session, STATIC_MAX_BYTES),
    pacer,
    proxyUsd: () => session.usage().costUsd,
    tunnel: null,
    server,
    close: async () => {
      await session.close().catch(() => undefined);
    },
  };
}

/** Sauts de redirection permanente suivis au plus par la sonde de l'étape 0 (R09). */
const MAX_PERMANENT_HOPS = 3;
const PERMANENT_REDIRECTS = new Set([301, 308]);

/**
 * Redirection permanente de l'URL de départ vers un AUTRE site (banc R09 : `lu.ma/paris` répond 301 vers
 * `luma.com/paris`) : sonde GET qui ne suit pas les redirections, par une session réseau de l'enquête (garde SSRF à chaque
 * connexion, verrou de domaines sur l'hôte sondé, plafond de coût, User-Agent du robot), cadencée ; au plus
 * `MAX_PERMANENT_HOPS` sauts 301 ou 308. Un saut dans la portée du site courant est suivi tel quel ; un hôte hors portée
 * n'est adopté qu'après la garde (résolution contrôlée : jamais une adresse privée, réservée ou de métadonnées cloud), en
 * http(s), sans identifiants dans l'URL. Une redirection temporaire (302, 307), une erreur ou un refus de la garde laissent
 * l'URL telle quelle : l'étape 0 décide comme avant (`domain_not_allowed` si la page sort du site). `url: null` : rien
 * d'adopté ; le coût proxy de la sonde est toujours rendu.
 */
async function permanentRedirectTarget(args: {
  sessionBase: SessionBase;
  guard: SsrfGuard;
  url: string;
  ceiling: number;
  signal: AbortSignal;
  pacer?: RequestPacer;
}): Promise<{ url: string | null; proxyUsd: number }> {
  let current = new URL(args.url);
  let adopted = false;
  let proxyUsd = 0;
  for (let hop = 0; hop < MAX_PERMANENT_HOPS; hop += 1) {
    const hopHost = current.hostname.toLowerCase();
    const session = openNetworkSession({ ...args.sessionBase, allowedHosts: [hopHost], allowedHostSuffixes: [siteScope(hopHost)], costCeiling: { maxUsd: Math.max(0, args.ceiling - proxyUsd) } });
    const got = await (async (): Promise<{ status: number; location: string | null } | null> => {
      try {
        if (args.pacer !== undefined) {
          const slot = await args.pacer.acquire(current.href);
          if (!slot.granted) return null;
        }
        const response = await session.fetch(current.href, { method: 'GET', headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, signal: args.signal }, { followRedirects: false });
        await response.body?.cancel().catch(() => undefined);
        await args.pacer?.report(current.href, { status: response.status, retryAfter: response.headers.get('retry-after'), failureClass: null }).catch(() => undefined);
        return { status: response.status, location: response.headers.get('location') };
      } catch {
        args.signal.throwIfAborted();
        return null;
      } finally {
        proxyUsd += session.usage().costUsd;
        await session.close().catch(() => undefined);
      }
    })();
    if (got === null || !PERMANENT_REDIRECTS.has(got.status) || got.location === null) break;
    let next: URL;
    try {
      next = new URL(got.location, current);
    } catch {
      break;
    }
    if ((next.protocol !== 'http:' && next.protocol !== 'https:') || next.username !== '' || next.password !== '') break;
    next.hash = '';
    if (!withinSiteScope(next.hostname, siteScope(hopHost))) {
      try {
        await args.guard.resolve(next.hostname, next.port === '' ? (next.protocol === 'https:' ? 443 : 80) : Number(next.port));
      } catch {
        break;
      }
      adopted = true;
    }
    current = next;
  }
  return { url: adopted ? current.href : null, proxyUsd: Math.round(proxyUsd * 1e6) / 1e6 };
}

/** Domaines de l'API vus par la passe : la page, et les hôtes capturés qui sont dans sa portée de site (04b §2). */
function apiHostsOf(capture: ReconCapture, host: string, scope: string): string[] {
  const hosts = new Set<string>([host]);
  for (const e of capture.exchanges) {
    try {
      const h = new URL(e.url).hostname.toLowerCase();
      if (withinSiteScope(h, scope)) hosts.add(h);
    } catch {
      // URL illisible : jamais un domaine de l'API.
    }
  }
  return [...hosts];
}

/**
 * Sonde par l'extension (`page_fetch` dans un onglet du site) : un défi détecté arrête le tunnel sur-le-champ. Aucun
 * `sent_accept_language` : le Chrome de l'utilisateur envoie sa propre langue (21 § 6.4), le rapport le dit (`requestsFrom`).
 */
function tunnelProbe(session: TunnelSession, maxBytes: number): AccessProbe {
  const transport = pageFetchTransport(session, maxBytes);
  return (url, signal) => transport({ method: 'GET', url, headers: {} }, signal);
}

/** `requests` : requêtes de contenu de la passe statique (page et URL de données), base du critère « reconnaissance réduite ». */
type ReconOutcome = { readonly capture: ReconCapture; readonly failure: ExecFailure | null; readonly proxyUsd: number; readonly requests?: number };

/** Reconnaissance par Chromium : passe E3 sur le premier réseau autorisé, proxy d'egress propre à la passe. */
async function browserRecon(
  deps: InvestigationExecutorDeps,
  args: {
    url: string;
    host: string;
    scope: string;
    signal: AbortSignal;
    userAgent: string;
    sessionBase: SessionBase;
    ceiling: number;
    otherUsd: () => number;
    pacer?: RequestPacer;
  },
): Promise<ReconOutcome> {
  // Code et styles d'un CDN tiers admis pour le rendu (banc R05), bornés ; le même objet tient le proxy d'egress et la page.
  const staticAssets = createStaticAssetAllowance();
  const egress = await openBrowserEgress({
    ...args.sessionBase,
    allowedHosts: [args.host],
    allowedHostSuffixes: [args.scope],
    staticAssets,
    costCeiling: { maxUsd: args.ceiling, otherUsd: args.otherUsd },
  });
  try {
    const pass = await runReconnaissancePass({
      pool: deps.browsers!,
      egress,
      guard: deps.guard,
      url: args.url,
      allowedHosts: [args.host],
      allowedHostSuffixes: [args.scope],
      staticAssets,
      signal: args.signal,
      userAgent: args.userAgent,
      ...(args.pacer === undefined ? {} : { pacer: args.pacer }),
    });
    return { capture: pass.capture, failure: pass.result.ok ? null : pass.result.failure, proxyUsd: egress.usage().costUsd };
  } finally {
    await egress.close().catch(() => undefined);
  }
}

/**
 * Reconnaissance sans navigateur (`DISABLE_BROWSER`) ou par l'extension (session requise) : la page (corps borné, classée
 * avant lecture), ses blobs, puis au plus `STATIC_MAX_ENDPOINTS` URL de données appelées par ses scripts en ligne (domaines
 * de l'API), chacune cadencée et classée ; un refus sur l'une arrête la reconnaissance (INV6).
 * En tunnel, les URL d'action (`isActionUrl` : déconnexion, suppression, désabonnement…) ne sont jamais rejouées.
 */
async function staticRecon(
  probe: AccessProbe,
  args: { url: string; allowHost: (host: string) => boolean; signal: AbortSignal; mode: 'static' | 'tunnel'; pacer?: RequestPacer; skipDiscovery?: boolean },
): Promise<ReconOutcome> {
  const empty = (failure: ExecFailure | null): ReconOutcome => ({ capture: { mode: args.mode, pageUrl: args.url, document: null, exchanges: [], totalBytes: 0 }, failure, proxyUsd: 0 });
  type Got = { readonly kind: 'failed'; readonly failure: ExecFailure } | { readonly kind: 'got'; readonly exchange: HttpExchange; readonly refused: ExecFailure | null };
  let requests = 0;
  const get = async (url: string): Promise<Got> => {
    requests += 1;
    if (args.pacer !== undefined) {
      const slot = await args.pacer.acquire(url);
      if (!slot.granted) return { kind: 'failed', failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` } };
    }
    try {
      const exchange = await probe(url, args.signal);
      const refused = classifyExchange(exchange, { requestUrl: url });
      await args.pacer?.report(url, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null, failureClass: refused?.failure_class ?? null }).catch(() => undefined);
      return { kind: 'got', exchange, refused };
    } catch (error) {
      args.signal.throwIfAborted();
      return { kind: 'failed', failure: classifyTransportError(error) };
    }
  };
  const page = await get(args.url);
  if (page.kind === 'failed') return empty(page.failure);
  if (page.refused !== null) return empty(page.refused);
  const html = page.exchange.body;
  const exchanges: CapturedExchange[] = [];
  // Un point d'accès confirmé par le code (dossier d'enquête, 19c § 3) : la reconnaissance se réduit à ce qui manque (la page et
  // ses blobs), sans relire les URL de données des scripts.
  for (const url of args.skipDiscovery === true ? [] : discoverScriptEndpoints(html, page.exchange.url, STATIC_MAX_ENDPOINTS)) {
    // Domaines de l'API (et, en tunnel, du site connecté dans l'extension) seulement.
    if (!args.allowHost(new URL(url).hostname)) continue;
    // En tunnel, la requête part avec les cookies de session de l'utilisateur : une URL d'action trouvée dans un script
    // (`/logout`, `/unsubscribe`, `/cart/clear`, souvent dans un gestionnaire de clic) n'est jamais rejouée.
    if (args.mode === 'tunnel' && isActionUrl(url)) continue;
    const res = await get(url);
    if (res.kind === 'failed') return empty(res.failure);
    if (res.refused !== null) {
      // Un refus ou un défi arrête tout (INV6) ; un 404 ou une page sans JSON n'est qu'une voie vide.
      if (!failureRoute(res.refused.failure_class).agent) return empty(res.refused);
      continue;
    }
    exchanges.push({
      url: res.exchange.url,
      method: 'GET',
      requestBody: null,
      requestContentType: null,
      status: res.exchange.status,
      contentType: res.exchange.headers['content-type'] ?? '',
      body: res.exchange.body,
      bytes: Buffer.byteLength(res.exchange.body),
    });
  }
  const docBytes = Buffer.byteLength(html);
  return {
    capture: {
      mode: args.mode,
      pageUrl: args.url,
      document: { url: page.exchange.url, status: page.exchange.status, html, renderedHtml: null, bytes: docBytes },
      exchanges,
      totalBytes: docBytes + exchanges.reduce((s, e) => s + e.bytes, 0),
    },
    failure: null,
    // Session partagée avec l'étape 0 : son coût est compté une fois, par l'appelant.
    proxyUsd: 0,
    requests,
  };
}

/**
 * Ports de la sonde du dossier (19c § 3) : portée (hôtes de l'API, http ou https), puis GET par la session réseau de
 * l'enquête (garde SSRF à chaque saut, plafond de coût, User-Agent du robot), cadencé comme la reconnaissance ; classifieur
 * de 04 § 7. Le robots.txt n'est jamais lu par la sonde (D-91). Coût : différence d'usage de la session (imputé au budget
 * d'enquête).
 */
function briefProbePorts(ports: AccessPorts, scope: string, pacer: RequestPacer | undefined, signal: AbortSignal, now: () => number): BriefProbePorts {
  return {
    now,
    check: async (url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { allowed: false, failure: { failure_class: 'code_error', retryable: false, detail: 'invalid_url' } };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { allowed: false, failure: { failure_class: 'code_error', retryable: false, detail: 'invalid_url' } };
      if (!withinSiteScope(parsed.hostname, scope)) return { allowed: false, failure: { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } };
      return { allowed: true };
    },
    get: async (url) => {
      const before = ports.proxyUsd();
      const started = now();
      if (pacer !== undefined) {
        const slot = await pacer.acquire(url);
        if (!slot.granted) return { failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }, costUsd: 0, ms: 0 };
      }
      try {
        const exchange = await ports.probe(url, signal);
        const refused = classifyExchange(exchange, { requestUrl: url });
        await pacer?.report(url, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null, failureClass: refused?.failure_class ?? null }).catch(() => undefined);
        return { exchange, costUsd: round6(Math.max(0, ports.proxyUsd() - before)), ms: Math.max(0, now() - started) };
      } catch (error) {
        signal.throwIfAborted();
        return { failure: classifyTransportError(error), costUsd: round6(Math.max(0, ports.proxyUsd() - before)), ms: Math.max(0, now() - started) };
      }
    },
    classify: (exchange, url) => classifyExchange(exchange, { requestUrl: url }),
    records: (exchange, url) => {
      const host = (() => {
        try {
          return new URL(url).hostname.toLowerCase();
        } catch {
          return '';
        }
      })();
      const found = analyzeCapture({ mode: 'static', pageUrl: url, document: null, exchanges: [briefCaptured({ ...exchange, url })], totalBytes: 0 }, [host]);
      const best = found.filter((c) => c.unsupported === undefined).sort((a, b) => b.count - a.count)[0];
      return best === undefined ? null : best.count;
    },
  };
}

/** Réponse d'un indice vérifié : échange capturé (gabarit déclaré par le code), sans en-tête d'authentification ni cookie. */
function briefCaptured(exchange: HttpExchange): CapturedExchange {
  return { url: exchange.url, method: 'GET', requestBody: null, requestContentType: null, status: exchange.status, contentType: exchange.headers['content-type'] ?? '', body: exchange.body, bytes: Buffer.byteLength(exchange.body) };
}

/**
 * Faits du code après une enquête conforme (19c § 4, § 6) : `brief_hint_outcomes`, récit en codes (`brief.report`) et, pour
 * chaque indice utilisé et vérifié d'un type éligible, l'événement de preuve `brief_hint_verified` (un par clé et par jour,
 * run réel seulement) pour le moteur de propositions de 2.11.
 */
async function recordBriefOutcome(
  pool: pg.Pool,
  ctx: RunCtx,
  version: number,
  finals: ReturnType<typeof finalizeBriefHints>,
  now: () => number,
  event: (kind: string, payload?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const at = new Date(now());
  await saveHintOutcomes(pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version, hints: finals, now: at });
  await event('brief.report', { version, hints: finals.map((h) => ({ id: h.id, kind: h.kind, state: h.state, reason: h.reason, provenance: h.provenance })) });
  const day = at.toISOString().slice(0, 10);
  for (const h of verifiedForPromotion(finals)) {
    if (await claimHintVerifiedEvent(pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, identityKey: h.identity_key, day })) {
      await event('brief_hint_verified', { identity_key: h.identity_key, hint_id: h.id, kind: h.kind, provenance: h.provenance, items: h.probe?.items_conform ?? null });
    }
  }
}

/**
 * Exécuteur du worker : la nature du run (`runs.kind`, posée à la création, jamais tirée de l'entrée de l'appelant)
 * choisit entre l'exécution d'une stratégie et l'enquête.
 */
export function dispatchByKind(executors: { readonly run: RunExecutor; readonly investigation: RunExecutor }): RunExecutor {
  return (ctx) => (ctx.kind === 'investigation' ? executors.investigation(ctx) : executors.run(ctx));
}
