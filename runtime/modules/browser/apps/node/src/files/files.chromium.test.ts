// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
// Tâche 1.8 sur de vrais Chromium 153 et la fixture de 0.5 (site local : /download/sample.bin, /upload) :
// - session_download_sha256 (C12) : fichier téléchargé sur la fixture, récupéré par l'API fichiers à l'octet près (sha256),
//   en session shared (Playwright natif) et dedicated (client CDP) ;
// - session_upload_read_back (C13) : envoi déposé par le nœud, posé par `DOM.setFileInputFiles` d'un client CDP, relu par
//   la page (FileReader) puis par la fixture après l'envoi du formulaire ;
// - assert_session_teardown (partie 1.8) : envois supprimés à la destruction, téléchargements encore listés jusqu'à expiresAt.
// Le proxy de lancement de ce test relaie vers le seul site de la fixture (l'egress de session est la tâche 1.5) : toute
// autre destination, et tout CONNECT, reçoit 403. Utilisateur non root exigé.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskBlobStore, MasterKey, ObjectStore } from '@sym-browser/core';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startSite, type SiteHandle } from '../../../../fixtures/src/site.ts';
import { dedicatedLauncher, sessionDir } from '../dedicated/index.js';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher } from '../pool/index.js';
import { SharedSessions } from '../sessions/index.js';
import { SessionFiles, attachBrowserFiles } from './index.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Proxy de lancement de test : relais HTTP (forme absolue) vers le seul site de la fixture. */
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
let pool: BrowserPool;
let files: SessionFiles;
let sessions: SharedSessions;
let dataDir: string;
let expected: Buffer;

beforeAll(async () => {
  if (process.getuid?.() === 0) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  site = await startSite({ port: 0, host: '127.0.0.1' });
  siteUrl = `http://127.0.0.1:${site.port}`;
  expected = Buffer.from(await (await fetch(`${siteUrl}/download/sample.bin`)).arrayBuffer());
  proxy = await startSiteOnlyProxy(siteUrl);
  const root = mkdtempSync(join(tmpdir(), 'symb-files-chromium-'));
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
  const store = new ObjectStore({ blobs: new DiskBlobStore(join(root, 'objects')), master: MasterKey.generate(), kekVersion: 1 });
  files = new SessionFiles({ store, limits: { downloadMaxBytes: 50 * 1024 * 1024, sessionDownloadMaxBytes: 100 * 1024 * 1024, uploadMaxBytes: 10 * 1024 * 1024 } });
  sessions = new SharedSessions({ pool, files, dataDir });
});

afterAll(async () => {
  await pool?.close();
  await proxy?.close();
  await site?.close();
});

async function waitForFiles(sessionId: string, count: number) {
  for (let i = 0; i < 200; i += 1) {
    await files.whenIdle();
    const listed = await files.list(sessionId);
    if (listed.length >= count) return listed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`aucun fichier capté pour ${sessionId}`);
}

async function fetchFile(sessionId: string, fileId: string): Promise<Buffer> {
  const { stream } = await files.open(sessionId, fileId);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe('fichiers des sessions sur de vrais Chromium', () => {
  test('session_download_sha256 (C12, shared) : téléchargé sur la fixture, récupéré à l’octet près ; encore listé après la fin (assert_session_teardown)', async () => {
    expect(expected.length).toBeGreaterThan(1000);
    const session = await sessions.create({ sessionId: 'dl-shared', tenantId: 'tenant-a', options: { acceptDownloads: true } });
    const dir = sessionDir(dataDir, 'dl-shared');
    expect(existsSync(dir.downloads)).toBe(true);
    const page = await session.context.newPage();
    await page.goto(`${siteUrl}/`);
    await page.click('a[href="/download/sample.bin"]');
    const [file] = await waitForFiles('dl-shared', 1);
    expect(file).toMatchObject({ name: 'sample.bin', size: expected.length, sha256: sha(expected) });
    expect(sha(await fetchFile('dl-shared', file!.id))).toBe(sha(expected));
    await session.release();
    // Destruction : répertoire de session supprimé ; le fichier reste listé et récupérable jusqu'à expiresAt.
    expect(existsSync(dir.root)).toBe(false);
    expect((await files.list('dl-shared')).map((f) => f.id)).toEqual([file!.id]);
    expect(sha(await fetchFile('dl-shared', file!.id))).toBe(sha(expected));
  });

  test('session sans acceptDownloads : rien n’est capté', async () => {
    const session = await sessions.create({ sessionId: 'dl-denied', tenantId: 'tenant-a', options: {} });
    const page = await session.context.newPage();
    await page.goto(`${siteUrl}/`);
    await page.click('a[href="/download/sample.bin"]');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await files.whenIdle();
    expect(await files.list('dl-denied')).toEqual([]);
    await session.release();
  });

  test('session_upload_read_back (C13, dedicated, client CDP) et session_download_sha256 en CDP ; envoi supprimé à la destruction (assert_session_teardown)', async () => {
    const lease = await pool.acquire({ sessionId: 'up-dedicated', type: 'dedicated', tenantId: 'tenant-b' });
    const dir = sessionDir(dataDir, 'up-dedicated');
    const attached = await attachBrowserFiles(files, { sessionId: 'up-dedicated', tenantId: 'tenant-b', dir, acceptDownloads: true, browser: lease.browser, context: lease.browser.contexts()[0]! });
    const content = Buffer.from(`envoi de test ${'z'.repeat(5_000)}`);
    const upload = await files.upload({ sessionId: 'up-dedicated', dir, body: [content], name: 'envoi.txt' });
    expect(upload).toMatchObject({ size: content.length, sha256: sha(content) });

    const client = await chromium.connectOverCDP(lease.cdpEndpoint!);
    try {
      const page = client.contexts()[0]!.pages()[0] ?? (await client.contexts()[0]!.newPage());
      await page.goto(`${siteUrl}/upload`);
      const cdp = await page.context().newCDPSession(page);
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [upload.path] });
      const readBack = await page.evaluate(async () => {
        const file = (document.querySelector('input[type=file]') as HTMLInputElement).files![0]!;
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        return { size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
      });
      expect(readBack).toEqual({ size: content.length, sha256: sha(content) });
      await page.click('button[type=submit]');
      await page.waitForSelector('#sha256');
      expect(await page.textContent('#sha256')).toBe(sha(content));

      await page.goto(`${siteUrl}/`);
      await page.click('a[href="/download/sample.bin"]');
      const [file] = await waitForFiles('up-dedicated', 1);
      expect(sha(await fetchFile('up-dedicated', file!.id))).toBe(sha(expected));
    } finally {
      await client.close().catch(() => undefined);
    }
    await attached.detach();
    await lease.release();
    expect(existsSync(upload.path)).toBe(false);
    expect(existsSync(dir.root)).toBe(false);
    expect((await files.list('up-dedicated')).length).toBe(1);
  });
});
