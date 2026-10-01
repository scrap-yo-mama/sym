// SPDX-License-Identifier: AGPL-3.0-only
// Dépôt des secrets (INV8, 08 § 3, 14 § 7) : scellement par ligne, key_check au démarrage, état `unreadable`,
// rotation `rekey` reprenable. Aucune fonction ne renvoie une valeur en clair hors d'un `Secret`.
import { randomUUID } from 'node:crypto';
import {
  artifactAad,
  createKeyCheck,
  kekFor,
  openSecret,
  rotate,
  sealSecret,
  Secret,
  SecretDecryptError,
  secretAad,
  secretValues,
  verifyKeyCheck,
  type Kek,
  type KeyCheckRecord,
  type Keyring,
  type MasterKey,
  type SealedValue,
} from '@runtime/core';
import type pg from 'pg';
import { appendAudit } from './audit.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Clés de `settings` utilisées ici. */
export const KEY_CHECK_SETTING = 'key_check';
export const REKEY_STATE_SETTING = 'rekey_state';
/**
 * Verrou consultatif des secrets (distinct de celui des migrations) : chaque processus qui utilise le dépôt le tient en
 * mode partagé pour sa durée de vie (`holdSecretsLock`) ; `rekey` l'exige en mode exclusif.
 */
export const REKEY_LOCK_KEY = '8315178094305570146';

/**
 * Colonnes chiffrées du schéma. `rekey` couvre celles marquées `rekey` ; les autres appartiennent à une tâche
 * ultérieure et `rekey` refuse de tourner si elles contiennent des données (aucune colonne n'échappe en silence).
 * Vérifié contre la base par secrets.integration.test.ts (toute colonne `*ciphertext*` doit figurer ici).
 */
export const ENCRYPTED_COLUMNS = [
  { table: 'secrets', column: 'ciphertext', coveredBy: 'rekey' },
  { table: 'settings', column: 'value', key: KEY_CHECK_SETTING, coveredBy: 'rekey' },
  // Écrite par la capture de session de l'extension (2.6) : cette tâche doit la rendre rotable avant toute écriture.
  { table: 'site_sessions', column: 'ciphertext', coveredBy: '2.6' },
  { table: 'run_artifacts', column: 'ciphertext', coveredBy: 'rekey' },
  { table: 'two_factor', column: 'secret_ciphertext', coveredBy: '3.7' },
] as const;

export class KeyCheckError extends Error {
  override name = 'KeyCheckError';
}

export class SecretUnreadableError extends Error {
  override name = 'SecretUnreadableError';
  readonly secretId: string;
  constructor(secretId: string) {
    super(`secret ${secretId} illisible avec la clé courante (état unreadable, à ressaisir)`);
    this.secretId = secretId;
  }
}

/** Le secret est sous une autre génération de clé que celle de ce processus (rotation faite ailleurs) : rien n'est marqué. */
export class SecretVersionMismatchError extends Error {
  override name = 'SecretVersionMismatchError';
  readonly secretId: string;
  constructor(secretId: string, rowVersion: number, processVersion: number) {
    super(`secret ${secretId} sous la version de clé ${rowVersion}, ce processus est en version ${processVersion} : redémarrez-le avec la MASTER_KEY courante`);
    this.secretId = secretId;
  }
}

/** Écriture refusée : rotation en cours, ou `key_check` passé à une autre version depuis le démarrage de ce processus. */
export class RekeyInProgressError extends Error {
  override name = 'RekeyInProgressError';
}

/**
 * Verrou partagé des secrets, à prendre au démarrage de `server` et `worker` sur une connexion de session dédiée
 * et à garder jusqu'à l'arrêt : `rekey` refuse de tourner tant qu'il est tenu. Renvoie la fonction de libération.
 */
export async function holdSecretsLock(client: pg.ClientBase): Promise<() => Promise<void>> {
  const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock_shared($1::bigint) AS ok', [REKEY_LOCK_KEY]);
  if (!rows[0]?.ok) throw new KeyCheckError('rotation de clé `runtime rekey` en cours : démarrage refusé jusqu’à sa fin.');
  return async () => {
    await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [REKEY_LOCK_KEY]);
  };
}

export type KeyCheckResult = { status: 'ok' | 'initialized'; version: number; fingerprint: string };
type RekeyState = { from: number; to: number; fromFingerprint: string; toFingerprint: string };

async function readSetting<T>(db: Queryable, key: string): Promise<T | undefined> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value;
}

async function writeSetting(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

const mismatchMessage = (expected: string, actual: string) =>
  `MASTER_KEY ne correspond pas à cette base (empreinte attendue ${expected}, reçue ${actual}). ` +
  'Aucun secret n’a été lu ni écrit. Remettez la clé d’origine ; pour changer de clé, utilisez `runtime rekey` ' +
  'avec MASTER_KEY_PREVIOUS. Une clé perdue rend les secrets définitivement illisibles (état unreadable, à ressaisir).';

/**
 * Contrôle de démarrage (`server` et `worker`) : la clé courante doit ouvrir `settings.key_check`, aucune rotation ne
 * doit être en cours et aucun secret lisible ne doit rester sous une autre version. Base neuve : le témoin est créé
 * (version 1). Échec : `KeyCheckError` au message clair, avant toute lecture ou écriture de secret.
 */
export async function keyCheck(db: Queryable, keyring: Keyring): Promise<KeyCheckResult> {
  const current = keyring.current;
  const record = await readSetting<KeyCheckRecord>(db, KEY_CHECK_SETTING);
  const rekeyState = await readSetting<RekeyState>(db, REKEY_STATE_SETTING);
  if (rekeyState) {
    throw new KeyCheckError(
      `rotation de clé inachevée (version ${rekeyState.from} → ${rekeyState.to}, empreinte ${rekeyState.fromFingerprint} → ` +
        `${rekeyState.toFingerprint}) : relancez \`runtime rekey --confirm\` avec MASTER_KEY (nouvelle) et MASTER_KEY_PREVIOUS (ancienne).`,
    );
  }
  if (!record) {
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM secrets WHERE state = 'ok'");
    if ((rows[0]?.n ?? 0) > 0) {
      throw new KeyCheckError('settings.key_check absent alors que des secrets existent : base incohérente, démarrage refusé.');
    }
    // Insertion concurrente (server et worker au même démarrage) : la première gagne, l'autre revérifie.
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [
      KEY_CHECK_SETTING,
      JSON.stringify(createKeyCheck(current, 1)),
    ]);
    const stored = await readSetting<KeyCheckRecord>(db, KEY_CHECK_SETTING);
    if (stored && verifyKeyCheck(stored, current)) return { status: 'initialized', version: stored.version, fingerprint: current.fingerprint };
    throw new KeyCheckError(mismatchMessage(stored?.fingerprint ?? '?', current.fingerprint));
  }
  if (!verifyKeyCheck(record, current)) throw new KeyCheckError(mismatchMessage(record.fingerprint, current.fingerprint));
  const { rows } = await db.query<{ v: number }>(
    "SELECT DISTINCT kek_version AS v FROM secrets WHERE state = 'ok' AND kek_version <> $1 ORDER BY 1",
    [record.version],
  );
  if (rows.length > 0) {
    throw new KeyCheckError(
      `secrets sous une version de clé inconnue (${rows.map((r) => r.v).join(', ')} ; courante ${record.version}) : démarrage refusé.`,
    );
  }
  return { status: 'ok', version: record.version, fingerprint: current.fingerprint };
}

type SecretRow = {
  id: string;
  owner_id: string | null;
  kind: string;
  ciphertext: Buffer;
  nonce: Buffer;
  alg: string;
  dek_wrapped: Buffer;
  kek_version: number;
  state: 'ok' | 'unreadable';
};

const sealedOf = (r: SecretRow): SealedValue => ({
  ciphertext: r.ciphertext,
  nonce: r.nonce,
  alg: r.alg,
  dekWrapped: r.dek_wrapped,
  kekVersion: r.kek_version,
});

export type SecretMetadata = {
  id: string;
  ownerId: string | null;
  kind: string;
  label: string;
  state: 'ok' | 'unreadable';
  kekVersion: number;
  unreadableSince: Date | null;
};

const KIND = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Dépôt des secrets, lié à une clé vérifiée par `keyCheck` (le `KeyCheckResult` est exigé pour qu'aucun appel ne
 * précède le contrôle). Écriture seule vers l'extérieur : `get` rend un `Secret`, jamais une chaîne.
 */
export function secretStore(db: Queryable, keyring: Keyring, checked: KeyCheckResult) {
  const kek = kekFor(keyring.current, checked.version);

  /** Ne marque que la ligne telle qu'elle a été lue : une ligne re-chiffrée entre-temps n'est jamais touchée. */
  async function markUnreadable(id: string, version: number): Promise<void> {
    await db.query(
      `UPDATE secrets SET state = 'unreadable', unreadable_since = coalesce(unreadable_since, now()), updated_at = now()
       WHERE id = $1 AND state = 'ok' AND kek_version = $2`,
      [id, version],
    );
  }

  return {
    /** Scelle et insère ; renvoie l'identifiant. `ownerId` NULL = secret d'instance. */
    async put(input: { ownerId: string | null; kind: string; label: string; value: string; projectId?: string }): Promise<string> {
      if (!KIND.test(input.kind)) throw new Error(`type de secret invalide : ${input.kind}`);
      const id = randomUUID();
      const aad = secretAad({ id, kind: input.kind, ownerId: input.ownerId });
      const s = sealSecret(input.value, kek, aad);
      // Garde atomique : pas d'écriture pendant une rotation, ni sous une version que key_check ne porte plus.
      const { rowCount } = await db.query(
        `INSERT INTO secrets (id, owner_id, project_id, kind, label, ciphertext, nonce, aad, alg, dek_wrapped, kek_version)
         SELECT $1, $2, coalesce($3::uuid, '00000000-0000-0000-0000-000000000001'), $4, $5, $6, $7, $8, $9, $10, $11
         WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = '${REKEY_STATE_SETTING}')
           AND EXISTS (SELECT 1 FROM settings WHERE key = '${KEY_CHECK_SETTING}' AND (value ->> 'version')::int = $11)`,
        [id, input.ownerId, input.projectId ?? null, input.kind, input.label, s.ciphertext, s.nonce, Buffer.from(aad), s.alg, s.dekWrapped, s.kekVersion],
      );
      if (rowCount !== 1) {
        throw new RekeyInProgressError('écriture de secret refusée : rotation de clé en cours ou terminée depuis le démarrage de ce processus.');
      }
      secretValues.add(input.value);
      return id;
    },

    /**
     * Ouvre un secret. L'AAD est recalculée depuis la ligne (id, kind, owner_id) : la colonne `aad` n'est jamais crue.
     * Échec de déchiffrement : la ligne passe en `unreadable` et `SecretUnreadableError` est levée.
     */
    async get(id: string): Promise<Secret> {
      const { rows } = await db.query<SecretRow>(
        'SELECT id, owner_id, kind, ciphertext, nonce, alg, dek_wrapped, kek_version, state FROM secrets WHERE id = $1',
        [id],
      );
      const row = rows[0];
      if (!row) throw new Error(`secret ${id} introuvable`);
      if (row.state === 'unreadable') throw new SecretUnreadableError(id);
      if (row.kek_version !== checked.version) throw new SecretVersionMismatchError(id, row.kek_version, checked.version);
      try {
        const value = openSecret(sealedOf(row), kek, secretAad({ id: row.id, kind: row.kind, ownerId: row.owner_id }));
        secretValues.add(value);
        return new Secret(value);
      } catch (error) {
        if (!(error instanceof SecretDecryptError)) throw error;
        await markUnreadable(id, row.kek_version);
        throw new SecretUnreadableError(id);
      }
    },

    /** Métadonnées seulement (« À ressaisir » = état `unreadable`). */
    async list(): Promise<SecretMetadata[]> {
      const { rows } = await db.query<SecretMetadata>(
        `SELECT id, owner_id AS "ownerId", kind, label, state, kek_version AS "kekVersion", unreadable_since AS "unreadableSince"
         FROM secrets ORDER BY created_at, id`,
      );
      return rows;
    },
  };
}

export type RekeyResult = {
  status: 'done' | 'already_done';
  from: number;
  to: number;
  /** Secrets re-chiffrés, et secrets passés en `unreadable`. */
  rotated: number;
  unreadable: number;
  /** Artefacts de run re-chiffrés, et artefacts MARQUÉS illisibles (conservés, audités `artifact.unreadable`). */
  rotatedArtifacts: number;
  unreadableArtifacts: number;
};

/**
 * `runtime rekey` : re-chiffre chaque secret de la version de `MASTER_KEY_PREVIOUS` vers `MASTER_KEY` (nouvelle DEK,
 * nouveaux nonces), par lots transactionnels, sous verrou consultatif. Reprenable : l'état est dans
 * `settings.rekey_state`, chaque lot est atomique, et une relance reprend les lignes restantes. À la fin, dans une
 * transaction : plus aucune ligne lisible sous l'ancienne version, `key_check` réécrit, `rekey_state` supprimé.
 * Une ligne que l'ancienne clé n'ouvre pas passe en `unreadable` (elle garde sa version d'origine).
 */
export async function rekey(
  client: pg.ClientBase,
  keyring: Keyring,
  opts: { batchSize?: number; afterBatch?: (rotated: number) => void | Promise<void> } = {},
): Promise<RekeyResult> {
  const batchSize = opts.batchSize ?? 100;
  const { current, previous } = keyring;
  if (!previous) throw new KeyCheckError('MASTER_KEY_PREVIOUS (ou MASTER_KEY_PREVIOUS_FILE) requise : c’est l’ancienne clé à remplacer.');
  if (previous.fingerprint === current.fingerprint) throw new KeyCheckError('MASTER_KEY et MASTER_KEY_PREVIOUS sont identiques : rien à faire.');

  const { rows: lock } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [REKEY_LOCK_KEY]);
  if (!lock[0]?.ok) {
    throw new KeyCheckError(
      'verrou des secrets indisponible : des instances tournent encore (server, worker) ou une autre rotation est en cours ; arrêtez-les puis relancez.',
    );
  }
  try {
    await assertDeferredColumnsEmpty(client);
    const record = await readSetting<KeyCheckRecord>(client, KEY_CHECK_SETTING);
    let state = await readSetting<RekeyState>(client, REKEY_STATE_SETTING);
    if (!record) throw new KeyCheckError('settings.key_check absent : démarrez d’abord l’instance avec l’ancienne clé.');
    if (!state && verifyKeyCheck(record, current)) {
      return { status: 'already_done', from: record.version, to: record.version, rotated: 0, unreadable: 0, rotatedArtifacts: 0, unreadableArtifacts: 0 };
    }
    if (!verifyKeyCheck(record, previous)) {
      throw new KeyCheckError(
        `MASTER_KEY_PREVIOUS ne correspond pas à cette base (empreinte attendue ${record.fingerprint}, reçue ${previous.fingerprint}).`,
      );
    }
    if (state && (state.toFingerprint !== current.fingerprint || state.fromFingerprint !== previous.fingerprint)) {
      throw new KeyCheckError(
        `rotation déjà commencée vers l’empreinte ${state.toFingerprint} : relancez avec cette MASTER_KEY (reçue ${current.fingerprint}).`,
      );
    }
    if (!state) {
      state = { from: record.version, to: record.version + 1, fromFingerprint: previous.fingerprint, toFingerprint: current.fingerprint };
      await writeSetting(client, REKEY_STATE_SETTING, state);
    }
    const from = kekFor(previous, state.from);
    const to = kekFor(current, state.to);
    let rotated = 0;
    let unreadable = 0;
    const artifacts = { rotated: 0, unreadable: 0 };
    for (;;) {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query<SecretRow>(
          `SELECT id, owner_id, kind, ciphertext, nonce, alg, dek_wrapped, kek_version, state FROM secrets
           WHERE kek_version = $1 AND state = 'ok' ORDER BY id LIMIT $2 FOR UPDATE`,
          [state.from, batchSize],
        );
        for (const row of rows) {
          const aad = secretAad({ id: row.id, kind: row.kind, ownerId: row.owner_id });
          let next: SealedValue;
          try {
            next = rotate(sealedOf(row), from, to, aad);
          } catch (error) {
            if (!(error instanceof SecretDecryptError)) throw error;
            await client.query(
              "UPDATE secrets SET state = 'unreadable', unreadable_since = coalesce(unreadable_since, now()), updated_at = now() WHERE id = $1",
              [row.id],
            );
            unreadable += 1;
            continue;
          }
          await client.query(
            `UPDATE secrets SET ciphertext = $2, nonce = $3, dek_wrapped = $4, alg = $5, kek_version = $6, aad = $7, updated_at = now()
             WHERE id = $1`,
            [row.id, next.ciphertext, next.nonce, next.dekWrapped, next.alg, next.kekVersion, Buffer.from(aad)],
          );
          rotated += 1;
        }
        const batch = await rotateArtifacts(client, state.from, from, to, batchSize);
        await client.query('COMMIT');
        artifacts.rotated += batch.rotated;
        artifacts.unreadable += batch.unreadable;
        if (rows.length === 0 && batch.rotated + batch.unreadable === 0) break;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      await opts.afterBatch?.(rotated);
    }
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM secrets WHERE state = 'ok' AND kek_version <> $1",
        [state.to],
      );
      if ((rows[0]?.n ?? 0) > 0) throw new KeyCheckError(`${rows[0]?.n} secret(s) encore hors de la version ${state.to} : rotation non terminée.`);
      const leftover = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM run_artifacts WHERE state = 'ok' AND key_version <> $1", [state.to]);
      if ((leftover.rows[0]?.n ?? 0) > 0) throw new KeyCheckError(`${leftover.rows[0]?.n} artefact(s) encore hors de la version ${state.to} : rotation non terminée.`);
      await writeSetting(client, KEY_CHECK_SETTING, createKeyCheck(current, state.to));
      await client.query('DELETE FROM settings WHERE key = $1', [REKEY_STATE_SETTING]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return { status: 'done', from: state.from, to: state.to, rotated, unreadable, rotatedArtifacts: artifacts.rotated, unreadableArtifacts: artifacts.unreadable };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [REKEY_LOCK_KEY]);
  }
}

/**
 * Re-chiffre un lot d'artefacts de run (14 § 10) dans la transaction de `rekey`. Un artefact que l'ancienne clé n'ouvre
 * pas (clé perdue, ligne altérée) est MARQUÉ `unreadable` et audité (`artifact.unreadable`, acteur système, sans contenu) :
 * rien ne disparaît sans trace ; la rétention (7 jours) le purge ensuite. Il reste sous l'ancienne version de clé.
 */
async function rotateArtifacts(
  client: pg.ClientBase,
  fromVersion: number,
  from: Kek,
  to: Kek,
  batchSize: number,
): Promise<{ rotated: number; unreadable: number }> {
  const { rows } = await client.query<{
    id: string;
    run_id: string;
    owner_id: string;
    kind: string;
    ciphertext: Buffer;
    nonce: Buffer;
    alg: string;
    dek_wrapped: Buffer;
    key_version: number;
  }>(
    `SELECT id, run_id, owner_id, kind, ciphertext, nonce, alg, dek_wrapped, key_version FROM run_artifacts
     WHERE key_version = $1 AND state = 'ok' ORDER BY id LIMIT $2 FOR UPDATE`,
    [fromVersion, batchSize],
  );
  const result = { rotated: 0, unreadable: 0 };
  for (const row of rows) {
    const aad = artifactAad({ id: row.id, runId: row.run_id, ownerId: row.owner_id, kind: row.kind });
    try {
      const next = rotate({ ciphertext: row.ciphertext, nonce: row.nonce, alg: row.alg, dekWrapped: row.dek_wrapped, kekVersion: row.key_version }, from, to, aad);
      await client.query('UPDATE run_artifacts SET ciphertext = $2, nonce = $3, dek_wrapped = $4, alg = $5, key_version = $6 WHERE id = $1', [
        row.id,
        next.ciphertext,
        next.nonce,
        next.dekWrapped,
        next.alg,
        next.kekVersion,
      ]);
      result.rotated += 1;
    } catch (error) {
      if (!(error instanceof SecretDecryptError)) throw error;
      await client.query("UPDATE run_artifacts SET state = 'unreadable', unreadable_since = now() WHERE id = $1", [row.id]);
      await appendAudit(client, {
        actorUserId: null,
        actorVia: 'system',
        action: 'artifact.unreadable',
        targetType: 'run_artifact',
        targetId: row.id,
        outcome: 'error',
        meta: { reason: 'rekey_decrypt_failed', key_version: row.key_version },
      });
      result.unreadable += 1;
    }
  }
  return result;
}

/** Colonnes chiffrées pas encore couvertes par `rekey` : elles doivent être vides, sinon refus. */
async function assertDeferredColumnsEmpty(db: Queryable): Promise<void> {
  for (const c of ENCRYPTED_COLUMNS) {
    if (c.coveredBy === 'rekey') continue;
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${c.table} WHERE ${c.column} IS NOT NULL`);
    if ((rows[0]?.n ?? 0) > 0) {
      throw new KeyCheckError(`${c.table}.${c.column} contient des données chiffrées que \`rekey\` ne couvre pas encore (tâche ${c.coveredBy}) : refus.`);
    }
  }
}

/**
 * Clé perdue, acceptée explicitement par l'administrateur : tous les secrets lisibles passent en `unreadable`
 * (conservés, « À ressaisir »), et `key_check` est réécrit pour la clé courante sous une nouvelle version.
 * Jamais appelé implicitement : aucune nouvelle clé n'est adoptée en silence.
 */
export async function acceptKeyLoss(client: pg.ClientBase, current: MasterKey): Promise<{ unreadable: number; version: number }> {
  await client.query('BEGIN');
  try {
    const record = await readSetting<KeyCheckRecord>(client, KEY_CHECK_SETTING);
    if (record && verifyKeyCheck(record, current)) throw new KeyCheckError('la clé courante ouvre key_check : aucune perte à accepter.');
    const version = (record?.version ?? 0) + 1;
    const { rowCount } = await client.query(
      "UPDATE secrets SET state = 'unreadable', unreadable_since = now(), updated_at = now() WHERE state = 'ok'",
    );
    await writeSetting(client, KEY_CHECK_SETTING, createKeyCheck(current, version));
    await client.query('DELETE FROM settings WHERE key = $1', [REKEY_STATE_SETTING]);
    await client.query('COMMIT');
    return { unreadable: rowCount ?? 0, version };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
