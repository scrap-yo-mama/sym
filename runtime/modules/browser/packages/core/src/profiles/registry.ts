// SPDX-License-Identifier: AGPL-3.0-only
// Registre des profils persistants (cdc/sym-browser 03 § 5 table `profiles`, 04c § 4.2, tâche 3.1) : version courante,
// clé d'objet, taille et verrou d'écriture exclusif. Implémentation PostgreSQL : `PgProfileRegistry` de @sym-browser/db
// (même forme, verrou par un seul UPDATE atomique) ; `MemoryProfileRegistry` sert aux tests et au mode tout-en-un sans base.
import { randomUUID } from 'node:crypto';

export type ProfileRecord = {
  tenantId: string;
  profileId: string;
  name: string;
  /** 0 tant que le profil est vide. */
  version: number;
  /** Clé de l'objet chiffré de la dernière version (`profiles/{tenantId}/{profileId}/v{version}`) ; `null` si vide. */
  objectKey: string | null;
  sizeBytes: number;
  /** Session qui tient le verrou d'écriture, `null` s'il est libre. */
  lockSessionId: string | null;
};

export type AcquireLockResult = { ok: true; profile: ProfileRecord } | { ok: false; reason: 'locked'; lockedBySession: string | null } | { ok: false; reason: 'not_found' };

export type NextVersion = { version: number; objectKey: string; sizeBytes: number };

export interface ProfileRegistry {
  /** Profil du client, `undefined` s'il n'existe pas (ou appartient à un autre client). */
  get(tenantId: string, profileId: string): Promise<ProfileRecord | undefined>;
  /**
   * Pose le verrou d'écriture pour `sessionId` si il est libre, tenu par une session terminée, ou déjà par elle ; atomique.
   */
  acquireWriteLock(tenantId: string, profileId: string, sessionId: string): Promise<AcquireLockResult>;
  /**
   * Bascule le pointeur vers `next` (qui doit valoir version courante + 1) ET libère le verrou, en une seule opération,
   * seulement si `sessionId` tient le verrou. Faux sinon (rien n'est changé).
   */
  commitVersion(tenantId: string, profileId: string, sessionId: string, next: NextVersion): Promise<boolean>;
  /** Libère le verrou s'il est tenu par `sessionId` ; idempotent. */
  releaseLock(tenantId: string, profileId: string, sessionId: string): Promise<void>;
}

/** 409 `profile_locked` (04 § 6, 04c § 4.2) : une autre session tient le verrou d'écriture du profil. */
export class ProfileLockedError extends Error {
  override name = 'ProfileLockedError';
  readonly code = 'profile_locked' as const;
  readonly status = 409 as const;
  readonly retryable = false as const;
  readonly profileId: string;
  readonly lockedBySession: string | null;
  constructor(profileId: string, lockedBySession: string | null) {
    super(`profil ${profileId} verrouillé en écriture par la session ${lockedBySession ?? '(inconnue)'}`);
    this.profileId = profileId;
    this.lockedBySession = lockedBySession;
  }

  /** Corps d'erreur typé de l'API (forme `ApiError` du contrat, 04 § 6). */
  toApiError(requestId: string, lang: 'fr' | 'en' = 'fr') {
    return {
      error: {
        code: this.code,
        message: lang === 'fr' ? 'Ce profil est déjà ouvert en écriture par une autre session.' : 'This profile is already open for writing by another session.',
        retryable: this.retryable,
        what_to_do:
          lang === 'fr'
            ? 'Attends la fin de la session qui tient le profil, ou ouvre-le en lecture seule (`mode: read`).'
            : 'Wait for the session holding the profile to end, or open it read-only (`mode: read`).',
        requestId,
        details: { profileId: this.profileId, lockedBySession: this.lockedBySession },
      },
    };
  }
}

export class ProfileNotFoundError extends Error {
  override name = 'ProfileNotFoundError';
  readonly status = 404 as const;
  readonly profileId: string;
  constructor(profileId: string) {
    super(`profil introuvable : ${profileId}`);
    this.profileId = profileId;
  }
}

/** Registre en mémoire, même sémantique que la table `profiles` (verrou repris aux sessions terminées). */
export class MemoryProfileRegistry implements ProfileRegistry {
  readonly #rows = new Map<string, ProfileRecord>();
  readonly #sessionEnded: (sessionId: string) => boolean;

  constructor(opts: { sessionEnded?: (sessionId: string) => boolean } = {}) {
    this.#sessionEnded = opts.sessionEnded ?? (() => false);
  }

  create(tenantId: string, name: string): string {
    if ([...this.#rows.values()].some((r) => r.tenantId === tenantId && r.name === name)) throw new RangeError(`profil déjà nommé ${name}`);
    const profileId = randomUUID();
    this.#rows.set(profileId, { tenantId, profileId, name, version: 0, objectKey: null, sizeBytes: 0, lockSessionId: null });
    return profileId;
  }

  /** Lecture synchrone (tests). */
  peek(tenantId: string, profileId: string): ProfileRecord | undefined {
    const row = this.#rows.get(profileId);
    return row && row.tenantId === tenantId ? { ...row } : undefined;
  }

  /** Force le pointeur de version (tests : objet déplacé). */
  forceVersion(tenantId: string, profileId: string, version: number, objectKey: string): void {
    const row = this.#rows.get(profileId);
    if (!row || row.tenantId !== tenantId) throw new ProfileNotFoundError(profileId);
    Object.assign(row, { version, objectKey });
  }

  async get(tenantId: string, profileId: string): Promise<ProfileRecord | undefined> {
    return this.peek(tenantId, profileId);
  }

  async acquireWriteLock(tenantId: string, profileId: string, sessionId: string): Promise<AcquireLockResult> {
    const row = this.#rows.get(profileId);
    if (!row || row.tenantId !== tenantId) return { ok: false, reason: 'not_found' };
    if (row.lockSessionId !== null && row.lockSessionId !== sessionId && !this.#sessionEnded(row.lockSessionId)) {
      return { ok: false, reason: 'locked', lockedBySession: row.lockSessionId };
    }
    row.lockSessionId = sessionId;
    return { ok: true, profile: { ...row } };
  }

  async commitVersion(tenantId: string, profileId: string, sessionId: string, next: NextVersion): Promise<boolean> {
    const row = this.#rows.get(profileId);
    if (!row || row.tenantId !== tenantId || row.lockSessionId !== sessionId || next.version !== row.version + 1) return false;
    Object.assign(row, { version: next.version, objectKey: next.objectKey, sizeBytes: next.sizeBytes, lockSessionId: null });
    return true;
  }

  async releaseLock(tenantId: string, profileId: string, sessionId: string): Promise<void> {
    const row = this.#rows.get(profileId);
    if (row && row.tenantId === tenantId && row.lockSessionId === sessionId) row.lockSessionId = null;
  }
}
