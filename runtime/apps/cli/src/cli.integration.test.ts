// `runtime migrate` de bout en bout sur base réelle : application, rejeu idempotent, descente hors production.
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
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
