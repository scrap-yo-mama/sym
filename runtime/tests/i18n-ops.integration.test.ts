// SPDX-License-Identifier: AGPL-3.0-only
// assert_cli_doctor_stable_ids (tâche 3.20, 21b M10, 21 § 4.7) : `runtime doctor --json` ne se localise pas en V1 (`doctor` localisé :
// V2). Sous `LANG=fr_FR.UTF-8` (et `LC_ALL`, `LANGUAGE`) il rend exactement les mêmes identifiants, codes et messages que sous `LANG=C` :
// la langue de l'environnement n'entre pas dans la sortie ; les identifiants sont stables.
// La locale ICU de Node est fixée au DÉMARRAGE du processus : modifier `process.env.LANG` en cours de route ne change rien. Chaque
// variante tourne donc dans un SOUS-PROCESSUS lancé avec son environnement (CLI construite, `apps/cli/dist/index.js`), et un témoin
// vérifie que cet environnement atteint bien `Intl` (« 1 234,5 » en fr, « 1,234.5 » en C) : sans lui, le test ne verrait rien.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateMasterKey } from '@runtime/core';
import { migrateUp } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/pg.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));

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

const C = { LANG: 'C', LC_ALL: 'C', LANGUAGE: 'C' };
const FR = { LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8', LANGUAGE: 'fr' };

/** Lance `args` avec Node dans un processus neuf dont l'environnement ne contient que `lang` (et PATH, HOME). */
const nodeUnder = async (args: string[], lang: Record<string, string>, extra: Record<string, string> = {}): Promise<string> => {
  const env = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...extra, ...lang };
  try {
    return (await exec(process.execPath, args, { env, timeout: 60_000 })).stdout;
  } catch (error) {
    // doctor sort en 1 (avertissement) ou 2 (erreur) : son JSON reste sur stdout.
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === 'string' && stdout.trim() !== '') return stdout;
    throw error;
  }
};

type Doctor = { exitCode: number; checks: { id: string; status: string; code: string; message: string }[] };
const doctorUnder = async (lang: Record<string, string>): Promise<Doctor> =>
  JSON.parse(await nodeUnder([CLI, 'doctor', '--json'], lang, { DATABASE_URL: tdb.url, MASTER_KEY: key, PUBLIC_URL: 'https://runtime.example.test' })) as Doctor;

describe('M10 : doctor --json, identifiants stables', () => {
  test('assert_cli_doctor_stable_ids : LANG=fr_FR.UTF-8 et LANG=C donnent les mêmes identifiants, codes et messages (sous-processus)', async () => {
    // Témoin : l'environnement du sous-processus atteint bien la locale ICU (un format dépendant de la langue diffère).
    const probe = ['-e', 'process.stdout.write((1234.5).toLocaleString())'];
    const probeC = await nodeUnder(probe, C);
    const probeFr = await nodeUnder(probe, FR);
    expect(probeC).toBe(new Intl.NumberFormat('en-US').format(1234.5));
    expect(probeFr).toBe(new Intl.NumberFormat('fr-FR').format(1234.5));
    expect(probeFr).not.toBe(probeC);

    const c = await doctorUnder(C);
    const fr = await doctorUnder(FR);
    expect(c.checks.length).toBeGreaterThan(3);
    expect(fr.checks.map((x) => x.id)).toEqual(c.checks.map((x) => x.id));
    expect(fr.checks.map((x) => x.code)).toEqual(c.checks.map((x) => x.code));
    expect(fr).toEqual(c);
    // Identifiants stables : snake_case ASCII, jamais une phrase.
    for (const check of c.checks) expect(check.id).toMatch(/^[a-z][a-z0-9_]*$/);
  }, 120_000);
});
