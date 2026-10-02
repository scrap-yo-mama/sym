// SPDX-License-Identifier: AGPL-3.0-only
// SDK TypeScript (tâche 3.4) de bout en bout contre une instance en mode `all` (tests/helpers/all-mode.ts : PostgreSQL,
// passerelle REST et WSS, nœud, vrais Chromium 153, egress par session, site de test de la tâche 0.5).
//   sdk_readme_example (A13, recette étape 4) : l'exemple du README du SDK, extrait tel quel, est exécuté par Node dans un
//     process enfant ; il crée une session shared, lit le titre de la page de la fixture, libère (`await using`) ; il se
//     termine sans erreur, la session est `ended` raison `released`, plus aucun Chromium n'est tenu par le pool.
//   assert_cdp_client_compat (BINV8, volet SDK de 3.4) : session `dedicated` par défaut, `connectCDP()` (Playwright
//     connectOverCDP sur `connectUrls.cdp`) et `connect()` natif lisent la fixture au travers des relais, puis libération.
// Prérequis : Docker, utilisateur non root, `playwright install chromium`. Sécurité : l'enfant Node est arrêté par son objet
// ChildProcess s'il dépasse son délai ; les Chromium par le pool (groupes de processus enregistrés), jamais par pid tiers.
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SymBrowser } from '../packages/sdk/src/index.ts';
import { ensureSdkBuilt, SDK_DIR } from '../packages/sdk/src/testing/build.ts';
import { readmeExample } from '../packages/sdk/src/testing/readme.ts';
import { SITE_HOST, startAllMode, type AllModeInstance } from './helpers/all-mode.ts';

let instance: AllModeInstance;
// Dossier dans le paquet du SDK : l'exemple y importe `@sym-browser/sdk` par auto-référence du paquet (dist compilé).
const RUN_DIR = join(SDK_DIR, '.readme-run');

beforeAll(async () => {
  ensureSdkBuilt();
  instance = await startAllMode();
}, 240_000);

afterAll(async () => {
  await rm(RUN_DIR, { recursive: true, force: true });
  await instance?.close();
}, 120_000);

async function waitFor(check: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return check();
}

function runNode(file: string, env: Record<string, string>, ms = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: RUN_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('SDK contre le mode all (vrais Chromium)', () => {
  test('sdk_readme_example : l’exemple du README crée une session, lit le titre de la fixture, libère ; session ended', async () => {
    await mkdir(RUN_DIR, { recursive: true });
    const file = join(RUN_DIR, 'example.mjs');
    await writeFile(file, readmeExample());
    const run = await runNode(file, { SYMB_URL: instance.url, SYMB_API_KEY: instance.apiKey, SYMB_DEMO_URL: instance.siteUrl });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('SYM Browser fixtures');
    expect(run.stdout).toContain('ended released');
    expect(run.stdout).not.toContain(instance.apiKey);

    const { rows } = await instance.db.query<{ state: string; end_reason: string; type: string }>("SELECT state, end_reason, type FROM sessions WHERE metadata->>'job' = 'demo'");
    expect(rows).toEqual([{ state: 'ended', end_reason: 'released', type: 'shared' }]);
    expect(await waitFor(() => instance.liveBrowsers() === 0)).toBe(true);
  }, 180_000);

  test('assert_cdp_client_compat (SDK) : dedicated par défaut, connectCDP puis connect natif lisent la fixture ; libération', async () => {
    const symb = new SymBrowser({ url: instance.url, apiKey: instance.apiKey, releaseOnExit: false });
    const port = Number(new URL(instance.siteUrl).port);
    let id = '';
    {
      await using session = await symb.sessions.create({ egress: { allowedHosts: [SITE_HOST], ports: [port] }, metadata: { job: 'cdp' } });
      id = session.id;
      expect(session.type).toBe('dedicated');
      expect(session.connectUrls?.cdp).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v1\/sessions\/.+\/cdp\?token=symbt_/);

      const cdp = await symb.connectCDP(session);
      const page = await cdp.contexts()[0]!.newPage();
      await page.goto(instance.siteUrl);
      expect(await page.title()).toBe('SYM Browser fixtures');
      await page.close();

      const native = await symb.connect(id);
      expect(native.version()).toMatch(/^153\./);
      const nativePage = await native.contexts()[0]!.newPage();
      await nativePage.goto(`${instance.siteUrl}static/about.html`);
      expect(await nativePage.title()).toBe('À propos');
      expect((await symb.sessions.get(id)).state).toBe('running');
    }
    const ended = await symb.sessions.get(id);
    expect([ended.state, ended.endReason]).toEqual(['ended', 'released']);
    expect(await waitFor(() => instance.liveBrowsers() === 0)).toBe(true);
    await symb.close();
  }, 180_000);

  test('aucune erreur interne journalisée par la passerelle ni par le nœud', () => {
    expect(instance.errors.map(String)).toEqual([]);
  });
});
