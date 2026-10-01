// SPDX-License-Identifier: AGPL-3.0-only
// assert_cli_doctor_stable_ids (tâche 3.20, 21b M10, 21 § 4.7) : `runtime doctor --json` ne se localise pas en V1 (`doctor` localisé :
// V2). Sous `LANG=fr_FR.UTF-8` (et `LC_ALL`, `LANGUAGE`) il rend exactement les mêmes identifiants, codes et messages que sous `LANG=C` :
// la langue de l'environnement n'entre pas dans la sortie ; les identifiants sont stables.
import { generateMasterKey } from '@runtime/core';
import { migrateUp } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { run } from '../apps/cli/src/cli.js';
import { createTestDatabase, type TestDatabase } from './helpers/pg.js';

let tdb: TestDatabase;
let key: string;
beforeAll(async () => {
  tdb = await createTestDatabase('i18n_doctor');
  await migrateUp({ connectionString: tdb.url });
  key = generateMasterKey();
}, 120_000);
afterAll(async () => {
  await tdb?.drop();
});

type Doctor = { exitCode: number; checks: { id: string; status: string; code: string; message: string }[] };
const doctorUnder = async (lang: Record<string, string>): Promise<Doctor> => {
  const saved = Object.fromEntries(['LANG', 'LC_ALL', 'LANGUAGE'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, lang);
  try {
    return JSON.parse((await run(['doctor', '--json'], { env: { DATABASE_URL: tdb.url, MASTER_KEY: key, PUBLIC_URL: 'https://runtime.example.test', ...lang } })).out) as Doctor;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('M10 : doctor --json, identifiants stables', () => {
  test('assert_cli_doctor_stable_ids : LANG=fr_FR.UTF-8 et LANG=C donnent les mêmes identifiants, codes et messages', async () => {
    const c = await doctorUnder({ LANG: 'C', LC_ALL: 'C', LANGUAGE: 'C' });
    const fr = await doctorUnder({ LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8', LANGUAGE: 'fr' });
    expect(c.checks.length).toBeGreaterThan(3);
    expect(fr.checks.map((x) => x.id)).toEqual(c.checks.map((x) => x.id));
    expect(fr.checks.map((x) => x.code)).toEqual(c.checks.map((x) => x.code));
    expect(fr).toEqual(c);
    // Identifiants stables : snake_case ASCII, jamais une phrase.
    for (const check of c.checks) expect(check.id).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
