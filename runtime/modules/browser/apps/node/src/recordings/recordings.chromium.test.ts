// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
// Tâche 3.3 sur de vrais Chromium 153 et le site de fixture de 0.5. Enregistrements produits CÔTÉ NŒUD, quel que soit le
// client (recette étape 20, 04d D5 et D6, 04f F7) :
// - session shared, `recordings` tous actifs : trace ouverte par `playwright show-trace` (visionneuse servie et lue par un
//   Chromium), HAR valide, vidéo lisible (lue par un Chromium), journaux console et réseau présents ; aucun secret dans les
//   artefacts déchiffrés, objets illisibles sans la clé (`assert_secrets_protected`) ;
// - session dedicated pilotée par un client CDP tiers (WebSocket brut, sans Playwright côté client : Puppeteer n'est pas au
//   catalogue) : webm, HAR et console.ndjson produits, `recording.ready` par type (`assert_cdp_client_compat`, F7).
// Le proxy de lancement de ce test relaie vers le seul site de la fixture (l'egress de session est la tâche 1.5).
// Utilisateur non root exigé. Seul processus signalé par le test : la visionneuse show-trace qu'il lance (son ChildProcess).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DiskBlobStore, MasterKey, ObjectStore, secretValues } from '@sym-browser/core';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startSite, type SiteHandle } from '../../../../fixtures/src/site.ts';
import { dedicatedLauncher, sessionDir } from '../dedicated/index.js';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher, type BrowserPool as Pool } from '../pool/index.js';
import { SharedSessions } from '../sessions/index.js';
import { PageVideo, RecordingVault, SessionRecorder, connectRecordingContext, ffmpegPath, readZip, validateHar, type RecordingEvent, type RecordingInfo } from './index.js';

const SECRET = 'zz_test_recording_secret_8d1f2c';

async function startSiteOnlyProxy(siteOrigin: string): Promise<{ url: string; close(): Promise<void> }> {
  const site = new URL(siteOrigin);
  const server: Server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      return void res.writeHead(400).end();
    }
    if (target.host !== site.host || target.protocol !== 'http:') return void res.writeHead(403).end();
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = request({ host: site.hostname, port: site.port, method: req.method, path: `${target.pathname}${target.search}`, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let site: SiteHandle;
let siteUrl: string;
let proxy: Awaited<ReturnType<typeof startSiteOnlyProxy>>;
let pool: Pool;
let root: string;
let dataDir: string;
let store: ObjectStore;
let vault: RecordingVault;
let recorder: SessionRecorder;
const events: RecordingEvent[] = [];

beforeAll(async () => {
  if (process.getuid?.() === 0) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  // Secret de test inscrit au registre des valeurs connues du processus, comme le nœud inscrit ses vrais secrets (clés,
  // mots de passe de proxy) : couche 3 du masquage de 0.3, appliquée à chaque artefact.
  secretValues.add(SECRET);
  site = await startSite({ port: 0, host: '127.0.0.1' });
  siteUrl = `http://127.0.0.1:${site.port}`;
  proxy = await startSiteOnlyProxy(siteUrl);
  root = mkdtempSync(join(tmpdir(), 'symb-rec-chromium-'));
  dataDir = join(root, 'data');
  const groups = new OwnedProcessGroups();
  pool = new BrowserPool({
    slotsTotal: 4,
    warmBrowsers: 1,
    launch: playwrightLauncher({ launchProxyUrl: proxy.url, groups }),
    launchDedicated: dedicatedLauncher({ launchProxyUrl: proxy.url, groups, dataDir }),
    constants: PROVISIONAL_CAPACITY,
    sweep: () => groups.sweep(),
  });
  await pool.start();
  store = new ObjectStore({ blobs: new DiskBlobStore(join(root, 'objects')), master: MasterKey.generate(), kekVersion: 1 });
  vault = new RecordingVault({ store, onEvent: (e) => events.push(e) });
  recorder = new SessionRecorder({ vault, maxBytes: 200 * 1024 * 1024 });
});

afterAll(async () => {
  secretValues.delete(SECRET);
  await pool?.close();
  await proxy?.close();
  await site?.close();
});

async function readRecording(sessionId: string, info: RecordingInfo): Promise<Buffer> {
  const { stream } = await vault.open(sessionId, info.id);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** Vidéo lue par un Chromium : métadonnées chargées, dimensions et durée non nulles. */
async function playVideo(webm: Buffer): Promise<{ width: number; height: number; duration: number }> {
  const lease = await pool.acquire({ sessionId: `player-${Date.now()}`, type: 'shared', tenantId: 'player' });
  const context = await lease.browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('http://zz-player.invalid/**', (route) => (route.request().url().endsWith('.webm') ? route.fulfill({ status: 200, contentType: 'video/webm', body: webm }) : route.fulfill({ status: 200, contentType: 'text/html', body: '<video id="v" src="/v.webm" preload="auto" muted></video>' })));
    await page.goto('http://zz-player.invalid/');
    return await page.evaluate(
      () =>
        new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
          const video = document.getElementById('v') as HTMLVideoElement;
          const done = () => {
            // Durée d'un webm sans index : se résout en cherchant loin.
            if (video.duration === Infinity) {
              video.currentTime = 1e9;
              video.ontimeupdate = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
            } else resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
          };
          if (video.readyState >= 1) done();
          else video.onloadedmetadata = done;
          video.onerror = () => reject(new Error(`vidéo illisible : ${video.error?.message ?? video.error?.code}`));
        }),
    );
  } finally {
    await context.close();
    await lease.release();
  }
}

/** Trace ouverte par `playwright show-trace` (visionneuse servie en HTTP), puis lue par un Chromium. */
async function openWithShowTrace(traceZip: Buffer, expected: string): Promise<string> {
  const path = join(root, `trace-${Date.now()}.zip`);
  writeFileSync(path, traceZip);
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js');
  const viewer = spawn(process.execPath, [cli, 'show-trace', '--host', '127.0.0.1', '--port', '0', path], { env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  viewer.stdout.on('data', (d: Buffer) => (output += d.toString()));
  viewer.stderr.on('data', (d: Buffer) => (output += d.toString()));
  // Visionneuse sur 127.0.0.1 : ouverte par un Chromium propre au test, sans proxy (ceux du pool ne joignent que la fixture).
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    for (let i = 0; i < 100 && !/Listening on http:\/\/127\.0\.0\.1:\d+/.test(output); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const url = /http:\/\/127\.0\.0\.1:\d+\S*/.exec(output)?.[0];
    if (url === undefined) throw new Error(`show-trace n’a pas démarré : ${output}`);
    const page = await browser.newPage();
    await page.goto(url);
    // Liste des actions rendue : l'action attendue (navigation vers la fixture) y figure.
    await page.getByText(expected).first().waitFor({ timeout: 30_000 });
    return await page.locator('body').innerText();
  } finally {
    await browser.close();
    viewer.kill('SIGTERM');
  }
}

function assertNoSecret(name: string, data: Buffer): void {
  expect(data.includes(SECRET), `${name} contient le secret de test`).toBe(false);
}

describe('enregistrements côté nœud sur de vrais Chromium', () => {
  test('recette étape 20 (shared) : trace ouverte par show-trace, HAR valide, vidéo lisible, journaux présents ; assert_secrets_protected (D5, D6)', async () => {
    const sessions = new SharedSessions({ pool, recorder, dataDir });
    const session = await sessions.create({ sessionId: 'rec-shared', tenantId: 'tenant-a', options: { extraHTTPHeaders: { Authorization: `Bearer ${SECRET}` } }, recordings: { trace: true, har: true, video: true, console: true, network: true } });
    const page = await session.context.newPage();
    await page.goto(`${siteUrl}/static/about.html?token=${SECRET}`);
    await page.evaluate((s) => console.log(`console du test Bearer ${s}`), SECRET);
    await page.goto(`${siteUrl}/`);
    await page.mouse.move(100, 100);
    await page.waitForTimeout(2_000);
    await session.release();

    const recordings = await vault.list('rec-shared');
    expect(recordings.map((r) => r.type).sort()).toEqual(['console', 'har', 'network', 'trace', 'video']);
    for (const r of recordings) expect(events).toContainEqual({ type: 'recording.ready', sessionId: 'rec-shared', recordingId: r.id, recordingType: r.type, size: r.size, expiresAt: r.expiresAt.toISOString() });

    const byType = Object.fromEntries(await Promise.all(recordings.map(async (r) => [r.type, await readRecording('rec-shared', r)] as const)));
    // HAR valide, avec les requêtes vers la fixture.
    const har = JSON.parse(byType.har!.toString()) as { log: { entries: { request: { url: string } }[] } };
    expect(validateHar(har)).toEqual([]);
    expect(har.log.entries.some((e) => e.request.url.startsWith(`${siteUrl}/static/about.html`))).toBe(true);
    // Journaux présents.
    expect(byType.console!.toString()).toContain('console du test');
    expect(byType.network!.toString()).toContain(`${siteUrl}/static/about.html"`);
    // Vidéo lisible.
    const video = await playVideo(byType.video!);
    expect(video.width).toBe(1280);
    expect(video.height).toBe(720);
    expect(video.duration).toBeGreaterThan(1);
    // Trace ouverte par show-trace : la visionneuse affiche la page de la fixture et ses requêtes.
    expect([...readZip(byType.trace!).keys()]).toEqual(expect.arrayContaining(['trace.trace', 'trace.network']));
    const viewer = await openWithShowTrace(byType.trace!, 'about.html');
    expect(viewer).toContain('about.html');

    // assert_secrets_protected : aucun secret dans les artefacts déchiffrés (trace décompressée comprise)…
    for (const [type, data] of Object.entries(byType)) {
      if (type === 'trace') for (const [name, entry] of readZip(data)) if (!name.startsWith('resources/')) assertNoSecret(`trace/${name}`, entry);
      if (type !== 'trace' && type !== 'video') assertNoSecret(type, data);
    }
    // … objets illisibles sans la clé ; aucun fichier laissé sur le disque du nœud.
    for (const object of await store.list('artifacts/')) {
      const raw = readFileSync(join(root, 'objects', ...object.key.split('/')));
      expect(raw.includes(Buffer.from('trace.network'))).toBe(false);
      expect(raw.includes(Buffer.from('"entries"'))).toBe(false);
    }
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);
  });

  test('Chromium chargé : aucune image de screencast avant la fin → vidéo produite quand même, lisible, de la durée de la page', async () => {
    const lease = await pool.acquire({ sessionId: 'rec-noframe', type: 'shared', tenantId: 'tenant-c' });
    const context = await lease.browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${siteUrl}/static/about.html`);
      // Chromium qui ne rend plus (CI chargée) : la session CDP du nœud ne reçoit jamais `Page.screencastFrame`.
      const silent = {
        newCDPSession: async (target: typeof page) => {
          const cdp = await context.newCDPSession(target);
          return new Proxy(cdp, { get: (obj, key) => (key === 'on' ? (event: string, listener: never) => (event === 'Page.screencastFrame' ? obj : obj.on(event as never, listener)) : Reflect.get(obj, key, obj)) });
        },
      } as unknown as typeof context;
      const video = await PageVideo.start(silent, page, { path: join(root, 'noframe.webm'), ffmpeg: ffmpegPath(), maxBytes: 10 * 1024 * 1024 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await video.stop();
      expect(video.frames).toBeGreaterThan(0);
      const played = await playVideo(readFileSync(video.path));
      expect(played.width).toBe(1280);
      expect(played.duration).toBeGreaterThan(1);
    } finally {
      await context.close();
      await lease.release();
    }
  });

  test('assert_cdp_client_compat (F7) : session dedicated pilotée par un client CDP tiers → webm, HAR et console.ndjson produits côté nœud, recording.ready par type', async () => {
    const lease = await pool.acquire({ sessionId: 'rec-cdp', type: 'dedicated', tenantId: 'tenant-b' });
    const connection = await connectRecordingContext(lease.cdpEndpoint!);
    const active = await recorder.start({ sessionId: 'rec-cdp', tenantId: 'tenant-b', context: connection.context, workDir: join(sessionDir(dataDir, 'rec-cdp').root, 'recordings'), options: { video: true, har: true, console: true } });

    // Client CDP tiers : WebSocket brut, cible créée, session attachée à plat, navigation et console.
    const ws = new WebSocket(lease.cdpEndpoint!);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map<number, (result: Record<string, unknown>) => void>();
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as { id?: number; result?: Record<string, unknown> };
      if (data.id !== undefined) pending.get(data.id)?.(data.result ?? {});
    };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId as string);
    await send('Page.navigate', { url: `${siteUrl}/static/about.html` }, sessionId as string);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await send('Runtime.evaluate', { expression: 'console.log("console du client CDP")' }, sessionId as string);
    await send('Page.navigate', { url: `${siteUrl}/` }, sessionId as string);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ws.close();

    // Fin de session (DELETE) : enregistrements arrêtés et déposés AVANT la destruction du Chromium.
    const produced = await active.stop();
    await connection.close();
    await lease.release();

    // Une vidéo par page : l'onglet initial du Chromium dédié et la page du client.
    expect([...new Set(produced.map((r) => r.type))].sort()).toEqual(['console', 'har', 'video']);
    for (const r of produced) expect(events).toContainEqual(expect.objectContaining({ type: 'recording.ready', sessionId: 'rec-cdp', recordingId: r.id, recordingType: r.type }));
    const get = (type: string) => readRecording('rec-cdp', produced.find((r) => r.type === type)!);
    const har = JSON.parse((await get('har')).toString()) as { log: { entries: { request: { url: string } }[] } };
    expect(validateHar(har)).toEqual([]);
    expect(har.log.entries.some((e) => e.request.url === `${siteUrl}/static/about.html`)).toBe(true);
    expect((await get('console')).toString()).toContain('console du client CDP');
    const durations: number[] = [];
    for (const r of produced.filter((p) => p.type === 'video')) durations.push((await playVideo(await readRecording('rec-cdp', r))).duration);
    expect(Math.max(...durations)).toBeGreaterThan(1);
  });
});
