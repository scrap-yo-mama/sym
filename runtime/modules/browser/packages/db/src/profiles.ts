// SPDX-License-Identifier: AGPL-3.0-only
// Registre des profils persistants sur PostgreSQL (cdc/sym-browser 03 § 5 table `profiles`, 04c § 4.2, tâche 3.1). Même
// forme que `ProfileRegistry` de @sym-browser/core (typage structurel : pas de dépendance entre les deux paquets).
// - Verrou d'écriture : un seul UPDATE conditionnel (libre, tenu par une session terminée, ou déjà par la demandeuse) ;
//   sous READ COMMITTED, deux demandes simultanées se sérialisent sur la ligne et la seconde relit la condition : un seul
//   verrou posé. La session demandeuse doit appartenir au même client que le profil.
// - Bascule de version et libération du verrou dans la même instruction (donc la même transaction).
import type pg from 'pg';

/** Connexion ou pool (`pg.Pool`, `pg.Client`, `pg.PoolClient`). */
type Queryable = Pick<pg.Pool, 'query'>;

export type ProfileRow = {
  tenantId: string;
  profileId: string;
  name: string;
  version: number;
  objectKey: string | null;
  sizeBytes: number;
  lockSessionId: string | null;
};

export type AcquireLockResult = { ok: true; profile: ProfileRow } | { ok: false; reason: 'locked'; lockedBySession: string | null } | { ok: false; reason: 'not_found' };

const COLUMNS = `tenant_id AS "tenantId", id AS "profileId", name, version, object_key AS "objectKey", size_bytes::float8 AS "sizeBytes", lock_session_id AS "lockSessionId"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (...values: string[]) => values.every((v) => UUID.test(v));

export class PgProfileRegistry {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  /** Crée un profil vide (version 0) ; nom unique par client (23505 sinon). */
  async create(tenantId: string, name: string): Promise<string> {
    const { rows } = await this.#db.query<{ id: string }>('INSERT INTO profiles (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, name]);
    return rows[0]!.id;
  }

  async get(tenantId: string, profileId: string): Promise<ProfileRow | undefined> {
    if (!isUuid(tenantId, profileId)) return undefined;
    const { rows } = await this.#db.query<ProfileRow>(`SELECT ${COLUMNS} FROM profiles WHERE id = $1 AND tenant_id = $2`, [profileId, tenantId]);
    return rows[0];
  }

  async acquireWriteLock(tenantId: string, profileId: string, sessionId: string): Promise<AcquireLockResult> {
    if (!isUuid(tenantId, profileId, sessionId)) return { ok: false, reason: 'not_found' };
    const { rows } = await this.#db.query<ProfileRow>(
      `UPDATE profiles p SET lock_session_id = $3, updated_at = now()
       WHERE p.id = $1 AND p.tenant_id = $2
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = $3 AND s.tenant_id = $2)
         AND (p.lock_session_id IS NULL OR p.lock_session_id = $3
              OR EXISTS (SELECT 1 FROM sessions h WHERE h.id = p.lock_session_id AND h.state IN ('ended', 'timed_out', 'failed')))
       RETURNING ${COLUMNS}`,
      [profileId, tenantId, sessionId],
    );
    if (rows[0]) return { ok: true, profile: rows[0] };
    const current = await this.get(tenantId, profileId);
    if (!current) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'locked', lockedBySession: current.lockSessionId };
  }

  async commitVersion(tenantId: string, profileId: string, sessionId: string, next: { version: number; objectKey: string; sizeBytes: number }): Promise<boolean> {
    if (!isUuid(tenantId, profileId, sessionId)) return false;
    const { rowCount } = await this.#db.query(
      `UPDATE profiles SET version = $4, object_key = $5, size_bytes = $6, lock_session_id = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND lock_session_id = $3 AND version = $4 - 1`,
      [profileId, tenantId, sessionId, next.version, next.objectKey, next.sizeBytes],
    );
    return rowCount === 1;
  }

  async releaseLock(tenantId: string, profileId: string, sessionId: string): Promise<void> {
    if (!isUuid(tenantId, profileId, sessionId)) return;
    await this.#db.query('UPDATE profiles SET lock_session_id = NULL, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND lock_session_id = $3', [profileId, tenantId, sessionId]);
  }
}
