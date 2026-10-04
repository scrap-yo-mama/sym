// SPDX-License-Identifier: AGPL-3.0-only
// assert_third_locale_no_code_change, volet de bout en bout (tâche 3.20, 21b M14) : une langue `qaa` (plage d'usage local d'ISO 639)
// ajoutée par FICHIERS DE DONNÉES seulement (copie de `fr.json`, entrée de registre, liste de mots interdits), sans aucune
// modification de source :
// - le serveur démarre avec `I18N_LOCALES_DIR` sur ce dossier, accepte `PATCH /api/me {locale: 'qaa'}` et répond dans cette langue
//   (`Content-Language: qaa`) ;
// - la console se construit (vrai `vite build`) dans une copie de travail où seul le dossier des langues a changé :
//   `import.meta.glob` trouve `qaa.json` et en fait un morceau chargé à la demande ;
// - les messages de l'extension (`_locales/qaa/messages.json`) se génèrent depuis le même dossier.
// Le volet unitaire (parité, résolution, repli `cronstrue`) est dans packages/i18n/src/i18n.unit.test.ts.
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { buildExtensionLocales, createI18n, DEFAULT_LOCALES_DIR } from '@runtime/i18n';
import { createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer } from './helpers/server.js';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');

/** Dossier de langues de l'essai : copie du dossier livré, plus qaa (fichier de langue, liste de mots interdits, entrée de registre). */
function thirdLocaleDir(): { dir: string; shipped: string } {
  const shipped = DEFAULT_LOCALES_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'i18n-qaa-e2e-'));
  cpSync(shipped, dir, { recursive: true });
  cpSync(join(dir, 'fr.json'), join(dir, 'qaa.json'));
  cpSync(join(dir, 'forbidden.fr.txt'), join(dir, 'forbidden.qaa.txt'));
  const registry = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as { languages: object[] };
  registry.languages.push({ code: 'qaa', endonym: 'Essai local', english_name: 'Local test language', dir: 'ltr', maintainers: ['zz_test'], gate: 'shipped', completeness: 1 });
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry, null, 2));
  return { dir, shipped };
}
const QAA = thirdLocaleDir();
// Le serveur relit le dossier des langues à chaque appel (`defaultI18n` suit I18N_LOCALES_DIR) : posé avant son démarrage.
process.env['I18N_LOCALES_DIR'] = QAA.dir;
let srv: TestServer;
let work: string | undefined;

beforeAll(async () => {
  srv = await startTestServer('i18n_qaa');
}, 180_000);

afterAll(async () => {
  await srv?.close();
  delete process.env['I18N_LOCALES_DIR'];
  rmSync(QAA.dir, { recursive: true, force: true });
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

describe('assert_third_locale_no_code_change : une langue qaa ajoutée par fichiers de données seulement', () => {
  test('le dossier de langues de l’essai n’est pas celui du paquet (aucun fichier livré n’est touché)', () => {
    expect(readdirSync(QAA.shipped)).not.toContain('qaa.json');
    expect(readdirSync(QAA.dir)).toContain('qaa.json');
  });

  test('serveur démarré avec I18N_LOCALES_DIR : PATCH /api/me {locale: qaa} accepté, réponses en qaa', async () => {
    await runSetup(srv);
    const user = await createUser(srv, 'zz_test_qaa@example.test');
    const cookie = await signIn(srv, user);
    const patch = await srv.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie, origin: PUBLIC_URL }, payload: { locale: 'qaa' } });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
    const me = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ locale: 'qaa' });
    // Une réponse REST localisée suit la langue du compte : qaa (copie du français).
    const bad = await srv.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie, origin: PUBLIC_URL }, payload: { timezone: 'Paris' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-language']).toBe('qaa');
    // Une langue absente du registre reste refusée : seule la donnée ajoutée ouvre la langue.
    const unknown = await srv.app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie, origin: PUBLIC_URL }, payload: { locale: 'qab' } });
    expect(unknown.statusCode).toBe(400);
  });

  test('extension : _locales/qaa généré depuis le même dossier', () => {
    const i18n = createI18n(QAA.dir);
    const locales = buildExtensionLocales(i18n.catalogs, i18n.registry);
    expect(Object.keys(locales)).toContain('qaa');
    expect(Object.keys(locales['qaa'] ?? {})).toEqual(Object.keys(locales['fr'] ?? {}));
  });

  test('console : vite build réel dans une copie où seul le dossier des langues a changé ; qaa devient un morceau chargé à la demande', async () => {
    work = mkdtempSync(join(tmpdir(), 'i18n-qaa-web-'));
    // Copie de travail : la console et le paquet de langues copiés (liens pnpm relatifs conservés), le reste lié tel quel.
    for (const name of ['node_modules', 'package.json', 'tsconfig.base.json']) symlinkSync(join(ROOT, name), join(work, name));
    mkdirSync(join(work, 'apps'));
    mkdirSync(join(work, 'packages'));
    for (const name of readdirSync(join(ROOT, 'packages'))) {
      if (name !== 'i18n') symlinkSync(join(ROOT, 'packages', name), join(work, 'packages', name));
    }
    cpSync(join(ROOT, 'packages/i18n'), join(work, 'packages/i18n'), { recursive: true, verbatimSymlinks: true, filter: (src) => !src.includes(`${join(ROOT, 'packages/i18n')}/locales`) });
    // Seule différence avec le dépôt : le dossier de langues de l'essai (qaa ajoutée par fichiers).
    cpSync(QAA.dir, join(work, 'packages/i18n/locales'), { recursive: true });
    cpSync(join(ROOT, 'apps/web'), join(work, 'apps/web'), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !/\/apps\/web\/(dist|test-results|node_modules\/\.vite)(\/|$)/.test(src),
    });
    const outDir = join(work, 'out');
    const vite = join(ROOT, 'apps/web/node_modules/vite/bin/vite.js');
    await run(process.execPath, [vite, 'build', '--logLevel', 'warn', '--outDir', outDir, '--emptyOutDir'], { cwd: join(work, 'apps/web'), env: { ...process.env, NODE_ENV: 'production' }, maxBuffer: 16 * 1024 * 1024 });
    const assets = readdirSync(join(outDir, 'assets'));
    const chunk = assets.find((f) => /^qaa-.*\.js$/.test(f));
    expect(chunk, assets.join(', ')).toBeDefined();
    expect(assets.some((f) => /^fr-.*\.js$/.test(f))).toBe(true);
    // Le registre embarqué dans la console liste qaa dans le sélecteur (endonyme du registre).
    const bundle = assets.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(outDir, 'assets', f), 'utf8')).join('\n');
    expect(bundle).toContain('Essai local');
  }, 240_000);
});
