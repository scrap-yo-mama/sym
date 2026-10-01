// SPDX-License-Identifier: AGPL-3.0-only
// Clé des sujets (D-25 ; 17 § 6 « liste d'exclusion hachée, sel d'instance ») : 32 octets aléatoires, générés une fois
// par instance, stockés chiffrés comme un secret d'instance (enveloppe DEK/KEK de 0.3a, `owner_id` NULL, kind dédié).
// `rekey` ré-enveloppe la ligne avec les autres secrets : la clé, donc chaque empreinte de `subject_exclusions` et de
// `dedup_keys`, survit à une rotation de MASTER_KEY. Elle n'est jamais dérivée de MASTER_KEY.
import { randomBytes } from 'node:crypto';
import type { Keyring } from '@runtime/core';
import type pg from 'pg';
import { secretStore, type KeyCheckResult } from './secrets.js';

export const SUBJECT_KEY_KIND = 'instance.subject_key';
export const SUBJECT_KEY_BYTES = 32;
/** Verrou de transaction de la création (deux processus au même démarrage : une seule clé). */
const SUBJECT_KEY_LOCK = '8315178094305570148';

export class SubjectKeyError extends Error {
  override name = 'SubjectKeyError';
}

/**
 * Clé HMAC des sujets de l'instance. Créée au premier appel (sous verrou consultatif de transaction), relue ensuite.
 * Refus explicite si la ligne est illisible (clé perdue) ou absente alors que `subject_exclusions` est rempli : une
 * nouvelle clé rendrait la liste d'exclusion muette, et un sujet effacé serait collecté à nouveau.
 */
export async function loadSubjectKey(pool: pg.Pool, keyring: Keyring, checked: KeyCheckResult): Promise<Buffer> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SUBJECT_KEY_LOCK]);
      const store = secretStore(client, keyring, checked);
      const { rows } = await client.query<{ id: string; state: string }>(
        'SELECT id, state FROM secrets WHERE owner_id IS NULL AND kind = $1 ORDER BY created_at, id',
        [SUBJECT_KEY_KIND],
      );
      let encoded: string;
      if (rows.length > 1) throw new SubjectKeyError(`${rows.length} clés des sujets en base : une seule attendue.`);
      if (rows[0]) {
        if (rows[0].state !== 'ok') {
          throw new SubjectKeyError(
            'clé des sujets illisible (état unreadable) : la liste d’exclusion ne peut plus être appliquée. Restaurez la MASTER_KEY d’origine ; aucune nouvelle clé n’est créée en silence.',
          );
        }
        encoded = (await store.get(rows[0].id)).reveal();
      } else {
        const { rows: ex } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM subject_exclusions');
        if ((ex[0]?.n ?? 0) > 0) {
          throw new SubjectKeyError(
            'clé des sujets absente alors que subject_exclusions contient des empreintes : base incohérente, aucune nouvelle clé créée.',
          );
        }
        encoded = randomBytes(SUBJECT_KEY_BYTES).toString('base64');
        await store.put({ ownerId: null, kind: SUBJECT_KEY_KIND, label: 'Clé des sujets (liste d’exclusion RGPD)', value: encoded });
      }
      await client.query('COMMIT');
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== SUBJECT_KEY_BYTES) throw new SubjectKeyError('clé des sujets invalide (longueur).');
      return key;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}
