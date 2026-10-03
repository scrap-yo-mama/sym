// SPDX-License-Identifier: AGPL-3.0-only
// État d'une enquête en direct (06 § 2, « Nouvelle API ») reconstruit à partir des événements SSE. Aucune logique métier
// (06 § 4.1) : la machine à états, le classifieur et le budget vivent côté serveur ; ici on ne fait que ranger ce que le
// serveur annonce. Le traitement est synchrone, sans file ni temporisation : un essai terminé est visible dès la trame
// reçue (critère de 3.5 : un essai apparaît en moins de 2 s, `assert_budget_and_stop_controls`).
//
// Contrat des charges `data` (JSON, snake_case, comme 04b et 05). Les noms d'événements sont ceux de `EventName`
// (OpenAPI spécifiée) ; leurs champs sont ceux que cette console lit, à confirmer par la tâche 3.1 qui livre le flux :
//   investigation.started  { run_id, api_id?, api_slug?, domain?, budget?, access_report? }
//   phase.started          { run_id, phase, plan?: [{ execution, network?, est_cost_usd?, source?, rule? }], budget? }
//   schema.proposed        { run_id, output_schema, sample?, input_schema?, budget? }
//   schema.validated       { run_id, by?: 'auto' | … }   (le schéma est validé : `auto` sous `auto_validate`, sinon par l'utilisateur)
//   attempt.finished       { run_id, attempt: RunAttempt (+ why?: { code, params }), source?, exchange?, budget? }
//   attempt.pruned         { run_id, by?: { execution, network, source? }, reason, pruned: [{ execution, network, source?, est_cost_usd? }] }
//   strategy.compiled      { run_id, from: 'agent_fetch', to: 'fetch', ok, reason?, proposals?, ratio?, cost_usd? }  (essai E4 compilé en
//                          stratégie déclarative html rejouée sans IA, ou compilation non retenue : E4 reste la stratégie)
// `exchange` (carte requête/réponse de la colonne « Ce que voit l'agent », 06 § 2 ; ADR 0003, à confirmer par 3.1) :
//   { request: { method, url }, response?: { status?, content_type?, bytes? } } — jamais d'en-tête ni de corps (INV8) ; la
//   console ne garde de l'URL que l'origine et le chemin (ni requête ni fragment), et ignore une méthode ou un schéma inattendus.
//   status.changed         { run_id?, api_id?, api_slug?, status, status_reason?, domain?, at?, strategy?, input_schema?, budget? }
//   action.required        { run_id?, api_id?, api_slug?, cause, domain?, platform?, offer? }
// `budget` : { spent_usd, max_usd, elapsed_s, timeout_s, retained_est_usd?, full_agent_est_usd? }. Toute charge est lue avec
// des gardes de type : une charge inattendue est ignorée, jamais rendue telle quelle (aucun HTML, texte seul).
import type { components } from '@runtime/client';
import { isRefusal } from '@/lib/refusal';
import { INVESTIGATION_MILESTONES, milestoneStates, type InvestigationMilestone, type MilestonePhase, type MilestoneState } from '@/lib/milestones';
import type { SseEvent } from '@/lib/sse';

type Schemas = components['schemas'];
export type Execution = Schemas['Execution'];
type Network = Schemas['Network'];
export type InvestigationPhase = Schemas['InvestigationPhase'];
type ApiStatus = Schemas['ApiStatus'];
export type AccessReport = Schemas['AccessReport'];

const EXECUTIONS: readonly Execution[] = ['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent'];
const NETWORKS: readonly Network[] = ['direct', 'dc_proxy', 'res_proxy', 'tunnel'];
const PHASES: readonly InvestigationPhase[] = ['access_check', 'reconnaissance', 'awaiting_schema_validation', 'testing', 'done'];
const STATUSES: readonly ApiStatus[] = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'];
/** Causes d'arrêt volontaire montrées par le panneau « Bloquée » (INV6) ; toute autre cause d'un statut `bloquee` est lue comme la première. */
export const BLOCK_CAUSES = ['blocked_by_protection', 'forbidden', 'robots_disallowed'] as const;
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
  /** Gisement de données de l'essai (`source` de `attempt.finished`), quand le serveur le donne. */
  source?: string | null;
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
  /** Gisement de données du couple, quand le serveur le donne. */
  source?: string | null;
  /** Règle (Markdown, 18) qui a ordonné ou restreint ce couple ; absent : politique par défaut du moins cher d'abord. */
  rule?: string | null;
}

/** Couple élagué (`attempt.pruned`) : jamais lancé, avec la classe de résultat qui l'a écarté. */
interface PrunedStep {
  execution: Execution;
  network: Network | null;
  estCostUsd: number | null;
  source: string | null;
  /** Classe de résultat (code stable) qui a fait sauter ce couple. */
  reason: string | null;
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

/** Compilation d'un essai E4 en stratégie déclarative rejouée sans IA (`strategy.compiled`). */
export interface CompiledView {
  ok: boolean;
  /** Raison du refus (code stable) ; nulle si la compilation est retenue. */
  reason: string | null;
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
  /** Ce que l'utilisateur a demandé (description saisie à la création) ; nulle pour une enquête rouverte. */
  description: string | null;
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
  /** Couples écartés par le classifieur (`attempt.pruned`), grisés avec leur raison dans le plan. */
  pruned: PrunedStep[];
  strategy: StrategyView | null;
  /** Compilation E4 → déclaratif html : retenue (rejeu sans IA) ou non ; nulle tant qu'aucune n'a eu lieu. */
  compiled: CompiledView | null;
  blocked: BlockedView | null;
  action: ActionView | null;
  /** Fin de l'enquête : `sain`, `warning`, `erreur`, `bloquee` ou arrêtée par l'utilisateur. */
  terminal: boolean;
  /** Dernier sous-état avant la fin : le jalon d'un arrêt est celui où l'enquête s'est arrêtée (la phase devient `done`). */
  reachedPhase: InvestigationPhase | null;
  /** Qui a validé le schéma : `auto` (`auto_validate`, aucune porte) ou l'utilisateur ; nul tant qu'il ne l'est pas. */
  validatedBy: 'auto' | 'user' | null;
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
    description: null,
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
    pruned: [],
    strategy: null,
    compiled: null,
    blocked: null,
    action: null,
    terminal: false,
    reachedPhase: null,
    validatedBy: null,
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
    source: null,
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
    if (execution) steps.push({ execution, network: oneOf(entry.network, NETWORKS), estCostUsd: num(entry.est_cost_usd), source: text(entry.source), rule: text(entry.rule) });
  }
  return steps;
}

/** Couples d'un `attempt.pruned` : la raison est le code de classe de l'essai qui a provoqué l'élagage. */
function prunedOf(data: Json): PrunedStep[] {
  const reason = text(data.reason);
  const steps = planOf(data.pruned) ?? [];
  return steps.map((step) => ({ execution: step.execution, network: step.network, estCostUsd: step.estCostUsd, source: step.source ?? null, reason }));
}

function accessOf(value: unknown): AccessReport | null {
  if (!isRecord(value) || !isRecord(value.robots) || !oneOf(value.signal, ['allowed', 'review', 'disallowed'] as const)) return null;
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
      if (phase && phase !== 'done') state.reachedPhase = phase;
      const plan = planOf(data.plan);
      if (plan) state.plan = plan;
      if (state.action?.resuming) state.action = null;
      break;
    }
    case 'schema.proposed': {
      if (isRecord(data.output_schema)) state.outputSchema = data.output_schema;
      if (Array.isArray(data.sample)) state.sample = data.sample.filter(isRecord);
      if (isRecord(data.input_schema)) state.inputSchema = data.input_schema;
      // `ok: false` : le serveur n'a pas pu proposer de schéma (l'enquête échoue) ; il n'y a rien à valider.
      if (data.ok !== false) {
        state.phase = 'awaiting_schema_validation';
        state.reachedPhase = 'awaiting_schema_validation';
      }
      break;
    }
    case 'schema.validated': {
      state.validatedBy = text(data.by) === 'auto' ? 'auto' : 'user';
      break;
    }
    case 'attempt.pruned': {
      for (const step of prunedOf(data)) {
        const known = state.pruned.some((entry) => entry.execution === step.execution && entry.network === step.network && entry.source === step.source);
        if (!known) state.pruned.push(step);
      }
      break;
    }
    case 'attempt.finished': {
      const attempt = attemptOf(data.attempt, data.why, data.exchange);
      if (attempt) {
        attempt.source = text(data.source);
        const at = state.attempts.findIndex((existing) => existing.index === attempt.index);
        if (at >= 0) state.attempts.splice(at, 1, attempt);
        else state.attempts.push(attempt);
        state.attempts.sort((a, b) => a.index - b.index);
      }
      if (state.action?.resuming) state.action = null;
      break;
    }
    case 'strategy.compiled': {
      state.compiled = { ok: data.ok === true, reason: data.ok === true ? null : text(data.reason) };
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
          cause: oneOf(reasonCode, BLOCK_CAUSES) ?? 'blocked_by_protection',
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
      if (state.terminal) {
        if (state.phase && state.phase !== 'done') state.reachedPhase = state.phase;
        state.phase = 'done';
      }
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
  if (state.phase !== 'done') state.reachedPhase = state.phase;
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
export function toggleExcluded(plan: readonly { execution: Execution }[], excluded: readonly Execution[], execution: Execution, checked: boolean): Execution[] {
  if (!plan.some((step) => step.execution === execution)) return [...excluded];
  const next = checked ? excluded.filter((entry) => entry !== execution) : [...new Set([...excluded, execution])];
  return plan.some((step) => !next.includes(step.execution)) ? next : [...excluded];
}

/**
 * États des quatre jalons (20 § 5.3) : « Décrire » est fait dès que l'API est créée ; un arrêt (refus, arrêt de l'utilisateur,
 * erreur) marque le jalon où l'enquête s'est arrêtée « arrêté », jamais « fait ». `created` : l'API existe (formulaire envoyé).
 */
export function milestoneView(state: Readonly<InvestigationState>, options: { created: boolean; cancelled?: boolean }): Record<InvestigationMilestone, MilestoneState> {
  const ended = state.terminal || options.cancelled === true;
  const phase = (state.phase === 'done' ? state.reachedPhase : state.phase) as MilestonePhase | null;
  const completed = state.terminal && (state.status === 'sain' || state.status === 'warning') && options.cancelled !== true;
  return milestoneStates({ phase, created: options.created, outcome: completed ? 'completed' : ended ? 'stopped' : 'running' });
}

export type { InvestigationMilestone, MilestoneState };
export { INVESTIGATION_MILESTONES };

/** Phrase-modèle de la description (20 § 5.3, m3 R7) : « Je veux [quoi] depuis [où] … », « I want [what] from [where] … ». */
const REQUEST_PATTERNS: Readonly<Record<string, RegExp>> = { fr: /^\s*je\s+veux\s+(.+?)\s+depuis\s+\S/iu, en: /^\s*i\s+want\s+(.+?)\s+from\s+\S/iu };
const REQUESTED_MAX_CHARS = 80;

/**
 * Les items demandés, tels que l'utilisateur les a nommés dans la phrase-modèle (« les livres ») : la bulle de la porte dit
 * « J'ai trouvé les livres. » (planche NouvelleApi.dc.html). Nul hors phrase-modèle ou au-delà de 80 caractères : la bulle
 * retombe alors sur le domaine enquêté, jamais sur un nom deviné. Seule la phrase-modèle de la langue de l'interface compte : une
 * description française n'entre pas dans une phrase anglaise. Texte de l'utilisateur, rendu en texte (jamais en HTML).
 */
export function requestedItems(description: string | null | undefined, locale: string): string | null {
  const pattern = REQUEST_PATTERNS[locale];
  if (!description || !pattern) return null;
  const what = pattern.exec(description)?.[1]?.trim();
  return what && Array.from(what).length <= REQUESTED_MAX_CHARS ? what : null;
}

/** Politique par défaut du moins cher d'abord, livrée en Markdown (04 § 3, 18) : la règle appliquée quand aucune autre n'a ordonné le plan. */
export const DEFAULT_RULE = 'escalade-par-defaut.md';

/** Une carte du plan d'essais : un couple (exécution, réseau), son coût estimé, sa règle et son état. */
export interface TrialCard {
  key: string;
  execution: Execution;
  network: Network | null;
  estCostUsd: number | null;
  /** Règle qui a ordonné ou restreint ce couple ; nulle : politique par défaut (le moins cher d'abord). */
  rule: string | null;
  state: 'planned' | 'running' | 'succeeded' | 'failed' | 'pruned';
  /** Classe de résultat : celle de l'essai (`failed`) ou de l'essai qui a élagué ce couple (`pruned`). */
  reason: string | null;
}

const cardKey = (execution: Execution, network: Network | null, source: string | null | undefined): string => `${execution}|${network ?? ''}|${source ?? ''}`;

/**
 * Ordre d'affichage du plan : celui du serveur quand une règle l'a décidé, sinon du moins cher au plus cher (INV2 : la suite
 * des coûts estimés est croissante ; tri stable, coût inconnu en dernier). La console ne réordonne jamais un plan qu'une règle a
 * réordonné, et n'ajoute jamais de couple.
 */
function orderPlan<T extends { estCostUsd: number | null; rule?: string | null }>(plan: readonly T[]): T[] {
  if (plan.some((step) => step.rule)) return [...plan];
  return plan.map((step, index) => ({ step, index })).sort((a, b) => (a.step.estCostUsd ?? Infinity) - (b.step.estCostUsd ?? Infinity) || a.index - b.index).map((entry) => entry.step);
}

/**
 * Cartes du plan d'essais (06 § 2, 20 § 5.3) : le plan du serveur, dans l'ordre de coût, chaque carte portant son état
 * (essai en cours, réussi, échoué, élagué avec sa raison) tiré des essais et des élagages reçus. Sans plan reçu : aucune carte. `halted` : l'enquête est arrêtée, les couples jamais lancés sont grisés (« non lancé »).
 * `refused` : l'enquête s'est arrêtée sur un refus (403, défi, robots.txt : statut `bloquee`). Un refus mène à l'arrêt volontaire,
 * jamais à un autre réseau (X3, X4) : les couples par proxy ou tunnel jamais lancés disparaissent du plan, pour qu'aucune carte
 * « changer d'adresse » ni proxy ne reste après le refus, même grisée. Le refus se lit aussi dès l'essai refusé ou l'élagage
 * qu'il provoque (`REFUSAL_RESULTS`), sans attendre le statut `bloquee` qui suit (`assert_trial_plan_pruned_on_refusal`).
 */
export function trialCards(state: Readonly<Pick<InvestigationState, 'plan' | 'attempts' | 'pruned'>>, options: { halted?: boolean; refused?: boolean } = {}): TrialCard[] {
  if (!state.plan || state.plan.length === 0) return [];
  const launched = (step: PlanStep): boolean => state.attempts.some((entry) => entry.state !== 'pruned' && entry.execution === step.execution && entry.network === (step.network ?? entry.network));
  const refused = options.refused === true || state.attempts.some((entry) => isRefusal(entry.result)) || state.pruned.some((entry) => isRefusal(entry.reason));
  const steps = refused ? state.plan.filter((step) => (step.network ?? 'direct') === 'direct' || launched(step)) : state.plan;
  return orderPlan(steps).map((step) => {
    const exact = cardKey(step.execution, step.network, step.source);
    const loose = (source: string | null | undefined): boolean => !step.source || !source || source === step.source;
    const attempt = state.attempts.find((entry) => entry.execution === step.execution && entry.network === (step.network ?? entry.network) && loose(entry.source));
    const pruned = state.pruned.find((entry) => entry.execution === step.execution && entry.network === step.network && loose(entry.source));
    const base = { key: exact, execution: step.execution, network: step.network, estCostUsd: step.estCostUsd ?? attempt?.estCostUsd ?? null, rule: step.rule ?? null };
    if (attempt?.state === 'running') return { ...base, state: 'running' as const, reason: null };
    if (attempt?.state === 'pruned') return { ...base, state: 'pruned' as const, reason: attempt.prunedReason };
    if (attempt) return attempt.result === 'ok' ? { ...base, state: 'succeeded' as const, reason: null } : { ...base, state: 'failed' as const, reason: attempt.result };
    if (pruned) return { ...base, state: 'pruned' as const, reason: pruned.reason };
    // Enquête arrêtée (refus, arrêt de l'utilisateur, fin) : ce qui n'a pas été lancé ne le sera pas, grisé comme un couple élagué.
    if (options.halted) return { ...base, state: 'pruned' as const, reason: null };
    return { ...base, state: 'planned' as const, reason: null };
  });
}

/** Un champ du schéma de sortie, avec son type et un exemple réel tiré de l'échantillon (jamais traduit, jamais inventé). */
export interface SchemaField {
  name: string;
  /** Types JSON Schema, tels que déclarés (`string`, `number`…) ; vide : non déclaré. */
  types: string[];
  /** Valeur de l'échantillon telle quelle (texte brut ou JSON), tronquée à 120 caractères ; null : aucun exemple dans l'échantillon. */
  example: string | null;
  /** Champ de données personnelles (`x-personal`) : l'exemple est masqué. */
  personal: boolean;
  /** Bornes déclarées d'un nombre (`minimum` et `maximum`), affichées « 1 à 5 » ; nulles sinon. */
  range: { min: number; max: number } | null;
}

const EXAMPLE_MAX_CHARS = 120;
/** Masque d'un exemple de champ personnel (20 § 5.3, D-49 : masqué si `x-personal`). */
const PERSONAL_MASK = '•••';
const FIELDS_MAX = 100;
const SAMPLE_ROWS_READ = 50;

/** Valeur d'un nœud du schéma, avec ses champs `x-personal` masqués (objets par `properties`, listes par `items`). */
function maskNode(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return value;
  if (schema['x-personal'] === true) return PERSONAL_MASK;
  if (Array.isArray(value)) return isRecord(schema.items) ? value.map((entry) => maskNode(schema.items, entry)) : value;
  if (!isRecord(value) || !isRecord(schema.properties)) return value;
  const properties = schema.properties;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Object.hasOwn(properties, key) ? maskNode(properties[key], entry) : entry]));
}

/**
 * Échantillon montré à l'écran (bloc « Échantillon » de la troisième colonne) : les champs `x-personal` du schéma de sortie,
 * à toute profondeur, y sont masqués comme dans la liste des champs. Jamais la valeur personnelle en clair sur le panneau.
 */
export function maskedSample(schema: Record<string, unknown> | null, sample: readonly Record<string, unknown>[]): unknown[] {
  if (!schema) return [...sample];
  const row = schema.type === 'array' && isRecord(schema.items) ? schema.items : schema;
  return sample.map((entry) => maskNode(row, entry));
}

function exampleText(value: unknown): string {
  const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const chars = Array.from(raw);
  return chars.length > EXAMPLE_MAX_CHARS ? `${chars.slice(0, EXAMPLE_MAX_CHARS).join('')}…` : raw;
}

/**
 * Champs de premier niveau du schéma de sortie (« Voici ce que tu vas récupérer », 20 § 5.3), un par ligne : nom, type et
 * un exemple réel, pris dans la première ligne de l'échantillon où le champ a une valeur. La valeur est celle de l'échantillon
 * octet pour octet : ni mise en forme selon la langue, ni traduction (`assert_schema_examples_untranslated`). Un schéma de
 * liste (`type: array`) est lu par son `items`.
 */
export function schemaFields(schema: Record<string, unknown> | null, sample: readonly Record<string, unknown>[]): SchemaField[] {
  if (!schema) return [];
  const root = schema.type === 'array' && isRecord(schema.items) ? schema.items : schema;
  const properties = isRecord(root.properties) ? root.properties : {};
  return Object.entries(properties)
    .slice(0, FIELDS_MAX)
    .map(([name, definition]) => {
      const declared = isRecord(definition) ? definition : {};
      const type = declared.type;
      const types = (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === 'string');
      const personal = declared['x-personal'] === true;
      const range = typeof declared.minimum === 'number' && typeof declared.maximum === 'number' ? { min: declared.minimum, max: declared.maximum } : null;
      let example: string | null = null;
      for (const row of sample.slice(0, SAMPLE_ROWS_READ)) {
        const value = Object.hasOwn(row, name) ? row[name] : undefined;
        if (value !== undefined && value !== null) {
          example = personal ? PERSONAL_MASK : exampleText(value);
          break;
        }
      }
      return { name, types, example, personal, range };
    });
}
