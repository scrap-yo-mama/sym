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
import {
  compileAgentTrace,
  hybridUsesLlm,
  htmlToVisibleText,
  induceLabelExtraction,
  validateHybridSpec,
  validateOutput,
  type AgentEngine,
  type AgentFetchSpec,
  type AgentRunResult,
  type AgentSpec,
  type HybridSpec,
} from '@runtime/core';
import { extractRecordsWithLlm, extractLabelsFromPage, readPageView, recordsSchema, runHybridSteps, extractPromptVersion, type HybridFailure, type SemanticRecorder } from '@runtime/agent';
import { classifyExchange, classifyTransportError, fetchTransport, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type NetworkSession, type SsrfGuard } from '@runtime/core/net';
import { LlmError, toFailureClass, type LlmClient, type RunUsage } from '@runtime/llm';
import type { BrowserContext, Page, Request, Response } from 'playwright-core';
import { boundedContent, TOO_LARGE } from '../browser/bounded.js';
import type { AgentBrowser, AgentBrowserOptions } from '../browser/agent-browser.js';
import type { BrowserPool } from '../browser/pool.js';
import { hostAllowed, isMainNavigation, openRunContext, trackStrategyRequests } from '../browser/run-context.js';

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
  /** Pourquoi la compilation n'a pas abouti (code stable). */
  readonly compileFailure?: string;
  /** Navigations ou requêtes de l'agent coupées par le verrou de domaines (hôtes, jamais d'URL). */
  readonly domainBlocked?: number;
};

/** Moteur d'un essai : construit sur le Chromium dédié (Stagehand par `cdpUrl`), ou `null` si le rôle `agent` manque. */
export type EngineFactory = (args: { cdpUrl: string; recorder: SemanticRecorder }) => { engine: AgentEngine; modelId: string; promptVersion: string } | null;

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

/** Erreur du client LLM → classe `llm_*` (08 §1) ; toute autre erreur → classe de transport. */
function llmFailure(error: unknown): ExecFailure {
  if (error instanceof LlmError) {
    const retryable = ['overloaded', 'timeout', 'rate_limited', 'empty_response', 'network'].includes(error.class);
    return { failure_class: toFailureClass(error.class), retryable, detail: `llm_${error.class}` };
  }
  return classifyTransportError(error);
}

/** Enregistrements conformes : chaque item validé contre `output_schema` (INV1) ; 0 item = `extraction`. */
function conform(records: readonly unknown[], outputSchema: unknown, requests: number): DeclarativeRunResult {
  if (records.length === 0) return fail({ failure_class: 'extraction', retryable: false, detail: 'no_records' }, requests);
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
export type AgentFetchOptions = {
  readonly spec: AgentFetchSpec;
  readonly outputSchema: unknown;
  readonly llm: LlmClient;
  readonly modelId: string | null;
  readonly signal: AbortSignal;
  readonly session?: Pick<NetworkSession, 'fetch'>;
  readonly browser?: { readonly pool: BrowserPool; readonly egress: BrowserEgress; readonly guard: SsrfGuard };
  readonly pacer?: RequestPacer;
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
};

async function fetchPage(options: AgentFetchOptions): Promise<HttpExchange> {
  const url = options.spec.request.url;
  if (options.spec.via === 'fetch') {
    if (options.session === undefined) throw new Error('session réseau absente');
    const transport = fetchTransport(options.session, { maxResponseBytes: options.spec.limits.max_response_bytes, timeoutMs: NAVIGATION_TIMEOUT_MS });
    return transport({ method: 'GET', url, headers: {} }, options.signal);
  }
  const b = options.browser;
  if (b === undefined) throw new Error('navigateur absent');
  return b.pool.run(options.signal, async (browser) => {
    const rc = await openRunContext(browser, { egressServer: b.egress.server, allowedHosts: options.spec.request.allowed_hosts });
    const strategy = trackStrategyRequests(rc.context, options.spec.request.allowed_hosts);
    try {
      const response = await strategy.during(isMainNavigation(rc.page), () => guardedGoto(rc.page, url, b.guard, { waitUntil: 'load' as const, timeout: NAVIGATION_TIMEOUT_MS }));
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
  const url = options.spec.request.url;
  if (options.pacer !== undefined) {
    const slot = await options.pacer.acquire(url);
    if (!slot.granted) return { result: fail({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }), llm: null };
  }
  let exchange: HttpExchange;
  try {
    exchange = await fetchPage(options);
  } catch (error) {
    if (options.signal.aborted) throw error;
    const code = (error as { code?: unknown }).code;
    return { result: fail(code === 'response_too_large' ? { failure_class: 'extraction', retryable: false, detail: 'response_too_large' } : classifyTransportError(error), 1), llm: null };
  }
  await options.pacer?.report(url, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null });
  // Garde de classification AVANT tout prompt (04 §7, 1.7) : un refus ou un défi n'atteint jamais le LLM.
  const refused = (options.classify ?? classifyExchange)(exchange);
  if (refused !== null) return { result: fail(refused, 1), llm: null };
  const { text, truncated } = pageText(exchange, options.spec.limits.max_input_chars);
  if (text.trim() === '') return { result: fail({ failure_class: 'extraction', retryable: false, detail: 'empty_page' }, 1), llm: null };
  const spend = () => spendFromUsage(options.llm.usage(), options.modelId, extractPromptVersion, null);
  try {
    const out = await extractRecordsWithLlm(options.llm, {
      instruction: options.spec.instruction,
      pageText: text,
      pageUrl: exchange.url,
      truncated,
      itemSchema: options.outputSchema,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.spec.limits.timeout_ms)]),
    });
    return { result: conform(out.records, options.outputSchema, 1), llm: spend() };
  } catch (error) {
    if (options.signal.aborted) throw error;
    return { result: fail(llmFailure(error), 1), llm: spend() };
  }
}

// --------------------------------------------------------------------------------------------------------------- E5
export type HybridOptions = {
  readonly spec: HybridSpec;
  readonly outputSchema: unknown;
  readonly signal: AbortSignal;
  readonly guard: SsrfGuard;
  readonly egress: BrowserEgress;
  /** Pool du worker : E5 sans délégation (aucun LLM). */
  readonly pool: BrowserPool | null;
  /** Chromium dédié (E5 avec étapes `agent`) et moteur ; client du rôle `extract` (extraction déléguée). */
  readonly agentBrowser?: (options: Omit<AgentBrowserOptions, 'egressServer'>) => Promise<AgentBrowser>;
  readonly engineFor?: EngineFactory;
  readonly llm?: LlmClient | null;
  readonly llmModelId?: string | null;
  readonly allowWriteActions: boolean;
  readonly pacer?: RequestPacer;
  readonly maxRequests?: number;
  readonly maxCostUsd: number;
  /** Garde de classification (1.7) appliquée à chaque document du cadre principal ; défaut : le statut HTTP seul. */
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
};

const READ_METHODS = new Set(['GET', 'HEAD']);
/** Classes qui arrêtent l'agent ou le script (INV6, 04 §3.3) ; un 404 ou un 5xx n'arrête pas : l'agent peut revenir. */
const STOP_CLASSES: ReadonlySet<string> = new Set(['blocked_by_protection', 'forbidden', 'rate_limited', 'robots_disallowed', 'auth_required', 'payment_required', 'account_limit']);
const MAX_CLASSIFIED_BODY = 5_000_000;

/**
 * Garde de classification sur les documents du cadre principal (INV6, 04 §7) : un refus (401, 403, 429, défi servi en
 * 200 vu par la garde de 1.7…) est signalé AUSSITÔT, et l'appelant arrête l'agent ou le script ; aucune étape ni aucun
 * appel au modèle ne suit. Les sauts de redirection (3xx) ne sont pas classés.
 */
function watchDocuments(context: BrowserContext, classify: ((exchange: HttpExchange) => ExecFailure | null) | undefined, onRefused: (failure: ExecFailure) => void): () => void {
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
    void (async () => {
      const headers = response.headers();
      let body = '';
      if (classify !== undefined && status >= 200 && status < 300 && /html/i.test(headers['content-type'] ?? 'text/html')) {
        const declared = Number(headers['content-length'] ?? NaN);
        if (!(Number.isFinite(declared) && declared > MAX_CLASSIFIED_BODY)) body = (await response.text().catch(() => '')).slice(0, MAX_CLASSIFIED_BODY);
      }
      const refused = (classify ?? classifyExchange)({ status, headers, body, url: response.url() });
      if (refused !== null && STOP_CLASSES.has(refused.failure_class)) onRefused(refused);
    })();
  };
  context.on('response', handler);
  return () => context.off('response', handler);
}

/** Admission des navigations d'un E5 sur le pool : écritures (08 §4 mesure 4), plafond de requêtes, cadence (1.9). */
function navigationAdmission(options: Pick<HybridOptions, 'allowWriteActions' | 'pacer' | 'maxRequests'>): (request: Request) => Promise<boolean> {
  let documents = 0;
  return async (request) => {
    if (!request.isNavigationRequest()) return true;
    if (!options.allowWriteActions && !READ_METHODS.has(request.method().toUpperCase())) return false;
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

/** Navigation gardée d'une étape E5 : schéma et garde SSRF, puis verrou de domaines sur l'URL finale. */
function gotoFor(page: Page, guard: SsrfGuard, allowedHosts: readonly string[]): (url: string) => Promise<void> {
  return async (url) => {
    const response = await guardedGoto(page, url, guard, { waitUntil: 'load' as const, timeout: NAVIGATION_TIMEOUT_MS });
    if (response !== null && !hostAllowed(response.url(), allowedHosts)) throw new DomainNotAllowedError(new URL(response.url()).hostname);
    const status = response?.status() ?? 0;
    const refused = classifyExchange({ status, headers: response?.headers() ?? {}, body: '', url });
    if (refused !== null) throw Object.assign(new Error('navigation refusée'), { execFailure: refused });
  };
}

function stepError(error: unknown): ExecFailure {
  const f = (error as { execFailure?: ExecFailure }).execFailure;
  if (f !== undefined) return f;
  const name = (error as { name?: unknown }).name;
  if (name === 'TimeoutError') return { failure_class: 'extraction', retryable: false, detail: 'step_timeout' };
  return classifyTransportError(error);
}

/** E5 sans délégation : contexte neuf du pool, étapes, extraction par libellés. Aucun appel LLM possible ici. */
async function runHybridWithoutLlm(options: HybridOptions, onPage?: (page: Page) => Promise<void>): Promise<DeclarativeRunResult> {
  const pool = options.pool;
  if (pool === null) return fail({ failure_class: 'code_error', retryable: false, detail: 'browser_disabled' });
  const spec = options.spec;
  return pool.run(options.signal, async (browser) => {
    const rc = await openRunContext(browser, { egressServer: options.egress.server, allowedHosts: spec.allowed_hosts, admit: navigationAdmission(options) });
    const strategy = trackStrategyRequests(rc.context, spec.allowed_hosts);
    const stop = new AbortController();
    let refusal: ExecFailure | undefined;
    const unwatch = watchDocuments(rc.context, options.classify, (f) => {
      refusal ??= f;
      stop.abort();
    });
    try {
      const goto = gotoFor(rc.page, options.guard, spec.allowed_hosts);
      let failure: HybridFailure | null;
      try {
        failure = await strategy.during(isMainNavigation(rc.page), () =>
          runHybridSteps(rc.page, spec, { goto, signal: AbortSignal.any([options.signal, stop.signal, AbortSignal.timeout(spec.limits.timeout_ms)]) }),
        );
      } catch (error) {
        if (options.signal.aborted) throw error;
        if (refusal !== undefined) return fail(refusal, 1);
        return fail(strategy.cut() ? { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } : stepError(error), 1);
      }
      if (refusal !== undefined) return fail(refusal, 1);
      if (failure !== null) return hybridFail(failure);
      if (onPage !== undefined) await onPage(rc.page);
      const extracted = await extractLabelsFromPage(rc.page, spec);
      if (refusal !== undefined) return fail(refusal, 1);
      return extracted.ok ? conform(extracted.records, options.outputSchema, spec.steps.length + 1) : hybridFail(extracted.failure);
    } finally {
      unwatch();
      await rc.close();
    }
  });
}

/** E5 : script déclaratif, étapes et extraction éventuellement déléguées (moteur, rôle `extract`). */
export async function runHybridExecutor(options: HybridOptions): Promise<AgentOutcome> {
  const spec = options.spec;
  if (!hybridUsesLlm(spec)) return { result: await runHybridWithoutLlm(options), llm: null };
  if (options.agentBrowser === undefined) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'browser_disabled' }), llm: null };
  const needsEngine = spec.steps.some((s) => s.op === 'agent');
  const ab = await options.agentBrowser({
    allowedHosts: spec.allowed_hosts,
    allowWriteActions: options.allowWriteActions,
    ...(options.pacer === undefined ? {} : { pacer: options.pacer }),
    ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
  });
  let spend: LlmSpend | null = null;
  const stop = new AbortController();
  let refusal: ExecFailure | undefined;
  const unwatch = watchDocuments(ab.context, options.classify, (f) => {
    refusal ??= f;
    stop.abort();
  });
  const signal = AbortSignal.any([options.signal, stop.signal]);
  try {
    const made = needsEngine ? (options.engineFor?.({ cdpUrl: ab.cdpUrl, recorder: ab.recorder }) ?? null) : null;
    if (needsEngine && made === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }), llm: null };
    const agentStep = async (instruction: string) => {
      const run = await made!.engine.run(
        {
          taskId: 'hybrid_step',
          instruction,
          startUrl: '',
          allowedDomains: spec.allowed_hosts,
          outputSchema: { type: 'object' },
          allowWriteActions: options.allowWriteActions,
          limits: { maxSteps: 10, maxDurationMs: spec.limits.step_timeout_ms * 4, maxCostUsd: options.maxCostUsd },
        },
        { model: { modelId: made!.modelId, temperature: 0, promptVersion: made!.promptVersion }, signal },
      );
      spend = addSpend(spend, spendFromAgent(run, made!.modelId, made!.promptVersion, `${made!.engine.id}@${made!.engine.version}`));
      return run.status === 'done' ? ({ ok: true } as const) : ({ ok: false, failure: { failure_class: 'extraction', detail: `agent_${run.status}` } } as const);
    };
    let failure: HybridFailure | null;
    try {
      failure = await runHybridSteps(ab.page, spec, {
        goto: gotoFor(ab.page, options.guard, spec.allowed_hosts),
        agentStep,
        signal: AbortSignal.any([signal, AbortSignal.timeout(spec.limits.timeout_ms)]),
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      return { result: fail(refusal ?? stepError(error), 1), llm: spend };
    }
    // Refus vu sur un document (INV6) : arrêt, aucune extraction, aucun appel au modèle de plus.
    if (refusal !== undefined) return { result: fail(refusal, 1), llm: spend };
    if (failure !== null) return { result: hybridFail(failure), llm: spend };
    if (spec.extract.mode === 'labels') {
      const extracted = await extractLabelsFromPage(ab.page, spec);
      return { result: extracted.ok ? conform(extracted.records, options.outputSchema, spec.steps.length + 1) : hybridFail(extracted.failure), llm: spend };
    }
    if (options.llm === undefined || options.llm === null) return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'llm_not_configured' }), llm: spend };
    const view = await readPageView(ab.page, spec.limits.max_input_chars * 10);
    if (view === null) return { result: fail({ failure_class: 'extraction', retryable: false, detail: 'response_too_large' }, 1), llm: spend };
    const text = view.text.slice(0, spec.limits.max_input_chars);
    try {
      const out = await extractRecordsWithLlm(options.llm, {
        instruction: spec.extract.instruction,
        pageText: text,
        pageUrl: ab.page.url(),
        truncated: view.text.length > text.length,
        itemSchema: options.outputSchema,
        signal: options.signal,
      });
      spend = addSpend(spend, spendFromUsage(options.llm.usage(), options.llmModelId ?? null, extractPromptVersion, null));
      return { result: conform(out.records, options.outputSchema, spec.steps.length + 1), llm: spend };
    } catch (error) {
      if (options.signal.aborted) throw error;
      spend = addSpend(spend, spendFromUsage(options.llm.usage(), options.llmModelId ?? null, extractPromptVersion, null));
      return { result: fail(llmFailure(error), 1), llm: spend };
    }
  } finally {
    unwatch();
    await ab.close();
  }
}

// --------------------------------------------------------------------------------------------------------------- E6
export type AgentOptions = {
  readonly spec: AgentSpec;
  readonly outputSchema: unknown;
  readonly signal: AbortSignal;
  readonly guard: SsrfGuard;
  readonly egress: BrowserEgress;
  readonly agentBrowser: (options: Omit<AgentBrowserOptions, 'egressServer'>) => Promise<AgentBrowser>;
  readonly engineFor: EngineFactory;
  /** Pool du worker : rejeux de vérification de la compilation (sans LLM). `null` : pas de compilation. */
  readonly pool: BrowserPool | null;
  readonly allowWriteActions: boolean;
  readonly pacer?: RequestPacer;
  readonly maxRequests?: number;
  readonly maxCostUsd: number;
  readonly taskId: string;
  /** Version E6 courante (origine de la stratégie compilée). */
  readonly version: number | null;
  /** Garde de classification (1.7) sur chaque document du cadre principal ; défaut : le statut HTTP seul. */
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
};

function agentFailure(run: AgentRunResult): ExecFailure {
  const cls = run.failureClass ?? '';
  if (cls === 'run_budget_exceeded') return { failure_class: 'run_budget_exceeded', retryable: false, detail: 'max_cost_usd' };
  if (/^llm_[a-z0-9_]+$/.test(cls)) return { failure_class: cls as `llm_${string}`, retryable: false, detail: cls };
  if (cls === 'agent_toolset_not_closed') return { failure_class: 'code_error', retryable: false, detail: cls };
  if (run.status === 'timeout') return { failure_class: 'transient', retryable: true, detail: 'agent_timeout' };
  if (run.status === 'max_steps') return { failure_class: 'extraction', retryable: false, detail: 'agent_max_steps' };
  return { failure_class: 'extraction', retryable: false, detail: 'agent_no_output' };
}

/**
 * Compilation E6 → E5 vérifiée : étapes depuis la trace, puis rejeu 1 (contexte neuf, aucun LLM) pour induire
 * l'extraction par libellés sur la page atteinte, puis rejeu 2 (autre contexte neuf) de la stratégie complète, qui doit
 * rendre exactement l'enregistrement validé. Un seul enregistrement par run (fiche) ; sinon pas de compilation.
 */
async function compileAndVerify(options: AgentOptions, run: AgentRunResult, records: readonly Record<string, unknown>[], engine: string): Promise<{ spec: HybridSpec } | { failure: string }> {
  if (options.pool === null) return { failure: 'browser_disabled' };
  if (records.length !== 1) return { failure: 'not_single_record' };
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
  const base: HybridOptions = { ...options, spec: draft.spec, pool: options.pool };
  let fields: ReturnType<typeof induceLabelExtraction> = null;
  const first = await runHybridWithoutLlm(base, async (page) => {
    const view = await readPageView(page, draft.spec.limits.max_input_chars * 10);
    if (view !== null) fields = induceLabelExtraction(view, expected);
  }).catch(() => null);
  if (first === null) return { failure: 'replay_error' };
  if (fields === null) return { failure: 'extraction_not_inducible' };
  const final = validateHybridSpec({ ...draft.spec, extract: { mode: 'labels', fields } });
  if (!final.ok) return { failure: 'invalid_compiled_spec' };
  const replay = await runHybridWithoutLlm({ ...base, spec: final.spec }).catch(() => null);
  if (replay === null || !replay.ok) return { failure: 'replay_failed' };
  if (replay.records.length !== 1 || JSON.stringify(replay.records[0]) !== JSON.stringify(expected)) return { failure: 'replay_mismatch' };
  return { spec: final.spec };
}

/** E6 : l'agent pilote le Chromium dédié de bout en bout ; trace réussie compilée en E5 vérifiée. */
export async function runAgentExecutor(options: AgentOptions): Promise<AgentOutcome> {
  const ab = await options.agentBrowser({
    allowedHosts: options.spec.allowed_hosts,
    allowWriteActions: options.allowWriteActions,
    ...(options.pacer === undefined ? {} : { pacer: options.pacer }),
    ...(options.maxRequests === undefined ? {} : { maxRequests: options.maxRequests }),
  });
  let run: AgentRunResult;
  let made: ReturnType<EngineFactory>;
  let domainBlocked: number;
  // Refus vu sur un document (401, 403, 429, défi…) : l'agent est arrêté aussitôt, sans autre action (INV6).
  const stop = new AbortController();
  let refusal: ExecFailure | undefined;
  const unwatch = watchDocuments(ab.context, options.classify, (f) => {
    refusal ??= f;
    stop.abort();
  });
  try {
    made = options.engineFor({ cdpUrl: ab.cdpUrl, recorder: ab.recorder });
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
        limits: { maxSteps: options.spec.limits.max_steps, maxDurationMs: options.spec.limits.timeout_ms, maxCostUsd: options.maxCostUsd },
      },
      { model: { modelId, temperature: 0, promptVersion }, signal: AbortSignal.any([options.signal, stop.signal]) },
    );
    try {
      run = await runTask();
    } catch (error) {
      if (options.signal.aborted) throw error;
      // Construction refusée (mode non local, X1) ou erreur du moteur : jamais un succès, jamais un repli.
      return { result: fail({ failure_class: 'code_error', retryable: false, detail: 'agent_engine_error' }), llm: null };
    }
    domainBlocked = ab.guard.blocked.filter((b) => b.reason === 'domain').length + options.egress.domainBlockedCount();
  } finally {
    unwatch();
    await ab.close();
  }
  const spend = spendFromAgent(run, made.modelId, made.promptVersion, `${made.engine.id}@${made.engine.version}`);
  if (refusal !== undefined) return { result: fail(refusal, 1), llm: spend, domainBlocked };
  if (run.status !== 'done') return { result: fail(agentFailure(run), 1), llm: spend, domainBlocked };
  const items = (run.output as { items?: unknown } | null)?.items;
  const result = conform(Array.isArray(items) ? items : [], options.outputSchema, 1);
  if (!result.ok) return { result, llm: spend, domainBlocked };
  const compiled = await compileAndVerify(options, run, result.records, `${made.engine.id}@${made.engine.version}`);
  return 'spec' in compiled ? { result, llm: spend, compiled: compiled.spec, domainBlocked } : { result, llm: spend, compileFailure: compiled.failure, domainBlocked };
}
