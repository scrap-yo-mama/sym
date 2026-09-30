// Machine à états du statut d'API (INV3, 04 §6). Types propres au module : aucune dépendance à l'autre code du noyau.

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
  'pagination_short',
  'slow',
  'cost_anomaly',
] as const;
export type DegradedSignal = (typeof DEGRADED_SIGNALS)[number];

/** Classes d'échec qui pilotent le statut (04 §7). Les `llm_*` ne changent jamais le statut à elles seules. */
export type FailureClass =
  | 'transient'
  | 'network'
  | 'rate_limited'
  | 'forbidden'
  | 'blocked_by_protection'
  | 'robots_disallowed'
  | 'robots_unreachable'
  | 'payment_required'
  | 'auth_required'
  | 'account_limit'
  | 'challenge_in_tunnel'
  | 'proxy_not_configured'
  | 'tunnel_offline'
  | 'not_found'
  | 'extraction'
  | 'code_error'
  | `llm_${string}`;

/** Refus qui mènent à `bloquee` (transitions 4 et 15). */
export const BLOCKING_CLASSES = ['blocked_by_protection', 'forbidden', 'robots_disallowed'] as const;
/** Refus qui mènent à `action_requise` pendant l'enquête (transition 3). */
export const INVESTIGATION_ACTION_CLASSES = [
  'auth_required',
  'payment_required',
  'account_limit',
  'proxy_not_configured',
  'tunnel_offline',
] as const;
/** Refus qui mènent à `action_requise` pendant une réparation (transition 14). */
export const REPAIR_ACTION_CLASSES = ['auth_required', 'payment_required', 'account_limit', 'challenge_in_tunnel'] as const;
/** Classes pour lesquelles le backoff automatique de `erreur` est permis (transition 16). */
export const BACKOFF_CLASSES = ['extraction', 'code_error', 'network', 'robots_unreachable'] as const;

export type ReinvestigationTrigger = 'manual' | 'schema_changed' | 'force_investigate';

/** État persistant de la machine. `previousStatus` n'a de sens qu'en `enquete` (transition 21). */
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
