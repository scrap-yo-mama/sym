// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur des runs d'enquête (`runs.kind = investigation`, tâche 2.1, 04 §2-§4, figure 1). Une enquête tient en un
// ou deux runs : premier appel (étape 0, reconnaissance, schéma proposé ; s'arrête en `awaiting_schema_validation` sauf
// `auto_validate`), puis, après `validate_schema`, les essais. Chaque run refait l'étape 0 (relue au plus toutes les
// 24 h, cache de robots.txt) : la base refuse tout essai sans rapport d'accès favorable antérieur (0015).
// 0. Rapport d'accès (1.11) : robots.txt sans option (INV11), signaux, 402 ; contact d'instance exigé (17 §5). Refus →
//    `bloquee` / `action_requise` / `erreur` (transitions 2, 3, 4), aucune autre requête.
// 1. Reconnaissance : une passe E3 sur N1 (Chromium : trafic XHR / fetch capturé, document servi et rendu), ou, sans
//    navigateur, la page et les URL de données que ses scripts en ligne appellent ; blobs embarqués cherchés avant de
//    conclure « pas d'API ». Une signature calculée côté client rend la voie `unsupported`, sans tentative (INV6).
// 2. Schéma de SORTIE d'abord (rôle `investigate`, squelettes seulement) : proposé avec un échantillon extrait par le
//    code ; validé par l'appelant (`validate_schema`) ou, avec `auto_validate`, par l'agent, journalisé.
// 3. Essais par coût estimé croissant (`buildTrialPlan`, `runTrials`), élagués par le classifieur, N = 3 exécutions
//    conformes dont une en page 2 si la stratégie pagine ; chaque exécution passe par l'exécuteur de stratégie et TOUTES
//    ses gardes (robots, SSRF, verrou de domaines, cadence, plafonds, classification avant extraction). Un couple = un
//    essai journalisé (`run_attempts`, INV2, INV4) et un `attempt.finished` ; un élagage = un `attempt.pruned`.
// 4. Fin : stratégie v1 (`created_by = investigation`), schéma de sortie validé et schéma d'entrée proposé posés sur
//    l'API, résultat livré (dataset du run), statut `sain` (1) ; sinon `bloquee`, `action_requise` ou `erreur` (2, 21).
// Plafonds : `investigation_budget_usd` et `investigation_timeout_s` (cumulés sur les runs de l'enquête), essais au plus.
// Rien ne s'élargit : réseaux de la politique de l'API et proxys de l'admin seulement, jamais de tunnel ni de proxy après
// un refus (X3, X4), jamais de valeur du site dans un prompt.
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
  buildUserAgent,
  InstanceContactError,
  requireInstanceContact,
  RobotsCache,
  RobotsGate,
  sessionAccessProbe,
  sessionRobotsFetcher,
  type AccessReport,
} from '@runtime/core/access';
import { classifyExchange, classifyTransportError, domainRequestPacer, failureRoute, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import {
  analyzeCapture,
  buildFromProposal,
  buildTrialPlan,
  discoverScriptEndpoints,
  INVESTIGATION_DEFAULTS,
  INVESTIGATION_EVENTS as EV,
  narrativeUrl,
  runTrials,
  type CapturedExchange,
  type DataCandidate,
  type PairOutcome,
  type PlanEntry,
  type PlanNetwork,
  type ReconCapture,
  type TokenPrice,
  type TrialExecution,
  type TrialPair,
} from '@runtime/core/investigation';
import {
  buildNetworkRungs,
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
import type { DomainPacer } from '@runtime/core';
import { investigatePromptVersion, proposeInvestigation } from '@runtime/agent';
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
import { runReconnaissancePass } from './browser-executors.js';
import type { StrategyRuntime, StrategyTrial } from './strategy-executor.js';

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
  readonly llm?: InvestigationLlmPorts;
  /** Exécuteurs agentiques E4-E6 branchés dans l'exécuteur de stratégie : leurs couples entrent alors dans le plan. */
  readonly agentic?: boolean;
  readonly robotsCache?: RobotsCache;
  readonly instanceContact?: () => Promise<string | null>;
  readonly version?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Exécutions conformes exigées par couple (défaut `INVESTIGATION_SAMPLES` = 3). */
  readonly samples?: number;
};

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const BLOCKING = new Set<FailureClass>(['blocked_by_protection', 'forbidden', 'robots_disallowed']);
const ACTION = new Set<FailureClass>(['auth_required', 'payment_required', 'account_limit']);
/** Échecs qui ne disent rien du site (créneau de cadence, panne passagère) : le run échoue, l'enquête reste ouverte. */
const RETRYABLE = new Set<FailureClass>(['rate_limited', 'transient']);
/** Corps d'une page lue par la reconnaissance statique. */
const STATIC_MAX_BYTES = 5_000_000;
const STATIC_MAX_ENDPOINTS = 3;

/** Prix d'un rôle en USD par million de jetons ; `undefined` : rôle non configuré, `null` : prix inconnu. */
function rolePrice(config: LlmConfig | null, role: 'extract' | 'agent'): TokenPrice | null | undefined {
  if (config === null) return undefined;
  const target = roleTarget(config, role);
  if (target === undefined) return undefined;
  const price = 'price' in target.model ? target.model.price : undefined;
  return price === undefined ? null : { in: price.in, out: price.out };
}

/** Schéma d'entrée proposé (04 §4 étape G) : plafond de pages pour une stratégie qui pagine ; le reste relève de 2.2. */
function proposedInputSchema(paginated: boolean): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    description: "Entrée de l'API.",
    properties: paginated ? { max_pages: { type: 'integer', minimum: 1, maximum: 50, description: 'Nombre maximal de pages lues par run (la liste peut finir avant).' } } : {},
    additionalProperties: false,
  };
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
    const baseElapsed = state.elapsed_ms;
    const deadlineMs = started + Math.max(0, request.timeout_s * 1000 - baseElapsed);
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
    /** Fin d'enquête en échec : statut visé par la classe (04 §6), phase close sauf échec passager, récit. */
    const finishFailed = async (failure: ExecFailure, at: string): Promise<RunResult> => {
      const cls = failure.failure_class;
      let statusEvent: StatusEventInput | null;
      if (BLOCKING.has(cls) || ACTION.has(cls)) statusEvent = { type: 'run_failed', failureClass: cls, ...(failure.status === undefined ? {} : { httpStatus: failure.status }) };
      else if (cls === 'robots_unreachable') statusEvent = { type: 'investigation_failed', cause: 'robots_unreachable' };
      else if (RETRYABLE.has(cls) || cls.startsWith('llm_') || (cls === 'code_error' && at === 'setup')) statusEvent = null;
      else statusEvent = { type: 'investigation_failed', cause: 'budget_exhausted' };
      const closes = statusEvent !== null;
      if (closes) await save('done');
      else await save(phase);
      if (ACTION.has(cls)) await event(EV.actionRequired, { cause: cls, domain: host });
      if (statusEvent !== null) await applyStatus(statusEvent);
      await event(EV.finished, { outcome: 'failed', failure_class: cls, detail: failure.detail, at, budget: budgetView() });
      return { state: 'failed', failure_class: cls, retryable: failure.retryable, error_detail: failure.detail };
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
    try {
      rungs = buildNetworkRungs(parseNetworkPolicy(target.api.networkPolicy), parseProxyDefinitions(await readProxySettings(deps.pool)));
    } catch {
      return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'network_config' };
    }
    const tunnelChosen = (() => {
      try {
        return policyAllowsTunnel(target.api.networkPolicy);
      } catch {
        return false;
      }
    })();
    const first = rungs[0];
    if (first === undefined) {
      // Politique sans réseau serveur : un proxy requis manque (transition 3), ou une enquête par le seul tunnel, hors V1.
      if (tunnelChosen) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'investigation_tunnel_only_unsupported' };
      // Run arrêté sans classe d'échec : le worker applique `run_stopped` (transition 3).
      return { state: 'failed', failure_class: null, stop_reason: 'proxy_not_configured', retryable: false, error_detail: 'proxy_not_configured' };
    }
    let credentials: ProxyCredentials | undefined;
    if (first.mode !== 'direct' && first.proxy.credentialsSecretId !== undefined) {
      if (deps.secrets === undefined) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'proxy_credentials_unavailable' };
      try {
        credentials = await loadProxyCredentials(deps.secrets, first.proxy);
      } catch {
        return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: 'proxy_credentials_unavailable' };
      }
    }
    let userAgent: string;
    try {
      // 17 §5 : le contact de l'instance est requis avant toute enquête.
      const contact = requireInstanceContact((await deps.instanceContact?.()) ?? null);
      userAgent = buildUserAgent({ version: deps.version ?? '0.0.0', contact });
    } catch (error) {
      if (error instanceof InstanceContactError) return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: error.code };
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
    // Étape 0 et reconnaissance sous le plus petit de `max_cost_usd` et du budget restant de l'enquête.
    const stageCeiling = Math.max(0, Math.min(target.api.maxCostUsd, request.budget_usd - spent));
    const sessionBase = {
      rung: first,
      guard: deps.guard,
      ...(credentials === undefined ? {} : { credentials }),
      ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
      userAgent,
    };
    const robotsSession = openNetworkSession({ ...sessionBase, costCeiling: { maxUsd: stageCeiling } });
    const robots = new RobotsGate({ fetch: sessionRobotsFetcher(robotsSession), cache: robotsCache, signal: ctx.signal, allowedHosts: [host], ...(pacerFor() === undefined ? {} : { pacer: pacerFor()! }) });
    const pacer = pacerFor(robots);
    let session: NetworkSession | undefined;
    const stageProxyUsd = () => robotsSession.usage().costUsd + (session?.usage().costUsd ?? 0);

    try {
      await event(EV.started, { phase, url: narrativeUrl(pageUrl), domain: host, budget: budgetView() });
      session = openNetworkSession({ ...sessionBase, allowedHosts: [host], checkUrl: robots.checkUrl, costCeiling: { maxUsd: stageCeiling, otherUsd: () => robotsSession.usage().costUsd } });

      // --- 0. Rapport d'accès -------------------------------------------------------------------------------------
      const report: AccessReport = await buildAccessReport({ url: pageUrl, gate: robots, probe: sessionAccessProbe(session), ...(pacer === undefined ? {} : { pacer }), signal: ctx.signal, now });
      await recordAccessReport(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, payload: accessReportEventPayload(report) });
      if (!report.verdict.proceed) {
        await charge(ctx, stageProxyUsd());
        spent = round6(spent + stageProxyUsd());
        return await finishFailed(report.verdict.failure, 'access_check');
      }

      // --- 1. Reconnaissance ----------------------------------------------------------------------------------------
      let candidates: readonly DataCandidate[] | undefined = state.candidates;
      let capture: ReconCapture | null = null;
      if (state.validated_schema === undefined || candidates === undefined) {
        await save('reconnaissance');
        await event(EV.phase, { phase: 'reconnaissance', budget: budgetView() });
        const recon =
          deps.browsers !== null
            ? await browserRecon(deps, { url: pageUrl, host, signal: ctx.signal, robots, userAgent, sessionBase, ceiling: stageCeiling, otherUsd: stageProxyUsd, ...(pacer === undefined ? {} : { pacer }) })
            : await staticRecon(session, { url: pageUrl, signal: ctx.signal, robots, ...(pacer === undefined ? {} : { pacer }) });
        await charge(ctx, stageProxyUsd() + recon.proxyUsd);
        spent = round6(spent + stageProxyUsd() + recon.proxyUsd);
        capture = recon.capture;
        candidates = recon.failure === null ? analyzeCapture(recon.capture, [host]) : [];
        await event(EV.reconnaissance, {
          mode: recon.capture.mode,
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
          document_bytes: recon.capture.document?.bytes ?? 0,
          total_bytes: recon.capture.totalBytes,
          budget: budgetView(),
        });
        if (recon.failure !== null) return await finishFailed(recon.failure, 'reconnaissance');
        await save('reconnaissance', {
          candidates,
          page: { url: pageUrl, host, document_bytes: recon.capture.document?.bytes ?? 0, total_bytes: recon.capture.totalBytes, mode: recon.capture.mode },
        });
      } else {
        await charge(ctx, stageProxyUsd());
        spent = round6(spent + stageProxyUsd());
      }
      if (spent >= request.budget_usd) return await budgetExhausted('investigation_budget_usd');

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
        const exampleOutput = (ctx.input as { example_output?: unknown } | null)?.example_output;
        let llmFailure: ExecFailure | null = null;
        try {
          const out = await proposeInvestigation(client, {
            description: request.description,
            ...(exampleOutput === undefined ? {} : { exampleOutput }),
            candidates,
            accessFacts: accessFactsForPrompt(report),
            ...(fixed === undefined ? {} : { fixedSchema: fixed }),
            signal: ctx.signal,
            beforeCall: () => {
              if (spent + (client.meter.snapshot().cost_usd_known ?? 0) >= request.budget_usd) throw new BudgetGuardError();
            },
          });
          proposal = out.proposal;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          if (error instanceof BudgetGuardError) llmFailure = { failure_class: 'run_budget_exceeded', retryable: false, detail: 'investigation_budget_usd' };
          else if (error instanceof LlmError) llmFailure = { failure_class: toFailureClass(error.class), retryable: false, detail: `llm_${error.class}` };
          else llmFailure = { failure_class: 'extraction', retryable: false, detail: 'proposal_unreadable' };
        }
        // Coût du rôle `investigate` (tentatives échouées comprises), imputé au run : inconnu si le prix manque.
        const usage = client.meter.snapshot();
        const model = config.roles.investigate.model;
        await charge(ctx, 0, usage.cost_usd, { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning, estimated: usage.usage_estimated });
        if (usage.cost_usd === null) {
          await ctx.log('warn', 'llm_price_missing', { model, role: 'investigate' });
          return await finishFailed({ failure_class: 'run_budget_exceeded', retryable: false, detail: 'llm_price_missing' }, 'schema');
        }
        spent = round6(spent + usage.cost_usd);
        if (llmFailure !== null) {
          if (llmFailure.failure_class === 'run_budget_exceeded') return await budgetExhausted('investigation_budget_usd');
          return await finishFailed(llmFailure, 'schema');
        }
        await ctx.log('info', 'investigate_call', { model, prompt_version: investigatePromptVersion, llm_usd: usage.cost_usd, calls: usage.calls });
      }
      const built = buildFromProposal(proposal!, candidates, capture, { ...(fixed === undefined ? {} : { fixedSchema: fixed }), agenticOnly });
      if (!built.ok) {
        await event(EV.schemaProposed, { ok: false, reason: built.reason, rejected: built.rejected, budget: budgetView() });
        return await finishFailed({ failure_class: 'extraction', retryable: false, detail: built.reason }, 'schema');
      }
      if (fixed === undefined) {
        // Échantillon : données de l'utilisateur, inscrites au registre de masquage du run (17 §6).
        for (const item of built.sample) ctx.personal.addFromItem(built.outputSchema, item);
        await event(EV.schemaProposed, {
          ok: true,
          output_schema: built.outputSchema,
          sample: built.sample,
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

      // --- 3. Essais du moins cher au plus cher --------------------------------------------------------------------
      await save('testing');
      const networks: PlanNetwork[] = rungs.map((r) => ({ mode: r.mode, perGbUsd: r.mode === 'direct' ? 0 : r.proxy.price.perGbUsd }));
      if (tunnelChosen || target.api.requires.tunnel === true || target.api.requiresSession) networks.push({ mode: 'tunnel', perGbUsd: 0 });
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
      const spend = new Map<TrialPair, { proxy: number; llm: number | null; tokens: { in: number; cached: number; out: number; reasoning: number; estimated: boolean }; model: string | null; prompt: string | null; engine: string | null }>();
      const outcome = await runTrials(
        plan,
        {
          now,
          execute: async (pair, index, limits) => {
            const entry = entries.get(pair)!;
            const trialTarget: RunTarget = {
              api: { ...target.api, outputSchema, maxCostUsd: limits.ceilingUsd },
              strategy: { version: 0, execution: entry.execution, network: entry.network, spec: entry.spec, scriptRef: null, estCostUsd: entry.est_cost_usd },
            };
            const timeout = AbortSignal.timeout(Math.max(1, limits.deadlineMs - now()));
            const trialCtx: RunCtx = { ...ctx, signal: AbortSignal.any([ctx.signal, timeout]), input: entry.paginated ? { max_pages: 2 } : {} };
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
            const r = trial.result;
            const stop = trial.outcome.stop;
            if (stop === 'challenge_in_tunnel') return execution(false, 'blocked_by_protection', 'challenge_in_tunnel', r.pages, cost, trial.ms, null);
            if (stop === 'tunnel_offline') return execution(false, 'code_error', 'tunnel_offline', r.pages, cost, trial.ms, null);
            if (trial.outcome.needsUser === true && !r.ok) return execution(false, 'auth_required', 'site_not_connected', r.pages, cost, trial.ms, null);
            if (cost === null) return execution(false, 'run_budget_exceeded', 'llm_price_missing', r.pages, null, trial.ms, null);
            if (cost > limits.ceilingUsd) return execution(false, 'run_budget_exceeded', 'max_cost_usd', r.pages, cost, trial.ms, null);
            if (!r.ok) {
              const f = trial.guardedFailure ?? r.failure;
              return execution(false, f.failure_class, f.detail, r.pages, cost, trial.ms, null);
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
      spent = outcome.spentUsd;

      switch (outcome.kind) {
        case 'conformant': {
          const entry = entries.get(outcome.outcome.pair)!;
          const records = lastRecords.get(outcome.outcome.pair) ?? [];
          const saved = await saveInvestigationStrategy(deps.pool, {
            apiId: ctx.apiId,
            ownerId: ctx.ownerId,
            execution: entry.execution,
            network: entry.network,
            spec: entry.spec,
            estCostUsd: entry.est_cost_usd,
            outputSchema,
            inputSchema: proposedInputSchema(entry.paginated),
            state: { ...state, spent_usd: spent, elapsed_ms: baseElapsed + Math.max(0, now() - started) },
          });
          phase = 'done';
          // Résultat livré (figure 1, étape I) : la sortie de la dernière exécution conforme, écrite comme le propriétaire.
          const dataset = await saveRunDataset(deps.pool, { runId: ctx.runId, apiId: ctx.apiId, ownerId: ctx.ownerId, projectId: target.api.projectId, items: records });
          await applyStatus({ type: 'investigation_succeeded' });
          await event(EV.finished, {
            outcome: 'conformant',
            strategy: { version: saved.version, execution: entry.execution, network: entry.network, source: entry.source, est_cost_usd: entry.est_cost_usd },
            items: records.length,
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
          const lastClass = outcome.tried.at(-1)?.result;
          return await finishFailed({ failure_class: lastClass === undefined || lastClass === 'ok' ? 'extraction' : lastClass, retryable: false, detail: 'no_conformant_strategy' }, 'testing');
        }
      }
    } finally {
      await session?.close().catch(() => undefined);
      await robotsSession.close().catch(() => undefined);
    }
  };
}

/** Garde du budget avant un appel du rôle `investigate` (levée par `beforeCall`, jamais réessayée). */
class BudgetGuardError extends Error {
  override name = 'BudgetGuardError';
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

type ReconOutcome = { readonly capture: ReconCapture; readonly failure: ExecFailure | null; readonly proxyUsd: number };

/** Reconnaissance par Chromium : passe E3 sur le premier réseau autorisé, proxy d'egress propre à la passe. */
async function browserRecon(
  deps: InvestigationExecutorDeps,
  args: {
    url: string;
    host: string;
    signal: AbortSignal;
    robots: RobotsGate;
    userAgent: string;
    sessionBase: Omit<Parameters<typeof openNetworkSession>[0], 'allowedHosts' | 'costCeiling' | 'checkUrl'>;
    ceiling: number;
    otherUsd: () => number;
    pacer?: RequestPacer;
  },
): Promise<ReconOutcome> {
  const egress = await openBrowserEgress({ ...args.sessionBase, allowedHosts: [args.host], checkUrl: args.robots.checkUrl, costCeiling: { maxUsd: args.ceiling, otherUsd: args.otherUsd } });
  try {
    const pass = await runReconnaissancePass({
      pool: deps.browsers!,
      egress,
      guard: deps.guard,
      url: args.url,
      allowedHosts: [args.host],
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
 * Reconnaissance sans navigateur (`DISABLE_BROWSER`) : la page (corps borné, classée avant lecture), ses blobs, puis au
 * plus `STATIC_MAX_ENDPOINTS` URL de données appelées par ses scripts en ligne, chacune cadencée, contrôlée par
 * robots.txt (session) et classée ; un refus sur l'une arrête la reconnaissance (INV6).
 */
async function staticRecon(session: NetworkSession, args: { url: string; signal: AbortSignal; robots: RobotsGate; pacer?: RequestPacer }): Promise<ReconOutcome> {
  const probe = sessionAccessProbe(session, STATIC_MAX_BYTES);
  const empty = (failure: ExecFailure | null): ReconOutcome => ({ capture: { mode: 'static', pageUrl: args.url, document: null, exchanges: [], totalBytes: 0 }, failure, proxyUsd: 0 });
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
  const page = await get(args.url);
  if (page.kind === 'failed') return empty(page.failure);
  if (page.refused !== null) return empty(page.refused);
  const html = page.exchange.body;
  const exchanges: CapturedExchange[] = [];
  for (const url of discoverScriptEndpoints(html, page.exchange.url, STATIC_MAX_ENDPOINTS)) {
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
      mode: 'static',
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
