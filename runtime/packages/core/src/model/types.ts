// SPDX-License-Identifier: AGPL-3.0-only
// Entités de 04b § 1 (Api, StrategyVersion, Run). Types seuls, sans I/O.
import type {
  ApiStatus,
  AttemptResult,
  Execution,
  FailureClass,
  InvestigationPhase,
  Network,
  RunOutcome,
  RunState,
  RunTrigger,
  StrategyCreator,
  Visibility,
} from './enums.js';

export type JsonObject = { [key: string]: unknown };
/** Schéma JSON (2020-12) fourni par l'utilisateur. */
export type UserJsonSchema = boolean | JsonObject;

export interface ApiRequires {
  session_domain: string | null;
  tunnel: boolean;
}

export interface NetworkPolicy {
  allow: Network[];
  res_proxy_params?: { country?: string; [key: string]: unknown };
}

export interface AccessPolicy {
  /** Une seule valeur (INV11). */
  robots: 'respect';
  report_id?: string;
  user_agent_contact?: string;
  [key: string]: unknown;
}

export interface DomainPacing {
  min_delay_ms: number;
  max_requests_per_run: number;
  max_wait_ms: number;
}

export interface Api {
  id: string;
  slug: string;
  owner_id: string;
  project_id: string;
  visibility: Visibility;
  description: string;
  input_schema: UserJsonSchema;
  output_schema: UserJsonSchema;
  views: { columns?: string[]; [key: string]: unknown };
  status: ApiStatus;
  investigation_phase: InvestigationPhase | null;
  status_reason: string | null;
  stale: boolean;
  clean_streak: number;
  last_signal_at: string | null;
  current_strategy_version: number | null;
  pinned: boolean;
  mcp_exposed: boolean;
  requires: ApiRequires;
  network_policy: NetworkPolicy;
  access_policy: AccessPolicy;
  purpose: string;
  legal_basis: string | null;
  contains_personal_data: boolean;
  allow_write_actions: boolean;
  max_cost_usd: number;
  budget_daily_usd: number;
  domain_pacing: DomainPacing;
  /** Mode « SYM ne lâche pas » (D-49, 04 §6) : opt-in, désactivé par défaut ; activé en console seulement. */
  persistence_mode?: boolean;
  /** Plafond propre du mode, cumulé depuis l'entrée en `erreur` ; `null` = `PERSISTENCE_BUDGET_USD_DEFAULT`, jamais illimité. */
  persistence_budget_usd?: number | null;
}

/** Opération RFC 6902. */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  from?: string;
  value?: unknown;
}

export interface StrategyVersion {
  api_id: string;
  version: number;
  execution: Execution;
  network: Network;
  /** Stratégie déclarative (04b § 2, tâche 1.1b) quand `kind = "declarative"`. */
  spec: JsonObject;
  script_ref: string | null;
  est_cost_usd: number | null;
  created_by: StrategyCreator;
  parent_version: number | null;
  /** RFC 6902, seulement si `created_by = "repair"`. */
  patch: JsonPatchOperation[] | null;
}

export interface RunAttempt {
  execution: Execution;
  network: Network;
  est_cost_usd: number;
  result: AttemptResult;
  /** null : coût LLM inconnu (prix absent, 08 §1), jamais 0. */
  cost_usd: number | null;
  ms: number;
  model_id: string | null;
  prompt_version: string | null;
  engine: string | null;
}

export interface RunCost {
  /** null : un essai au moins a un coût LLM inconnu (prix absent, 08 §1), jamais 0. */
  llm_usd: number | null;
  proxy_usd: number;
  total_usd: number | null;
}

export interface RunTokens {
  in: number;
  cached: number;
  out: number;
  reasoning: number;
  estimated: boolean;
}

export interface Run {
  id: string;
  api_id: string;
  owner_id: string;
  strategy_version: number | null;
  trigger: RunTrigger;
  state: RunState;
  outcome: RunOutcome | null;
  degraded_reasons: string[];
  failure_class: FailureClass | null;
  retryable: boolean | null;
  attempts: RunAttempt[];
  cost: RunCost;
  tokens: RunTokens;
  items: number;
  /** Items extraits non conformes, jamais livrés (04b §1, D-49). */
  items_rejected: number;
  /**
   * Agrégats de la quarantaine (05 §4.1 `RunResult.rejected`) : sans valeur, `null` sans rejet. L'échantillon n'est jamais
   * ici : il se lit à part (`get_items(rejected)`), par l'appelant du run seul.
   */
  rejected: RunRejected | null;
  dataset_id: string | null;
  trace_id: string | null;
}

/** Agrégats sans valeur d'une quarantaine (04b §1, 05 §4.1). */
export interface RunRejected {
  count: number;
  by_reason: { keyword: string; path: string; count: number }[];
}
