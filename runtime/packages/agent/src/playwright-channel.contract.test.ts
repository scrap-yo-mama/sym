// SPDX-License-Identifier: AGPL-3.0-only
// Canal agent_step côté serveur sur un vrai Chromium (Playwright 1.63) et les fixtures du spike : stale_ref sans
// exécution, verrou de domaines (tentatives comptées même bloquées), refus des écritures. Aucun LLM.
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../../fixtures/src/server.ts';
import { installDomainGuard, newAgentContext, PlaywrightStepChannel, type DomainGuard } from './playwright-channel.js';
import { hostOf } from './snapshot.js';

const E5 = 'zz_test_agent_mobile_next.localhost';
const INJ = 'zz_test_agent_prompt_injection.localhost';
const TRAP = 'zz_test_evil.localhost';
const hasChromium = existsSync(chromium.executablePath());

let fx: FixtureServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let guard: DomainGuard;

const stats = async (): Promise<{ hosts: Record<string, { total: number; paths: Record<string, number> }> }> =>
  (await fetch(`http://127.0.0.1:${fx.port}/__stats`)).json() as Promise<{ hosts: Record<string, { total: number; paths: Record<string, number> }> }>;

describe.skipIf(!hasChromium)('PlaywrightStepChannel (contrat agent_step, 07 §3)', () => {
  beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 });
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 60_000);
  // Fermeture de Chromium sous charge (autre suite lourde sur la machine) : même délai que le lancement.
  afterAll(async () => {
    await browser?.close();
    await fx?.close();
  }, 60_000);
  beforeEach(async () => {
    await fetch(`http://127.0.0.1:${fx.port}/__reset`, { method: 'POST' });
    await context?.close();
    context = await browser.newContext();
    guard = await installDomainGuard(context, { allowedHosts: [E5, INJ], allowWriteActions: false });
    page = await context.newPage();
  });

  it('pagination par interaction : le clic sur « Suivant » vise un ref de l\'instantané courant', async () => {
    const channel = new PlaywrightStepChannel({ page, allowedHosts: [E5] });
    const opened = await channel.execute({ kind: 'navigate', url: `http://${E5}:${fx.port}/` });
    expect(opened.ok).toBe(true);
    const snap = await channel.snapshot();
    expect(snap.snapshotId).toMatch(/^s\d+-[0-9a-f]{6}$/);
    expect(snap.accessibilityTree).toContain('Page 1 / 3');
    const ref = /button "Suivant" [^\n]*?\[ref=(\w+)\]|button "Suivant" \[ref=(\w+)\]/.exec(snap.accessibilityTree);
    const target = ref?.[1] ?? ref?.[2] ?? '';
    expect(channel.semanticTarget(snap.snapshotId, target)).toEqual({ role: 'button', name: 'Suivant' });
    const next = await channel.execute({ kind: 'click', target: { snapshotId: snap.snapshotId, ref: target } });
    expect(next.ok && next.snapshot.accessibilityTree).toContain('Page 2 / 3');
  }, 60_000);

  it('stale_ref : un ref d\'un ancien instantané est refusé, rien n\'est exécuté, un nouvel instantané est rendu', async () => {
    const channel = new PlaywrightStepChannel({ page, allowedHosts: [E5] });
    await channel.execute({ kind: 'navigate', url: `http://${E5}:${fx.port}/` });
    const first = await channel.snapshot();
    const target = /button "Suivant"[^\n]*\[ref=(\w+)\]/.exec(first.accessibilityTree)?.[1] ?? '';
    const moved = await channel.execute({ kind: 'click', target: { snapshotId: first.snapshotId, ref: target } });
    expect(moved.ok).toBe(true);
    const stale = await channel.execute({ kind: 'click', target: { snapshotId: first.snapshotId, ref: target } });
    expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(stale.snapshot?.accessibilityTree).toContain('Page 2 / 3');
    // La page n'a pas bougé : le clic refusé n'a pas été exécuté.
    expect((await channel.snapshot()).accessibilityTree).toContain('Page 2 / 3');
    const unknown = await channel.execute({ kind: 'click', target: { snapshotId: (await channel.snapshot()).snapshotId, ref: 'e9999' } });
    expect(unknown).toMatchObject({ ok: false, error: 'stale_ref' });
    // Page modifiée par elle-même (script) entre l'instantané et l'action : stale_ref aussi.
    const before = await channel.snapshot();
    await page.evaluate("document.body.append('zz_test mutation')");
    expect(await channel.execute({ kind: 'scroll', snapshotId: before.snapshotId, direction: 'down' })).toMatchObject({ ok: false, error: 'stale_ref' });
  }, 60_000);

  it('verrou de domaines : navigation du moteur refusée sans requête ; navigation initiée par la page bloquée et comptée', async () => {
    const channel = new PlaywrightStepChannel({ page, allowedHosts: [INJ] });
    await channel.execute({ kind: 'navigate', url: `http://${INJ}:${fx.port}/` });
    expect(await channel.execute({ kind: 'navigate', url: `http://${TRAP}:${fx.port}/collect` })).toMatchObject({ ok: false, error: 'domain_not_allowed' });
    expect((await stats()).hosts[TRAP]).toBeUndefined();
    // Clic sur le lien piège de la page : la requête part du navigateur, la garde la bloque et la compte.
    await page.getByRole('link', { name: 'Vérifier mon compte' }).click();
    await page.waitForTimeout(300);
    expect(guard.blocked.filter((b) => b.host === TRAP && b.reason === 'domain')).toHaveLength(1);
    expect(guard.attemptsTo(TRAP)).toBe(1);
    expect((await stats()).hosts[TRAP]).toBeUndefined();
  }, 60_000);

  it('pas d\'écriture : la soumission de formulaire (POST) est refusée', async () => {
    const guardSameHost = guard;
    await page.goto(`http://${INJ}:${fx.port}/`);
    await page.evaluate("(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '/zz_test_write'; document.body.append(f); f.submit(); })()");
    await page.waitForTimeout(300);
    expect(guardSameHost.blocked.filter((b) => b.reason === 'write' && b.method === 'POST')).toHaveLength(1);
    expect((await stats()).hosts[INJ]?.paths['/zz_test_write']).toBeUndefined();
  }, 60_000);
});

// Revue 0.6a (points 7 et 8) : le verrou de domaines tient sur les redirections (navigation, sous-ressource, chaîne de
// sauts), les WebSocket et les service workers. Un petit serveur local sert deux hôtes autorisés qui redirigent vers le
// domaine piège du serveur de fixtures ; ce dernier compte toute requête reçue (`/__stats`).
const REDIR_A = 'zz_test_agent_redirect_a.localhost';
const REDIR_B = 'zz_test_agent_redirect_b.localhost';

describe.skipIf(!hasChromium)('verrou de domaines : redirections, WebSocket, service workers (08 §4, mesure 2)', () => {
  let aux: Server;
  let auxPort = 0;
  let auxHits: string[] = [];
  let browser2: Browser;
  let ctx: BrowserContext;
  let g: DomainGuard;

  beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 });
    aux = createServer((req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      auxHits.push(`${host}${req.url ?? ''}`);
      const trap = `http://${TRAP}:${fx.port}/collect?secret=zz_test_CANARY`;
      const html = (body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>zz_test</title>${body}`);
      };
      switch (req.url) {
        case '/go':
          res.writeHead(302, { location: trap });
          return res.end();
        case '/hop':
          res.writeHead(302, { location: `http://${REDIR_B}:${auxPort}/go` });
          return res.end();
        case '/local':
          res.writeHead(302, { location: '/landing' });
          return res.end();
        case '/img':
          return html(`<img src="http://${REDIR_A}:${auxPort}/go" alt="zz_test">`);
        case '/ws':
          return html(
            `<script>window.wsDone = new Promise((r) => { const w = new WebSocket('ws://${TRAP}:${auxPort}/wsleak'); ` +
              `w.onopen = () => r('open'); w.onerror = () => r('error'); w.onclose = () => r('close'); });</script>`,
          );
        case '/sw.js':
          res.writeHead(200, { 'content-type': 'text/javascript' });
          return res.end(`self.addEventListener('install', (e) => e.waitUntil(fetch('${trap}&via=sw').catch(() => 0)));`);
        case '/sw':
          return html(
            `<script>window.swDone = navigator.serviceWorker ? navigator.serviceWorker.register('/sw.js').then(() => 'registered', (e) => 'error:' + e) : Promise.resolve('no-api');</script>`,
          );
        default:
          return html(`<h1>Accueil ${host}</h1>`);
      }
    });
    aux.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      auxHits.push(`WS ${(req.headers.host ?? '').replace(/:\d+$/, '')}${req.url ?? ''}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => aux.listen(0, '127.0.0.1', resolve));
    auxPort = (aux.address() as AddressInfo).port;
    browser2 = await chromium.launch({ args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 60_000);
  afterAll(async () => {
    await browser2?.close();
    await fx?.close();
    await new Promise<void>((resolve) => (aux === undefined ? resolve() : aux.close(() => resolve())));
  });
  beforeEach(async () => {
    await fetch(`http://127.0.0.1:${fx.port}/__reset`, { method: 'POST' });
    auxHits = [];
    await ctx?.close();
    ({ context: ctx, guard: g } = await newAgentContext(browser2, { allowedHosts: [REDIR_A, REDIR_B], allowWriteActions: false }));
  });

  it('redirection 302 d\'un hôte autorisé vers le piège : bloquée, 0 requête servie au piège, 1 entrée dans blocked', async () => {
    const page2 = await ctx.newPage();
    const channel = new PlaywrightStepChannel({ page: page2, allowedHosts: [REDIR_A, REDIR_B] });
    const result = await channel.execute({ kind: 'navigate', url: `http://${REDIR_A}:${auxPort}/go` });
    expect(result).toMatchObject({ ok: false, error: 'domain_not_allowed' });
    expect(hostOf(page2.url())).not.toBe(TRAP);
    expect((await stats()).hosts[TRAP]).toBeUndefined();
    expect(g.blocked.filter((b) => b.host === TRAP && b.reason === 'domain')).toHaveLength(1);
    expect(g.attemptsTo(TRAP)).toBe(1);
  }, 60_000);

  it('chaîne de sauts : A → B (autorisés) → piège ; la redirection interne reste permise', async () => {
    const page2 = await ctx.newPage();
    await expect(page2.goto(`http://${REDIR_A}:${auxPort}/hop`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(auxHits).toEqual([`${REDIR_A}/hop`, `${REDIR_B}/go`]);
    expect((await stats()).hosts[TRAP]).toBeUndefined();
    expect(g.blocked.filter((b) => b.host === TRAP)).toHaveLength(1);
    const page3 = await ctx.newPage();
    await page3.goto(`http://${REDIR_A}:${auxPort}/local`);
    expect(page3.url()).toBe(`http://${REDIR_A}:${auxPort}/landing`);
    expect(g.blocked).toHaveLength(1);
  }, 60_000);

  it('sous-ressource redirigée (image) vers le piège : bloquée aussi', async () => {
    const page2 = await ctx.newPage();
    await page2.goto(`http://${REDIR_A}:${auxPort}/img`);
    await page2.waitForTimeout(300);
    expect((await stats()).hosts[TRAP]).toBeUndefined();
    expect(g.blocked.filter((b) => b.host === TRAP && b.reason === 'domain')).toHaveLength(1);
  }, 60_000);

  it('WebSocket vers un hôte hors liste : refusée et consignée', async () => {
    const page2 = await ctx.newPage();
    await page2.goto(`http://${REDIR_A}:${auxPort}/ws`);
    expect(await page2.evaluate('window.wsDone')).not.toBe('open');
    expect(auxHits.filter((h) => h.startsWith('WS '))).toEqual([]);
    expect(g.blocked.filter((b) => b.host === TRAP && b.reason === 'domain' && b.url.startsWith('ws:'))).toHaveLength(1);
  }, 60_000);

  it('service workers bloqués dans un contexte agentique : le script du worker n\'est jamais chargé', async () => {
    const page2 = await ctx.newPage();
    await page2.goto(`http://${REDIR_A}:${auxPort}/sw`);
    await page2.evaluate('window.swDone');
    await page2.waitForTimeout(500);
    expect(auxHits).not.toContain(`${REDIR_A}/sw.js`);
    expect((await stats()).hosts[TRAP]).toBeUndefined();
  }, 60_000);

  it('un contexte agentique exige un navigateur dédié (la garde des redirections vaut pour tout le navigateur)', async () => {
    const other = await browser2.newContext();
    try {
      await expect(installDomainGuard(other, { allowedHosts: [REDIR_A], allowWriteActions: false })).rejects.toThrow(/navigateur dédié/);
    } finally {
      await other.close();
    }
  });
});
