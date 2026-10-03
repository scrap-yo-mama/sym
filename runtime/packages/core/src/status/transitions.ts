// SPDX-License-Identifier: AGPL-3.0-only
// Les 21 transitions de 04 §6 : table unique, source des noms de tests `transition_NN_*`.
import {
  BLOCKING_CLASSES as BLOCKING,
  INVESTIGATION_ACTION_CLASSES,
  INVESTIGATION_ACTION_REASONS,
  REPAIR_ACTION_CLASSES,
  REPAIR_ACTION_REASONS,
  type Status,
  type TransitionId,
} from './types.js';

export type TransitionDef = {
  id: TransitionId;
  from: Status;
  to: Status;
  /** Suffixe stable du test nommé `transition_NN_<slug>`. */
  slug: string;
  /** Codes de raison stables que cette transition peut porter : classes d'échec (`FailureClass`) ou codes propres à la machine. */
  reasons: readonly string[];
};

/** Signaux d'un run dégradé (5, 8) : `items_rejected` compris (D-49, 04 §5). le test de propriété explore tout `DEGRADED_SIGNALS`. */
const SIGNALS = [
  'retried', 'escalated', 'repaired', 'optional_fields_missing', 'volume_anomaly', 'items_rejected', 'pagination_short', 'slow', 'cost_anomaly',
  // Profil des sorties (2.12) : aucune transition nouvelle, les motifs passent par 5 et 8.
  'field_constant', 'pattern_shift', 'sentinel_values', 'duplicate_items', 'new_enum_value',
] as const;
/** `rules_changed` : recompilation demandée par le propriétaire après la modification d'une règle (18 §4.8, tâche 2.10). */
const REINVESTIGATION = ['reinvestigate_manual', 'output_schema_changed', 'force_investigate', 'rules_changed'] as const;
/** Échec non transitoire de rejeu (10, 11) : y compris les refus, qui repartent aussitôt en 14 ou 15. */
const REPLAY_FAILURES = [
  'extraction', 'code_error', 'network', 'not_found', ...REPAIR_ACTION_CLASSES, ...REPAIR_ACTION_REASONS, ...BLOCKING,
] as const;

export const TRANSITIONS: readonly TransitionDef[] = [
  { id: 1, from: 'enquete', to: 'sain', slug: 'enquete_to_sain', reasons: ['strategy_conform'] },
  { id: 2, from: 'enquete', to: 'erreur', slug: 'enquete_to_erreur', reasons: ['investigation_budget_exhausted'] },
  {
    id: 3, from: 'enquete', to: 'action_requise', slug: 'enquete_to_action_requise',
    reasons: [...INVESTIGATION_ACTION_CLASSES, ...INVESTIGATION_ACTION_REASONS],
  },
  { id: 4, from: 'enquete', to: 'bloquee', slug: 'enquete_to_bloquee', reasons: [...BLOCKING, 'prior_refusal'] },
  { id: 5, from: 'sain', to: 'warning', slug: 'sain_to_warning_degraded', reasons: SIGNALS },
  { id: 6, from: 'sain', to: 'warning', slug: 'sain_to_warning_unavailable', reasons: ['unavailable'] },
  { id: 7, from: 'sain', to: 'warning', slug: 'sain_to_warning_version_rollback', reasons: ['version_rollback'] },
  { id: 8, from: 'warning', to: 'warning', slug: 'warning_to_warning', reasons: [...SIGNALS, 'unavailable', 'version_rollback'] },
  { id: 9, from: 'warning', to: 'sain', slug: 'warning_to_sain', reasons: ['clean_streak', 'quiet_period'] },
  { id: 10, from: 'sain', to: 'reparation', slug: 'sain_to_reparation', reasons: REPLAY_FAILURES },
  { id: 11, from: 'warning', to: 'reparation', slug: 'warning_to_reparation', reasons: REPLAY_FAILURES },
  { id: 12, from: 'reparation', to: 'warning', slug: 'reparation_to_warning', reasons: ['repaired'] },
  { id: 13, from: 'reparation', to: 'erreur', slug: 'reparation_to_erreur', reasons: ['repair_budget_exhausted', 'repair_repeated_patch'] },
  {
    id: 14, from: 'reparation', to: 'action_requise', slug: 'reparation_to_action_requise',
    reasons: [...REPAIR_ACTION_CLASSES, ...REPAIR_ACTION_REASONS],
  },
  { id: 15, from: 'reparation', to: 'bloquee', slug: 'reparation_to_bloquee', reasons: BLOCKING },
  { id: 16, from: 'erreur', to: 'enquete', slug: 'erreur_to_enquete', reasons: ['backoff', 'reinvestigate_manual', 'force_investigate'] },
  { id: 17, from: 'action_requise', to: 'enquete', slug: 'action_requise_to_enquete', reasons: ['user_acted'] },
  { id: 18, from: 'bloquee', to: 'enquete', slug: 'bloquee_to_enquete_manual_only', reasons: ['reinvestigate_manual'] },
  { id: 19, from: 'sain', to: 'enquete', slug: 'sain_to_enquete', reasons: REINVESTIGATION },
  { id: 20, from: 'warning', to: 'enquete', slug: 'warning_to_enquete', reasons: REINVESTIGATION },
  // 21 : `to` est le statut précédent (sain ou warning), porté par `previous_status`.
  { id: 21, from: 'enquete', to: 'sain', slug: 'enquete_to_previous_status', reasons: ['reinvestigation_failed'] },
];

export const TRANSITION_COUNT = 21;

export function transitionDef(id: TransitionId): TransitionDef {
  const def = TRANSITIONS.find((t) => t.id === id);
  if (def === undefined) throw new Error(`Transition inconnue : ${String(id)}`);
  return def;
}
