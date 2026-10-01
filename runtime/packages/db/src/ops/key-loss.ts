// SPDX-License-Identifier: AGPL-3.0-only
// `runtime secrets accept-key-loss --confirm` (D-12, 14 § 7) : MASTER_KEY perdue. Les secrets sont CONSERVÉS en état
// `unreadable` (« À ressaisir ») et `key_check` est réécrit pour la clé courante sous une nouvelle version ; rien n'est
// généré ni adopté en silence (08 § 3). Les autres colonnes chiffrées que la clé perdue rend inutilisables sont vidées
// dans la même transaction : sessions de site (cookies à recapturer) et artefacts de run (éphémères).
// Les secrets 2FA (`two_factor`, tâche 3.7) ne sont que signalés : traitement `deferred` de KEY_LOSS_TREATMENT.
// Aucun changement de statut d'API ici : 04 § 6 n'a pas de transition vers `action_requise` pour `secret_unreadable`, et aucune API n'est liée à un secret en base.
import { verifyKeyCheck, type KeyCheckRecord, type MasterKey } from '@runtime/core';
import type pg from 'pg';
import { acceptKeyLoss, KEY_CHECK_SETTING, KeyCheckError, REKEY_LOCK_KEY } from '../secrets.js';

/**
 * Traitement de CHAQUE colonne chiffrée de `ENCRYPTED_COLUMNS` quand la clé est perdue (D-12). Le registre est vérifié
 * contre `ENCRYPTED_COLUMNS` (ops.unit.test.ts) et contre la base (cli.ops.integration.test.ts) : une colonne chiffrée
 * ajoutée plus tard sans traitement déclaré fait échouer les tests, au lieu de rester scellée sous la clé perdue.
 * - `unreadable` : lignes conservées, état « À ressaisir » ;  `rewritten` : témoin réécrit pour la clé courante ;
 * - `cleared` : colonne vidée (la ligne reste, à resynchroniser) ;  `deleted` : lignes supprimées (éphémères) ;
 * - `deferred` : non traitée ici, signalée dans la sortie ; `task` hérite du traitement, `until` dit quoi faire en attendant.
 */
export const KEY_LOSS_TREATMENT = {
  'secrets.ciphertext': { action: 'unreadable' },
  'settings.value': { action: 'rewritten' },
  'site_sessions.ciphertext': { action: 'cleared' },
  'run_artifacts.ciphertext': { action: 'deleted' },
  'two_factor.secret_ciphertext': {
    action: 'deferred',
    task: '3.7',
    until: 'secret 2FA illisible, signalé par la commande ; la réinitialisation du 2FA relève de 3.7 (aucune commande ici)',
  },
} as const satisfies Record<string, { action: 'unreadable' | 'rewritten' | 'cleared' | 'deleted' } | { action: 'deferred'; task: string; until: string }>;

export type KeyLossInspection = {
  /** `no_loss` : la clé courante ouvre `key_check` ; `loss` : elle ne l'ouvre pas (ou le témoin est absent). */
  status: 'no_loss' | 'loss';
  currentFingerprint: string;
  expectedFingerprint: string | null;
  secretsReadable: number;
  secretsUnreadable: number;
  siteSessions: number;
  artifacts: number;
  twoFactor: number;
};

const count = async (db: Pick<pg.ClientBase, 'query'>, sql: string): Promise<number> => (await db.query<{ n: number }>(sql)).rows[0]?.n ?? 0;

/** Lecture seule : ce que `accept-key-loss --confirm` ferait. */
export async function inspectKeyLoss(db: Pick<pg.ClientBase, 'query'>, current: MasterKey): Promise<KeyLossInspection> {
  const { rows } = await db.query<{ value: KeyCheckRecord }>('SELECT value FROM settings WHERE key = $1', [KEY_CHECK_SETTING]);
  const record = rows[0]?.value;
  return {
    status: record && verifyKeyCheck(record, current) ? 'no_loss' : 'loss',
    currentFingerprint: current.fingerprint,
    expectedFingerprint: record?.fingerprint ?? null,
    secretsReadable: await count(db, "SELECT count(*)::int AS n FROM secrets WHERE state = 'ok'"),
    secretsUnreadable: await count(db, "SELECT count(*)::int AS n FROM secrets WHERE state = 'unreadable'"),
    siteSessions: await count(db, 'SELECT count(*)::int AS n FROM site_sessions WHERE ciphertext IS NOT NULL'),
    artifacts: await count(db, 'SELECT count(*)::int AS n FROM run_artifacts'),
    twoFactor: await count(db, 'SELECT count(*)::int AS n FROM two_factor WHERE secret_ciphertext IS NOT NULL'),
  };
}

export type KeyLossResult = {
  unreadable: number;
  version: number;
  fingerprint: string;
  siteSessionsCleared: number;
  artifactsDeleted: number;
  twoFactorUnreadable: number;
};

/**
 * Accepte la perte. Exige le verrou EXCLUSIF des secrets (comme `rekey`) : une instance qui tourne tient le verrou
 * partagé, preuve qu'elle a la bonne clé, donc que la clé n'est pas perdue. Refus si la clé courante ouvre `key_check`.
 */
export async function acceptKeyLossLocked(client: pg.ClientBase, current: MasterKey): Promise<KeyLossResult> {
  const { rows: lock } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [REKEY_LOCK_KEY]);
  if (!lock[0]?.ok) {
    throw new KeyCheckError(
      'verrou des secrets indisponible : une instance (server, worker) tourne, donc elle possède encore la clé. Arrêtez tout, puis relancez.',
    );
  }
  try {
    const twoFactorUnreadable = await count(client, 'SELECT count(*)::int AS n FROM two_factor WHERE secret_ciphertext IS NOT NULL');
    let siteSessionsCleared = 0;
    let artifactsDeleted = 0;
    const { unreadable, version } = await acceptKeyLoss(client, current, {
      inTransaction: async (c) => {
        const sessions = await c.query(
          'UPDATE site_sessions SET ciphertext = NULL, nonce = NULL, dek_wrapped = NULL, alg = NULL, key_version = NULL, captured_at = NULL WHERE ciphertext IS NOT NULL',
        );
        siteSessionsCleared = sessions.rowCount ?? 0;
        artifactsDeleted = (await c.query('DELETE FROM run_artifacts')).rowCount ?? 0;
      },
    });
    return { unreadable, version, fingerprint: current.fingerprint, siteSessionsCleared, artifactsDeleted, twoFactorUnreadable };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [REKEY_LOCK_KEY]);
  }
}
