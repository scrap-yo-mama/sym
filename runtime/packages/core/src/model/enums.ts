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

/** `recompile` : recompilation à la demande après la modification d'une règle (18 §4.8, tâche 2.10). */
export const STRATEGY_CREATORS = ['investigation', 'repair', 'user', 'revert', 'import', 'recompile'] as const;
export type StrategyCreator = (typeof STRATEGY_CREATORS)[number];

/** Une trace E6 est-elle compilable en E5 (tâche 2.13, 19b §1) ? `no` : seul l'agent instruit (opt-in) la rejoue. */
export const STRATEGY_COMPILABLE = ['yes', 'unknown', 'no'] as const;
export type StrategyCompilable = (typeof STRATEGY_COMPILABLE)[number];

/** Raison d'archivage d'une version non courante (2.13 : vN+1 conforme mais non validée sans agent ; le reste avec 3.14). */
export const STRATEGY_ARCHIVE_REASONS = ['repair_not_validated'] as const;
export type StrategyArchiveReason = (typeof STRATEGY_ARCHIVE_REASONS)[number];

/** Issue d'une étape dans le journal de reprise (`run_attempts.step_outcome`, 19 §4). */
export const STEP_OUTCOMES = ['replayed', 'alternate', 'agent_repaired', 'failed'] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

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

/** Nature d'un run (migration 0016) : exécution d'une stratégie, ou enquête (04 §4). */
export const RUN_KINDS = ['run', 'investigation'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_OUTCOMES = ['clean', 'degraded', 'failed'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * Classes d'échec fermées (04b § 1, 04 §7) : LA seule énumération `FailureClass` du runtime. La machine à états
 * (status/) l'importe ; les CHECK de `runs.failure_class` et `run_attempts.result_class` la reproduisent, avec les
 * valeurs historiques `LEGACY_FAILURE_CLASSES` (db/src/enums.integration.test.ts). `schema_mismatch` est un code de journal, pas une classe. `challenge_in_tunnel`,
 * `proxy_not_configured` et `tunnel_offline` sont des codes de raison de transition (`status_reason`, 04 §6), pas des
 * classes : voir `ACTION_REASONS` dans status/types.ts.
 */
export const FAILURE_CLASSES = [
  'transient',
  'network',
  'rate_limited',
  'forbidden',
  'blocked_by_protection',
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

/**
 * Valeurs historiques (D-91) : classes produites avant que le robots.txt ne soit plus lu automatiquement. Plus jamais
 * produites ; encore admises par les CHECK de `runs.failure_class` et `run_attempts.result_class` pour que les lignes
 * anciennes restent lisibles (aucune migration destructive).
 */
export const LEGACY_FAILURE_CLASSES = ['robots_disallowed', 'robots_unreachable'] as const;
export type LegacyFailureClass = (typeof LEGACY_FAILURE_CLASSES)[number];

export function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === 'string' && ((FAILURE_CLASSES as readonly string[]).includes(value) || LLM_FAILURE_CLASS_PATTERN.test(value));
}

/** Résultat d'un essai (`attempts[].result`, colonne `run_attempts.result_class`) : `ok` ou une classe d'échec. */
export const ATTEMPT_RESULTS = ['ok', ...FAILURE_CLASSES] as const;
export type AttemptResult = 'ok' | FailureClass;
