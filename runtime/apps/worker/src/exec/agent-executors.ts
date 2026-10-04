// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteurs agentiques E4-E6 (tâche 2.4 ; 04 §3.1 ; ADR 0001 ; 08 §4) :
// - E4 `agent_fetch` : page obtenue comme en E1 (couche réseau de l'essai) ou par le navigateur (contexte du run),
//   CLASSÉE AVANT tout prompt (défi servi en 200, 401, 403… : le LLM n'est jamais appelé, la page n'entre dans aucun
//   prompt, INV6), puis texte visible mis en forme par le rôle `extract` (aucun outil, contenu non fiable encadré) ;
// - E6 `agent` : `AgentEngine` (Stagehand 3.7.3) sur un Chromium dédié à l'essai, derrière le proxy d'egress de l'essai
//   (verrou de domaines + SSRF) et la garde Playwright ; limité au serveur (0.6b). Une trace réussie est COMPILÉE en E5
//   puis rejouée deux fois SANS LLM dans des contextes neufs (induction de l'extraction, puis vérification) : la
//   stratégie compilée n'est rendue que si elle reproduit exactement la sortie validée ;
// - E5 `hybrid` : étapes déclaratives (aucun code généré), étapes `agent` déléguées au moteur, extraction par libellés
//   ou déléguée au rôle `extract`. Sans étape ni extraction déléguée : aucun appel LLM, contexte du pool.
// Toute sortie est validée contre `output_schema` (INV1). Coût LLM et jetons rendus pour l'essai (INV2, INV4).
// Correctifs de vérification :
// - plafond `max_cost_usd` tenu PENDANT l'essai (attempt-cost.ts) : un compteur partagé par le proxy et le LLM ; chaque
//   run de moteur reçoit le reliquat, le client `extract` est contrôlé avant chaque envoi ; prix absent : coût null,
//   jamais 0, et plafond intenable (`run_budget_exceeded`, `llm_price_missing`) ;
// - garde de classification (1.7) sur les documents du cadre principal en E5 et E6 : corps borné TOUJOURS lu (défi servi
//   en 200), et attendue avant chaque appel au modèle et avant toute extraction : l'agent ne reçoit jamais une page
//   refusée (INV6) ;
// - écritures (méthode autre que GET, HEAD, OPTIONS) refusées sur le pool sans `allow_write_actions`, navigation ou non
//   (XHR, fetch, beacon) ; une trace E6 dont une écriture a été coupée n'est jamais compilée (08 §4 mesure 4) ;
// - une trace E6 à plusieurs enregistrements (liste, pagination par bouton : F-E5) n'est pas compilée
//   (`list_not_compilable`) : point faible connu de l'ADR 0001, E5 « mouvant » ; voir l'ADR (suivi de 2.4) ;
// - le Chromium dédié (E5 à étapes déléguées, E6) est lancé DANS un slot du pool (`BrowserPool.hold`), tenu jusqu'à la
//   fin de l'essai, rejeux de compilation compris (sans redemander de slot) : `BROWSER_CONCURRENCY` borne aussi les
//   essais agentiques, un Chromium par slot (14 §11) ; sans pool (`DISABLE_BROWSER`) : `browser_disabled`.
// Garde des contextes de run : chaque Chromium de ces exécuteurs — contexte du pool (E4 par le navigateur, E5 sans
// délégation, rejeux de compilation E6) comme Chromium dédié piloté par Stagehand (E5 délégué, E6) — reçoit la garde des
// contextes de run d'E1-E3 (`openRunContext` : verrou de domaines à chaque saut, WebSocket, workers).
import {
  compileAgentTrace,
  hybridUsesLlm,
  htmlToVisibleText,
  induceLabelExtraction,
  partitionItems,
  validateHybridSpec,
  validateOutput,
  type AgentEngine,
  type AgentFetchSpec,
  type AgentPhase,
  type AgentRunResult,
  type AgentTraceStep,
  type AgentSpec,
  type AgentTaskRules,
  type HybridSpec,
  type ItemPolicy,
} from '@runtime/core';
import {
  extractRecordsWithLlm,
  extractLabelsFromPage,
  readPageView,
  recordsSchema,
  runHybridSteps,
  extractPromptVersion,
  type HybridFailure,
  type SemanticRecorder,
  type StagehandEngineHooks,
} from '@runtime/agent';
import {
  classifyExchange,
  classifyTransportError,
  fetchTransport,
  type ClassifyContext,
  type DeclarativeRunResult,
  type ExecFailure,
  type HttpExchange,
  type RequestPacer,
} from '@runtime/core/exec';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type NetworkSession, type SsrfGuard } from '@runtime/core/net';
import { LlmError, toFailureClass, type LlmClient, type RunUsage } from '@runtime/llm';
import type { Browser, BrowserContext, Page, Request, Response } from 'playwright-core';
import { boundedContent, boundedDocumentBody, TOO_LARGE, trackDecodedSizes, type DecodedSizes } from '../browser/bounded.js';
import type { AgentBrowser, AgentBrowserOptions } from '../browser/agent-browser.js';
import type { BrowserPool, SlotLease } from '../browser/pool.js';
import { createAgentRequestGate, type AgentRequestGate } from '../browser/agent-request-gate.js';
import { hostAllowed, isMainNavigation, openRunContext, trackStrategyRequests } from '../browser/run-context.js';
import { AttemptBudgetExceededError, AttemptCost, type RunBudget } from './attempt-cost.js';

/** Coût et traçabilité LLM d'un essai (`run_attempts`). `usd = null` si un prix manque (jamais 0, 08 §1). */
export type LlmSpend = {
  readonly usd: number | null;
  readonly tokens: { in: number; cached: number; out: number; reasoning: number; estimated: boolean };
  readonly modelId: string | null;
  readonly promptVersion: string | null;
  readonly engine: string | null;
};

export type AgentOutcome = {
  readonly result: DeclarativeRunResult;
  readonly llm: LlmSpend | null;
  /** Stratégie E5 compilée depuis la trace E6 réussie, vérifiée par rejeu sans LLM. */
  readonly compiled?: HybridSpec;
  /** Trace E6 de la compilation (cibles sémantiques et URL, jamais de texte saisi) : `post` des étapes compilées (2.13). */
  readonly trace?: readonly AgentTraceStep[];
  /** Pourquoi la compilation n'a pas abouti (code stable). */
  readonly compileFailure?: string;
  /** Navigations ou requêtes de l'agent coupées par le verrou de domaines (hôtes, jamais d'URL). */
  readonly domainBlocked?: number;
  /** Requêtes refusées par la politique de requêtes de l'agent (`agent_request_blocked`, 19 §7) : codes seulement, jamais d'URL ni de valeur. */
  readonly requestPolicy?: { readonly blocked: number; readonly reasons: readonly string[] };
  /**
   * Essai E4 réussi : page servie (corps borné par `limits.max_response_bytes`, jamais écrit ni journalisé), gardée en
   * mémoire pour la compilation en stratégie déclarative `html` par l'enquête (constat UX-20).
   */
  readonly page?: { readonly html: string; readonly url: string };
};

/** Options communes de la politique de requêtes de l'agent (PA-01) : valeurs sensibles du run et entrées du run. */
type AgentPolicyOptions = {
  /** Valeurs sensibles (secrets et leurs encodages) : jamais dans une URL ni un corps de l'agent. Relues à chaque requête. */
  readonly sensitiveValues?: () => readonly string[];
  /** Données personnelles vues pendant le run (registre RGPD) : jamais dans une URL composée ; admises dans l'URL déclarée (UX-33). */
  readonly seenValues?: () => readonly string[];
  readonly runInputs?: Readonly<Record<string, unknown>>;
};

/**
 * Écritures coupées avant le contrôle de requêtes (garde d'écriture du contexte, consultée AVANT lui) : même refus, même code
 * (`method_not_allowed`), pour que le journal porte tous les refus de la politique. Le verdict de la garde sur la DERNIÈRE
 * écriture arrive après la fin du run (course constatée sous charge) : le compte est le maximum de celui de la garde et de celui
 * des écritures lancées (`settleWrites`), jamais le seul premier. Le journal est complété de l'écart, sans double compte.
 */
const noteWriteRefusals = (gate: AgentRequestGate, ab: AgentBrowser, launchedWrites: number): void => {
  gate.ensureWriteRefusals(Math.max(ab.guard.blocked.filter((b) => b.reason === 'write').length, launchedWrites));
};

/** Résumé du relevé d'une garde, ou rien si aucune requête n'a été refusée. */
const policyOutcome = (gate: AgentRequestGate | undefined): Pick<AgentOutcome, 'requestPolicy'> => {
  const summary = gate?.summary();
  return summary === undefined || summary.blocked === 0 ? {} : { requestPolicy: summary };
};

/** Garde de classification (1.7) : `classifyExchange` par défaut. */
type ClassifyFn = (exchange: HttpExchange, context?: ClassifyContext) => ExecFailure | null;

/**
 * Moteur d'un essai : construit sur le Chromium dédié (Stagehand par `cdpUrl`), ou `null` si le rôle `agent` manque.
 * `hooks` : plafond de coût partagé de l'essai et garde de classification, à passer au moteur (StagehandEngineOptions).
 */
export type EngineFactory = (args: { cdpUrl: string; recorder: SemanticRecorder; hooks: StagehandEngineHooks; phase: AgentPhase }) => { engine: AgentEngine; modelId: string; promptVersion: string } | null;

const NAVIGATION_TIMEOUT_MS = 30_000;
const fail = (failure: ExecFailure, requests = 0): DeclarativeRunResult => ({ ok: false, failure, pages: 0, requests });
const ok = (records: Record<string, unknown>[], requests: number): DeclarativeRunResult => ({ ok: true, records, pages: 1, requests, escalated: false, stop: 'records_empty', truncated: false });

function spendFromUsage(usage: RunUsage, modelId: string | null, promptVersion: string | null, engine: string | null): LlmSpend {
  return {
    usd: usage.cost_usd,
    tokens: { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning, estimated: usage.usage_estimated },
    modelId,
    promptVersion,
    engine,
  };
}

function spendFromAgent(run: AgentRunResult, modelId: string, promptVersion: string, engine: string): LlmSpend {
  return {
    usd: run.costUsd,
    tokens: { in: run.usage.tokensIn, cached: run.usage.tokensCached, out: run.usage.tokensOut, reasoning: run.usage.tokensReasoning, estimated: run.usage.usageEstimated },
    modelId,
    promptVersion,
    engine,
  };
}

function addSpend(a: LlmSpend | null, b: LlmSpend | null): LlmSpend | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    usd: a.usd === null || b.usd === null ? null : Math.round((a.usd + b.usd) * 1e9) / 1e9,
    tokens: {
      in: a.tokens.in + b.tokens.in,
      cached: a.tokens.cached + b.tokens.cached,
      out: a.tokens.out + b.tokens.out,
      reasoning: a.tokens.reasoning + b.tokens.reasoning,
      estimated: a.tokens.estimated || b.tokens.estimated,
    },
    modelId: a.modelId ?? b.modelId,
    promptVersion: a.promptVersion ?? b.promptVersion,
    engine: a.engine ?? b.engine,
  };
}

/** Plafond de l'essai atteint, ou intenable (coût LLM inconnu : prix absent). */
function budgetFailure(unpriced: boolean): ExecFailure {
  return { failure_class: 'run_budget_exceeded', retryable: false, detail: unpriced ? 'llm_price_missing' : 'max_cost_usd' };
}
const budgetOf = (cost: AttemptCost): ExecFailure => budgetFailure(cost.llmUsd() === null);
/** Erreur portant sa classe d'essai (levée dans une étape, lue par `stepError`). */
const withFailure = (failure: ExecFailure): Error => Object.assign(new Error(failure.detail), { execFailure: failure });

/** Erreur du client LLM → classe `llm_*` (08 §1) ; plafond de l'essai → `run_budget_exceeded` ; sinon, transport. */
function llmFailure(error: unknown): ExecFailure {
  if (error instanceof AttemptBudgetExceededError) return budgetFailure(error.unpriced);
  if (error instanceof LlmError) {
    const retryable = ['overloaded', 'timeout', 'rate_limited', 'empty_response', 'network'].includes(error.class);
    return { failure_class: toFailureClass(error.class), retryable, detail: `llm_${error.class}` };
  }
  return classifyTransportError(error);
}

/**
 * Enregistrements conformes : chaque item validé contre `output_schema` (INV1) ; 0 item = `extraction`. Politique
 * `quarantine` (runs, D-49) : TOUS les enregistrements sont rendus ; l'exécuteur les trie (Ajv : un non-objet échoue sur
 * `type`), écarte les non conformes en quarantaine, jamais livrés, et décide la casse sur le run (0 conforme casse).
 */
export function conformRecords(records: readonly unknown[], outputSchema: unknown, requests: number, policy: ItemPolicy = 'strict'): DeclarativeRunResult {
  if (records.length === 0) return fail({ failure_class: 'extraction', retryable: false, detail: 'no_records' }, requests);
  // Les non-objets voyagent tels quels jusqu'au tri (`partitionItems`), qui ne lit jamais leurs clés.
  if (policy === 'quarantine') return ok(records as Record<string, unknown>[], requests);
  for (const r of records) {
    if (typeof r !== 'object' || r === null || Array.isArray(r) || !validateOutput(outputSchema, r).ok) {
      return fail({ failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }, requests);
    }
  }
  return ok(records as Record<string, unknown>[], requests);
}

function pageText(exchange: HttpExchange, maxChars: number): { text: string; truncated: boolean } {
  const type = exchange.headers['content-type'] ?? 'text/html';
  if (/html/i.test(type)) return htmlToVisibleText(exchange.body, maxChars);
  return { text: exchange.body.slice(0, maxChars), truncated: exchange.body.length > maxChars };
}

// --------------------------------------------------------------------------------------------------------------- E4
export type AgentFetchOptions = AgentPolicyOptions & {
  readonly spec: AgentFetchSpec;
  readonly outputSchema: unknown;
  /** Politique des items non conformes (D-49) : `strict` (défaut, enquête) ou `quarantine` (runs). */
  readonly itemPolicy?: ItemPolicy;
  readonly llm: LlmClient;
  readonly modelId: string | null;
  readonly signal: AbortSignal;
  readonly session?: Pick<NetworkSession, 'fetch'>;
  readonly browser?: { readonly pool: BrowserPool; readonly egress: BrowserEgress; readonly guard: SsrfGuard; readonly userAgent?: string };
  readonly pacer?: RequestPacer;
  readonly classify?: ClassifyFn;
  /** Plafond de coût de l'essai (proxy + LLM). */
  readonly maxCostUsd: number;
  /** Compteur partagé de l'essai (l'exécuteur de stratégie y branche le proxy) ; défaut : un compteur propre. */
  readonly cost?: AttemptCost;
  /**
   * Règles embarquées (tâche 2.10, 18 §4.5) : texte reconstruit par l'appelant depuis les références de `spec.rules`
   * (`rule_file_versions` du propriétaire, empreintes vérifiées) ; absent, aucune règle injectée.
   */
  readonly rulesText?: string;
};

async function fetchPage(options: AgentFetchOptions, gate: AgentRequestGate): Promise<HttpExchange> {
  const url = options.spec.request.url;
  // Politique de requêtes de l'agent (19 §7, PA-01) sur la requête déclarée, avant tout réseau : refus explicite, sans exécution.
  if (!(await gate.check({ url, redirect: false, rootUrl: url, resourceType: 'Document', mainFrame: true, method: 'GET' }))) {
    throw withFailure({ failure_class: 'code_error', retryable: false, detail: 'agent_request_blocked' });
  }
  if (options.spec.via === 'fetch') {
    if (options.session === undefined) throw new Error('session réseau absente');
    const transport = fetchTransport(options.session, { maxResponseBytes: options.spec.limits.max_response_bytes, timeoutMs: NAVIGATION_TIMEOUT_MS });
    return transport({ method: 'GET', url, headers: {} }, options.signal);
  }
  const b = options.browser;
  if (b === undefined) throw new Error('navigateur absent');
  return b.pool.run(options.signal, async (browser) => {
    // E4 n'a ni agent ni outil : seule la requête DÉCLARÉE est contrôlée (ci-dessus). Le trafic de la page (POST, navigation par
    // script, XHR) garde le régime d'avant la garde ; le verrou de domaines du contexte le borne toujours.
    const rc = await openRunContext(browser, { egressServer: b.egress.server, allowedHosts: options.spec.request.allowed_hosts, ...(b.userAgent === undefined ? {} : { userAgent: b.userAgent }) });
    const strategy = trackStrategyRequests(rc.context, options.spec.request.allowed_hosts);
    try {
      const response = await strategy
        .during(isMainNavigation(rc.page), () => guardedGoto(rc.page, url, b.guard, { waitUntil: 'load' as const, timeout: NAVIGATION_TIMEOUT_MS }));
      if (response === null) throw new Error('navigation sans réponse');
      if (!hostAllowed(response.url(), options.spec.request.allowed_hosts) || strategy.cut()) throw new DomainNotAllowedError(new URL(response.url()).hostname);
      const body = await boundedContent(rc.page, options.spec.limits.max_response_bytes);
      if (body === TOO_LARGE) throw Object.assign(new Error('réponse trop grande'), { code: 'response_too_large' });
      return { status: response.status(), headers: response.headers(), body, url: rc.page.url() };
    } finally {
      await rc.close();
    }
  });
}

/** E4 : une page, classée avant tout prompt, mise en forme par le rôle `extract`. */
export async function runAgentFetchExecutor(options: AgentFetchOptions): Promise<AgentOutcome> {
  // Phase e4_extract (aucun outil) : la seule requête permise est celle que la stratégie déclare.
  const gate = createAgentRequestGate({
    phase: 'e4_extract',
    allowedHosts: options.spec.request.allowed_hosts,
    startUrl: options.spec.request.url,
    allowWriteActions: false,
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    ...(options.seenValues === undefined ? {} : { seenValues: options.seenValues }),
    ...(options.runInputs === undefined ? {} : { runInputs: options.runInputs }),
  });
  const out = await runAgentFetch(options, gate);
  return { ...out, ...policyOutcome(gate) };
}

async function runAgentFetch(options: AgentFetchOptions, gate: AgentRequestGate): Promise<AgentOutcome> {
  const url = options.spec.request.url;
  if (options.pacer !== undefined) {
    const slot = await options.pacer.acquire(url);
    if (!slot.granted) return { result: fail({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }), llm: null };
  }
  let exchange: HttpExchange;
  try {
    exchange = await fetchPage(options, gate);
  } catch (error) {
    if (options.signal.aborted) throw error;
    const code = (error as { code?: unknown }).code;
    const refusal = (error as { execFailure?: ExecFailure }).execFailure;
    if (refusal !== undefined) return { result: fail(refusal, 1), llm: null };
    return { result: fail(code === 'response_too_large' ? { failure_class: 'extraction', retryable: false, detail: 'response_too_large' } : classifyTransportError(error), 1), llm: null };
  }
  await options.pacer?.report(url, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null });
  // Garde de classification AVANT tout prompt (04 §7, 1.7) : un refus ou un défi n'atteint jamais le LLM.
  const refused = (options.classify ?? classifyExchange)(exchange, { requestUrl: url });
  if (refused !== null) return { result: fail(refused, 1), llm: null };
  const { text, truncated } = pageText(exchange, options.spec.limits.max_input_chars);
  if (text.trim() === '') return { result: fail({ failure_class: 'extraction', retryable: false, detail: 'empty_page' }, 1), llm: null };
  const cost = options.cost ?? new AttemptCost(options.maxCostUsd);
  cost.addLlm(() => options.llm.usage().cost_usd);
  if (cost.exhausted()) return { result: fail(budgetOf(cost), 1), llm: null };
  const spend = () => spendFromUsage(options.llm.usage(), options.modelId, extractPromptVersion, null);
  try {
    const out = await extractRecordsWithLlm(options.llm, {
      instruction: options.spec.instruction,
      ...(options.rulesText === undefined || options.rulesText === '' ? {} : { rules: options.rulesText }),
      pageText: text,
      pageUrl: exchange.url,
      truncated,
      itemSchema: options.outputSchema,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.spec.limits.timeout_ms)]),
      // Plafond tenu avant chaque envoi (premier appel, réparations, réessais).
      beforeCall: () => cost.assertAvailable(),
    });
    const llm = spend();
    // Coût inconnu (prix absent) : jamais un succès dont le plafond n'a pas pu être tenu.
    if (llm.usd === null) return { result: fail(budgetFailure(true), 1), llm };
    const result = conformRecords(out.records, options.outputSchema, 1, options.itemPolicy);
    const html = /html/i.test(exchange.headers['content-type'] ?? 'text/html');
    return { result, llm, ...(result.ok && html ? { page: { html: exchange.body, url: exchange.url } } : {}) };
  } catch (error) {
    if (options.signal.aborted) throw error;
    return { result: fail(llmFailure(error), 1), llm: spend() };
  }
}

// --------------------------------------------------------------------------------------------------------------- E5
export type HybridOptions = AgentPolicyOptions & {
  readonly spec: HybridSpec;
  readonly outputSchema: unknown;
  /** Politique des items non conformes (D-49) : `strict` (défaut, enquête) ou `quarantine` (runs). */
  readonly itemPolicy?: ItemPolicy;
  readonly signal: AbortSignal;
  readonly guard: SsrfGuard;
  readonly egress: BrowserEgress;
  /** Pool du worker : E5 sans délégation (aucun LLM) et slot du Chromium dédié (E5 avec délégation). */
  readonly pool: BrowserPool | null;
  /** Chromium dédié (E5 avec étapes `agent`) et moteur ; client du rôle `extract` (extraction déléguée). */
  readonly agentBrowser?: (options: Omit<AgentBrowserOptions, 'egressServer'>) => Promise<AgentBrowser>;
  readonly engineFor?: EngineFactory;
  readonly llm?: LlmClient | null;
  readonly llmModelId?: string | null;
  readonly allowWriteActions: boolean;
  /** User-Agent du robot (identité du run) ; défaut : celui du moteur du navigateur. */
  readonly userAgent?: string;
  readonly pacer?: RequestPacer;
  readonly maxRequests?: number;
  readonly maxCostUsd: number;
  /** Compteur partagé de l'essai (proxy + LLM) ; défaut : un compteur propre. */
  readonly cost?: AttemptCost;
  /** Garde de classification (1.7) appliquée à chaque document du cadre principal ; défaut : `classifyExchange`. */
  readonly classify?: ClassifyFn;
};

/** Méthodes de lecture (même verdict que `installDomainGuard`, playwright-channel.ts). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Classes qui arrêtent l'agent ou le script (INV6, 04 §3.3) ; un 404 ou un 5xx n'arrête pas : l'agent peut revenir. */
const STOP_CLASSES: ReadonlySet<string> = new Set(['blocked_by_protection', 'forbidden', 'rate_limited', 'auth_required', 'payment_required', 'account_limit']);
const MAX_CLASSIFIED_BODY = 5_000_000;
/**
 * Échéance de la barrière qui précède le compte des écritures lancées pendant l'agent (`settleWrites`) : une page qui
 * boucle ne tient ni l'essai ni le slot du pool au-delà ; la barrière sans réponse compte pour une écriture (échec fermé).
 */
const WRITE_BARRIER_TIMEOUT_MS = 5000;
/** Attente au plus du corps d'un document à classer (un document qui ne finit pas n'est classé que sur statut et en-têtes). */
const CLASSIFY_BODY_TIMEOUT_MS = 10_000;

type DocumentWatch = {
  /** Résout quand tous les documents vus jusqu'ici sont classés. */
  settled(): Promise<void>;
  /** Premier refus vu (classe d'arrêt), s'il y en a un. */
  refusal(): ExecFailure | undefined;
  /** Attend les classements en cours, puis lève (`execFailure`) si un document a été refusé. */
  gate(): Promise<void>;
  dispose(): void;
};

/**
 * Garde de classification sur les documents du cadre principal (INV6, 04 §7) : chaque document 2xx HTML est lu (corps
 * borné, taille décodée vue par CDP si `sizes`) puis classé par `classify` (classifieur de 1.7 par défaut : défi servi
 * en 200 compris). Un refus est signalé AUSSITÔT (`onRefused` : l'appelant arrête l'agent ou le script) ; `gate` est
 * attendue avant chaque appel au modèle et avant toute extraction : aucun prompt ne part pendant qu'un document est en
 * cours de classement, ni après un refus. Les sauts de redirection (3xx) ne sont pas classés.
 */
function watchDocuments(context: BrowserContext, classify: ClassifyFn | undefined, onRefused: (failure: ExecFailure) => void, sizes?: DecodedSizes): DocumentWatch {
  const pending = new Set<Promise<void>>();
  let first: ExecFailure | undefined;
  const handler = (response: Response) => {
    const request = response.request();
    let main: boolean;
    try {
      main = request.isNavigationRequest() && request.resourceType() === 'document' && request.frame().parentFrame() === null;
    } catch {
      // Requête sans cadre (service worker) : jamais un document du cadre principal.
      main = false;
    }
    const status = response.status();
    if (!main || (status >= 300 && status < 400)) return;
    let origin: Request = request;
    for (let r = request.redirectedFrom(); r !== null; r = r.redirectedFrom()) origin = r;
    const work = (async () => {
      const headers = response.headers();
      let body = '';
      if (status >= 200 && status < 300 && /html/i.test(headers['content-type'] ?? 'text/html')) {
        const raw = await boundedDocumentBody(response, MAX_CLASSIFIED_BODY, CLASSIFY_BODY_TIMEOUT_MS, sizes).catch(() => undefined);
        body = typeof raw === 'string' ? raw : '';
      }
      const refused = (classify ?? classifyExchange)({ status, headers, body, url: response.url() }, { requestUrl: origin.url() });
      if (refused !== null && STOP_CLASSES.has(refused.failure_class)) {
        first ??= refused;
        onRefused(refused);
      }
    })().catch(() => undefined);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  context.on('response', handler);
  const settled = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  return {
    settled,
    refusal: () => first,
    gate: async () => {
      await settled();
      if (first !== undefined) throw withFailure(first);
    },
    dispose: () => context.off('response', handler),
  };
}

/** Taille décodée des documents de `page` (CDP), pour lire sans risque un corps compressé ; `undefined` si indisponible. */
async function decodedSizes(context: BrowserContext, page: Page): Promise<DecodedSizes | undefined> {
  const cdp = await context.newCDPSession(page).catch(() => undefined);
  return cdp === undefined ? undefined : trackDecodedSizes(cdp).catch(() => undefined);
}

/**
 * Admission des requêtes d'un E5 sur le pool : écritures refusées sans `allow_write_actions` pour TOUTE requête (XHR,
 * fetch, beacon, formulaire : 08 §4 mesure 4, même verdict que `installDomainGuard`), puis, sur les navigations,
 * plafond de requêtes et cadence (1.9).
 */
function navigationAdmission(options: Pick<HybridOptions, 'allowWriteActions' | 'pacer' | 'maxRequests'>): (request: Request) => Promise<boolean> {
  let documents = 0;
  return async (request) => {
    if (!options.allowWriteActions && !READ_METHODS.has(request.method().toUpperCase())) return false;
    if (!request.isNavigationRequest()) return true;
    if (request.redirectedFrom() !== null) return true;
    if (options.maxRequests !== undefined && documents >= options.maxRequests) return false;
    if (options.pacer !== undefined) {
      const slot = await options.pacer.acquire(request.url());
      if (!slot.granted) return false;
    }
    documents += 1;
    return true;
  };
}

const hybridFail = (f: HybridFailure): DeclarativeRunResult => fail({ failure_class: f.failure_class, retryable: false, detail: f.detail }, 1);

/**
 * Navigation gardée d'une étape E5 : schéma et garde SSRF, puis verrou de domaines sur l'URL finale, puis garde de
 * classification sur le document servi (corps lu et classé par `watch`, classifieur de l'option ou de 1.7) ; un statut
 * d'échec qui n'arrête pas l'agent (404, 5xx) arrête quand même une navigation demandée par le script.
 */
function gotoFor(page: Page, guard: SsrfGuard, allowedHosts: readonly string[], watch: DocumentWatch, classify: ClassifyFn | undefined): (url: string) => Promise<void> {
  return async (url) => {
    const response = await guardedGoto(page, url, guard, { waitUntil: 'load' as const, timeout: NAVIGATION_TIMEOUT_MS });
    if (response !== null && !hostAllowed(response.url(), allowedHosts)) throw new DomainNotAllowedError(new URL(response.url()).hostname);
    await watch.gate();
    const status = response?.status() ?? 0;
    const refused = (classify ?? classifyExchange)({ status, headers: response?.headers() ?? {}, body: '', url: response?.url() ?? url }, { requestUrl: url });
    if (refused !== null) throw withFailure(refused);
  };
}

function stepError(error: unknown): ExecFailure {
  const f = (error as { execFailure?: ExecFailure }).execFailure;
  if (f !== undefined) return f;
  const name = (error as { name?: unknown }).name;
  if (name === 'TimeoutError') return { failure_class: 'extraction', retryable: false, detail: 'step_timeout' };
  return classifyTransportError(error);
}

/**
 * E5 sans délégation : contexte neuf du pool, étapes, extraction par libellés. Aucun appel LLM possible ici. `lease` :
 * slot déjà tenu par l'essai (rejeux de compilation E6), emprunté sans en redemander un.
 */
async function runHybridWithoutLlm(options: HybridOptions, onPage?: (page: Page) => Promise<void>, lease?: SlotLease): Promise<DeclarativeRunResult> {
  const pool = options.pool;
  if (pool === null && lease === undefined) return fail({ failure_class: 'code_error', retryable: false, detail: 'browser_disabled' });
  const spec = options.spec;
  const borrow = <T>(fn: (browser: Browser) => Promise<T>): Promise<T> => (lease !== undefined ? lease.run(fn) : pool!.run(options.signal, fn));
  return borrow(async (browser) => {
    const rc = await openRunContext(browser, { egressServer: options.egress.server, allowedHosts: spec.allowed_hosts, admit: navigationAdmission(options), ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }) });
    const strategy = trackStrategyRequests(rc.context, spec.allowed_hosts);
    const stop = new AbortController();
    const watch = watchDocuments(rc.context, options.classify, () => stop.abort(), await decodedSizes(rc.context, rc.page));
    try {
      const goto = gotoFor(rc.page, options.guard, spec.allowed_hosts, watch, options.classify);
      let failure: HybridFailure | null;
      try {
        failure = await strategy.during(isMainNavigation(rc.page), () =>
          runHybridSteps(rc.page, spec, { goto, signal: AbortSignal.any([options.signal, stop.signal, AbortSignal.timeout(spec.limits.timeout_ms)]) }),
        );
      } catch (error) {
        if (options.signal.aborted) throw error;
        await watch.settled();
        const refusal = watch.refusal();
        if (refusal !== undefined) return fail(refusal, 1);
        return fail(strategy.cut() ? { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } : stepError(error), 1);
      }
      // Garde avant toute lecture de la page (INV6) : tous les documents vus sont classés, aucun refus.
      await watch.settled();
      if (watch.refusal() !== undefined) return fail(watch.refusal()!, 1);
      if (failure !== null) return hybridFail(failure);
      if (onPage !== undefined) await onPage(rc.page);
      const extracted = await extractLabelsFromPage(rc.page, spec);
      await watch.settled();
      if (watch.refusal() !== undefined) return fail(watch.refusal()!, 1);
      return extracted.ok ? conformRecords(extracted.records, options.outputSchema, spec.steps.length + 1, options.itemPolicy) : hybridFail(extracted.failure);
    } finally {
      watch.dispose();
      await rc.close();
    }
  });
}

/** E5 : script déclaratif, étapes et extraction éventuellement déléguées (moteur, rôle `extract`). */
export async function runHybridExecutor(options: HybridOptions): Promise<AgentOutcome> {
  const spec = options.spec;
  if (!hybridUsesLlm(spec)) return { result: await runHybridWithoutLlm(options), llm: null };
  const agentBrowser = options.agentBrowser;
  if (agentBrowser === undefined || options.pool === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'browser_disabled' }), llm: null };
  // Politique de requêtes de l'agent (19 §7, PA-01) : départ et `goto` déclarés connus d'avance, le reste doit venir de la page.
  const gate = createAgentRequestGate({
    phase: 'e5_e6',
    allowedHosts: spec.allowed_hosts,
    startUrl: spec.start_url,
    templates: spec.steps.flatMap((s) => (s.op === 'goto' ? [s.url] : [])),
    allowWriteActions: options.allowWriteActions,
    // Les étapes code (goto, clic, attente) sont celles du propriétaire : l'agent ne pilote la page que pendant une étape `agent`.
    agentActive: false,
    trustedText: [...spec.steps.flatMap((s) => (s.op === 'agent' ? [s.instruction] : [])), spec.extract.mode === 'agent' ? spec.extract.instruction : ''].join(' '),
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    ...(options.seenValues === undefined ? {} : { seenValues: options.seenValues }),
    ...(options.runInputs === undefined ? {} : { runInputs: options.runInputs }),
  });
  // Chromium dédié dans un slot du pool (BROWSER_CONCURRENCY), tenu jusqu'à la fin de l'essai.
  const out = await options.pool.hold(options.signal, (lease) => runHybridDelegated(options, agentBrowser, lease, gate));
  return { ...out, ...policyOutcome(gate) };
}

async function runHybridDelegated(options: HybridOptions, agentBrowser: NonNullable<HybridOptions['agentBrowser']>, lease: SlotLease, gate: AgentRequestGate): Promise<AgentOutcome> {
  const spec = options.spec;
  const needsEngine = spec.steps.some((s) => s.op === 'agent');
  const cost = options.cost ?? new AttemptCost(options.maxCostUsd);
  const extractLlm = options.llm ?? null;
  if (extractLlm !== null) cost.addLlm(() => extractLlm.usage().cost_usd);
  // Une seule échéance pour tout l'essai : étapes, étapes déléguées et extraction (timeout_ms, comme E4).
  const deadline = AbortSignal.timeout(spec.limits.timeout_ms);
  const ab = await lease.dedicated(() =>
    agentBrowser({
      allowedHosts: spec.allowed_hosts,
      allowWriteActions: options.allowWriteActions,
      checkRequest: gate.check,
      ...(options.pacer === undefined ? {} : { pacer: options.pacer }),
      ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
    }),
  );
  gate.attach(ab.page);
  let spend: LlmSpend | null = null;
  const stop = new AbortController();
  const watch = watchDocuments(ab.context, options.classify, () => stop.abort(), await decodedSizes(ab.context, ab.page));
  const signal = AbortSignal.any([options.signal, stop.signal]);
  /** Run de moteur en cours (étape `agent`) : reliquat et dépense de l'essai faite ailleurs. */
  let current: RunBudget | undefined;
  const hooks: StagehandEngineHooks = {
    spentElsewhereUsd: () => current?.spentElsewhereUsd() ?? 0,
    onCost: (usd) => current?.report(usd),
    beforeModelCall: () => watch.gate(),
  };
  try {
    const made = needsEngine ? (options.engineFor?.({ cdpUrl: ab.cdpUrl, recorder: ab.recorder, hooks, phase: 'e5_e6' }) ?? null) : null;
    if (needsEngine && made === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }), llm: null };
    const agentStep = async (instruction: string): Promise<{ ok: true } | { ok: false; failure: HybridFailure }> => {
      await watch.gate();
      // Chaque étape reçoit le RELIQUAT de l'essai, jamais le plafond entier ; plus rien : aucun appel.
      if (cost.exhausted()) throw withFailure(budgetOf(cost));
      const budget = cost.openRun();
      current = budget;
      let run: AgentRunResult;
      try {
        gate.setAgentActive(true);
        run = await made!.engine.run(
          {
            taskId: 'hybrid_step',
            instruction,
            startUrl: '',
            allowedDomains: spec.allowed_hosts,
            outputSchema: { type: 'object' },
            allowWriteActions: options.allowWriteActions,
            limits: { maxSteps: 10, maxDurationMs: spec.limits.step_timeout_ms * 4, maxCostUsd: budget.limitUsd },
          },
          { model: { modelId: made!.modelId, temperature: 0, promptVersion: made!.promptVersion }, signal: AbortSignal.any([signal, deadline]) },
        );
      } finally {
        gate.setAgentActive(false);
        current = undefined;
      }
      budget.report(run.costUsd);
      spend = addSpend(spend, spendFromAgent(run, made!.modelId, made!.promptVersion, `${made!.engine.id}@${made!.engine.version}`));
      await watch.gate();
      if (run.status === 'done') return { ok: true };
      const failure = agentFailure(run, cost);
      if (failure.failure_class === 'extraction') return { ok: false, failure: { failure_class: 'extraction', detail: failure.detail } };
      throw withFailure(failure);
    };
    let failure: HybridFailure | null;
    try {
      failure = await runHybridSteps(ab.page, spec, {
        goto: gotoFor(ab.page, options.guard, spec.allowed_hosts, watch, options.classify),
        agentStep,
        signal: AbortSignal.any([signal, deadline]),
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      await watch.settled();
      return { result: fail(watch.refusal() ?? stepError(error), 1), llm: spend };
    }
    // Refus vu sur un document (INV6) : arrêt, aucune extraction, aucun appel au modèle de plus.
    await watch.settled();
    if (watch.refusal() !== undefined) return { result: fail(watch.refusal()!, 1), llm: spend };
    if (failure !== null) return { result: hybridFail(failure), llm: spend };
    if (spec.extract.mode === 'labels') {
      const extracted = await extractLabelsFromPage(ab.page, spec);
      return { result: extracted.ok ? conformRecords(extracted.records, options.outputSchema, spec.steps.length + 1, options.itemPolicy) : hybridFail(extracted.failure), llm: spend };
    }
    if (extractLlm === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }), llm: spend };
    // Reliquat contrôlé AVANT l'extraction déléguée : plus rien, aucun appel.
    if (cost.exhausted()) return { result: fail(budgetOf(cost), 1), llm: spend };
    const view = await readPageView(ab.page, spec.limits.max_input_chars * 10);
    if (view === null) return { result: fail({ failure_class: 'extraction', retryable: false, detail: 'response_too_large' }, 1), llm: spend };
    const text = view.text.slice(0, spec.limits.max_input_chars);
    const extractSpend = () => spendFromUsage(extractLlm.usage(), options.llmModelId ?? null, extractPromptVersion, null);
    try {
      const out = await extractRecordsWithLlm(extractLlm, {
        instruction: spec.extract.instruction,
        pageText: text,
        pageUrl: ab.page.url(),
        truncated: view.text.length > text.length,
        itemSchema: options.outputSchema,
        signal: AbortSignal.any([options.signal, deadline]),
        beforeCall: () => cost.assertAvailable(),
      });
      spend = addSpend(spend, extractSpend());
      if (spend?.usd === null) return { result: fail(budgetFailure(true), 1), llm: spend };
      return { result: conformRecords(out.records, options.outputSchema, spec.steps.length + 1, options.itemPolicy), llm: spend };
    } catch (error) {
      if (options.signal.aborted) throw error;
      spend = addSpend(spend, extractSpend());
      if (deadline.aborted && !(error instanceof AttemptBudgetExceededError)) return { result: fail({ failure_class: 'transient', retryable: true, detail: 'extract_timeout' }, 1), llm: spend };
      return { result: fail(llmFailure(error), 1), llm: spend };
    }
  } finally {
    watch.dispose();
    // Verdict tardif de la garde sur la dernière écriture de l'agent : barrière des écritures lancées (comme en E6).
    noteWriteRefusals(gate, ab, options.allowWriteActions ? 0 : await ab.settleWrites(WRITE_BARRIER_TIMEOUT_MS).catch(() => 0));
    await ab.close();
  }
}

// --------------------------------------------------------------------------------------------------------------- E6
export type AgentOptions = AgentPolicyOptions & {
  readonly spec: AgentSpec;
  readonly outputSchema: unknown;
  /** Politique des items non conformes (D-49) : `strict` (défaut, enquête) ou `quarantine` (runs). */
  readonly itemPolicy?: ItemPolicy;
  readonly signal: AbortSignal;
  readonly guard: SsrfGuard;
  readonly egress: BrowserEgress;
  readonly agentBrowser: (options: Omit<AgentBrowserOptions, 'egressServer'>) => Promise<AgentBrowser>;
  readonly engineFor: EngineFactory;
  /**
   * Pool du worker : slot du Chromium dédié, tenu jusqu'à la fin de l'essai, puis rejeux de vérification de la
   * compilation (sans LLM) dans ce même slot. `null` (`DISABLE_BROWSER`) : `browser_disabled`, aucun Chromium.
   */
  readonly pool: BrowserPool | null;
  readonly allowWriteActions: boolean;
  readonly pacer?: RequestPacer;
  readonly maxRequests?: number;
  readonly maxCostUsd: number;
  /** Compteur partagé de l'essai (proxy + LLM) ; défaut : un compteur propre. */
  readonly cost?: AttemptCost;
  readonly taskId: string;
  /** Version E6 courante (origine de la stratégie compilée). */
  readonly version: number | null;
  /** Garde de classification (1.7) sur chaque document du cadre principal ; défaut : `classifyExchange`. */
  readonly classify?: ClassifyFn;
  /**
   * Agent instruit (2.13, 19 §4) : faux tant que K runs instruits n'ont pas réussi, la compilation n'est pas tentée
   * (`instructed_compile_deferred`). Défaut : vrai (essai de compilation de chaque E6 réussi, 2.4).
   */
  readonly compile?: boolean;
  /**
   * Règles embarquées (tâche 2.10, 18 §4.5) : `systemPrompt` reconstruit par l'appelant depuis les références de
   * `spec.rules` (empreintes vérifiées) et `read_skill` sur les seuls skills référencés, à leur version épinglée.
   */
  readonly rules?: AgentTaskRules;
  /** Phase de l'agent (registre d'outils de 19 §7) : `e5_e6` (défaut) ou `instructed` (agent instruit). */
  readonly phase?: AgentPhase;
};

function agentFailure(run: AgentRunResult, cost?: AttemptCost): ExecFailure {
  const cls = run.failureClass ?? '';
  if (cls === 'run_budget_exceeded') return budgetFailure(run.costUsd === null || (cost !== undefined && cost.llmUsd() === null));
  if (/^llm_[a-z0-9_]+$/.test(cls)) return { failure_class: cls as `llm_${string}`, retryable: false, detail: cls };
  if (cls === 'agent_toolset_not_closed') return { failure_class: 'code_error', retryable: false, detail: cls };
  // Garde de l'appelant : la classe réelle est celle du document refusé (rendue par l'appelant) ; jamais une extraction.
  if (cls === 'page_refused') return { failure_class: 'blocked_by_protection', retryable: false, detail: cls };
  if (run.status === 'timeout') return { failure_class: 'transient', retryable: true, detail: 'agent_timeout' };
  if (run.status === 'max_steps') return { failure_class: 'extraction', retryable: false, detail: 'agent_max_steps' };
  return { failure_class: 'extraction', retryable: false, detail: 'agent_no_output' };
}

/**
 * Compilation E6 → E5 vérifiée : étapes depuis la trace, puis rejeu 1 (contexte neuf, aucun LLM) pour induire
 * l'extraction par libellés sur la page atteinte, puis rejeu 2 (autre contexte neuf) de la stratégie complète, qui doit
 * rendre exactement l'enregistrement validé. Refusée :
 * - si une écriture a été lancée pendant l'agent (`write_blocked` ; sans `allow_write_actions`, toute écriture est coupée,
 *   par la garde ou avant elle) : le clic qui l'a déclenchée, rejoué sur le pool,
 *   deviendrait une écriture à chaque run (08 §4 mesure 4) ;
 * - si la sortie compte plusieurs enregistrements (`list_not_compilable`) : l'extraction par libellés lit UNE fiche ; une
 *   liste paginée par bouton (F-E5) reste rejouée par l'agent, point faible connu de l'ADR 0001 (E5 « mouvant »).
 */
async function compileAndVerify(
  options: AgentOptions,
  lease: SlotLease,
  run: AgentRunResult,
  records: readonly Record<string, unknown>[],
  engine: string,
  writesBlocked: number,
  requestsRefused: number,
): Promise<{ spec: HybridSpec } | { failure: string }> {
  if (writesBlocked > 0) return { failure: 'write_blocked' };
  // Une trace qui porte une requête refusée par la politique de requêtes (page piégée) ne se rejoue jamais : le rejeu E5 n'est pas
  // sous la politique de l'agent et enverrait la requête refusée (PA-01).
  if (requestsRefused > 0) return { failure: 'request_refused' };
  if (records.length !== 1) return { failure: 'list_not_compilable' };
  const steps = compileAgentTrace(run.steps, run.status, options.spec.allowed_hosts);
  if (!steps.ok) return { failure: steps.reason };
  const expected = records[0]!;
  const draft = validateHybridSpec({
    schema_version: 1,
    kind: 'hybrid',
    start_url: options.spec.start_url,
    allowed_hosts: options.spec.allowed_hosts,
    steps: steps.steps,
    // Extraction provisoire, remplacée par l'induction sur la page rejouée.
    extract: { mode: 'labels', fields: { _: { heading: 1 } } },
    compiled_from: { execution: 'agent', version: options.version, engine },
  });
  if (!draft.ok) return { failure: 'invalid_compiled_spec' };
  const base: HybridOptions = { ...options, spec: draft.spec };
  let fields: ReturnType<typeof induceLabelExtraction> = null;
  const first = await runHybridWithoutLlm(base, async (page) => {
    const view = await readPageView(page, draft.spec.limits.max_input_chars * 10);
    if (view !== null) fields = induceLabelExtraction(view, expected);
  }, lease).catch(() => null);
  if (first === null) return { failure: 'replay_error' };
  if (fields === null) return { failure: 'extraction_not_inducible' };
  const final = validateHybridSpec({ ...draft.spec, extract: { mode: 'labels', fields } });
  if (!final.ok) return { failure: 'invalid_compiled_spec' };
  const replay = await runHybridWithoutLlm({ ...base, spec: final.spec }, undefined, lease).catch(() => null);
  if (replay === null || !replay.ok) return { failure: 'replay_failed' };
  if (replay.records.length !== 1 || JSON.stringify(replay.records[0]) !== JSON.stringify(expected)) return { failure: 'replay_mismatch' };
  return { spec: final.spec };
}

/**
 * E6 : l'agent pilote le Chromium dédié de bout en bout ; trace réussie compilée en E5 vérifiée. Un slot du pool est
 * tenu pour tout l'essai : le Chromium dédié y tourne, puis il est fermé avant les rejeux, faits dans le même slot.
 */
export async function runAgentExecutor(options: AgentOptions): Promise<AgentOutcome> {
  if (options.pool === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'browser_disabled' }), llm: null };
  // Politique de requêtes de l'agent (19 §7, PA-01) : l'agent ne navigue que vers le départ ou une URL venue de la page.
  const phase: AgentPhase = options.phase ?? 'e5_e6';
  const gate = createAgentRequestGate({
    phase,
    allowedHosts: options.spec.allowed_hosts,
    startUrl: options.spec.start_url,
    allowWriteActions: options.allowWriteActions,
    trustedText: options.spec.instruction,
    ...(options.sensitiveValues === undefined ? {} : { sensitiveValues: options.sensitiveValues }),
    ...(options.seenValues === undefined ? {} : { seenValues: options.seenValues }),
    ...(options.runInputs === undefined ? {} : { runInputs: options.runInputs }),
  });
  const out = await options.pool.hold(options.signal, (lease) => runAgentInSlot(options, lease, gate, phase));
  return { ...out, ...policyOutcome(gate) };
}

async function runAgentInSlot(options: AgentOptions, lease: SlotLease, gate: AgentRequestGate, phase: AgentPhase): Promise<AgentOutcome> {
  const cost = options.cost ?? new AttemptCost(options.maxCostUsd);
  const ab = await lease.dedicated(() =>
    options.agentBrowser({
      allowedHosts: options.spec.allowed_hosts,
      allowWriteActions: options.allowWriteActions,
      checkRequest: gate.check,
      ...(options.pacer === undefined ? {} : { pacer: options.pacer }),
      ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
    }),
  );
  gate.attach(ab.page);
  let run: AgentRunResult;
  let made: ReturnType<EngineFactory>;
  let domainBlocked: number;
  let writesBlocked: number;
  let launchedWrites = 0;
  // Refus vu sur un document (401, 403, 429, défi…) : l'agent est arrêté aussitôt, sans autre action (INV6).
  const stop = new AbortController();
  const watch = watchDocuments(ab.context, options.classify, () => stop.abort(), await decodedSizes(ab.context, ab.page));
  // Le run reçoit le reliquat de l'essai ; la dépense faite ailleurs (proxy) est relue à chaque appel.
  const budget = cost.openRun();
  try {
    made = options.engineFor({
      cdpUrl: ab.cdpUrl,
      recorder: ab.recorder,
      hooks: { spentElsewhereUsd: () => budget.spentElsewhereUsd(), onCost: (usd) => budget.report(usd), beforeModelCall: () => watch.gate() },
      phase,
    });
    if (made === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }), llm: null };
    const { engine, modelId, promptVersion } = made;
    const runTask = () => engine.run(
      {
        taskId: options.taskId,
        instruction: options.spec.instruction,
        startUrl: options.spec.start_url,
        allowedDomains: options.spec.allowed_hosts,
        outputSchema: recordsSchema(options.outputSchema) as unknown as Record<string, unknown>,
        allowWriteActions: options.allowWriteActions,
        limits: { maxSteps: options.spec.limits.max_steps, maxDurationMs: options.spec.limits.timeout_ms, maxCostUsd: budget.limitUsd },
        // Règles embarquées (tâche 2.10, 18 §4.5) : `systemPrompt` de Stagehand ; `read_skill` ne sert que les skills
        // référencés par la stratégie (version épinglée, empreinte vérifiée), sinon `skill_not_found`.
        ...(options.rules === undefined ? {} : { rules: options.rules }),
      },
      { model: { modelId, temperature: 0, promptVersion }, signal: AbortSignal.any([options.signal, stop.signal]) },
    );
    try {
      run = await runTask();
    } catch (error) {
      if (options.signal.aborted) throw error;
      // Navigation refusée (document refusé) qui a fait échouer le moteur : la classe du refus.
      await watch.settled();
      const refused = watch.refusal();
      if (refused !== undefined) return { result: fail(refused, 1), llm: null };
      // Construction refusée (mode non local, X1) ou erreur du moteur : jamais un succès, jamais un repli.
      return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'agent_engine_error' }), llm: null };
    }
    budget.report(run.costUsd);
    await watch.settled();
    // Une coupure n'est comptée que par la couche qui la fait (sans double compte, voir `dedicated` dans run-context.ts) :
    // route du contexte de run (requêtes initiales, WebSocket), interception du verrou (sauts de redirection), proxy d'egress.
    // Écritures : le verdict de la garde sur celles du dernier geste de l'agent arrive APRÈS la fin du run quand une couche
    // consultée avant elle tarde (cadence ; course constatée sous charge, le clic d'écriture était alors compilé en E5),
    // et une écriture coupée par la route des domaines ne l'atteint jamais. Sans
    // `allow_write_actions`, toute écriture LANCÉE est coupée : c'est elle qui est comptée, quel que soit son verdict
    // (`settleWrites`, toutes cibles). Les deux comptes sont des minorants des mêmes écritures.
    launchedWrites = options.allowWriteActions ? 0 : await ab.settleWrites(WRITE_BARRIER_TIMEOUT_MS);
    domainBlocked = ab.guard.blocked.filter((b) => b.reason === 'domain').length + ab.violations() + options.egress.domainBlockedCount();
    writesBlocked = Math.max(ab.guard.blocked.filter((b) => b.reason === 'write').length, launchedWrites);
  } finally {
    watch.dispose();
    noteWriteRefusals(gate, ab, launchedWrites);
    await ab.close();
  }
  const spend = spendFromAgent(run, made.modelId, made.promptVersion, `${made.engine.id}@${made.engine.version}`);
  const refusal = watch.refusal();
  if (refusal !== undefined) return { result: fail(refusal, 1), llm: spend, domainBlocked };
  if (run.status !== 'done') return { result: fail(agentFailure(run, cost), 1), llm: spend, domainBlocked };
  // Coût inconnu (prix absent) : plafond intenable, jamais un succès.
  if (spend.usd === null) return { result: fail(budgetFailure(true), 1), llm: spend, domainBlocked };
  const items = (run.output as { items?: unknown } | null)?.items;
  const result = conformRecords(Array.isArray(items) ? items : [], options.outputSchema, 1, options.itemPolicy);
  if (!result.ok) return { result, llm: spend, domainBlocked };
  if (options.compile === false) return { result, llm: spend, compileFailure: 'instructed_compile_deferred', domainBlocked };
  // La compilation E6 → E5 ne part que d'une sortie entièrement CONFORME (quarantaine : les non conformes sont encore dans
  // `result.records`) ; une sortie dont un item est écarté n'est pas compilée (une liste réduite à un item conforme
  // passerait pour une fiche).
  if (options.itemPolicy === 'quarantine' && partitionItems(options.outputSchema, result.records).rejected.length > 0) return { result, llm: spend, compileFailure: 'items_rejected', domainBlocked };
  const compiled = await compileAndVerify(options, lease, run, result.records, `${made.engine.id}@${made.engine.version}`, writesBlocked, gate.summary().blocked);
  return 'spec' in compiled ? { result, llm: spend, compiled: compiled.spec, trace: run.steps, domainBlocked } : { result, llm: spend, compileFailure: compiled.failure, domainBlocked };
}
