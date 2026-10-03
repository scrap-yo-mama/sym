// SPDX-License-Identifier: AGPL-3.0-only
// Machine à états du statut d'API (INV3, 04 §6). Seule dépendance au reste du noyau : l'énumération `FailureClass` du modèle.
import type { FailureClass } from '../model/enums.js';

export const STATUSES = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'] as const;
export type Status = (typeof STATUSES)[number];

/** Horloge injectée : la machine ne lit jamais l'heure elle-même. */
export interface Clock {
  now(): Date;
}

/** Signaux d'un run dégradé (04 §6), affichés comme raison. */
export const DEGRADED_SIGNALS = [
  'retried',
  'escalated',
  'repaired',
  'optional_fields_missing',
  'volume_anomaly',
  /** Items non conformes écartés sous le seuil de casse (D-49, 04 §5) : le reste est livré. */
  'items_rejected',
  'pagination_short',
  'slow',
  'cost_anomaly',
  /** Motifs du profil des sorties (tâche 2.12, 19 §3, r4 R4) : informatifs, transitions 5 et 8 existantes. */
  'field_constant',
  'pattern_shift',
  'sentinel_values',
  'duplicate_items',
  'new_enum_value',
] as const;
export type DegradedSignal = (typeof DEGRADED_SIGNALS)[number];

/*
 * Classes d'échec : l'énumération unique `FailureClass` du modèle (04b § 1, 04 §7), importée telle quelle.
 * Les `llm_*`, `rate_limited`, `robots_unreachable` (pendant un run), `run_budget_exceeded` et `budget_exceeded` ne
 * changent jamais le statut à elles seules : l'épuisement d'un budget d'enquête ou de réparation passe par
 * `investigation_failed` (2, 21) ou `repair_failed` (13).
 */

/** Refus qui mènent à `bloquee` (transitions 4 et 15). */
export const BLOCKING_CLASSES = ['blocked_by_protection', 'forbidden', 'robots_disallowed'] as const satisfies readonly FailureClass[];
/** Classes qui mènent à `action_requise` pendant l'enquête (transition 3). */
export const INVESTIGATION_ACTION_CLASSES = ['auth_required', 'payment_required', 'account_limit'] as const satisfies readonly FailureClass[];
/** Classes qui mènent à `action_requise` pendant une réparation (transition 14). */
export const REPAIR_ACTION_CLASSES = ['auth_required', 'payment_required', 'account_limit'] as const satisfies readonly FailureClass[];

/**
 * Codes de raison de transition (`status_reason`, 04 §6) qui ne sont PAS des `failure_class` (04b § 1 : liste fermée) :
 * proxy requis non configuré, tunnel hors ligne et contact d'instance absent (transition 3 ; 17 § 5) et prix du modèle d'enquête absent (transition 3 ; UX-11), défi en tunnel (transition 14, 04 §3.2 « raison
 * `challenge_in_tunnel` », 07). Un run arrêté pour l'une de ces raisons l'est sans classe d'échec : événement `run_stopped`.
 */
export const INVESTIGATION_ACTION_REASONS = ['proxy_not_configured', 'tunnel_offline', 'instance_contact_missing', 'llm_price_missing'] as const;
export const REPAIR_ACTION_REASONS = ['challenge_in_tunnel'] as const;
export const ACTION_REASONS = [...INVESTIGATION_ACTION_REASONS, ...REPAIR_ACTION_REASONS] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

/** Classes pour lesquelles le backoff automatique de `erreur` est permis (transition 16). */
export const BACKOFF_CLASSES = ['extraction', 'code_error', 'network', 'robots_unreachable'] as const satisfies readonly FailureClass[];

/** `rules_changed` : recompilation à la demande (18 §4.8), depuis `sain` ou `warning` seulement (19, 20). */
export type ReinvestigationTrigger = 'manual' | 'schema_changed' | 'force_investigate' | 'rules_changed';

/** État persistant de la machine. `previousStatus` n'a de sens qu'en `enquete` (transition 21) : `sain`, `warning`, ou `erreur` pendant une tentative de persistance. */
export type ApiStatusState = {
  status: Status;
  reason: string | null;
  cleanStreak: number;
  /** Epoch ms du dernier signal (dégradé, indisponible, retour de version, réparation). */
  lastSignalAt: number | null;
  previousStatus: Status | null;
  stale: boolean;
};

export type StatusEventInput =
  /** Fin d'enquête avec une stratégie conforme (1). */
  | { type: 'investigation_succeeded' }
  /** Enquête sans résultat conforme : budget épuisé (2 ou 21) ou robots.txt persistant en 5xx (2). */
  | { type: 'investigation_failed'; cause: 'budget_exhausted' | 'robots_unreachable' }
  /** Échec d'un run ou d'une étape : refus (3, 4, 14, 15), indisponibilité (6, 8), échec non transitoire (10, 11). */
  | { type: 'run_failed'; failureClass: FailureClass; httpStatus?: number }
  /** Run arrêté sans classe d'échec : proxy non configuré ou tunnel hors ligne (3), défi en tunnel (10/11 puis 14, ou 14). */
  | { type: 'run_stopped'; reason: ActionReason }
  /** Run réussi : propre ou dégradé (5, 8, 9). */
  | { type: 'run_succeeded'; signals: readonly DegradedSignal[] }
  /** Retour à une version antérieure de la stratégie (7, 8). */
  | { type: 'version_rollback' }
  /** Issue de la réparation : vN+1 conforme (12), budget épuisé ou correctif répété (13). */
  | { type: 'repair_succeeded' }
  | { type: 'repair_failed'; cause: 'budget_exhausted' | 'repeated_patch' }
  /** Ré-enquête : 16 (bouton), 18 (manuelle seulement), 19, 20. */
  | { type: 'reinvestigate'; trigger: ReinvestigationTrigger }
  /** Backoff automatique depuis `erreur` (16), réservé à certaines classes ; `attempt` compte à partir de 0. */
  | { type: 'backoff_elapsed'; failureClass: FailureClass; attempt: number }
  /**
   * Tentative du mode « SYM ne lâche pas » (D-49, 2.16) : la 16 depuis `erreur` seulement, pour une classe de la 16 ;
   * `erreur` devient le statut précédent, de sorte qu'un échec repasse par la 21 (jamais la 2) et un succès par la 1.
   */
  | { type: 'persistence_attempt'; failureClass: FailureClass }
  /**
   * Mémoire négative (tâche 2.12, 19 §2, r1 R14) : le domaine a déjà refusé l'accès (`forbidden`, `bloquee`) ; arrêt
   * préventif AVANT tout appel LLM et toute requête, par la transition 4 existante, raison `prior_refusal`.
   */
  | { type: 'prior_refusal' }
  /** L'utilisateur a agi : connexion, proxy, paiement, tunnel (17). */
  | { type: 'user_acted' };

export type TransitionId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;

/** Une transition appliquée : c'est ce qu'on persiste dans `status_events`. */
export type TransitionRecord = {
  transition: TransitionId;
  from: Status;
  to: Status;
  reason: string;
  at: Date;
};

export type StatusStep =
  | { ok: true; state: ApiStatusState; transitions: TransitionRecord[] }
  | { ok: false; state: ApiStatusState; transitions: []; rejected: string };

export type MachineContext = {
  clock: Clock;
  /** Période de planification de l'API (ms), sinon `null` : sert à D = max(7 j, 3 × période). */
  schedulePeriodMs?: number | null;
};

/** Ligne prête pour `status_events` (from_status, to_status, reason, run_id, at). */
export type StatusEventRow = {
  from_status: Status;
  to_status: Status;
  reason: string;
  run_id: string | null;
  at: Date;
};
