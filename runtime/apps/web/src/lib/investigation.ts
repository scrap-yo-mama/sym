// SPDX-License-Identifier: AGPL-3.0-only
// État d'une enquête en direct (06 § 2, « Nouvelle API ») reconstruit à partir des événements SSE. Aucune logique métier
// (06 § 4.1) : la machine à états, le classifieur et le budget vivent côté serveur ; ici on ne fait que ranger ce que le
// serveur annonce. Le traitement est synchrone, sans file ni temporisation : un essai terminé est visible dès la trame
// reçue (critère de 3.5 : un essai apparaît en moins de 2 s, `assert_budget_and_stop_controls`).
//
// Contrat des charges `data` (JSON, snake_case, comme 04b et 05). Les noms d'événements sont ceux de `EventName`
// (OpenAPI spécifiée) ; leurs champs sont ceux que cette console lit, à confirmer par la tâche 3.1 qui livre le flux :
//   investigation.started  { run_id, api_id?, api_slug?, domain?, budget?, access_report? }
//   phase.started          { run_id, phase, plan?: [{ execution, network?, est_cost_usd? }], budget? }
//   schema.proposed        { run_id, output_schema, sample?, input_schema?, budget? }
//   attempt.finished       { run_id, attempt: RunAttempt (+ why?: { code, params }), exchange?, budget? }
// `exchange` (carte requête/réponse de la colonne « Ce que voit l'agent », 06 § 2 ; ADR 0003, à confirmer par 3.1) :
//   { request: { method, url }, response?: { status?, content_type?, bytes? } } — jamais d'en-tête ni de corps (INV8) ; la
//   console ne garde de l'URL que l'origine et le chemin (ni requête ni fragment), et ignore une méthode ou un schéma inattendus.
//   status.changed         { run_id?, api_id?, api_slug?, status, status_reason?, domain?, at?, strategy?, input_schema?, budget? }
//   action.required        { run_id?, api_id?, api_slug?, cause, domain?, platform?, offer? }
// `budget` : { spent_usd, max_usd, elapsed_s, timeout_s, retained_est_usd?, full_agent_est_usd? }. Toute charge est lue avec
// des gardes de type : une charge inattendue est ignorée, jamais rendue telle quelle (aucun HTML, texte seul).
import type { components } from '@runtime/client';
import type { SseEvent } from '@/lib/sse';

type Schemas = components['schemas'];
export type Execution = Schemas['Execution'];
type Network = Schemas['Network'];
export type InvestigationPhase = Schemas['InvestigationPhase'];
type ApiStatus = Schemas['ApiStatus'];
export type AccessReport = Schemas['AccessReport'];

const EXECUTIONS: readonly Execution[] = ['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent'];
const NETWORKS: readonly Network[] = ['direct', 'dc_proxy', 'res_proxy', 'tunnel'];
/** Les quatre jalons de la frise (`done` est l'état final, pas un jalon). */
export const PHASE_MILESTONES = ['access_check', 'reconnaissance', 'awaiting_schema_validation', 'testing'] as const;
const PHASES: readonly InvestigationPhase[] = [...PHASE_MILESTONES, 'done'];
const STATUSES: readonly ApiStatus[] = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'];
/**
 * Causes d'arrêt volontaire montrées par le panneau « Bloquée » (INV6) ; toute autre cause d'un statut `bloquee` est lue
 * comme la première. Le robots.txt ne conditionne plus la collecte (D-91) : une ancienne cause `robots_disallowed`
 * (valeur historique) se lit comme un refus du site (`forbidden`), sans texte sur le robots.txt.
 */
export const BLOCK_CAUSES = ['blocked_by_protection', 'forbidden'] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];
/** Causes d'une action requise (06 § 2). */
const ACTION_CAUSES = [
  'auth_required',
  'cookie_expired',
  'session_device_bound',
  'proxy_required',
  'tunnel_offline',
  'challenge_in_tunnel',
  'secret_unreadable',
  'payment_required',
  'account_limit',
] as const;
export type ActionCause = (typeof ACTION_CAUSES)[number];

export interface ReasonView {
  code: string;
  params: Record<string, string | number>;
}

export interface BudgetView {
  spentUsd: number | null;
  maxUsd: number | null;
  /** Secondes écoulées au moment `receivedAtMs` ; le compteur affiché ajoute le temps passé depuis. */
  elapsedS: number | null;
  timeoutS: number | null;
  retainedEstUsd: number | null;
  fullAgentEstUsd: number | null;
  receivedAtMs: number;
}

export interface AttemptView {
  index: number;
  execution: Execution;
  network: Network;
  state: 'running' | 'done' | 'pruned';
  /** `ok` ou classe d'échec de l'essai (code stable). */
  result: string | null;
  costUsd: number | null;
  estCostUsd: number | null;
  ms: number | null;
  prunedReason: string | null;
  /** Le « pourquoi » de l'essai, en code et paramètres. */
  why: ReasonView | null;
  /** Raison d'échec en clair (code et paramètres). */
  error: ReasonView | null;
  /** Carte requête/réponse de l'essai, quand le flux la donne (`exchange` de `attempt.finished`). */
  exchange?: ExchangeView | null;
}

/** Résumé d'un échange HTTP d'un essai : jamais d'en-tête, de cookie ni de corps. */
export interface ExchangeView {
  method: string;
  /** Origine et chemin seulement. */
  url: string;
  status: number | null;
  /** Type de média sans paramètres (`text/html`). */
  contentType: string | null;
  bytes: number | null;
}

export interface PlanStep {
  execution: Execution;
  network: Network | null;
  estCostUsd: number | null;
}

interface BlockedView {
  cause: BlockCause;
  domain: string | null;
  at: string | null;
  /** Essai déclencheur : le dernier essai connu au moment du blocage. */
  attempt: AttemptView | null;
  costUsd: number | null;
}

export interface ActionView {
  cause: ActionCause;
  domain: string | null;
  platform: string | null;
  offer: string | null;
  /** Transition 17 : l'utilisateur a agi, l'enquête reprend (« Reprise de l'enquête… »). */
  resuming: boolean;
}

export interface StrategyView {
  version: number | null;
  execution: Execution | null;
  network: Network | null;
}

export interface InvestigationState {
  runId: string | null;
  apiId: string | null;
  slug: string | null;
  domain: string | null;
  phase: InvestigationPhase | null;
  status: ApiStatus | null;
  statusReason: ReasonView | null;
  attempts: AttemptView[];
  budget: BudgetView | null;
  access: AccessReport | null;
  outputSchema: Record<string, unknown> | null;
  sample: Record<string, unknown>[];
  inputSchema: Record<string, unknown> | null;
  plan: PlanStep[] | null;
  strategy: StrategyView | null;
  blocked: BlockedView | null;
  action: ActionView | null;
  /** Fin de l'enquête : `sain`, `warning`, `erreur`, `bloquee` ou arrêtée par l'utilisateur. */
  terminal: boolean;
  /** Pause demandée par l'utilisateur, relue du Run (`paused_at`, extension de 05 § 4.2 à livrer par 3.1) ; null hors pause. */
  pausedAt: string | null;
  /** Identifiants déjà vus : un événement rejoué (reprise, rejeu à la réouverture) n'est appliqué qu'une fois. */
  seen: string[];
}

export function emptyInvestigation(): InvestigationState {
  return {
    runId: null,
    apiId: null,
    slug: null,
    domain: null,
    phase: null,
    status: null,
    statusReason: null,
    attempts: [],
    budget: null,
    access: null,
    outputSchema: null,
    sample: [],
    inputSchema: null,
    plan: null,
    strategy: null,
    blocked: null,
    action: null,
    terminal: false,
    pausedAt: null,
    seen: [],
  };
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const oneOf = <T extends string>(value: unknown, list: readonly T[]): T | null => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null);

function reasonOf(value: unknown): ReasonView | null {
  if (!isRecord(value)) return null;
  const code = text(value.code);
  if (!code) return null;
  const params: Record<string, string | number> = {};
  if (isRecord(value.params)) for (const [key, param] of Object.entries(value.params)) if (typeof param === 'string' || typeof param === 'number') params[key] = param;
  return { code, params };
}

function budgetOf(value: unknown, nowMs: number): BudgetView | null {
  if (!isRecord(value)) return null;
  return {
    spentUsd: num(value.spent_usd),
    maxUsd: num(value.max_usd),
    elapsedS: num(value.elapsed_s),
    timeoutS: num(value.timeout_s),
    retainedEstUsd: num(value.retained_est_usd),
    fullAgentEstUsd: num(value.full_agent_est_usd),
    receivedAtMs: nowMs,
  };
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** Carte requête/réponse ; null si la méthode est inconnue ou si l'URL n'est pas http(s). */
function exchangeOf(value: unknown): ExchangeView | null {
  if (!isRecord(value) || !isRecord(value.request)) return null;
  const method = oneOf(value.request.method, METHODS);
  const raw = text(value.request.url);
  if (!method || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const response = isRecord(value.response) ? value.response : {};
  const status = num(response.status);
  const bytes = num(response.bytes);
  const type = text(response.content_type)?.split(';')[0]?.trim().toLowerCase() ?? null;
  return {
    method,
    url: `${url.origin}${url.pathname}`,
    status: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    contentType: type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : null,
    bytes: bytes !== null && Number.isInteger(bytes) && bytes >= 0 ? bytes : null,
  };
}

/** Un essai (forme `RunAttempt` de l'OpenAPI) ; null si l'exécution ou le réseau sont inconnus. */
function attemptOf(value: unknown, why: unknown = null, exchange: unknown = null): AttemptView | null {
  if (!isRecord(value)) return null;
  const execution = oneOf(value.execution, EXECUTIONS);
  const network = oneOf(value.network, NETWORKS);
  const index = num(value.index);
  if (!execution || !network || index === null) return null;
  return {
    index,
    execution,
    network,
    state: oneOf(value.state, ['running', 'done', 'pruned'] as const) ?? 'done',
    result: text(value.result),
    costUsd: num(value.cost_usd),
    estCostUsd: num(value.est_cost_usd),
    ms: num(value.ms),
    prunedReason: text(value.pruned_reason),
    why: reasonOf(why) ?? reasonOf(value.why),
    error: reasonOf(value.error),
    exchange: exchangeOf(exchange),
  };
}

function planOf(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: PlanStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const execution = oneOf(entry.execution, EXECUTIONS);
    if (execution) steps.push({ execution, network: oneOf(entry.network, NETWORKS), estCostUsd: num(entry.est_cost_usd) });
  }
  return steps;
}

/** Rapport d'accès d'un événement : `signal` connu suffit ; la section `robots` (historique, D-91) n'est pas exigée. */
function accessOf(value: unknown): AccessReport | null {
  if (!isRecord(value) || !oneOf(value.signal, ['allowed', 'review', 'disallowed'] as const)) return null;
  return value as unknown as AccessReport;
}

function domainOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Domaine d'une URL saisie (hôte seul), pour le panneau « Bloquée » et l'avertissement des sites à compte. */
export function hostOf(url: string): string | null {
  return domainOfUrl(url.trim());
}

function parse(data: string): Json | null {
  try {
    const value: unknown = JSON.parse(data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

const SEEN_LIMIT = 2000;

/**
 * Applique un événement du flux à l'enquête suivie. Renvoie vrai si l'événement la concerne (même `run_id`, ou même
 * API quand la charge n'a pas de run). Un événement sans identifiant de run ni d'API connu de l'état est ignoré.
 */
export function ingestEvent(state: InvestigationState, event: SseEvent, nowMs: number): boolean {
  const data = parse(event.data);
  if (!data) return false;
  const runId = text(data.run_id);
  const apiId = text(data.api_id);
  const slug = text(data.api_slug);
  const matches = runId ? runId === state.runId : (apiId !== null && apiId === state.apiId) || (slug !== null && slug === state.slug);
  if (!matches) return false;
  if (event.id) {
    if (state.seen.includes(event.id)) return true;
    state.seen.push(event.id);
    if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT);
  }
  if (apiId) state.apiId ??= apiId;
  if (slug) state.slug ??= slug;
  const domain = text(data.domain);
  if (domain) state.domain = domain;

  const budget = budgetOf(data.budget, nowMs);
  if (budget) state.budget = budget;

  switch (event.event) {
    case 'investigation.started': {
      state.phase ??= 'access_check';
      state.access = accessOf(data.access_report) ?? state.access;
      break;
    }
    case 'phase.started': {
      const phase = oneOf(data.phase, PHASES);
      if (phase) state.phase = phase;
      const plan = planOf(data.plan);
      if (plan) state.plan = plan;
      if (state.action?.resuming) state.action = null;
      break;
    }
    case 'schema.proposed': {
      if (isRecord(data.output_schema)) state.outputSchema = data.output_schema;
      if (Array.isArray(data.sample)) state.sample = data.sample.filter(isRecord);
      if (isRecord(data.input_schema)) state.inputSchema = data.input_schema;
      state.phase = 'awaiting_schema_validation';
      break;
    }
    case 'attempt.finished': {
      const attempt = attemptOf(data.attempt, data.why, data.exchange);
      if (attempt) {
        const at = state.attempts.findIndex((existing) => existing.index === attempt.index);
        if (at >= 0) state.attempts.splice(at, 1, attempt);
        else state.attempts.push(attempt);
        state.attempts.sort((a, b) => a.index - b.index);
      }
      if (state.action?.resuming) state.action = null;
      break;
    }
    case 'status.changed': {
      const status = oneOf(data.status, STATUSES);
      if (!status) break;
      state.status = status;
      state.statusReason = reasonOf(data.status_reason);
      if (isRecord(data.input_schema)) state.inputSchema = data.input_schema;
      if (isRecord(data.strategy)) {
        state.strategy = { version: num(data.strategy.version), execution: oneOf(data.strategy.execution, EXECUTIONS), network: oneOf(data.strategy.network, NETWORKS) };
      }
      if (status === 'bloquee') {
        const reasonCode = state.statusReason?.code ?? null;
        state.blocked = {
          cause: reasonCode === 'robots_disallowed' ? 'forbidden' : (oneOf(reasonCode, BLOCK_CAUSES) ?? 'blocked_by_protection'),
          domain: state.domain,
          at: text(data.at),
          attempt: state.attempts.at(-1) ?? null,
          costUsd: state.budget?.spentUsd ?? null,
        };
      } else {
        state.blocked = null;
      }
      if (status === 'enquete' && state.action) state.action.resuming = true;
      else if (status !== 'action_requise') state.action = null;
      state.terminal = status === 'sain' || status === 'warning' || status === 'erreur' || status === 'bloquee';
      if (state.terminal) state.phase = 'done';
      break;
    }
    case 'action.required': {
      const cause = oneOf(data.cause, ACTION_CAUSES);
      if (cause) state.action = { cause, domain: state.domain, platform: text(data.platform), offer: text(data.offer), resuming: false };
      break;
    }
    default:
      return false;
  }
  return true;
}

/** Amorce l'état avec la réponse de création (`ApiCreated`, 05 § 4.1). */
export function seedFromCreated(state: InvestigationState, created: Json): void {
  state.apiId = text(created.api_id) ?? state.apiId;
  state.slug = text(created.slug) ?? state.slug;
  state.runId = text(created.run_id) ?? state.runId;
  state.phase = oneOf(created.investigation_phase, PHASES) ?? state.phase ?? 'access_check';
  state.access = accessOf(created.access_report) ?? state.access;
  if (isRecord(created.proposed_output_schema)) state.outputSchema = created.proposed_output_schema;
  if (Array.isArray(created.sample)) state.sample = created.sample.filter(isRecord);
}

/** Amorce l'état avec un run relu (`Run`, GET /api/runs/{id}) : essais déjà faits, coût engagé, API suivie. */
export function seedFromRun(state: InvestigationState, run: Json, nowMs: number): void {
  state.runId = text(run.id) ?? state.runId;
  state.apiId = text(run.api_id) ?? state.apiId;
  state.slug = text(run.api_slug) ?? state.slug;
  if (Array.isArray(run.attempts)) {
    for (const entry of run.attempts) {
      const attempt = attemptOf(entry);
      if (attempt && !state.attempts.some((existing) => existing.index === attempt.index)) state.attempts.push(attempt);
    }
    state.attempts.sort((a, b) => a.index - b.index);
  }
  const total = isRecord(run.cost) ? num(run.cost.total_usd) : null;
  if (total !== null) state.budget = { ...(state.budget ?? { maxUsd: null, elapsedS: null, timeoutS: null, retainedEstUsd: null, fullAgentEstUsd: null }), spentUsd: total, receivedAtMs: nowMs };
  const runState = text(run.state);
  if (runState === 'succeeded' || runState === 'failed' || runState === 'cancelled') state.terminal = true;
  state.pausedAt = state.terminal ? null : text(run.paused_at);
}

/**
 * Nouvelle liste de méthodes exclues après (dé)cochage d'une méthode du plan (06 § 2) : on retire des méthodes, jamais on
 * n'en ajoute, et au moins une reste cochée. Renvoie la liste inchangée si le changement viderait le plan.
 */
export function toggleExcluded(plan: readonly PlanStep[], excluded: readonly Execution[], execution: Execution, checked: boolean): Execution[] {
  if (!plan.some((step) => step.execution === execution)) return [...excluded];
  const next = checked ? excluded.filter((entry) => entry !== execution) : [...new Set([...excluded, execution])];
  return plan.some((step) => !next.includes(step.execution)) ? next : [...excluded];
}
