// SPDX-License-Identifier: AGPL-3.0-only
// Extension Chrome (tâche 2.6, 07 § 1-2, INV5, INV8) : appairage multi-appareils, jetons, domaines connectés,
// cookies chiffrés en écriture seule, révocation, et résolution des cookies d'un run liée au propriétaire.
//
// Identités :
// - web, transaction `withActor` (rôle `runtime_app`, RLS) : `createPairingCode`, `listDevices`, `revokeDevice`,
//   `listSites`, `connectSite`, `storeSiteCookies`, `disconnectSite`, `disconnectSiteById`. runtime_app n'a aucun
//   droit de lecture sur les colonnes chiffrées de `site_sessions` (migration 0006) ;
// - système (propriétaire des tables), avant de connaître l'utilisateur : `exchangePairingCode`, `resolveExtensionToken` ;
// - admin, transaction `withActor` : `listAllDevices` (vue de métadonnées), `adminRevokeDevice` (fonction de révocation) ;
// - système côté worker : `siteCookiesForRun`, seule fonction qui ouvre un cookie, toujours pour le propriétaire du run.
import {
  cookieMatchesDomain,
  EXTENSION_TOKEN_LIFETIME_DAYS,
  generateExtensionToken,
  generatePairingCode,
  hashExtensionToken,
  hashPairingCode,
  isExtensionTokenFormat,
  isRole,
  liveCookies,
  openSecret,
  openSecretBytes,
  PAIRING_CODE_TTL_MINUTES,
  sealSecret,
  SecretDecryptError,
  siteSessionAad,
  type Kek,
  type Role,
  type SiteCookie,
} from '@runtime/core';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

// ---------------------------------------------------------------------------------------------------------------------
// Appairage et jetons
// ---------------------------------------------------------------------------------------------------------------------

/** Codes d'appairage actifs (ni utilisés ni expirés) par utilisateur : borne le nombre de codes devinables à la fois. */
const MAX_ACTIVE_PAIRING_CODES = 5;

/**
 * Code d'appairage (07 § 1) : le code n'existe en clair que dans la valeur de retour. `null` si l'utilisateur a déjà
 * `MAX_ACTIVE_PAIRING_CODES` codes actifs (verrou transactionnel par utilisateur : pas de dépassement en parallèle).
 */
export async function createPairingCode(db: Queryable, ownerId: string): Promise<{ code: string; expiresAt: Date } | null> {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('extension_pairing_codes:' || $1, 0))", [ownerId]);
  const active = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM extension_pairing_codes WHERE owner_id = $1 AND used_at IS NULL AND expires_at > now()',
    [ownerId],
  );
  if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_PAIRING_CODES) return null;
  const { code, hash } = generatePairingCode();
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO extension_pairing_codes (owner_id, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at`,
    [ownerId, hash, PAIRING_CODE_TTL_MINUTES],
  );
  return { code, expiresAt: rows[0]!.expires_at };
}

export type PairedDevice = {
  /** Jeton en clair : renvoyé une seule fois à l'extension, jamais stocké ni journalisé. */
  token: string;
  tunnelId: string;
  ownerId: string;
  email: string;
  deviceLabel: string | null;
  expiresAt: Date;
};

/**
 * Échange d'un code contre un jeton lié à (utilisateur, appareil) (07 § 1, `assert_pairing_code_single_use`) :
 * code inconnu, expiré ou déjà utilisé → `null`, aucun jeton. Le même appareil ré-appairé remplace son ancien jeton ;
 * les autres appareils de l'utilisateur restent actifs (multi-appareils).
 */
export async function exchangePairingCode(
  pool: pg.Pool,
  input: { code: string; deviceId: string; deviceLabel: string | null },
): Promise<PairedDevice | null> {
  const hash = hashPairingCode(input.code);
  if (hash === null) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const used = await client.query<{ id: string; owner_id: string }>(
      `UPDATE extension_pairing_codes SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, owner_id`,
      [hash],
    );
    const code = used.rows[0];
    if (!code) {
      await client.query('ROLLBACK');
      return null;
    }
    const user = (await client.query<{ email: string; status: string }>('SELECT email, status FROM users WHERE id = $1', [code.owner_id])).rows[0];
    if (!user || user.status !== 'active') {
      // Le code est brûlé quand même : un compte désactivé n'obtient aucun jeton.
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      'UPDATE tunnels SET revoked_at = now(), revoked_by = owner_id WHERE owner_id = $1 AND device_id = $2 AND revoked_at IS NULL',
      [code.owner_id, input.deviceId],
    );
    const { token, hash: tokenHash } = generateExtensionToken();
    const tunnel = (
      await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO tunnels (owner_id, device_id, device_label, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
        [code.owner_id, input.deviceId, input.deviceLabel, tokenHash, EXTENSION_TOKEN_LIFETIME_DAYS],
      )
    ).rows[0]!;
    await client.query('UPDATE extension_pairing_codes SET tunnel_id = $2 WHERE id = $1', [code.id, tunnel.id]);
    await client.query('COMMIT');
    return { token, tunnelId: tunnel.id, ownerId: code.owner_id, email: user.email, deviceLabel: input.deviceLabel, expiresAt: tunnel.expires_at };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type ExtensionIdentity = {
  tunnelId: string;
  userId: string;
  role: Role;
  email: string;
  deviceId: string;
  deviceLabel: string | null;
  expiresAt: Date;
};

/**
 * Identité d'un jeton d'extension (identité système : étape d'authentification). Jeton inconnu, révoqué, expiré
 * (90 jours sans usage) ou compte inactif → `null`. Un usage renouvelle l'échéance à 90 jours (07 § 1).
 */
export async function resolveExtensionToken(db: Queryable, token: string): Promise<ExtensionIdentity | null> {
  if (!isExtensionTokenFormat(token)) return null;
  const { rows } = await db.query<{
    id: string;
    owner_id: string;
    device_id: string;
    device_label: string | null;
    expires_at: Date;
    role: string;
    email: string;
  }>(
    `UPDATE tunnels t SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
     FROM users u
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now() AND u.id = t.owner_id AND u.status = 'active'
     RETURNING t.id, t.owner_id, t.device_id, t.device_label, t.expires_at, u.role, u.email`,
    [hashExtensionToken(token), EXTENSION_TOKEN_LIFETIME_DAYS],
  );
  const row = rows[0];
  if (!row || !isRole(row.role)) return null;
  return {
    tunnelId: row.id,
    userId: row.owner_id,
    role: row.role,
    email: row.email,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    expiresAt: row.expires_at,
  };
}

export type DeviceView = {
  id: string;
  deviceLabel: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

type DeviceRow = { id: string; device_label: string | null; created_at: Date; last_seen_at: Date | null; expires_at: Date; revoked_at: Date | null };
const deviceView = (r: DeviceRow): DeviceView => ({
  id: r.id,
  deviceLabel: r.device_label,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

/** Appareils de l'utilisateur (transaction `withActor`). Jamais le jeton ni son empreinte. */
export async function listDevices(db: Queryable, ownerId: string): Promise<DeviceView[]> {
  const { rows } = await db.query<DeviceRow>(
    `SELECT id, device_label, created_at, last_seen_at, expires_at, revoked_at FROM tunnels
     WHERE owner_id = $1 ORDER BY created_at DESC`,
    [ownerId],
  );
  return rows.map(deviceView);
}

/** Révocation d'un de ses appareils (transaction `withActor`). */
export async function revokeDevice(db: Queryable, ownerId: string, tunnelId: string): Promise<'revoked' | 'already_revoked' | 'not_found'> {
  const updated = await db.query(
    'UPDATE tunnels SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL RETURNING id',
    [tunnelId, ownerId],
  );
  if (updated.rowCount === 1) return 'revoked';
  const own = await db.query('SELECT 1 FROM tunnels WHERE id = $1 AND owner_id = $2', [tunnelId, ownerId]);
  return own.rowCount === 1 ? 'already_revoked' : 'not_found';
}

export type AdminDeviceView = DeviceView & { ownerId: string; ownerEmail: string };

/**
 * Vue d'administration (transaction `withActor` d'un admin ou de l'owner) : métadonnées seulement, par la vue
 * `admin_tunnel_metadata` (vide pour un autre rôle).
 */
export async function listAllDevices(db: Queryable): Promise<AdminDeviceView[]> {
  const { rows } = await db.query<DeviceRow & { owner_id: string; owner_email: string }>(
    `SELECT id, device_label, created_at, last_seen_at, expires_at, revoked_at, owner_id, owner_email
     FROM admin_tunnel_metadata ORDER BY created_at DESC`,
  );
  return rows.map((r) => ({ ...deviceView(r), ownerId: r.owner_id, ownerEmail: r.owner_email }));
}

/**
 * Révocation par un admin (07 § 1, `assert_admin_revoke_only`), transaction `withActor` : la fonction
 * `admin_revoke_tunnel` vérifie le rôle en base et ne pose que `revoked_at` et `revoked_by` ; rien n'est lu du jeton.
 */
export async function adminRevokeDevice(db: Queryable, tunnelId: string): Promise<{ ownerId: string } | null> {
  const { rows } = await db.query<{ owner_id: string }>('SELECT owner_id FROM admin_revoke_tunnel($1)', [tunnelId]);
  return rows[0] ? { ownerId: rows[0].owner_id } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Domaines connectés et cookies (07 § 2)
// ---------------------------------------------------------------------------------------------------------------------

export type SiteView = {
  id: string;
  domain: string;
  serverUseAllowed: boolean;
  /** Des cookies sont stockés côté serveur (jamais leur valeur). */
  hasServerCookies: boolean;
  consentedAt: Date;
  capturedAt: Date | null;
  expiresAt: Date | null;
};

type SiteRow = {
  id: string;
  domain: string;
  server_use_allowed: boolean;
  key_version: number | null;
  consented_at: Date;
  captured_at: Date | null;
  expires_at: Date | null;
};
const SITE_COLUMNS = 'id, domain, server_use_allowed, key_version, consented_at, captured_at, expires_at';
const siteView = (r: SiteRow): SiteView => ({
  id: r.id,
  domain: r.domain,
  serverUseAllowed: r.server_use_allowed,
  hasServerCookies: r.key_version !== null,
  consentedAt: r.consented_at,
  capturedAt: r.captured_at,
  expiresAt: r.expires_at,
});

export async function listSites(db: Queryable, ownerId: string): Promise<SiteView[]> {
  const { rows } = await db.query<SiteRow>(`SELECT ${SITE_COLUMNS} FROM site_sessions WHERE owner_id = $1 ORDER BY domain`, [ownerId]);
  return rows.map(siteView);
}

const WIPE_SEALED = 'ciphertext = NULL, nonce = NULL, dek_wrapped = NULL, alg = NULL, key_version = NULL, captured_at = NULL, expires_at = NULL';

/**
 * Consentement explicite pour un domaine (07 § 2) : connecte le domaine pour cet utilisateur, avec l'usage choisi.
 * Repasser en mode tunnel efface les cookies stockés (minimisation, CHECK `site_sessions_server_use`).
 */
export async function connectSite(
  db: Queryable,
  input: { ownerId: string; domain: string; serverUseAllowed: boolean },
): Promise<{ site: SiteView; change: 'connected' | 'server_use_changed' | 'unchanged' }> {
  const existing = (
    await db.query<SiteRow>(`SELECT ${SITE_COLUMNS} FROM site_sessions WHERE owner_id = $1 AND domain = $2 FOR UPDATE`, [input.ownerId, input.domain])
  ).rows[0];
  if (!existing) {
    const { rows } = await db.query<SiteRow>(
      `INSERT INTO site_sessions (owner_id, domain, server_use_allowed) VALUES ($1, $2, $3) RETURNING ${SITE_COLUMNS}`,
      [input.ownerId, input.domain, input.serverUseAllowed],
    );
    return { site: siteView(rows[0]!), change: 'connected' };
  }
  const changed = existing.server_use_allowed !== input.serverUseAllowed;
  const { rows } = await db.query<SiteRow>(
    `UPDATE site_sessions SET server_use_allowed = $3, consented_at = now(), updated_at = now()${input.serverUseAllowed ? '' : `, ${WIPE_SEALED}`}
     WHERE id = $1 AND owner_id = $2 RETURNING ${SITE_COLUMNS}`,
    [existing.id, input.ownerId, input.serverUseAllowed],
  );
  return { site: siteView(rows[0]!), change: changed ? 'server_use_changed' : 'unchanged' };
}

export class CookieDomainMismatchError extends Error {
  override name = 'CookieDomainMismatchError';
}

/**
 * Cookies envoyés par l'extension pour un domaine en usage serveur : scellés (AES-256-GCM, AAD = propriétaire,
 * domaine, version de clé), jamais relus par le rôle des requêtes. Un cookie d'un autre domaine refuse tout l'envoi.
 * `kek` : KEK `site_sessions` de la génération courante.
 */
export async function storeSiteCookies(
  db: Queryable,
  kek: Kek,
  input: { ownerId: string; domain: string; cookies: readonly SiteCookie[] },
): Promise<'stored' | 'not_connected' | 'server_use_not_allowed'> {
  const site = (
    await db.query<{ id: string; server_use_allowed: boolean }>(
      'SELECT id, server_use_allowed FROM site_sessions WHERE owner_id = $1 AND domain = $2 FOR UPDATE',
      [input.ownerId, input.domain],
    )
  ).rows[0];
  if (!site) return 'not_connected';
  if (!site.server_use_allowed) return 'server_use_not_allowed';
  for (const c of input.cookies) {
    if (!cookieMatchesDomain(c.domain, input.domain)) throw new CookieDomainMismatchError(`cookie hors du domaine ${input.domain}`);
  }
  const cookies = liveCookies(input.cookies, Date.now() / 1000);
  if (cookies.length === 0) {
    await db.query(`UPDATE site_sessions SET ${WIPE_SEALED}, updated_at = now() WHERE id = $1`, [site.id]);
    return 'stored';
  }
  // Fin de la session entière : jamais si un cookie de session (sans date) est présent, sinon la plus tardive des
  // dates. Un cookie court (_gat, __cf_bm) n'avance jamais l'expiration de toute la session ; chaque cookie expiré
  // est écarté individuellement à la lecture (`liveCookies`).
  const expiries = cookies.map((c) => c.expirationDate);
  const expiresAt = expiries.every((e): e is number => e !== undefined) ? new Date(Math.max(...expiries) * 1000) : null;
  const sealed = sealSecret(JSON.stringify(cookies), kek, siteSessionAad({ ownerId: input.ownerId, domain: input.domain, keyVersion: kek.version }));
  await db.query(
    `UPDATE site_sessions SET ciphertext = $2, nonce = $3, dek_wrapped = $4, alg = $5, key_version = $6,
       captured_at = now(), expires_at = $7, updated_at = now()
     WHERE id = $1`,
    [site.id, sealed.ciphertext, sealed.nonce, sealed.dekWrapped, sealed.alg, sealed.kekVersion, expiresAt],
  );
  return 'stored';
}

/** « Déconnecter ce site » (07 § 2) : supprime le domaine et ses cookies. Renvoie vrai si une ligne existait. */
export async function disconnectSite(db: Queryable, ownerId: string, domain: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM site_sessions WHERE owner_id = $1 AND domain = $2', [ownerId, domain]);
  return rowCount === 1;
}

/** Même révocation depuis la console, par identifiant. Renvoie le domaine supprimé, ou `null`. */
export async function disconnectSiteById(db: Queryable, ownerId: string, id: string): Promise<string | null> {
  const { rows } = await db.query<{ domain: string }>('DELETE FROM site_sessions WHERE id = $1 AND owner_id = $2 RETURNING domain', [id, ownerId]);
  return rows[0]?.domain ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cookies d'un run (INV5, assert_identity_pinned)
// ---------------------------------------------------------------------------------------------------------------------

/** Raisons `action_requise` d'une session de site manquante (04b, 07 § 2), ou mode tunnel (cookies dans le navigateur). */
export type SiteSessionUnavailable = 'auth_required' | 'cookie_expired' | 'tunnel_only';

export type RunSiteSession = { ok: true; ownerId: string; cookies: SiteCookie[] } | { ok: false; reason: SiteSessionUnavailable };

export class RunSessionNotFoundError extends Error {
  override name = 'RunSessionNotFoundError';
}

/**
 * Cookies utilisables par un run (identité système, côté worker). Une session appartient à son propriétaire
 * (INV5) : seule la ligne `site_sessions` du propriétaire de l'API, qui est aussi l'appelant du run, est lue ; aucune
 * autre identité n'est jamais essayée (pas de repli, pas de pool). Domaine non connecté → `auth_required` ;
 * mode tunnel → `tunnel_only` ; cookies expirés → `cookie_expired` ; valeur illisible (déplacée vers un autre
 * propriétaire ou domaine, clé changée) → `auth_required`.
 */
export async function siteCookiesForRun(db: Queryable, kek: Kek, input: { runId: string; domain: string }): Promise<RunSiteSession> {
  const run = (await db.query<{ owner_id: string; api_owner_id: string }>('SELECT owner_id, api_owner_id FROM runs WHERE id = $1', [input.runId])).rows[0];
  if (!run) throw new RunSessionNotFoundError(`run ${input.runId} introuvable`);
  // Une API à session est privée (CHECK apis_session_private) : l'appelant est son propriétaire. Sinon, rien.
  if (run.owner_id !== run.api_owner_id) return { ok: false, reason: 'auth_required' };
  const row = (
    await db.query<{
      server_use_allowed: boolean;
      ciphertext: Buffer | null;
      nonce: Buffer | null;
      dek_wrapped: Buffer | null;
      alg: string | null;
      key_version: number | null;
      expires_at: Date | null;
    }>(
      `SELECT server_use_allowed, ciphertext, nonce, dek_wrapped, alg, key_version, expires_at
       FROM site_sessions WHERE owner_id = $1 AND domain = $2`,
      [run.owner_id, input.domain],
    )
  ).rows[0];
  if (!row) return { ok: false, reason: 'auth_required' };
  if (!row.server_use_allowed) return { ok: false, reason: 'tunnel_only' };
  if (!row.ciphertext || !row.nonce || !row.dek_wrapped || !row.alg || row.key_version === null) return { ok: false, reason: 'auth_required' };
  // `expires_at` = expiration du dernier cookie : passée, plus aucun cookie n'est vivant (inutile de déchiffrer).
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'cookie_expired' };
  let cookies: SiteCookie[];
  try {
    const sealed = { ciphertext: row.ciphertext, nonce: row.nonce, dekWrapped: row.dek_wrapped, alg: row.alg, kekVersion: row.key_version };
    cookies = JSON.parse(openSecret(sealed, kek, siteSessionAad({ ownerId: run.owner_id, domain: input.domain, keyVersion: row.key_version }))) as SiteCookie[];
  } catch (error) {
    if (error instanceof SecretDecryptError) return { ok: false, reason: 'auth_required' };
    throw error;
  }
  const live = liveCookies(cookies, Date.now() / 1000);
  if (live.length === 0) return { ok: false, reason: 'cookie_expired' };
  return { ok: true, ownerId: run.owner_id, cookies: live };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rotation de clé (`runtime rekey`, INV8)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Un lot de la rotation des cookies scellés (identité système, dans la transaction de `rekey`) : chaque ligne sous la
 * version `from.version` est ouverte avec l'ancienne KEK `site_sessions` et l'AAD de cette version, puis rescellée
 * (nouvelle DEK, nouveaux nonces) avec la nouvelle KEK et l'AAD de la nouvelle version. Une valeur que l'ancienne clé
 * n'ouvre pas est effacée (les cookies seront resynchronisés par l'extension ; le run passe en `action_requise`
 * d'ici là) : rien ne reste sous l'ancienne version. Renvoie le nombre de lignes lues (0 = rotation terminée).
 */
export async function rekeySiteSessionsBatch(
  db: Queryable,
  from: Kek,
  to: Kek,
  batchSize: number,
): Promise<{ seen: number; rotated: number; wiped: number }> {
  const { rows } = await db.query<{ id: string; owner_id: string; domain: string; ciphertext: Buffer; nonce: Buffer; dek_wrapped: Buffer; alg: string }>(
    `SELECT id, owner_id, domain, ciphertext, nonce, dek_wrapped, alg FROM site_sessions
     WHERE key_version = $1 ORDER BY id LIMIT $2 FOR UPDATE`,
    [from.version, batchSize],
  );
  let rotated = 0;
  let wiped = 0;
  for (const row of rows) {
    const sealed = { ciphertext: row.ciphertext, nonce: row.nonce, dekWrapped: row.dek_wrapped, alg: row.alg, kekVersion: from.version };
    let plaintext: Buffer;
    try {
      plaintext = openSecretBytes(sealed, from, siteSessionAad({ ownerId: row.owner_id, domain: row.domain, keyVersion: from.version }));
    } catch (error) {
      if (!(error instanceof SecretDecryptError)) throw error;
      await db.query(`UPDATE site_sessions SET ${WIPE_SEALED}, updated_at = now() WHERE id = $1`, [row.id]);
      wiped += 1;
      continue;
    }
    let next: ReturnType<typeof sealSecret>;
    try {
      next = sealSecret(plaintext, to, siteSessionAad({ ownerId: row.owner_id, domain: row.domain, keyVersion: to.version }));
    } finally {
      plaintext.fill(0);
    }
    await db.query(
      'UPDATE site_sessions SET ciphertext = $2, nonce = $3, dek_wrapped = $4, alg = $5, key_version = $6, updated_at = now() WHERE id = $1',
      [row.id, next.ciphertext, next.nonce, next.dekWrapped, next.alg, next.kekVersion],
    );
    rotated += 1;
  }
  return { seen: rows.length, rotated, wiped };
}
