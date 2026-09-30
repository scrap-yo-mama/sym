// SPDX-License-Identifier: AGPL-3.0-only
// `runtime migrate` de bout en bout sur base réelle : application, rejeu idempotent, descente hors production.
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { generateMasterKey } from '@runtime/core';
import { loadMigrations } from '@runtime/db';
import { run } from './cli.js';

let tdb: TestDatabase;
const log = () => {};
const count = loadMigrations().length;

beforeAll(async () => {
  tdb = await createTestDatabase('cli');
});
afterAll(async () => {
  await tdb.drop();
});

test(`runtime migrate, rejeu, down --all, migrate (PostgreSQL ${inject('pgVersion')})`, async () => {
  const env = { DATABASE_URL: tdb.url };
  expect(await run(['migrate'], { env, log })).toEqual({ code: 0, out: `migrate : ${count} migration(s) appliquée(s)` });
  expect(await run(['migrate'], { env, log })).toEqual({ code: 0, out: 'migrate : 0 migration(s) appliquée(s)' });
  expect(await run(['migrate', 'down', '--all'], { env, log })).toEqual({ code: 0, out: `migrate down : ${count} migration(s) annulée(s)` });
  expect((await run(['migrate'], { env, log })).code).toBe(0);
});

test('runtime key-check puis runtime rekey --confirm : l’ancienne clé est ensuite refusée', async () => {
  const [oldKey, newKey] = [generateMasterKey(), generateMasterKey()];
  const db = await createTestDatabase('clikey');
  try {
    const base = { DATABASE_URL: db.url };
    expect((await run(['migrate'], { env: base, log })).code).toBe(0);
    expect((await run(['key-check'], { env: { ...base, MASTER_KEY: oldKey }, log })).out).toMatch(/témoin créé .* version 1/);
    const lines: string[] = [];
    const res = await run(['rekey', '--confirm'], {
      env: { ...base, MASTER_KEY: newKey, MASTER_KEY_PREVIOUS: oldKey },
      log: (l) => lines.push(l),
    });
    expect(res).toEqual({ code: 0, out: expect.stringMatching(/version 1 → 2, 0 secret\(s\) re-chiffré\(s\)\. MASTER_KEY_PREVIOUS peut être retirée/) });
    expect((await run(['key-check'], { env: { ...base, MASTER_KEY: newKey }, log })).out).toMatch(/clé vérifiée .* version 2/);
    const refused = await run(['key-check'], { env: { ...base, MASTER_KEY: oldKey }, log });
    expect(refused.code).toBe(2);
    expect(refused.out).toMatch(/Refus de démarrer : MASTER_KEY ne correspond pas/);
    expect(refused.out + lines.join('')).not.toContain(oldKey);
  } finally {
    await db.drop();
  }
});
