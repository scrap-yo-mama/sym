// SPDX-License-Identifier: AGPL-3.0-only
// État d'une session de site, calculé côté serveur et dit en mots (CDC V1 sym-sessions, B1, F4 ; INV5, INV8).
// Fonction pure : aucune lecture, aucun réseau. L'appelant lui donne ce que la base sait (colonnes de `site_sessions` et
// derniers événements de `site_session_events`), jamais une valeur de cookie.
//
// Règle (premier cas qui s'applique) :
//   null          le domaine est en mode tunnel : les cookies restent dans le navigateur, le serveur n'a aucune session à qualifier ;
//   `expiree`     aucun cookie stocké, ou `expires_at` passé, ou dernier test « morte » (postérieur à la dernière capture) ;
//   `a_renouveler` un `refresh_requested` sans `refreshed` derrière (le serveur a vu la session refusée), ou une expiration sous 24 h ;
//   `active`      une preuve de vie postérieure à la dernière capture et vieille de 7 jours au plus : test « vivante »
//                 ou rejeu réussi (`used` de résultat `ok`) ;
//   `a_verifier`  sinon : jamais testée depuis la dernière capture, test trop ancien ou non concluant.
// Une preuve antérieure à la dernière capture ne compte pas : la session poussée est neuve, elle n'a pas encore servi.

export const SESSION_STATES = ['active', 'a_renouveler', 'expiree', 'a_verifier'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Libellés français affichés par l'écran des sessions (F4). */
export const SESSION_STATE_LABELS: Readonly<Record<SessionState, string>> = {
  active: 'Active',
  a_renouveler: 'À renouveler',
  expiree: 'Expirée',
  a_verifier: 'À vérifier',
};

/** Une expiration plus proche que cela rend la session « à renouveler ». */
export const SESSION_RENEW_WINDOW_MS = 24 * 3600 * 1000;
/** Une preuve de vie plus vieille que cela ne suffit plus : la session redevient « à vérifier ». */
export const SESSION_PROOF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export type SessionCheckVerdict = 'alive' | 'dead' | 'inconclusive';

/**
 * Verdict d'un code de résultat de test (`site_session_events.outcome`) : `alive`, `dead_*` ou `inconclusive_*`.
 * Tout autre code, ou l'absence de code, ne conclut rien.
 */
export function checkVerdictOf(outcome: string | null | undefined): SessionCheckVerdict | null {
  if (outcome === undefined || outcome === null) return null;
  if (outcome === 'alive') return 'alive';
  if (outcome.startsWith('dead')) return 'dead';
  if (outcome.startsWith('inconclusive')) return 'inconclusive';
  return null;
}

export type SessionStateInput = {
  /** Le propriétaire a consenti l'usage serveur du domaine (`server_use_allowed`). */
  serverUseAllowed: boolean;
  /** Des cookies scellés sont stockés (`key_version` non nul). */
  hasServerCookies: boolean;
  /** Dernière capture reçue de l'extension. */
  capturedAt: Date | null;
  /** Fin de la session entière (la plus tardive des dates de cookies), `null` si un cookie de session n'a pas de date. */
  expiresAt: Date | null;
  /** Dernier test de validité (événement `checked`) : instant et code de résultat. */
  lastCheckAt: Date | null;
  lastCheckOutcome: string | null;
  /** Dernier rejeu serveur réussi (événement `used` de résultat `ok`). */
  lastUseOkAt: Date | null;
  /** Un `refresh_requested` attend un `refreshed`. */
  refreshPending: boolean;
};

export function computeSessionState(input: SessionStateInput, now: Date = new Date()): SessionState | null {
  if (!input.serverUseAllowed) return null;
  const t = now.getTime();
  if (!input.hasServerCookies) return 'expiree';
  if (input.expiresAt !== null && input.expiresAt.getTime() <= t) return 'expiree';
  const capturedAt = input.capturedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const check = input.lastCheckAt !== null && input.lastCheckAt.getTime() >= capturedAt ? checkVerdictOf(input.lastCheckOutcome) : null;
  if (check === 'dead') return 'expiree';
  if (input.refreshPending) return 'a_renouveler';
  if (input.expiresAt !== null && input.expiresAt.getTime() - t < SESSION_RENEW_WINDOW_MS) return 'a_renouveler';
  const proofs: number[] = [];
  if (check === 'alive' && input.lastCheckAt !== null) proofs.push(input.lastCheckAt.getTime());
  if (input.lastUseOkAt !== null && input.lastUseOkAt.getTime() >= capturedAt) proofs.push(input.lastUseOkAt.getTime());
  const proof = proofs.length === 0 ? null : Math.max(...proofs);
  return proof !== null && t - proof <= SESSION_PROOF_MAX_AGE_MS ? 'active' : 'a_verifier';
}
