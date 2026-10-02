// SPDX-License-Identifier: AGPL-3.0-only
// Comptes avancés (tâche 3.7, 13 § 5-7, § 10) : graine TOTP scellée, codes de secours hachés, révocations en cascade,
// désactivation, anonymisation, clone et transfert d'API sans jamais copier une session de site (X5, INV5).
// Identité système (tables d'authentification hors runtime_app, comme 0003) : chaque fonction filtre explicitement
// par l'utilisateur concerné ; aucune ne prend un identifiant d'objet seul pour un contenu d'utilisateur.
import { randomBytes } from 'node:crypto';
import { openSecretBytes, rotate, sealSecret, SecretDecryptError, twoFactorAad, type Kek, type SealedValue } from '@runtime/core';
import type pg from 'pg';
import { appendAudit } from './audit.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

// ---------------------------------------------------------------------------------------------------------------
// 2FA : graine scellée (MASTER_KEY, AAD = two_factor|user_id), anti-rejeu, état illisible
// ---------------------------------------------------------------------------------------------------------------

export type TwoFactorState =
  | { status: 'none' }
  | { status: 'pending' | 'confirmed'; secret: Buffer; lastUsedStep: number | null }
  /**
   * Graine illisible (MASTER_KEY perdue ou ligne altérée) : codes de secours seulement, puis ré-enrôlement.
   * `transient` : graine sous une version de clé que ce processus n'a pas (rotation en cours, processus pas encore
   * redémarré) ; rien n'est marqué, la graine redevient lisible avec la bonne clé.
   */
  | { status: 'unreadable'; confirmed: boolean; transient?: true };

type TwoFactorRow = {
  secret_ciphertext: Buffer;
  nonce: Buffer;
  dek_wrapped: Buffer;
  alg: string;
  key_version: number;
  last_used_step: string | null;
  unreadable_since: Date | null;
  confirmed_at: Date | null;
};

const sealedOf = (r: TwoFactorRow): SealedValue => ({ ciphertext: r.secret_ciphertext, nonce: r.nonce, dekWrapped: r.dek_wrapped, alg: r.alg, kekVersion: r.key_version });

/** Commence (ou recommence) l'enrôlement : remplace toute graine NON confirmée ou illisible. `false` si une 2FA lisible est active. */
export async function startTwoFactorEnrollment(db: Queryable, kek: Kek, userId: string, secret: Buffer): Promise<boolean> {
  const sealed = sealSecret(secret, kek, twoFactorAad(userId));
  const { rowCount } = await db.query(
    `INSERT INTO two_factor (user_id, secret_ciphertext, nonce, dek_wrapped, alg, key_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET secret_ciphertext = EXCLUDED.secret_ciphertext, nonce = EXCLUDED.nonce,
       dek_wrapped = EXCLUDED.dek_wrapped, alg = EXCLUDED.alg, key_version = EXCLUDED.key_version,
       last_used_step = NULL, unreadable_since = NULL, confirmed_at = NULL, created_at = now()
     WHERE two_factor.confirmed_at IS NULL OR two_factor.unreadable_since IS NOT NULL`,
    [userId, sealed.ciphertext, sealed.nonce, sealed.dekWrapped, sealed.alg, sealed.kekVersion],
  );
  // La 2FA change d'état (ré-enrôlement) : un lien de réinitialisation émis avant ne vaut plus rien.
  if (rowCount === 1) await deleteResetLinks(db, userId);
  return rowCount === 1;
}

/**
 * État de la 2FA d'un utilisateur. `keks` : la KEK courante, et la précédente si le trousseau l'a ; la graine est
 * ouverte par la KEK de SA version. Un vrai échec de déchiffrement marque la ligne illisible (jamais en silence) ; une
 * version qu'aucune KEK fournie ne porte (rotation en cours) refuse sans rien écrire.
 */
export async function loadTwoFactor(db: Queryable, keks: Kek | readonly Kek[], userId: string): Promise<TwoFactorState> {
  const { rows } = await db.query<TwoFactorRow>(
    `SELECT secret_ciphertext, nonce, dek_wrapped, alg, key_version, last_used_step, unreadable_since, confirmed_at
     FROM two_factor WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { status: 'none' };
  if (row.unreadable_since) return { status: 'unreadable', confirmed: row.confirmed_at !== null };
  const ring: readonly Kek[] = 'key' in keks ? [keks] : keks;
  const kek = ring.find((k) => k.version === row.key_version);
  if (!kek) return { status: 'unreadable', confirmed: row.confirmed_at !== null, transient: true };
  try {
    const secret = openSecretBytes(sealedOf(row), kek, twoFactorAad(userId));
    return { status: row.confirmed_at ? 'confirmed' : 'pending', secret, lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step) };
  } catch (error) {
    if (!(error instanceof SecretDecryptError)) throw error;
    await db.query('UPDATE two_factor SET unreadable_since = now() WHERE user_id = $1 AND unreadable_since IS NULL', [userId]);
    return { status: 'unreadable', confirmed: row.confirmed_at !== null };
  }
}

/** Anti-rejeu atomique : le pas n'est consommé que s'il est strictement plus récent que le dernier accepté. */
export async function consumeTotpStep(db: Queryable, userId: string, step: number): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE two_factor SET last_used_step = $2 WHERE user_id = $1 AND (last_used_step IS NULL OR last_used_step < $2)',
    [userId, step],
  );
  return rowCount === 1;
}

export async function confirmTwoFactor(db: Queryable, userId: string): Promise<void> {
  await db.query('UPDATE two_factor SET confirmed_at = now() WHERE user_id = $1', [userId]);
  await db.query('UPDATE users SET two_factor_enabled = true, updated_at = now() WHERE id = $1', [userId]);
}

/**
 * Retire la 2FA (graine et codes de secours) et, dans la même transaction de l'appelant, tout lien de
 * réinitialisation en cours : un lien émis pendant que la 2FA protégeait le compte ne doit jamais servir sans elle
 * (13 § 4 : « le lien ne suffit pas à prendre le compte », INV5).
 */
export async function removeTwoFactor(db: Queryable, userId: string): Promise<boolean> {
  await deleteResetLinks(db, userId);
  const { rowCount } = await db.query('DELETE FROM two_factor WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM backup_codes WHERE user_id = $1', [userId]);
  await db.query('UPDATE users SET two_factor_enabled = false, updated_at = now() WHERE id = $1', [userId]);
  return (rowCount ?? 0) > 0;
}

/** 2FA confirmée (lisible ou non) : une connexion exige alors le second facteur. */
export async function hasConfirmedTwoFactor(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM two_factor WHERE user_id = $1 AND confirmed_at IS NOT NULL', [userId]);
  return rowCount === 1;
}

/** Remplace les codes de secours (les anciens sont révoqués). */
export async function replaceBackupCodes(db: Queryable, userId: string, hashes: readonly string[]): Promise<void> {
  await db.query('DELETE FROM backup_codes WHERE user_id = $1', [userId]);
  await db.query('INSERT INTO backup_codes (user_id, code_hash) SELECT $1, unnest($2::text[])', [userId, hashes]);
}

/** Usage unique atomique d'un code de secours. */
export async function consumeBackupCode(db: Queryable, userId: string, hash: string): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE backup_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [userId, hash]);
  return rowCount === 1;
}

/**
 * `rekey` : re-chiffre un lot de graines de l'ancienne version vers la nouvelle (même AAD). Une graine que l'ancienne
 * clé n'ouvre pas est marquée illisible (elle garde sa version d'origine) : codes de secours puis ré-enrôlement.
 */
export async function rekeyTwoFactorBatch(db: Queryable, from: Kek, to: Kek, batchSize: number): Promise<{ seen: number; rotated: number; unreadable: number }> {
  const { rows } = await db.query<TwoFactorRow & { user_id: string }>(
    `SELECT user_id, secret_ciphertext, nonce, dek_wrapped, alg, key_version, last_used_step, unreadable_since, confirmed_at
     FROM two_factor WHERE key_version = $1 AND unreadable_since IS NULL ORDER BY user_id LIMIT $2 FOR UPDATE`,
    [from.version, batchSize],
  );
  let rotated = 0;
  let unreadable = 0;
  for (const row of rows) {
    let next: SealedValue;
    try {
      next = rotate(sealedOf(row), from, to, twoFactorAad(row.user_id));
    } catch (error) {
      if (!(error instanceof SecretDecryptError)) throw error;
      await db.query('UPDATE two_factor SET unreadable_since = now() WHERE user_id = $1', [row.user_id]);
      unreadable += 1;
      continue;
    }
    await db.query('UPDATE two_factor SET secret_ciphertext = $2, nonce = $3, dek_wrapped = $4, alg = $5, key_version = $6 WHERE user_id = $1', [
      row.user_id,
      next.ciphertext,
      next.nonce,
      next.dekWrapped,
      next.alg,
      next.kekVersion,
    ]);
    rotated += 1;
  }
  return { seen: rows.length, rotated, unreadable };
}

// ---------------------------------------------------------------------------------------------------------------
// Liens de réinitialisation du mot de passe (13 § 4, § 5, § 6) : empreinte seule en base, un lien actif par compte
// ---------------------------------------------------------------------------------------------------------------

/**
 * Origine d'un lien : `email` (mot de passe oublié, avec SMTP), `admin` (lien copiable d'un admin, compte à 2FA
 * seulement : le second facteur est TOUJOURS exigé à la consommation), `operator` (commande serveur
 * `runtime user:reset-link` / `owner:reset-link`, auditée et signalée au titulaire).
 */
export type ResetLinkKind = 'email' | 'admin' | 'operator';

const RESET_PREFIX: Record<ResetLinkKind, string> = { email: 'reset', admin: 'reset-admin', operator: 'reset-cli' };
const RESET_KIND = new Map(Object.entries(RESET_PREFIX).map(([kind, prefix]) => [prefix, kind as ResetLinkKind]));
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const resetIdentifiers = (userId: string) => Object.values(RESET_PREFIX).map((p) => `${p}:${userId}`);

/** Supprime tout lien de réinitialisation du compte, quelle que soit son origine ; renvoie le nombre supprimé. */
export async function deleteResetLinks(db: Queryable, userId: string): Promise<number> {
  const { rowCount } = await db.query('DELETE FROM verifications WHERE identifier = ANY($1::text[])', [resetIdentifiers(userId)]);
  return rowCount ?? 0;
}

/** Enregistre l'empreinte d'un nouveau lien (les précédents du compte sont supprimés) ; renvoie son échéance. */
export async function storeResetLink(db: Queryable, kind: ResetLinkKind, userId: string, tokenHash: string, ttlHours: number): Promise<Date> {
  await deleteResetLinks(db, userId);
  const { rows } = await db.query<{ expires_at: Date }>(
    'INSERT INTO verifications (identifier, value, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at',
    [`${RESET_PREFIX[kind]}:${userId}`, tokenHash, ttlHours],
  );
  return rows[0]!.expires_at;
}

/** Lien valide (non expiré, compte actif et non supprimé) correspondant à l'empreinte ; null sinon. */
export async function findResetLink(db: Queryable, tokenHash: string): Promise<{ userId: string; kind: ResetLinkKind } | null> {
  const { rows } = await db.query<{ identifier: string }>(
    "SELECT identifier FROM verifications WHERE value = $1 AND expires_at > now() AND identifier ~ '^reset(-admin|-cli)?:'",
    [tokenHash],
  );
  for (const { identifier } of rows) {
    const cut = identifier.indexOf(':');
    const kind = RESET_KIND.get(identifier.slice(0, cut));
    const userId = identifier.slice(cut + 1);
    if (!kind || !UUID_TEXT.test(userId)) continue;
    const active = await db.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL", [userId]);
    if (active.rowCount === 1) return { userId, kind };
  }
  return null;
}

/** Consomme le lien (usage unique, atomique) : true si c'est cet appel qui l'a supprimé. */
export async function consumeResetLink(db: Queryable, kind: ResetLinkKind, userId: string, tokenHash: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM verifications WHERE identifier = $1 AND value = $2', [`${RESET_PREFIX[kind]}:${userId}`, tokenHash]);
  return rowCount === 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Signalements au titulaire d'un compte, montrés une fois à sa connexion suivante (13 § 4 et § 6)
// ---------------------------------------------------------------------------------------------------------------

export type AccountNotice = { code: string; at: string };
/** Durée de conservation d'un signalement non encore montré. */
const NOTICE_TTL_DAYS = 90;

/** Signalement au titulaire (`password_reset_by_operator`, `password_reset_withheld`...), montré une fois. */
export async function addAccountNotice(db: Queryable, userId: string, code: string): Promise<void> {
  await db.query("INSERT INTO verifications (identifier, value, expires_at) VALUES ('notice:' || $1::text, $2, now() + make_interval(days => $3))", [
    userId,
    code,
    NOTICE_TTL_DAYS,
  ]);
}

/** Signalements en attente pour le compte, retirés à la lecture (montrés une fois). */
export async function takeAccountNotices(db: Queryable, userId: string): Promise<AccountNotice[]> {
  const { rows } = await db.query<{ value: string; created_at: Date; expires_at: Date }>(
    "DELETE FROM verifications WHERE identifier = 'notice:' || $1::text RETURNING value, created_at, expires_at",
    [userId],
  );
  const now = Date.now();
  return rows
    .filter((r) => r.expires_at.getTime() > now)
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
    .map((r) => ({ code: r.value, at: r.created_at.toISOString() }));
}

export type OperatorResetResult =
  | { ok: true; userId: string; email: string; role: string; expiresAt: Date }
  | { ok: false; reason: 'not_found' | 'inactive' | 'owner_account' };

/**
 * Lien de réinitialisation émis par la commande serveur (`runtime user:reset-link <email>`, `runtime owner:reset-link`) :
 * pour un compte sans 2FA sur une instance sans SMTP (13 § 4, § 6). Empreinte seule en base, sessions du compte
 * fermées, audit `user.reset_link` (acteur système, via cli) et signalement au titulaire à sa connexion suivante.
 * Si le compte a une 2FA, son second facteur reste exigé à la consommation (6.4.3). Transaction propre.
 */
export async function issueOperatorResetLink(
  client: pg.ClientBase,
  target: { email: string } | { owner: true },
  tokenHash: string,
  ttlHours: number,
): Promise<OperatorResetResult> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<{ id: string; email: string; role: string; status: string }>(
      'owner' in target
        ? "SELECT id, email, role, status FROM users WHERE role = 'owner' AND deleted_at IS NULL FOR UPDATE"
        : 'SELECT id, email, role, status FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE',
      'owner' in target ? [] : [target.email.trim().toLowerCase()],
    );
    const user = rows[0];
    let refusal: Exclude<OperatorResetResult, { ok: true }>['reason'] | null = null;
    if (!user) refusal = 'not_found';
    else if (!('owner' in target) && user.role === 'owner') refusal = 'owner_account';
    else if (user.status !== 'active') refusal = 'inactive';
    if (refusal || !user) {
      await client.query('ROLLBACK');
      return { ok: false, reason: refusal ?? 'not_found' };
    }
    const expiresAt = await storeResetLink(client, 'operator', user.id, tokenHash, ttlHours);
    await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [user.id]);
    await addAccountNotice(client, user.id, 'password_reset_by_operator');
    await appendAudit(client, { actorUserId: null, actorVia: 'system', action: 'user.reset_link', targetType: 'user', targetId: user.id, outcome: 'success', meta: { via: 'cli' } });
    await client.query('COMMIT');
    return { ok: true, userId: user.id, email: user.email, role: user.role, expiresAt };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** Identités OIDC liées au compte (13 § 7) : signalées à la réinitialisation et à la révocation complète. */
export async function countOidcIdentities(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1 AND provider_id LIKE 'oidc:%'", [userId]);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Révocations, désactivation, suppression (13 § 5 « Fin de session », 13 § 6)
// ---------------------------------------------------------------------------------------------------------------

export type AccessRevocation = { sessions: number; apiKeys: number; tunnels: number; siteSessions: number; knownDevices: number };

/**
 * Ferme toutes les sessions d'interface, révoque clés d'API et jetons de tunnel (et l'appairage en cours) ;
 * `wipeCookies` supprime aussi les cookies serveur (`site_sessions`) et les appareils reconnus.
 */
export async function revokeUserAccess(db: Queryable, userId: string, by: string | null, opts: { wipeCookies?: boolean } = {}): Promise<AccessRevocation> {
  const sessions = await db.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
  const keys = await db.query('UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL', [userId, by]);
  const tunnels = await db.query('UPDATE tunnels SET revoked_at = now(), revoked_by = $2 WHERE owner_id = $1 AND revoked_at IS NULL', [userId, by]);
  await db.query('DELETE FROM extension_pairing_codes WHERE owner_id = $1', [userId]);
  let siteSessions = 0;
  let knownDevices = 0;
  if (opts.wipeCookies) {
    siteSessions = (await db.query('DELETE FROM site_sessions WHERE owner_id = $1', [userId])).rowCount ?? 0;
    knownDevices = (await db.query('DELETE FROM auth_known_devices WHERE user_id = $1', [userId])).rowCount ?? 0;
  }
  return { sessions: sessions.rowCount ?? 0, apiKeys: keys.rowCount ?? 0, tunnels: tunnels.rowCount ?? 0, siteSessions, knownDevices };
}

/**
 * Désactivation (13 § 6) : statut `disabled`, sessions fermées, clés et jetons de tunnel révoqués, cookies serveur
 * supprimés, planifications suspendues. Runs, datasets et APIs restent à leur propriétaire. À appeler dans une transaction.
 */
export async function deactivateUser(db: Queryable, userId: string, by: string | null): Promise<AccessRevocation & { schedules: number }> {
  // Révocations d'abord (révoqué par l'admin, tracé) ; le déclencheur de 0008 couvre aussi une désactivation par SQL ou CLI.
  const revoked = await revokeUserAccess(db, userId, by, { wipeCookies: true });
  await db.query("UPDATE users SET status = 'disabled', disabled_at = now(), updated_at = now() WHERE id = $1", [userId]);
  const schedules = await db.query('UPDATE schedules SET enabled = false, updated_at = now() WHERE owner_id = $1 AND enabled', [userId]);
  return { ...revoked, schedules: schedules.rowCount ?? 0 };
}

export async function reactivateUser(db: Queryable, userId: string): Promise<void> {
  await db.query("UPDATE users SET status = 'active', disabled_at = NULL, updated_at = now() WHERE id = $1 AND status = 'disabled'", [userId]);
}

/**
 * Suppression d'un compte désactivé (13 § 6) : identité effacée (e-mail, nom, mots de passe, liaisons OIDC, 2FA,
 * codes, clés, sessions, cookies, appareils). Sans contenu, la ligne disparaît ; avec contenu (APIs, runs, datasets
 * restés au compte), elle est anonymisée : l'audit garde l'identifiant, pas les données.
 */
export async function deleteOrAnonymizeUser(client: pg.ClientBase, userId: string, by: string): Promise<'deleted' | 'anonymized'> {
  await revokeUserAccess(client, userId, by, { wipeCookies: true });
  for (const sql of [
    'DELETE FROM auth_accounts WHERE user_id = $1',
    'DELETE FROM two_factor WHERE user_id = $1',
    'DELETE FROM backup_codes WHERE user_id = $1',
    'DELETE FROM api_keys WHERE user_id = $1',
    'DELETE FROM tunnels WHERE owner_id = $1',
    "DELETE FROM verifications WHERE identifier IN ('reset:' || $1::text, 'reset-admin:' || $1::text, 'reset-cli:' || $1::text, 'notice:' || $1::text)",
  ]) {
    await client.query(sql, [userId]);
  }
  await client.query('SAVEPOINT delete_user');
  try {
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('RELEASE SAVEPOINT delete_user');
    return 'deleted';
  } catch (error) {
    if ((error as { code?: string }).code !== '23503') throw error; // seule une référence de contenu justifie l'anonymisation
    await client.query('ROLLBACK TO SAVEPOINT delete_user');
  }
  await client.query(
    `UPDATE users SET email = 'deleted+' || id::text || '@deleted.invalid', display_name = '', image = NULL, status = 'disabled',
       email_verified = false, email_verified_at = NULL, two_factor_enabled = false, deleted_at = now(),
       disabled_at = coalesce(disabled_at, now()), updated_at = now()
     WHERE id = $1`,
    [userId],
  );
  await client.query('UPDATE schedules SET enabled = false, updated_at = now() WHERE owner_id = $1', [userId]);
  return 'anonymized';
}

// ---------------------------------------------------------------------------------------------------------------
// Clone et transfert d'API (13 § 6 et § 10, X5) : la session de site n'est JAMAIS copiée ni réaffectée
// ---------------------------------------------------------------------------------------------------------------

/** Colonnes d'`apis` jamais recopiées par un clone (identité, propriétaire, état de santé, baux). */
const API_CLONE_EXCLUDED = new Set([
  'id',
  'slug',
  'owner_id',
  'visibility',
  'status',
  'status_reason',
  'investigation_phase',
  // État d'enquête (2.1) : demande et gisements du propriétaire d'origine, jamais copiés au nouveau propriétaire.
  'investigation',
  'stale',
  'clean_streak',
  'last_signal_at',
  'pinned',
  'repair_lease_owner',
  'repair_lease_until',
  'warning_alerted_at',
  // Mode « SYM ne lâche pas » (2.16) : un acte humain du propriétaire, jamais hérité par un clone.
  'persistence_mode',
  'created_at',
  'updated_at',
]);

async function columnsOf(db: Queryable, table: string, excluded: ReadonlySet<string>): Promise<string[]> {
  const { rows } = await db.query<{ c: string }>(
    `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.c).filter((c) => !excluded.has(c));
}

const quote = (c: string) => `"${c.replace(/"/g, '""')}"`;

export class ApiNotFoundError extends Error {
  override name = 'ApiNotFoundError';
}

/**
 * Clone l'API `apiId` de `fromOwnerId` pour `toOwnerId` (assert_clone_no_session) : définition et versions de
 * stratégie copiées, AUCUNE ligne `site_sessions` ni secret ; une API à session passe en `action_requise` jusqu'à ce que
 * SON nouveau propriétaire connecte SON compte. Le clone est privé. À appeler dans une transaction.
 */
export async function cloneApi(db: Queryable, input: { apiId: string; fromOwnerId: string; toOwnerId: string; slug?: string }): Promise<{ id: string; slug: string; status: string }> {
  const source = await db.query<{ slug: string; requires_session: boolean; status: string }>(
    'SELECT slug, requires_session, status FROM apis WHERE id = $1 AND owner_id = $2',
    [input.apiId, input.fromOwnerId],
  );
  const row = source.rows[0];
  if (!row) throw new ApiNotFoundError('API introuvable pour ce propriétaire');
  const slug = input.slug ?? `${row.slug}-copy-${randomBytes(3).toString('hex')}`;
  const status = row.requires_session ? 'action_requise' : row.status === 'bloquee' ? 'bloquee' : 'enquete';
  const reason = row.requires_session ? 'session_required' : row.status === 'bloquee' ? 'cloned_from_blocked' : 'cloned';
  const cols = await columnsOf(db, 'apis', API_CLONE_EXCLUDED);
  const list = cols.map(quote).join(', ');
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO apis (slug, owner_id, visibility, status, status_reason, ${list})
     SELECT $3, $4, 'private', $5, $6, ${list} FROM apis WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [input.apiId, input.fromOwnerId, slug, input.toOwnerId, status, reason],
  );
  const id = inserted.rows[0]!.id;
  const svCols = await columnsOf(db, 'strategy_versions', new Set(['api_id', 'owner_id']));
  const svList = svCols.map(quote).join(', ');
  await db.query(
    `INSERT INTO strategy_versions (api_id, owner_id, ${svList}) SELECT $3, $4, ${svList} FROM strategy_versions WHERE api_id = $1 AND owner_id = $2`,
    [input.apiId, input.fromOwnerId, id, input.toOwnerId],
  );
  return { id, slug, status };
}

/**
 * Transfert des APIs SANS session de `fromOwnerId` vers `toOwnerId` (13 § 6, par un admin) : les runs déjà faits
 * restent à leur auteur, les planifications suivent l'API mais sont suspendues (le nouveau propriétaire les relance).
 * Les APIs avec session ne sont jamais réaffectées : elles restent à leur propriétaire (`kept`). Leur statut n'est pas
 * forcé ici (INV3 : seule la machine à états le change, au prochain run sans session : `auth_required`).
 */
export async function transferApisWithoutSession(db: Queryable, fromOwnerId: string, toOwnerId: string): Promise<{ transferred: string[]; kept: string[] }> {
  const moved = await db.query<{ id: string }>(
    'UPDATE apis SET owner_id = $2, updated_at = now() WHERE owner_id = $1 AND NOT requires_session RETURNING id',
    [fromOwnerId, toOwnerId],
  );
  const ids = moved.rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.query('UPDATE strategy_versions SET owner_id = $2 WHERE api_id = ANY($1::uuid[])', [ids, toOwnerId]);
    await db.query('UPDATE schedules SET owner_id = $2, enabled = false, updated_at = now() WHERE api_id = ANY($1::uuid[])', [ids, toOwnerId]);
  }
  const kept = await db.query<{ id: string }>('SELECT id FROM apis WHERE owner_id = $1 AND requires_session ORDER BY id', [fromOwnerId]);
  return { transferred: ids, kept: kept.rows.map((r) => r.id) };
}
