// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.1 sur de vrais Chromium 153 (recette, étape 13 ; 04c § 4, critères C10 et C11) : connexion à la fixture conservée
// d'une session à l'autre (`mode: 'write'`), 2e écriture simultanée → 409 `profile_locked`, lecture seule en parallèle dont
// les changements disparaissent, plantage sans sauvegarde, import et export `storageState`, objet de profil illisible sans
// la clé maîtresse. Parties 3.1 de assert_session_isolation (C10) et de assert_secrets_protected (C11).
// La fixture « connexion » est servie par interception (`route`) : le proxy de lancement fermé coupe tout réseau réel.
// Sécurité des tests : seul le processus principal d'un Chromium lancé ici est signalé, par son pid exact (plantage simulé) ;
// les groupes sont tués par OwnedProcessGroups, qui refuse tout groupe non enregistré, 0, 1 et le sien.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskBlobStore, MasterKey, MemoryProfileRegistry, ObjectStore, ProfileLockedError, ProfileStore, SecretDecryptError, type ProfileEvent } from '@sym-browser/core';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dedicatedLauncher } from '../dedicated/dedicated.js';
import { startClosedLaunchProxy, type ClosedLaunchProxy } from '../pool/closed-proxy.js';
import { playwrightLauncher } from '../pool/launch.js';
import { BrowserPool, type BrowserLauncher, type LaunchedBrowser, type PoolLease } from '../pool/pool.js';
import { OwnedProcessGroups, readProcessTable } from '../pool/process-group.js';
import { exportStorageState, importStorageState } from './storage-state.js';

const isRoot = process.getuid?.() === 0;
let proxy: ClosedLaunchProxy;
const roots: string[] = [];

beforeAll(async () => {
  if (isRoot) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  proxy = await startClosedLaunchProxy();
});
afterAll(async () => {
  await proxy?.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const SID = 'zz_test_session_31';
const FIXTURE = 'https://fixture.test';

function setup() {
  const groups = new OwnedProcessGroups();
  const dataDir = tmp('symb-data-');
  const objectsDir = tmp('symb-objects-');
  const master = MasterKey.generate();
  const objects = new ObjectStore({ blobs: new DiskBlobStore(objectsDir), master, kekVersion: 1 });
  const ended = new Set<string>();
  const registry = new MemoryProfileRegistry({ sessionEnded: (id) => ended.has(id) });
  const events: ProfileEvent[] = [];
  const profiles = new ProfileStore({ objects, registry, maxBytes: 100 * 1024 * 1024, onEvent: (e) => events.push(e) });
  const launched = new Map<string, LaunchedBrowser>();
  const base = dedicatedLauncher({ launchProxyUrl: proxy.url, groups, dataDir, profiles });
  const launchDedicated: BrowserLauncher = async (purpose) => {
    const browser = await base(purpose);
    launched.set(purpose.sessionId!, browser);
    return browser;
  };
  const pool = new BrowserPool({
    slotsTotal: 6,
    warmBrowsers: 0,
    launch: playwrightLauncher({ launchProxyUrl: proxy.url, groups }),
    launchDedicated,
    sweep: () => groups.sweep(),
    sweepIntervalMs: 0,
    closeTimeoutMs: 30_000,
  });
  return { pool, launched, dataDir, objectsDir, master, objects, registry, profiles, events };
}

const tenantId = randomUUID();

/** Client CDP de la session, fixture « connexion » branchée par interception sur le contexte par défaut. */
async function client(lease: PoolLease): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.connectOverCDP(lease.cdpEndpoint!);
  const context = browser.contexts()[0]!;
  await context.route(`${FIXTURE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/login') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'set-cookie': `sid=${SID}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400` },
        body: `<script>localStorage.setItem('zz_test_ls', 'connecté')</script><p id="s">login</p>`,
      });
      return;
    }
    if (url.pathname === '/logout') {
      await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'set-cookie': 'sid=; Path=/; Secure; Max-Age=0' }, body: `<script>localStorage.clear()</script><p id="s">logout</p>` });
      return;
    }
    const cookie = (await route.request().allHeaders())['cookie'] ?? '';
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<p id="s">${cookie.includes(`sid=${SID}`) ? 'connecté' : 'anonyme'}</p>` });
  });
  return { browser, context };
}

async function status(context: BrowserContext): Promise<{ me: string | null; ls: string | null }> {
  const page = await context.newPage();
  await page.goto(`${FIXTURE}/me`);
  const me = await page.textContent('#s');
  const ls = await page.evaluate(() => localStorage.getItem('zz_test_ls'));
  await page.close();
  return { me, ls };
}

async function visit(context: BrowserContext, path: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${FIXTURE}${path}`);
  await page.close();
}

const alive = (pid: number) => readProcessTable().some((p) => p.pid === pid && p.state !== 'Z');

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('profils persistants sur de vrais Chromium (tâche 3.1, recette étape 13)', () => {
  test('assert_session_isolation (3.1, C10) : toujours connecté après une nouvelle session ; 2e écriture → 409 profile_locked ; lecture seule en parallèle, ses changements disparaissent', async () => {
    const { pool, launched, dataDir, registry } = setup();
    const profileId = registry.create(tenantId, 'fixture');
    const profile = (mode: 'read' | 'write') => ({ tenantId, profileId, mode });

    // Session 1 (écriture) : connexion à la fixture, puis fin normale → v1.
    const s1 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: profile('write') });
    const c1 = await client(s1);
    expect(await status(c1.context)).toEqual({ me: 'anonyme', ls: null });
    await visit(c1.context, '/login');
    expect(await status(c1.context)).toEqual({ me: 'connecté', ls: 'connecté' });
    await s1.release();
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 1, lockSessionId: null });

    // Session 2 (écriture), nouvelle session sur le même profil : toujours connectée, sans nouvelle authentification.
    const s2id = randomUUID();
    const s2 = await pool.acquire({ sessionId: s2id, type: 'dedicated', tenantId, profile: profile('write') });
    const c2 = await client(s2);
    expect(await status(c2.context)).toEqual({ me: 'connecté', ls: 'connecté' });

    // 2e écriture simultanée : 409 profile_locked, avant tout lancement de Chromium, slot rendu, aucun répertoire laissé.
    const before = launched.size;
    const freeBefore = pool.stats().slotsFree;
    const s3id = randomUUID();
    const locked = await pool.acquire({ sessionId: s3id, type: 'dedicated', tenantId, profile: profile('write') }).catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(ProfileLockedError);
    expect(locked).toMatchObject({ status: 409, code: 'profile_locked', lockedBySession: s2id });
    expect(launched.size).toBe(before);
    expect(existsSync(join(dataDir, 'sessions', s3id))).toBe(false);
    expect(pool.stats().slotsFree).toBe(freeBefore);

    // Lecture seule en parallèle : état restauré ; elle se déconnecte, mais ses changements disparaissent à sa fin.
    const r1 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: profile('read') });
    const r2 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: profile('read') });
    const cr1 = await client(r1);
    const cr2 = await client(r2);
    expect(await status(cr1.context)).toEqual({ me: 'connecté', ls: 'connecté' });
    expect(await status(cr2.context)).toEqual({ me: 'connecté', ls: 'connecté' });
    await visit(cr1.context, '/logout');
    expect(await status(cr1.context)).toEqual({ me: 'anonyme', ls: null });
    await r1.release();
    await r2.release();
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 1, lockSessionId: s2id });

    // La session 2 se termine : v2, verrou libéré ; une lecture suivante est toujours connectée.
    await s2.release();
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 2, lockSessionId: null });
    const r3 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: profile('read') });
    expect(await status((await client(r3)).context)).toEqual({ me: 'connecté', ls: 'connecté' });
    await r3.release();

    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
    await pool.close();
  });

  test('plantage d’une session en écriture : aucune sauvegarde, la dernière version valide reste, verrou libéré', async () => {
    const { pool, launched, registry } = setup();
    const profileId = registry.create(tenantId, 'plantage');
    const write = { tenantId, profileId, mode: 'write' as const };
    const s1 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: write });
    await visit((await client(s1)).context, '/login');
    await s1.release();

    const crashId = randomUUID();
    const s2 = await pool.acquire({ sessionId: crashId, type: 'dedicated', tenantId, profile: write });
    await visit((await client(s2)).context, '/logout');
    const pid = launched.get(crashId)!.pid!;
    process.kill(pid, 'SIGKILL'); // pid exact du Chromium lancé par ce test
    await waitFor(() => s2.signal.aborted && !alive(pid));
    await waitFor(() => registry.peek(tenantId, profileId)?.lockSessionId === null);
    expect(await registry.get(tenantId, profileId)).toMatchObject({ version: 1, lockSessionId: null });

    const r = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: { ...write, mode: 'read' } });
    expect(await status((await client(r)).context)).toEqual({ me: 'connecté', ls: 'connecté' });
    await r.release();
    await pool.close();
  });

  test('storageState : import dans un profil en écriture (sauvegardé à la fin), export depuis une session en cours', async () => {
    const { pool, registry } = setup();
    const profileId = registry.create(tenantId, 'import');
    const state = {
      cookies: [{ name: 'sid', value: SID, domain: 'fixture.test', path: '/', expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
      origins: [{ origin: FIXTURE, localStorage: [{ name: 'zz_test_ls', value: 'connecté' }] }],
    };
    const s1 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: { tenantId, profileId, mode: 'write' } });
    await importStorageState(s1, state);
    await s1.release();

    const s2 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: { tenantId, profileId, mode: 'read' } });
    expect(await status((await client(s2)).context)).toEqual({ me: 'connecté', ls: 'connecté' });
    const exported = await exportStorageState(s2);
    expect(exported.cookies).toEqual([expect.objectContaining({ name: 'sid', value: SID, domain: 'fixture.test', httpOnly: true, secure: true })]);
    expect(exported.origins).toEqual([{ origin: FIXTURE, localStorage: [{ name: 'zz_test_ls', value: 'connecté' }] }]);
    await s2.release();
    await pool.close();
  });

  test('assert_secrets_protected (3.1, C11) : objet du profil chiffré au repos, illisible sans la MASTER_KEY', async () => {
    const { pool, registry, objectsDir, master } = setup();
    const profileId = registry.create(tenantId, 'secret');
    const s1 = await pool.acquire({ sessionId: randomUUID(), type: 'dedicated', tenantId, profile: { tenantId, profileId, mode: 'write' } });
    await visit((await client(s1)).context, '/login');
    await s1.release();

    const stored = walk(objectsDir);
    expect(stored).toHaveLength(1);
    const raw = readFileSync(stored[0]!);
    for (const clear of [SID, 'zz_test_ls', 'SQLite format 3', 'Cookies']) expect(raw.includes(Buffer.from(clear)), clear).toBe(false);

    const row = (await registry.get(tenantId, profileId))!;
    const withKey = new ObjectStore({ blobs: new DiskBlobStore(objectsDir), master, kekVersion: 1 });
    expect((await withKey.getBuffer(row.objectKey!)).length).toBeGreaterThan(0);
    const withoutKey = new ObjectStore({ blobs: new DiskBlobStore(objectsDir), master: MasterKey.generate(), kekVersion: 1 });
    await expect(withoutKey.getBuffer(row.objectKey!)).rejects.toBeInstanceOf(SecretDecryptError);
    const other = new ProfileStore({ objects: withoutKey, registry, maxBytes: 100 * 1024 * 1024 });
    await expect(other.restore({ tenantId, profileId, mode: 'read', sessionId: randomUUID() }, tmp('symb-restore-'))).rejects.toBeInstanceOf(SecretDecryptError);
    await pool.close();
  });
});
