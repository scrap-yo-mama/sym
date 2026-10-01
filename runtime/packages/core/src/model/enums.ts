// SPDX-License-Identifier: AGPL-3.0-only
// Énumérations fermées de 04b § 1, définies une seule fois. Le schéma Drizzle (`@runtime/db`) les réutilise ;
// model/enums.integration.test.ts (dans db) vérifie qu'elles sont identiques aux CHECK SQL de la base migrée.

export const API_STATUSES = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'] as const;
export type ApiStatus = (typeof API_STATUSES)[number];

export const INVESTIGATION_PHASES = ['access_check', 'reconnaissance', 'awaiting_schema_validation', 'testing', 'done'] as const;
export type InvestigationPhase = (typeof INVESTIGATION_PHASES)[number];

export const VISIBILITIES = ['private', 'instance'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Niveaux d'exécution E1 à E6, du moins cher au plus cher. */
export const EXECUTIONS = ['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent'] as const;
export type Execution = (typeof EXECUTIONS)[number];

export const NETWORKS = ['direct', 'dc_proxy', 'res_proxy', 'tunnel'] as const;
export type Network = (typeof NETWORKS)[number];

export const STRATEGY_CREATORS = ['investigation', 'repair', 'user', 'revert', 'import'] as const;
export type StrategyCreator = (typeof STRATEGY_CREATORS)[number];

export const RUN_TRIGGERS = ['mcp', 'rest', 'schedule', 'ui', 'canary'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATES = [
  'queued',
  'running',
  'waiting_tunnel',
  'succeeded',
  'failed',
  'cancelled',
  'skipped_tunnel_offline',
  'skipped_window',
  'skipped_quota',
  'skipped_status',
  'skipped_overlap',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_OUTCOMES = ['clean', 'degraded', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * Classes d'échec fermées (04b § 1, 04 §7) : LA seule énumération `FailureClass` du runtime. La machine à états
 * (status/) l'importe ; les CHECK de `runs.failure_class` et `run_attempts.result_class` la reproduisent
 * (db/src/enums.integration.test.ts). `schema_mismatch` est un code de journal, pas une classe. `challenge_in_tunnel`,
 * `proxy_not_configured` et `tunnel_offline` sont des codes de raison de transition (`status_reason`, 04 §6), pas des
 * classes : voir `ACTION_REASONS` dans status/types.ts.
 */
export const FAILURE_CLASSES = [
  'transient',
  'network',
  'rate_limited',
  'forbidden',
  'blocked_by_protection',
  'robots_disallowed',
  'robots_unreachable',
  'payment_required',
  'auth_required',
  'account_limit',
  'not_found',
  'extraction',
  'code_error',
  'run_budget_exceeded',
  'budget_exceeded',
] as const;

/** `llm_*` : famille ouverte, validée en base par ce motif (miroir du CHECK SQL). */
export const LLM_FAILURE_CLASS_PATTERN = /^llm_[a-z0-9_]+$/;
export type LlmFailureClass = `llm_${string}`;
export type FailureClass = (typeof FAILURE_CLASSES)[number] | LlmFailureClass;

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && ((FAILURE_CLASSES as readonly string[]).includes(value) || LLM_FAILURE_CLASS_PATTERN.test(value));
}

/** Résultat d'un essai (`attempts[].result`, colonne `run_attempts.result_class`) : `ok` ou une classe d'échec. */
export const ATTEMPT_RESULTS = ['ok', ...FAILURE_CLASSES] as const;
export type AttemptResult = 'ok' | FailureClass;
