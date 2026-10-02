// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur des runs d'enquête (`runs.kind = investigation`, tâche 2.1, 04 §2-§4, figure 1). Une enquête tient en un
// ou deux runs : premier appel (étape 0, reconnaissance, schéma proposé ; s'arrête en `awaiting_schema_validation` sauf
// `auto_validate`), puis, après `validate_schema`, les essais. Chaque run refait l'étape 0 (relue au plus toutes les
// 24 h, cache de robots.txt) : la base refuse tout essai sans rapport d'accès favorable antérieur (0015).
// 0. Rapport d'accès (1.11) : robots.txt sans option (INV11), signaux, 402 ; contact d'instance exigé (17 §5) ; identité
//    des runs (D-33) : User-Agent réel du moteur, jeton d'instance et `From` seulement avec `identify_instance`. Refus →
//    `bloquee` / `action_requise` / `erreur` (transitions 2, 3, 4), aucune autre requête.
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
//    ses gardes (robots, SSRF, verrou de domaines, cadence, plafonds, classification avant extraction). Un couple = un
//    essai journalisé (`run_attempts`, INV2, INV4) et un `attempt.finished` ; un élagage = un `attempt.pruned`.
// 4. Fin : stratégie v1 (`created_by = investigation` ; une trace E6 n'est gardée que compilée en E5, 04 §3.1), schéma de
//    sortie validé et schéma d'entrée proposé posés sur l'API, résultat livré (dataset du run), statut `sain` (1) ; sinon
//    `bloquee`, `action_requise` ou `erreur` (2, 3, 21). Toute fin ferme la phase et le récit.
// Plafonds : `investigation_budget_usd` (coût imputé de tout le run d'enquête, cumulé sur ses runs ; chaque exécution
// d'un couple sous le plus petit de `max_cost_usd` et du budget restant) et `investigation_timeout_s` (échéance de chaque
// phase : étape 0, reconnaissance, appel LLM, essais), nombre d'essais. Rien ne s'élargit : réseaux de la politique de
// l'API et proxys de l'admin seulement, jamais de tunnel ni de proxy après un refus (X3, X4), jamais de valeur du site
// dans un prompt.
import {
  type FailureClass,
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
  ROBOTS_MAX_BYTES,
  RobotsCache,
  RobotsGate,
  sessionAccessProbe,
  sessionRobotsFetcher,
  type AccessProbe,
  type AccessReport,
  type RobotsFetcher,
} from '@runtime/core/access';
import { classifyExchange, classifyTransportError, domainRequestPacer, failureRoute, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import {
  analyzeCapture,
  buildFromProposal,
  buildTrialPlan,
  discoverScriptEndpoints,
  INVESTIGATION_DEFAULTS,
  INVESTIGATION_EVENTS as EV,
  isActionUrl,
  narrativeUrl,
  PROPOSAL_HARD_MAX_PAGES,
  rematchCandidates,
  retainedStrategy,
  runTrials,
  siteScope,
  storedCandidate,
  withinSiteScope,
  type CapturedExchange,
  type DataCandidate,
  type PairOutcome,
  type PlanEntry,
  type PlanNetwork,
  type ReconCapture,
  type TokenPrice,
  type TrialExecution,
  type TrialPair,
  type TrialPurpose,
  type TrialsOutcome,
} from '@runtime/core/investigation';
import {
  buildNetworkRungs,
  checkSiteDomain,
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
import { buildInputSchema, type DomainPacer } from '@runtime/core';
import { investigateCallCeilingUsd, investigatePromptVersion, proposeInvestigation } from '@runtime/agent';
import {
  appendInvestigationEvent,
  loadInvestigation,
  loadRunTarget,
  readProxySettings,
  recordAccessReport,
  saveInvestigationState,
  saveInvestigationStrategy,
  saveRunDataset,
  type InvestigationState,
  type RunTarget,
} from '@runtime/db';
import { LlmError, roleTarget, toFailureClass, type LlmClient, type LlmConfig } from '@runtime/llm';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import type { BrowserPool } from '../browser/pool.js';
import type { TunnelPort } from '../tunnel/client.js';
import { runReconnaissancePass } from './browser-executors.js';
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
  readonly robotsCache?: RobotsCache;
  readonly instanceContact?: () => Promise<string | null>;
  /** Réglage `identify_instance` (désactivé par défaut) : jeton d'instance et `From`, comme les runs (D-33, 17 §5). */
  readonly identifyInstance?: () => Promise<boolean>;
  readonly version?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Exécutions conformes exigées par couple (défaut `INVESTIGATION_SAMPLES` = 3). */
  readonly samples?: number;
};

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const BLOCKING = new Set<FailureClass>(['blocked_by_protection', 'forbidden', 'robots_disallowed']);
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
 * Entrée d'une exécution d'essai : les N exécutions d'échantillon lisent au plus 2 pages (la page 2 est exigée, 04 §4) ;
 * l'exécution de vérification de la règle d'arrêt va jusqu'au plafond dur de pages (tâche 2.2).
 */
const trialInput = (paginated: boolean, purpose: TrialPurpose): Record<string, unknown> => (paginated ? { max_pages: purpose === 'stop_check' ? PROPOSAL_HARD_MAX_PAGES : 2 } : {});

/** Récit de la vérification de la règle d'arrêt (codes et nombres, aucune valeur du site). */
const stopCheckView = (o: PairOutcome) => (o.stop_check === null ? undefined : { verified: o.stop_check.verified, stop: o.stop_check.stop, pages: o.stop_check.pages, ...(o.stop_check.reason === undefined ? {} : { reason: o.stop_check.reason }) });

/** Transport de l'étape 0 et de la reconnaissance : réseau serveur (N1-N3) ou tunnel de l'extension (session requise). */
type AccessPorts = {
  readonly mode: 'server' | 'tunnel';
  readonly robots: RobotsGate;
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

type SessionBase = Omit<Parameters<typeof openNetworkSession>[0], 'allowedHosts' | 'allowedHostSuffixes' | 'costCeiling' | 'checkUrl'>;

/**
 * Événement de statut d'une fin d'enquête en échec (04 §6) : refus et défis (4), connexion, paiement, limite de compte (3)
 * par `run_failed` ; robots.txt injoignable (2) ; seule une trace E6 non compilable en E5 conforme, sans `instructed_mode`
 * (2.13, 19 §4) : `not_compilable` (2, ou 21 pour une ré-enquête) ; tout le reste : budget épuisé (2 ou 21).
 */
export function investigationFailureEvent(failure: ExecFailure): StatusEventInput {
  const cls = failure.failure_class;
  if (BLOCKING.has(cls) || ACTION.has(cls)) return { type: 'run_failed', failureClass: cls, ...(failure.status === undefined ? {} : { httpStatus: failure.status }) };
  if (cls === 'robots_unreachable') return { type: 'investigation_failed', cause: 'robots_unreachable' };
  if (failure.detail === 'not_compilable') return { type: 'investigation_failed', cause: 'not_compilable' };
  return { type: 'investigation_failed', cause: 'budget_exhausted' };
}

export function createInvestigationExecutor(deps: InvestigationExecutorDeps): RunExecutor {
  const now = deps.now ?? Date.now;
  const robotsCache = deps.robotsCache ?? new RobotsCache();
  const logger = deps.logger ?? pino({ enabled: false });

  return async (ctx: RunCtx): Promise<RunResult> => {
    const started = now();
    const inv = await loadInvestigation(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId });
    const target = await loadRunTarget(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: null });
    if (inv === null || target === null) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'api_not_found' };
    if (inv.state === null) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'investigation_not_started' };
    let state: InvestigationState = inv.state;
    let phase: InvestigationPhase | null = inv.phase;
    const request = state.request;
    const pageUrl = new URL(request.url).href;
    const host = new URL(pageUrl).hostname.toLowerCase();
    // Domaines de l'API (04b §2) : la page et ses sous-domaines (ou ceux du domaine sans `www.`), jamais un voisin.
    const scope = siteScope(host);
    const baseElapsed = state.elapsed_ms;
    const deadlineMs = started + Math.max(0, request.timeout_s * 1000 - baseElapsed);
    // `investigation_timeout_s` borne CHAQUE phase (étape 0, reconnaissance, appel LLM, essais), pas seulement les essais.
    const deadline = AbortSignal.timeout(Math.max(1, deadlineMs - now()));
    const signal = AbortSignal.any([ctx.signal, deadline]);
    const timedOut = () => !ctx.signal.aborted && (deadline.aborted || now() >= deadlineMs);
    let spent = state.spent_usd;
    const budgetView = () => ({ spent_usd: spent, max_usd: request.budget_usd, elapsed_s: Math.round((baseElapsed + now() - started) / 1000), timeout_s: request.timeout_s });
    const event = (kind: string, payload: Record<string, unknown> = {}) =>
      appendInvestigationEvent(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, kind, payload: { run_id: ctx.runId, ...payload } });
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
     * `bloquee` (4), connexion, paiement, limite de compte → `action_requise` (3), robots.txt injoignable → `erreur` (2) ;
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
    const finishStopped = async (reason: 'proxy_not_configured' | 'tunnel_offline', detail: string, at: string): Promise<RunResult> => {
      await save('done');
      await event(EV.actionRequired, { cause: reason, domain: host });
      await event(EV.finished, { outcome: 'stopped', stop_reason: reason, detail, at, budget: budgetView() });
      return { state: 'failed', failure_class: null, stop_reason: reason, retryable: false, error_detail: detail };
    };
    /** Budget, durée ou nombre d'essais épuisés sans stratégie conforme : `erreur` (2) ou statut précédent (21). */
    const budgetExhausted = async (reason: string): Promise<RunResult> => {
      await save('done');
      await applyStatus({ type: 'investigation_failed', cause: 'budget_exhausted' });
      await event(EV.finished, { outcome: 'budget_exhausted', reason, budget: budgetView() });
      return { state: 'failed', failure_class: 'run_budget_exceeded', retryable: false, error_detail: reason };
    };

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
      if (error instanceof InstanceContactError) return await finishFailed({ failure_class: 'code_error', retryable: false, detail: error.code }, 'setup');
      throw error;
    }
    const pacerFor = (robots?: RobotsGate): RequestPacer | undefined =>
      deps.pacer === undefined
        ? undefined
        : domainRequestPacer(deps.pacer, {
            ...(target.api.domainPacing.min_delay_ms === undefined ? {} : { minDelayMs: target.api.domainPacing.min_delay_ms }),
            ...(target.api.domainPacing.max_wait_ms === undefined ? {} : { maxWaitMs: target.api.domainPacing.max_wait_ms }),
            ...(robots === undefined ? {} : { crawlDelayMs: robots.crawlDelayMs }),
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
      const robots = new RobotsGate({
        fetch: tunnelRobotsFetcher(tunnel),
        cache: robotsCache,
        signal,
        allowedHosts: [host],
        allowedHostSuffixes: [scope],
        ...(pacerFor() === undefined ? {} : { pacer: pacerFor()! }),
      });
      ports = {
        mode: 'tunnel',
        robots,
        // Corps borné comme la reconnaissance : en tunnel, une page plus grosse que la borne serait refusée, pas tronquée.
        probe: tunnelProbe(tunnel, STATIC_MAX_BYTES),
        reconProbe: tunnelProbe(tunnel, STATIC_MAX_BYTES),
        pacer: pacerFor(robots),
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
      // Étape 0 et reconnaissance sous le plus petit de `max_cost_usd` et du budget restant de l'enquête.
      const ceiling = Math.max(0, Math.min(target.api.maxCostUsd, request.budget_usd - spent));
      const sessionBase: SessionBase = {
        rung,
        guard: deps.guard,
        ...(credentials === undefined ? {} : { credentials }),
        ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
        userAgent,
        ...(from === null ? {} : { from }),
      };
      const robotsSession = openNetworkSession({ ...sessionBase, costCeiling: { maxUsd: ceiling } });
      const robots = new RobotsGate({
        fetch: sessionRobotsFetcher(robotsSession),
        cache: robotsCache,
        signal,
        allowedHosts: [host],
        allowedHostSuffixes: [scope],
        ...(pacerFor() === undefined ? {} : { pacer: pacerFor()! }),
      });
      const session: NetworkSession = openNetworkSession({
        ...sessionBase,
        allowedHosts: [host],
        allowedHostSuffixes: [scope],
        checkUrl: robots.checkUrl,
        costCeiling: { maxUsd: ceiling, otherUsd: () => robotsSession.usage().costUsd },
      });
      ports = {
        mode: 'server',
        robots,
        probe: sessionAccessProbe(session),
        reconProbe: sessionAccessProbe(session, STATIC_MAX_BYTES),
        pacer: pacerFor(robots),
        proxyUsd: () => robotsSession.usage().costUsd + session.usage().costUsd,
        tunnel: null,
        server: { sessionBase, ceiling },
        close: async () => {
          await session.close().catch(() => undefined);
          await robotsSession.close().catch(() => undefined);
        },
      };
    }
    const { robots, pacer } = ports;
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
      const report: AccessReport = await buildAccessReport({ url: pageUrl, gate: robots, probe: ports.probe, ...(pacer === undefined ? {} : { pacer }), signal, now });
      const stopped0 = await tunnelOutcome('access_check');
      if (stopped0 !== null) return stopped0;
      await recordAccessReport(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, payload: accessReportEventPayload(report) });
      if (!report.verdict.proceed) {
        await charge(ctx, ports.proxyUsd());
        spent = round6(spent + ports.proxyUsd());
        return await finishFailed(report.verdict.failure, 'access_check');
      }
      if (timedOut()) return await budgetExhausted('investigation_timeout_s');

      // --- 1. Reconnaissance (à chaque run : l'état ne garde aucune valeur du site, 17 §6) ------------------------
      // Premier run : gisements frais. Run des essais (schéma validé) : mêmes gisements, retrouvés sous leurs identifiants.
      const firstRun = state.validated_schema === undefined;
      if (firstRun) {
        await save('reconnaissance');
        await event(EV.phase, { phase: 'reconnaissance', budget: budgetView() });
      }
      const recon =
        ports.mode === 'tunnel'
          ? await staticRecon(ports.reconProbe, { url: pageUrl, allowHost: (h) => withinSiteScope(h, scope) && hostWithinDomain(h, ports.tunnel!.domain), signal, robots, mode: 'tunnel', ...(pacer === undefined ? {} : { pacer }) })
          : deps.browsers !== null
            ? await browserRecon(deps, { url: pageUrl, host, scope, signal, robots, userAgent, sessionBase: ports.server!.sessionBase, ceiling: ports.server!.ceiling, otherUsd: ports.proxyUsd, ...(pacer === undefined ? {} : { pacer }) })
            : await staticRecon(ports.reconProbe, { url: pageUrl, allowHost: (h) => withinSiteScope(h, scope), signal, robots, mode: 'static', ...(pacer === undefined ? {} : { pacer }) });
      await charge(ctx, ports.proxyUsd() + recon.proxyUsd);
      spent = round6(spent + ports.proxyUsd() + recon.proxyUsd);
      const stopped1 = await tunnelOutcome('reconnaissance');
      if (stopped1 !== null) return stopped1;
      const capture: ReconCapture = recon.capture;
      const fresh = recon.failure === null ? analyzeCapture(capture, apiHostsOf(capture, host, scope)) : [];
      const candidates: readonly DataCandidate[] = firstRun ? fresh : rematchCandidates(state.candidates ?? [], fresh);
      await event(EV.reconnaissance, {
        mode: capture.mode,
        ...(recon.failure === null ? {} : { failure_class: recon.failure.failure_class, detail: recon.failure.detail }),
        candidates: candidates.map((c) => ({
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
        budget: budgetView(),
      });
      if (recon.failure !== null) return await finishFailed(recon.failure, 'reconnaissance');
      // État : gisements SANS valeur (origine, chemin, noms de paramètres) ; ceux du premier run gardent leurs identifiants.
      await save(firstRun ? 'reconnaissance' : phase, {
        candidates: firstRun ? fresh.map(storedCandidate) : (state.candidates ?? []),
        page: { url: pageUrl, host, document_bytes: capture.document?.bytes ?? 0, total_bytes: capture.totalBytes, mode: capture.mode },
      });
      if (spent >= request.budget_usd) return await budgetExhausted('investigation_budget_usd');
      if (timedOut()) return await budgetExhausted('investigation_timeout_s');

      // --- 2. Schéma de sortie d'abord ------------------------------------------------------------------------------
      const config = deps.llm === undefined ? null : await deps.llm.config().catch(() => null);
      // Voies agentiques essayables (E4 par le réseau, E6 avec Chromium) : un schéma sans gisement de données leur reste ouvert.
      const agenticOnly = deps.agentic === true && (rolePrice(config, 'extract') !== undefined || (deps.browsers !== null && rolePrice(config, 'agent') !== undefined));
      const fixed = state.validated_schema;
      let proposal = state.proposal;
      const remap = proposal !== undefined && fixed !== undefined && JSON.stringify(fixed) !== JSON.stringify(state.proposed_schema);
      if (proposal === undefined || remap) {
        if (deps.llm === undefined || config === null || config.roles.investigate === undefined) {
          return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }, 'setup');
        }
        if (!agenticOnly && candidates.filter((c) => c.unsupported === undefined).length === 0) {
          return await finishFailed({ failure_class: 'extraction', retryable: false, detail: candidates.length > 0 ? 'client_signature' : 'no_data_source' }, 'reconnaissance');
        }
        let client: LlmClient;
        try {
          client = deps.llm.client({ ...config, roles: { investigate: config.roles.investigate } });
        } catch {
          return await finishFailed({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }, 'setup');
        }
        const model = config.roles.investigate.model;
        const exampleOutput = (ctx.input as { example_output?: unknown } | null)?.example_output;
        const args = {
          description: request.description,
          ...(exampleOutput === undefined ? {} : { exampleOutput }),
          candidates,
          accessFacts: accessFactsForPrompt(report),
          ...(fixed === undefined ? {} : { fixedSchema: fixed }),
        };
        // Coût d'un appel borné AVANT l'envoi (sortie plafonnée, entrée estimée par excès) : jamais un appel qui
        // ferait dépasser `investigation_budget_usd` ; prix inconnu → aucun appel (08 §1, jamais 0).
        const price = rolePrice(config, 'investigate');
        if (price === null || price === undefined) {
          await ctx.log('warn', 'llm_price_missing', { model, role: 'investigate' });
          return await finishFailed({ failure_class: 'run_budget_exceeded', retryable: false, detail: 'llm_price_missing' }, 'schema');
        }
        const callCeiling = investigateCallCeilingUsd(args, price);
        let llmFailure: ExecFailure | null = null;
        try {
          const out = await proposeInvestigation(client, {
            ...args,
            signal,
            beforeCall: () => {
              if (spent + (client.meter.snapshot().cost_usd_known ?? 0) + callCeiling > request.budget_usd) throw new BudgetGuardError();
            },
          });
          proposal = out.proposal;
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
          await ctx.log('warn', 'llm_price_missing', { model, role: 'investigate' });
          return await finishFailed({ failure_class: 'run_budget_exceeded', retryable: false, detail: 'llm_price_missing' }, 'schema');
        }
        spent = round6(spent + usage.cost_usd);
        if (llmFailure !== null) {
          if (llmFailure.failure_class === 'run_budget_exceeded') return await budgetExhausted(llmFailure.detail);
          return await finishFailed(llmFailure, 'schema');
        }
        await ctx.log('info', 'investigate_call', { model, prompt_version: investigatePromptVersion, llm_usd: usage.cost_usd, calls: usage.calls });
      }
      const built = buildFromProposal(proposal!, candidates, fixed === undefined ? capture : null, { ...(fixed === undefined ? {} : { fixedSchema: fixed }), agenticOnly });
      if (!built.ok) {
        await event(EV.schemaProposed, { ok: false, reason: built.reason, rejected: built.rejected, budget: budgetView() });
        return await finishFailed({ failure_class: 'extraction', retryable: false, detail: built.reason }, 'schema');
      }
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
        if (spent >= request.budget_usd) return await budgetExhausted('investigation_budget_usd');
        if (!request.auto_validate) {
          await save('awaiting_schema_validation', { proposal: proposal!, proposed_schema: built.outputSchema });
          await event(EV.phase, { phase: 'awaiting_schema_validation', budget: budgetView() });
          return { state: 'succeeded', outcome: 'clean', degraded_reasons: [], items: 0 };
        }
        await save('testing', { proposal: proposal!, proposed_schema: built.outputSchema, validated_schema: built.outputSchema, validated_by: 'auto' });
        await event(EV.schemaValidated, { by: 'auto' });
        await ctx.log('info', 'schema_auto_validated', {});
      } else if (remap) {
        await save(phase, { proposal: proposal! });
      }
      const outputSchema = built.outputSchema;
      if (spent >= request.budget_usd) return await budgetExhausted('investigation_budget_usd');
      if (timedOut()) return await budgetExhausted('investigation_timeout_s');

      // --- 3. Essais du moins cher au plus cher --------------------------------------------------------------------
      await save('testing');
      // Session requise (04 §3.2, C2) : seul le tunnel porte l'identité de l'utilisateur. Le serveur n'utilise aucun
      // cookie de session en V1 : un essai N1/N2 partirait sans la session (401/403 → arrêt, puis tunnel élagué, X3)
      // ou retiendrait une stratégie serveur sans session pour une API à session. Le plan se limite donc au tunnel.
      const networks: PlanNetwork[] = sessionRequired
        ? [{ mode: 'tunnel', perGbUsd: 0 }]
        : [...rungs.map((r) => ({ mode: r.mode, perGbUsd: r.mode === 'direct' ? 0 : r.proxy.price.perGbUsd })), ...(tunnelChosen ? [{ mode: 'tunnel' as const, perGbUsd: 0 }] : [])];
      const plan = buildTrialPlan({
        strategies: built.strategies,
        networks,
        browser: deps.browsers !== null,
        agentic: deps.agentic === true ? { ...(rolePrice(config, 'extract') === undefined ? {} : { extract: rolePrice(config, 'extract')! }), ...(rolePrice(config, 'agent') === undefined ? {} : { agent: rolePrice(config, 'agent')! }) } : {},
        pageUrl,
        pageHost: host,
        instruction: request.description,
        documentBytes: state.page?.document_bytes ?? 0,
        totalBytes: state.page?.total_bytes ?? 0,
      });
      await event(EV.phase, {
        phase: 'testing',
        plan: plan.map((p) => ({ execution: p.execution, network: p.network, source: p.source, est_cost_usd: p.est_cost_usd })),
        budget: budgetView(),
      });
      const entries = new Map<TrialPair, PlanEntry>(plan.map((p) => [p, p]));
      const lastRecords = new Map<TrialPair, Record<string, unknown>[]>();
      /** Trace E6 compilée en E5 par la dernière exécution conforme du couple (04 §3.1). */
      const compiledFor = new Map<TrialPair, unknown>();
      const spend = new Map<TrialPair, { proxy: number; llm: number | null; tokens: { in: number; cached: number; out: number; reasoning: number; estimated: boolean }; model: string | null; prompt: string | null; engine: string | null }>();
      const spentBeforeTrials = spent;
      let trialsUsd = 0;
      let outcome: TrialsOutcome;
      try {
        outcome = await runTrials(
          plan,
          {
            now,
            execute: async (pair, index, limits, purpose = 'sample') => {
              const entry = entries.get(pair)!;
              const trialTarget: RunTarget = {
                api: { ...target.api, outputSchema, maxCostUsd: limits.ceilingUsd },
                strategy: { version: 0, execution: entry.execution, network: entry.network, spec: entry.spec, scriptRef: null, estCostUsd: entry.est_cost_usd, compilable: 'unknown', sourceSteps: null, instructedSteps: null },
              };
              const timeout = AbortSignal.timeout(Math.max(1, limits.deadlineMs - now()));
              const trialCtx: RunCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, timeout]), input: trialInput(entry.paginated, purpose) };
              let trial: StrategyTrial;
              try {
                trial = await deps.strategy.trial(trialCtx, trialTarget, trialTarget.strategy!);
              } catch (error) {
                if (ctx.signal.aborted) throw error;
                if (timeout.aborted) return execution(false, 'run_budget_exceeded', 'investigation_timeout_s', 0, null, 0, null);
                logger.warn({ runId: ctx.runId, err: error instanceof Error ? error.name : 'error' }, 'enquête : essai en erreur');
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
              const cost = trial.llmUsd === null ? null : round6(trial.proxyUsd + trial.llmUsd);
              trialsUsd = round6(trialsUsd + (cost ?? 0));
              const r = trial.result;
              const stop = trial.outcome.stop;
              // Extension hors ligne (04 §6, transition 3) : arrêt SANS classe d'échec, aucun essai journalisé (comme un run).
              if (stop === 'tunnel_offline') throw new TunnelOfflineStop();
              if (stop === 'challenge_in_tunnel') return execution(false, 'blocked_by_protection', 'challenge_in_tunnel', r.pages, cost, trial.ms, null);
              if (trial.outcome.needsUser === true && !r.ok) return execution(false, 'auth_required', 'site_not_connected', r.pages, cost, trial.ms, null);
              if (cost === null) return execution(false, 'run_budget_exceeded', 'llm_price_missing', r.pages, null, trial.ms, null);
              if (cost > limits.ceilingUsd) return execution(false, 'run_budget_exceeded', 'max_cost_usd', r.pages, cost, trial.ms, null);
              if (!r.ok) {
                const f = trial.guardedFailure ?? r.failure;
                return execution(false, f.failure_class, f.detail, r.pages, cost, trial.ms, null);
              }
              // E6 réussi sans trace compilable en E5 : jamais retenu (04 §3.1, pas d'agent à chaque run sans `instructed_mode`).
              if (entry.execution === 'agent') {
                const compiled = trial.outcome.agent?.compiled;
                if (compiled === undefined) return execution(false, 'extraction', 'not_compilable', r.pages, cost, trial.ms, null);
                compiledFor.set(pair, compiled);
              }
              lastRecords.set(pair, r.records);
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
              });
              await event(EV.attemptFinished, {
                attempt: { execution: o.pair.execution, network: o.pair.network, est_cost_usd: o.pair.est_cost_usd, result: o.result, cost_usd: o.cost_usd, ms: o.ms },
                source: o.pair.source,
                ...(o.detail === null ? {} : { why: { code: o.detail, params: {} } }),
                executions: o.executions.map((e) => ({ ok: e.ok, records: e.records, pages: e.pages, stop: e.stop, cost_usd: e.cost_usd, ms: e.ms })),
                ...(stopCheckView(o) === undefined ? {} : { pagination: stopCheckView(o) }),
                budget: budgetView(),
              });
            },
            pruned: async (pairs, by, cls) => {
              await event(EV.attemptPruned, {
                by: { execution: by.execution, network: by.network, source: by.source },
                reason: cls,
                pruned: pairs.map((p) => ({ execution: p.execution, network: p.network, source: p.source, est_cost_usd: p.est_cost_usd })),
              });
            },
          },
          { maxUsd: request.budget_usd, spentUsd: spent, deadlineMs, maxAttempts: INVESTIGATION_DEFAULTS.maxAttempts, maxCostPerRunUsd: target.api.maxCostUsd },
          { ...(deps.samples === undefined ? {} : { samples: deps.samples }), paginated: (p) => entries.get(p)?.paginated === true },
        );
      } catch (error) {
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
          const records = lastRecords.get(pair) ?? [];
          const runs = Math.max(1, outcome.outcome.executions.length);
          const kept = retainedStrategy(entry, compiledFor.get(pair), round6((spend.get(pair)?.proxy ?? 0) / runs));
          if (!kept.ok) return await finishFailed({ failure_class: 'extraction', retryable: false, detail: kept.reason }, 'testing');
          const saved = await saveInvestigationStrategy(deps.pool, {
            apiId: ctx.apiId,
            ownerId: ctx.ownerId,
            execution: kept.execution,
            network: kept.network,
            spec: kept.spec,
            estCostUsd: kept.estCostUsd,
            outputSchema,
            inputSchema: buildInputSchema({ paginated: entry.paginated, maxPages: PROPOSAL_HARD_MAX_PAGES }),
            state: { ...state, spent_usd: spent, elapsed_ms: baseElapsed + Math.max(0, now() - started) },
          });
          phase = 'done';
          // Résultat livré (figure 1, étape I) : la sortie de la dernière exécution conforme, écrite comme le propriétaire.
          const dataset = await saveRunDataset(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, projectId: target.api.projectId, items: records });
          await applyStatus({ type: 'investigation_succeeded' });
          await event(EV.finished, {
            outcome: 'conformant',
            strategy: { version: saved.version, execution: kept.execution, network: kept.network, source: entry.source, est_cost_usd: kept.estCostUsd, ...(kept.execution !== entry.execution ? { compiled_from: entry.execution } : {}) },
            items: records.length,
            ...(stopCheckView(outcome.outcome) === undefined ? {} : { pagination: stopCheckView(outcome.outcome) }),
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
          const last = outcome.tried.at(-1);
          const lastClass = last?.result;
          const detail = last?.detail === 'not_compilable' ? 'not_compilable' : 'no_conformant_strategy';
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

/** Garde du budget avant un appel du rôle `investigate` (levée par `beforeCall`, jamais réessayée). */
class BudgetGuardError extends Error {
  override name = 'BudgetGuardError';
}

/** Extension hors ligne pendant un essai : arrêt des essais sans classe d'échec. */
class TunnelOfflineStop extends Error {
  override name = 'TunnelOfflineStop';
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

/** Lecture de robots.txt par l'extension (`page_fetch`, redirections suivies par le navigateur), corps borné. */
function tunnelRobotsFetcher(session: TunnelSession): RobotsFetcher {
  const transport = pageFetchTransport(session, ROBOTS_MAX_BYTES);
  return async (url, signal) => {
    const res = await transport({ method: 'GET', url, headers: { accept: 'text/plain, */*;q=0.1' } }, signal);
    return { status: res.status, location: null, body: res.status >= 200 && res.status < 300 ? res.body : '', truncated: false };
  };
}

/** Sonde par l'extension (`page_fetch` dans un onglet du site) : un défi détecté arrête le tunnel sur-le-champ. */
function tunnelProbe(session: TunnelSession, maxBytes: number): AccessProbe {
  const transport = pageFetchTransport(session, maxBytes);
  return (url, signal) => transport({ method: 'GET', url, headers: {} }, signal);
}

type ReconOutcome = { readonly capture: ReconCapture; readonly failure: ExecFailure | null; readonly proxyUsd: number };

/** Reconnaissance par Chromium : passe E3 sur le premier réseau autorisé, proxy d'egress propre à la passe. */
async function browserRecon(
  deps: InvestigationExecutorDeps,
  args: {
    url: string;
    host: string;
    scope: string;
    signal: AbortSignal;
    robots: RobotsGate;
    userAgent: string;
    sessionBase: SessionBase;
    ceiling: number;
    otherUsd: () => number;
    pacer?: RequestPacer;
  },
): Promise<ReconOutcome> {
  const egress = await openBrowserEgress({
    ...args.sessionBase,
    allowedHosts: [args.host],
    allowedHostSuffixes: [args.scope],
    checkUrl: args.robots.checkUrl,
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
      signal: args.signal,
      access: args.robots.access,
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
 * de l'API), chacune cadencée, contrôlée par robots.txt et classée ; un refus sur l'une arrête la reconnaissance (INV6).
 * En tunnel, les URL d'action (`isActionUrl` : déconnexion, suppression, désabonnement…) ne sont jamais rejouées.
 */
async function staticRecon(
  probe: AccessProbe,
  args: { url: string; allowHost: (host: string) => boolean; signal: AbortSignal; robots: RobotsGate; mode: 'static' | 'tunnel'; pacer?: RequestPacer },
): Promise<ReconOutcome> {
  const empty = (failure: ExecFailure | null): ReconOutcome => ({ capture: { mode: args.mode, pageUrl: args.url, document: null, exchanges: [], totalBytes: 0 }, failure, proxyUsd: 0 });
  type Got = { readonly kind: 'failed'; readonly failure: ExecFailure } | { readonly kind: 'got'; readonly exchange: HttpExchange; readonly refused: ExecFailure | null };
  const get = async (url: string): Promise<Got> => {
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
  // La page passe par robots.txt comme ses URL de données (déjà vérifiée par l'étape 0, relue du cache).
  const pageDecision = await args.robots.check(args.url);
  if (!pageDecision.allowed) return empty(pageDecision.failure);
  const page = await get(args.url);
  if (page.kind === 'failed') return empty(page.failure);
  if (page.refused !== null) return empty(page.refused);
  const html = page.exchange.body;
  const exchanges: CapturedExchange[] = [];
  for (const url of discoverScriptEndpoints(html, page.exchange.url, STATIC_MAX_ENDPOINTS)) {
    // Domaines de l'API (et, en tunnel, du site connecté dans l'extension) seulement.
    if (!args.allowHost(new URL(url).hostname)) continue;
    // En tunnel, la requête part avec les cookies de session de l'utilisateur : une URL d'action trouvée dans un script
    // (`/logout`, `/unsubscribe`, `/cart/clear`, souvent dans un gestionnaire de clic) n'est jamais rejouée.
    if (args.mode === 'tunnel' && isActionUrl(url)) continue;
    const decision = await args.robots.check(url);
    if (!decision.allowed) continue; // chemin interdit : 0 requête, la voie n'existe pas pour nous
    const res = await get(url);
    if (res.kind === 'failed') {
      if (res.failure.failure_class === 'robots_disallowed') continue;
      return empty(res.failure);
    }
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
  };
}

/**
 * Exécuteur du worker : la nature du run (`runs.kind`, posée à la création, jamais tirée de l'entrée de l'appelant)
 * choisit entre l'exécution d'une stratégie et l'enquête.
 */
export function dispatchByKind(executors: { readonly run: RunExecutor; readonly investigation: RunExecutor }): RunExecutor {
  return (ctx) => (ctx.kind === 'investigation' ? executors.investigation(ctx) : executors.run(ctx));
}
