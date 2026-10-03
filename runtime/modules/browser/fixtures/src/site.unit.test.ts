// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DOWNLOAD_BYTES, HEAVY_BYTES, LOGIN } from './config.ts';
import { startSite, type SiteHandle } from './site.ts';

let site: SiteHandle;
let base: string;
beforeAll(async () => {
  site = await startSite({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${site.port}`;
});
afterAll(async () => {
  await site.close();
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('site de test : pages', () => {
  test('pages statiques : index, sous-page, feuille de style, robots', async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>SYM Browser fixtures</title>');
    expect(await (await fetch(`${base}/static/about.html`)).text()).toContain('<h1>À propos</h1>');
    expect((await fetch(`${base}/static/style.css`)).headers.get('content-type')).toContain('text/css');
    expect(await (await fetch(`${base}/robots.txt`)).text()).toContain('User-agent');
    expect((await fetch(`${base}/static/absent.html`)).status).toBe(404);
  });

  test('SPA : toute route /spa/* renvoie la coquille, les données viennent de /spa/api', async () => {
    const shell = await fetch(`${base}/spa/items/7`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<title>SYM SPA fixture</title>');
    const items = (await (await fetch(`${base}/spa/api/items`)).json()) as { id: number; title: string }[];
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(items[6]).toEqual({ id: 7, title: 'Article 7' });
  });

  test('connexion : mauvais mot de passe 401, bon mot de passe cookie HttpOnly, /account protégé, déconnexion', async () => {
    expect((await fetch(`${base}/account`, { redirect: 'manual' })).status).toBe(302);
    const form = (user: string, pw: string): RequestInit => ({
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: user, password: pw }).toString(),
    });
    expect((await fetch(`${base}/login`, form(LOGIN.username, 'faux'))).status).toBe(401);
    const ok = await fetch(`${base}/login`, form(LOGIN.username, LOGIN.password));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/account');
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^zz_test_session=[0-9a-f]{32}; /);
    expect(cookie).toContain('HttpOnly');
    const pair = cookie.split(';')[0] ?? '';
    const account = await fetch(`${base}/account`, { headers: { cookie: pair } });
    expect(await account.text()).toContain(`Connecté : ${LOGIN.username}`);
    await fetch(`${base}/logout`, { redirect: 'manual', headers: { cookie: pair } });
    expect((await fetch(`${base}/account`, { redirect: 'manual', headers: { cookie: pair } })).status).toBe(302);
  });

  test('téléchargement : octets déterministes, sha256 annoncé et recalculable', async () => {
    const res = await fetch(`${base}/download/sample.bin`);
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="sample.bin"');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(DOWNLOAD_BYTES);
    expect(res.headers.get('x-content-sha256')).toBe(sha256(body));
    const manifest = (await (await fetch(`${base}/download/manifest.json`)).json()) as Record<string, { bytes: number; sha256: string }>;
    expect(manifest['sample.bin']).toEqual({ bytes: DOWNLOAD_BYTES, sha256: sha256(body) });
  });

  test('envoi : multipart relu par la page (nom, taille, sha256) et par /upload/files', async () => {
    const content = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    const data = new FormData();
    data.append('note', 'zz_test_note');
    data.append('file', new Blob([content], { type: 'application/octet-stream' }), 'zz_test_envoi.bin');
    const res = await fetch(`${base}/upload`, { method: 'POST', body: data });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('zz_test_envoi.bin');
    expect(html).toContain(sha256(content));
    const last = (await (await fetch(`${base}/upload/last`)).json()) as { name: string; bytes: number; sha256: string; note: string };
    expect(last).toEqual({ name: 'zz_test_envoi.bin', bytes: 70_000, sha256: sha256(content), note: 'zz_test_note' });
    const back = new Uint8Array(await (await fetch(`${base}/upload/files/zz_test_envoi.bin`)).arrayBuffer());
    expect(sha256(back)).toBe(sha256(content));
  });

  test('WebSocket : message de bienvenue, écho, gros message, fermeture', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${site.port}/ws`);
    const inbox: string[] = [];
    socket.addEventListener('message', (event) => inbox.push(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('ws error')));
    });
    const waitFor = async (count: number): Promise<void> => {
      for (let i = 0; i < 100 && inbox.length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(inbox.length).toBeGreaterThanOrEqual(count);
    };
    await waitFor(1);
    expect(inbox[0]).toBe('hello');
    socket.send('bonjour');
    await waitFor(2);
    expect(inbox[1]).toBe('echo:bonjour');
    const big = 'x'.repeat(70_000);
    socket.send(big);
    await waitFor(3);
    expect(inbox[2]).toBe(`echo:${big}`);
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
    socket.close(1000);
    await closed;
    expect(await (await fetch(`${base}/ws-page`)).text()).toContain('new WebSocket');
  });

  test('page lourde : 5 Mo exactement, non mis en cache, taille réglable', async () => {
    const page = await (await fetch(`${base}/heavy`)).text();
    expect(page).toContain('/heavy/payload.js');
    const res = await fetch(`${base}/heavy/payload.js`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.arrayBuffer()).byteLength).toBe(HEAVY_BYTES);
    expect((await (await fetch(`${base}/heavy/payload.js?bytes=1000`)).arrayBuffer()).byteLength).toBe(1000);
  });
});

describe('site de test : journal des IP sources', () => {
  test('/__ip renvoie l’IP vue ; chaque requête est journalisée puis le journal se remet à zéro', async () => {
    await fetch(`${base}/__reset`, { method: 'POST' });
    const seen = (await (await fetch(`${base}/__ip`)).json()) as { ip: string };
    expect(seen.ip).toBe('127.0.0.1');
    await fetch(`${base}/static/about.html`);
    const journal = (await (await fetch(`${base}/__ips`)).json()) as { ip: string; method: string; path: string }[];
    expect(journal.find((e) => e.path === '/static/about.html')).toMatchObject({ ip: '127.0.0.1', method: 'GET' });
    expect(site.journal.entries().length).toBeGreaterThanOrEqual(journal.length);
    await fetch(`${base}/__reset`, { method: 'POST' });
    expect(((await (await fetch(`${base}/__ips`)).json()) as unknown[]).length).toBe(0);
  });
});
