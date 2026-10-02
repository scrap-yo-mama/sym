// SPDX-License-Identifier: AGPL-3.0-only
// Profils persistants (cdc/sym-browser 04c § 4, tâche 3.1) : `ProfileStore.restore(cible, dir)` et `ProfileStore.save(cible,
// dir)` de 04c § 6.1, sur l'ObjectStore chiffré (tâche 3.0) et le registre des profils (table `profiles`).
// - Écriture exclusive (`mode: 'write'`) : verrou posé AVANT toute restauration ; une 2e écriture reçoit
//   `ProfileLockedError` (409 `profile_locked`, `lockedBySession`). À la fin : archivage, dépôt de `v{n+1}`, puis bascule
//   du pointeur ET libération du verrou en une seule opération. Échec ou plantage : la version précédente reste en place et
//   le verrou est libéré.
// - Lecture seule partagée (`mode: 'read'`) : sans verrou, autant de sessions que voulu ; chacune restaure la dernière
//   version, ses modifications disparaissent avec son répertoire temporaire.
// - Les anciennes versions restent dans l'ObjectStore : une lecture en cours sur `v{n}` n'est jamais coupée par une
//   écriture qui publie `v{n+1}`.
// - Au-delà de `maxBytes` (`SYMB_PROFILE_MAX_BYTES`) : sauvegarde abandonnée, `profile.save_failed {reason: size_exceeded}`.
import { mkdir } from 'node:fs/promises';
import type { ObjectStore } from '../storage/object-store.js';
import { profileObjectKey } from '../storage/keys.js';
import { packProfile, ProfileTooLargeError, unpackProfile } from './archive.js';
import { ProfileLockedError, ProfileNotFoundError, type ProfileRegistry } from './registry.js';

export type ProfileMode = 'read' | 'write';

/** Profil demandé par une session : client, profil, mode et session (détentrice du verrou en écriture). */
export type ProfileTarget = { tenantId: string; profileId: string; mode: ProfileMode; sessionId: string };

export type ProfileSaveFailure = 'size_exceeded' | 'error';

/** Événement de session (`session_events`, 04 § 5), sans contenu du profil. */
export type ProfileEvent = {
  type: 'profile.save_failed';
  tenantId: string;
  profileId: string;
  sessionId: string;
  data: { reason: ProfileSaveFailure };
};

export type ProfileStoreOptions = {
  objects: ObjectStore;
  registry: ProfileRegistry;
  /** `SYMB_PROFILE_MAX_BYTES`. */
  maxBytes: number;
  onEvent?: (event: ProfileEvent) => void;
};

export type RestoreResult = { version: number; files: number; bytes: number };
export type SaveResult = { saved: true; version: number; objectKey: string; sizeBytes: number; files: number } | { saved: false; reason: 'size_exceeded' };

export class ProfileStore {
  readonly #objects: ObjectStore;
  readonly #registry: ProfileRegistry;
  readonly #maxBytes: number;
  readonly #onEvent: (event: ProfileEvent) => void;

  constructor(opts: ProfileStoreOptions) {
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes <= 0) throw new RangeError(`taille maximale de profil invalide : ${opts.maxBytes}`);
    this.#objects = opts.objects;
    this.#registry = opts.registry;
    this.#maxBytes = opts.maxBytes;
    this.#onEvent = opts.onEvent ?? (() => undefined);
  }

  /**
   * Restaure la dernière version du profil dans `dir` (répertoire de données Chromium de la session). En écriture, pose
   * d'abord le verrou (`ProfileLockedError` sinon) et le libère si la restauration échoue.
   */
  async restore(target: ProfileTarget, dir: string): Promise<RestoreResult> {
    const { tenantId, profileId, sessionId } = target;
    let profile;
    if (target.mode === 'write') {
      const lock = await this.#registry.acquireWriteLock(tenantId, profileId, sessionId);
      if (!lock.ok) {
        if (lock.reason === 'not_found') throw new ProfileNotFoundError(profileId);
        throw new ProfileLockedError(profileId, lock.lockedBySession);
      }
      profile = lock.profile;
    } else {
      profile = await this.#registry.get(tenantId, profileId);
      if (!profile) throw new ProfileNotFoundError(profileId);
    }
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (profile.version === 0 || profile.objectKey === null) return { version: 0, files: 0, bytes: 0 };
      // Audit 5.3 S08 : la clé d'objet (et donc l'AAD) doit être celle de CE profil de CE client, jamais celle que la base dit.
      if (profile.objectKey !== profileObjectKey({ tenantId, profileId, version: profile.version })) {
        throw new RangeError('clé d’objet du profil incohérente avec le client et le profil demandés');
      }
      const restored = await unpackProfile(await this.#objects.get(profile.objectKey), dir, { maxBytes: this.#maxBytes });
      return { version: profile.version, ...restored };
    } catch (error) {
      if (target.mode === 'write') await this.#registry.releaseLock(tenantId, profileId, sessionId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Fin d'une session en écriture (Chromium fermé proprement) : archive `dir`, dépose `v{n+1}`, bascule le pointeur et
   * libère le verrou. Taille dépassée : rien n'est déposé, verrou libéré, `{saved: false}`. Toute autre erreur est rendue,
   * verrou libéré, version précédente intacte.
   */
  async save(target: ProfileTarget, dir: string): Promise<SaveResult> {
    const { tenantId, profileId, sessionId } = target;
    if (target.mode !== 'write') throw new RangeError('profil en lecture seule : aucune sauvegarde');
    let committed = false;
    try {
      const current = await this.#registry.get(tenantId, profileId);
      if (!current) throw new ProfileNotFoundError(profileId);
      if (current.lockSessionId !== sessionId) throw new ProfileLockedError(profileId, current.lockSessionId);
      let packed;
      try {
        packed = await packProfile(dir, { maxBytes: this.#maxBytes });
      } catch (error) {
        if (!(error instanceof ProfileTooLargeError)) throw error;
        this.#emit(target, 'size_exceeded');
        return { saved: false, reason: 'size_exceeded' };
      }
      const version = current.version + 1;
      const objectKey = profileObjectKey({ tenantId, profileId, version });
      let stored;
      try {
        stored = await this.#objects.put(objectKey, packed.stream);
      } catch (error) {
        if (!(error instanceof ProfileTooLargeError)) throw error;
        this.#emit(target, 'size_exceeded');
        return { saved: false, reason: 'size_exceeded' };
      }
      committed = await this.#registry.commitVersion(tenantId, profileId, sessionId, { version, objectKey, sizeBytes: stored.storedBytes });
      if (!committed) {
        // Verrou perdu entre-temps : l'objet n'est retiré que s'il n'est pas devenu celui d'une autre session.
        const now = await this.#registry.get(tenantId, profileId);
        if (now?.objectKey !== objectKey) await this.#objects.delete(objectKey).catch(() => undefined);
        throw new ProfileLockedError(profileId, now?.lockSessionId ?? null);
      }
      return { saved: true, version, objectKey, sizeBytes: stored.storedBytes, files: packed.files };
    } catch (error) {
      if (!(error instanceof ProfileLockedError)) this.#emit(target, 'error');
      throw error;
    } finally {
      if (!committed) await this.#registry.releaseLock(tenantId, profileId, sessionId).catch(() => undefined);
    }
  }

  /** Fin sans sauvegarde (plantage, lecture seule) : libère le verrou s'il est tenu par la session ; idempotent. */
  async release(target: ProfileTarget): Promise<void> {
    if (target.mode === 'write') await this.#registry.releaseLock(target.tenantId, target.profileId, target.sessionId);
  }

  #emit(target: ProfileTarget, reason: ProfileSaveFailure): void {
    try {
      this.#onEvent({ type: 'profile.save_failed', tenantId: target.tenantId, profileId: target.profileId, sessionId: target.sessionId, data: { reason } });
    } catch {
      // Un abonné en échec n'empêche pas la fin de session.
    }
  }
}
