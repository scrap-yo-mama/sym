// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'API en base (cdc/sym-browser 03 § 5, 04 § 1 ; tâche 2.1). Seuls le préfixe affiché et l'empreinte argon2id sont
// stockés (calculés par @sym-browser/core : `newApiKey`, `bootstrapApiKeyRecord`) ; la clé en clair ne passe jamais ici.
// `pgApiKeyStore` implémente `ApiKeyStore` de @sym-browser/core (forme structurelle : aucune dépendance de db vers core).
// Révoquer pose `revoked_at` sans supprimer : la clé reste référencée par les sessions et le comptage (BINV5).
import type pg from 'pg';

/** `pg.Pool`, `pg.Client` ou `pg.PoolClient`. */
export type Queryable = Pick<pg.ClientBase, 'query'>;

export type ApiKeyRow = {
  id: string;
  tenantId: string;
  keyHash: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export type ApiKeySummary = { id: string; prefix: string; scopes: string[]; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date };

type Scope = 'sessions:write' | 'sessions:read' | 'profiles:write' | 'admin';

/** Verrou transactionnel de la création de la première clé (démarrages concurrents de plusieurs passerelles). */
export const FIRST_API_KEY_LOCK_KEY = 0x53594d42_02; // « SYMB » puis 2.1

export function pgApiKeyStore(db: Queryable) {
  return {
    async findByPrefix(prefix: string): Promise<ApiKeyRow | null> {
      const { rows } = await db.query<ApiKeyRow>(
        `SELECT id, tenant_id AS "tenantId", key_hash AS "keyHash", scopes, expires_at AS "expiresAt",
                revoked_at AS "revokedAt", last_used_at AS "lastUsedAt"
           FROM api_keys WHERE key_prefix = $1`,
        [prefix],
      );
      return rows[0] ?? null;
    },
    async touch(id: string, at: Date): Promise<void> {
      await db.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $2)', [id, at]);
    },
  };
}

export async function insertApiKey(
  db: Queryable,
  input: { tenantId: string; prefix: string; keyHash: string; scopes: readonly Scope[]; expiresAt: Date | null },
): Promise<{ id: string; createdAt: Date }> {
  const { rows } = await db.query<{ id: string; createdAt: Date }>(
    `INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes, expires_at) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at AS "createdAt"`,
    [input.tenantId, input.prefix, input.keyHash, [...input.scopes], input.expiresAt],
  );
  return rows[0]!;
}

/** Clés d'un client, sans empreinte (console, `GET /v1/admin/keys`). */
export async function listApiKeys(db: Queryable, tenantId: string): Promise<ApiKeySummary[]> {
  const { rows } = await db.query<ApiKeySummary>(
    `SELECT id, key_prefix AS prefix, scopes, expires_at AS "expiresAt", last_used_at AS "lastUsedAt",
            revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at, id`,
    [tenantId],
  );
  return rows;
}

/** Révoque une clé du client (idempotent : la première date est gardée) ; `false` si la clé n'est pas à ce client. */
export async function revokeApiKey(db: Queryable, input: { tenantId: string; id: string }): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND tenant_id = $2', [input.id, input.tenantId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Première clé (`SYMB_BOOTSTRAP_API_KEY`, 04g § 6) : si la table des clés est vide, crée le client `tenantName` (ou le
 * reprend) et la clé, dans une transaction sous verrou consultatif ; sinon ne fait rien (`skipped`).
 */
export async function ensureFirstApiKey(
  pool: pg.Pool,
  record: { tenantName: string; prefix: string; keyHash: string; scopes: readonly Scope[]; expiresAt: Date | null },
): Promise<'created' | 'skipped'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [FIRST_API_KEY_LOCK_KEY]);
    const { rows } = await client.query<{ any: boolean }>('SELECT EXISTS (SELECT 1 FROM api_keys) AS any');
    if (rows[0]?.any) {
      await client.query('COMMIT');
      return 'skipped';
    }
    const tenant = await client.query<{ id: string }>(
      'INSERT INTO tenants (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [record.tenantName],
    );
    await insertApiKey(client, { tenantId: tenant.rows[0]!.id, prefix: record.prefix, keyHash: record.keyHash, scopes: record.scopes, expiresAt: record.expiresAt });
    await client.query('COMMIT');
    return 'created';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
