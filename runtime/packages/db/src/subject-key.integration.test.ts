// SPDX-License-Identifier: AGPL-3.0-only
// Clé des sujets (D-25, revue de 1.8 points 2 et 17) : clé d'instance aléatoire et stable, stockée chiffrée comme un
// secret d'instance, ré-enveloppée par `rekey`. Un `rekey` de MASTER_KEY ne fait jamais réapparaître un sujet effacé.
import { randomUUID } from 'node:crypto';
import { filterExcludedItems, MasterKey } from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';
import { ensureDatasetItemsPartitions } from './partitions.js';
import { eraseSubject, isSubjectExcluded, loadSubjectExclusions } from './retention/index.js';
import { keyCheck, rekey } from './secrets.js';
import { loadSubjectKey, SUBJECT_KEY_KIND, SubjectKeyError } from './subject-key.js';

const SCHEMA = {
  type: 'object',
  properties: { email: { type: 'string', 'x-personal': 'identifier' }, phone: { type: 'string', 'x-personal': true }, title: { type: 'string' } },
};
const ALICE = { email: 'alice.rekey@example.test', phone: '+33 6 11 22 33 44', title: 'fiche' };

let tdb: TestDatabase;
let pool: pg.Pool;
const OWNER = randomUUID();
const oldKey = MasterKey.generate();
const newKey = MasterKey.generate();

beforeAll(async () => {
  tdb = await createTestDatabase('subjkey');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_sk@example.test', 'active')", [OWNER]);
  await ensureDatasetItemsPartitions(pool, new Date());
});

afterAll(async () => {
  await pool?.end();
  await tdb?.drop();
});

describe('clé des sujets', () => {
  test('générée une seule fois, même sous appels concurrents ; stockée chiffrée (secret d’instance), jamais dérivée de MASTER_KEY', async () => {
    const keyring = { current: oldKey };
    const checked = await keyCheck(pool, keyring);
    const keys = await Promise.all([1, 2, 3, 4].map(() => loadSubjectKey(pool, keyring, checked)));
    expect(new Set(keys.map((k) => k.toString('hex'))).size).toBe(1);
    expect(keys[0]).toHaveLength(32);
    const rows = await pool.query<{ owner_id: string | null; ciphertext: Buffer }>('SELECT owner_id, ciphertext FROM secrets WHERE kind = $1', [SUBJECT_KEY_KIND]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.owner_id).toBeNull();
    expect(rows.rows[0]!.ciphertext.includes(keys[0]!)).toBe(false);
    expect(keys[0]!.equals(oldKey.kek('secrets'))).toBe(false);
  });

  test('assert_erasure_survives_rekey : erase_subject, rekey complet, puis le sujet est toujours exclu', async () => {
    const before = await loadSubjectKey(pool, { current: oldKey }, await keyCheck(pool, { current: oldKey }));
    const apiId = (
      await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ('zz_test_sk', $1, $2::jsonb) RETURNING id", [OWNER, JSON.stringify(SCHEMA)])
    ).rows[0]!.id;
    const ds = (await pool.query<{ id: string }>('INSERT INTO datasets (api_id, owner_id) VALUES ($1, $2) RETURNING id', [apiId, OWNER])).rows[0]!.id;
    await pool.query('INSERT INTO dataset_items (created_at, dataset_id, seq, owner_id, item, size_bytes) VALUES (now(), $1, 1, $2, $3::jsonb, 10)', [ds, OWNER, JSON.stringify(ALICE)]);
    const req = { values: [ALICE.email, ALICE.phone], key: before, actor: { userId: OWNER, via: 'ui' as const }, scope: { ownerId: OWNER } };
    const dry = await eraseSubject(pool, req, { dryRun: true });
    await eraseSubject(pool, req, { confirm: dry.plan.confirmation });
    expect(await isSubjectExcluded(pool, before, '06 11 22 33 44')).toBe(true);

    const client = await pool.connect();
    try {
      expect(await rekey(client, { current: newKey, previous: oldKey })).toMatchObject({ status: 'done' });
    } finally {
      client.release();
    }

    const after = await loadSubjectKey(pool, { current: newKey }, await keyCheck(pool, { current: newKey }));
    expect(after.equals(before)).toBe(true);
    expect(await isSubjectExcluded(pool, after, ALICE.email)).toBe(true);
    // Un run suivant (filtre avant écriture) exclut toujours la personne, sous la nouvelle MASTER_KEY.
    const excluded = await loadSubjectExclusions(pool);
    expect(filterExcludedItems(after, excluded, SCHEMA, [ALICE, { email: 'bob.rekey@example.test', title: 'x' }]).dropped).toBe(1);
  });

  test('clé perdue (illisible) ou absente alors que la liste d’exclusion est remplie : refus, jamais une nouvelle clé en silence', async () => {
    await pool.query("UPDATE secrets SET state = 'unreadable', unreadable_since = now() WHERE kind = $1", [SUBJECT_KEY_KIND]);
    const keyring = { current: newKey };
    await expect(loadSubjectKey(pool, keyring, await keyCheck(pool, keyring))).rejects.toBeInstanceOf(SubjectKeyError);
    await pool.query('DELETE FROM secrets WHERE kind = $1', [SUBJECT_KEY_KIND]);
    await expect(loadSubjectKey(pool, keyring, await keyCheck(pool, keyring))).rejects.toThrow(/subject_exclusions/);
  });
});
