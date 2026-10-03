// SPDX-License-Identifier: AGPL-3.0-only
// BINV2, tâche 1.5 : `assert_session_egress_enforced` sur un vrai Chromium 153 (playwright-core 1.63.0), critères C1 à C4 de
// 04c § 6.2 et § 1.6 (WebRTC, WebTransport). Destination : site de test de la tâche 0.5 (`fixtures/src/site.ts`, journal des
// requêtes avec hôte et IP source), derrière un relais TCP qui compte connexions et octets côté destination.
// Accroches : le pool (1.1) et les sessions `shared` / `dedicated` (1.3, 1.4) n'existent pas encore ; Chromium est lancé ici
// avec les seuls arguments produits par l'egress (`sharedLaunchOptions`, `sharedContextOptions`, `dedicatedChromiumArgs`),
// les valeurs que le pool et les sessions reprendront. Chaque navigateur est fermé par son objet (aucun signal à un autre pid).
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { EgressPolicy } from '@sym/contracts/browser';
import { startSite, type SiteHandle } from '../../../../fixtures/src/site.ts';
import { startCountingRelay, startFixtureSite, startSink, type CountingRelay, type FixtureSite } from '../testing/egress-fixtures.js';
import {
  assertNavigable,
  createEgressGuard,
  dedicatedChromiumArgs,
  sharedContextOptions,
  sharedLaunchOptions,
  startClosedEgress,
  startSessionEgress,
  type EgressEvent,
  type EgressTarget,
  type SessionEgress,
} from './index.js';

/** Résolution maîtrisée : la boucle locale tient lieu d'Internet, seuls site-a et site-b y sont admis (SYMB_PRIVATE_HOSTS). */
const NAMES: Record<string, string> = {
  'site-a.test': '127.0.0.1',
  'site-b.test': '127.0.0.1',
  'piege.test': '127.0.0.1',
  'meta.test': '169.254.169.254',
  'prive.test': '10.0.0.7',
};
const guard = () =>
  createEgressGuard({
    privateHosts: ['site-a.test', 'site-b.test'],
    resolver: async (host) => (NAMES[host] === undefined ? Promise.reject(new Error('ENOTFOUND')) : [{ address: NAMES[host] ?? '', family: 4 as const }]),
  });

let site: SiteHandle;
let siteA: CountingRelay;
let siteB: CountingRelay;
let redirector: FixtureSite;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  site = await startSite({ host: '127.0.0.1' });
  siteA = await startCountingRelay(site.port);
  siteB = await startCountingRelay(site.port);
  redirector = await startFixtureSite();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
  await redirector.close();
  await siteA.close();
  await siteB.close();
  await site.close();
});

type Session = { egress: SessionEgress; events: EgressEvent[]; requests: EgressTarget[] };

async function sessionEgress(policy: EgressPolicy): Promise<Session> {
  const events: EgressEvent[] = [];
  const requests: EgressTarget[] = [];
  const egress = await startSessionEgress(
    { ports: [siteA.port, siteB.port, redirector.port], ...policy },
    { guard: guard(), onEvent: (event) => events.push(event), onRequest: (target) => requests.push(target), blockedWindowMs: 200 },
  );
  cleanups.push(() => egress.close());
  return { egress, events, requests };
}

async function launch(options: Parameters<typeof chromium.launch>[0]): Promise<Browser> {
  const browser = await chromium.launch({ headless: true, ...options });
  cleanups.push(() => browser.close());
  return browser;
}

/** Navigation du nœud : contrôle du schéma avant Chromium (04c § 1.1), puis goto. */
async function goto(page: Page, url: string): Promise<void> {
  assertNavigable(url);
  await page.goto(url);
}

/** Globales de la page utilisées dans `page.evaluate` (le typage du nœud n'inclut pas le DOM). */
type PageGlobals = {
  Image: new () => { onload: (() => void) | null; onerror: (() => void) | null; src: string };
  RTCPeerConnection: new (config: { iceServers: { urls: string; username?: string; credential?: string }[] }) => {
    createDataChannel(label: string): unknown;
    createOffer(): Promise<unknown>;
    setLocalDescription(offer: unknown): Promise<void>;
  };
  WebTransport: new (url: string) => { ready: Promise<void> };
};

const settle = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blockedOf = (events: EgressEvent[]) => events.filter((e) => e.type === 'egress.blocked').map((e) => e.data);
const journalHosts = () => site.journal.entries().map((entry) => entry.host.split(':')[0]);

describe('assert_session_egress_enforced (BINV2, tâche 1.5)', () => {
  test('assert_session_egress_enforced C1 (shared) : sous-ressource, redirection et WebSocket vers site-b → 3 refus domain_not_allowed, 0 connexion vers site-b, 3 événements', async () => {
    const closed = await startClosedEgress({ guard: guard() });
    cleanups.push(() => closed.close());
    const browser = await launch(sharedLaunchOptions(closed.url, {}));
    const { egress, events } = await sessionEgress({ allowedHosts: ['site-a.test'] });
    // Le client propose un proxy tiers : la valeur est remplacée par l'egress de la session.
    const context = await browser.newContext(sharedContextOptions({ proxy: { server: 'http://tiers.example:3128' } }, egress.url));
    cleanups.push(() => context.close());
    const page = await context.newPage();
    const siteBBefore = siteB.connections();

    await goto(page, `http://site-a.test:${siteA.port}/ws-page`);
    await expect.poll(() => page.locator('#log li').first().textContent(), { timeout: 5_000 }).toBe('hello');

    // 1. Sous-ressource.
    await page.evaluate(
      (src) =>
        new Promise<void>((resolve) => {
          const image = new (globalThis as unknown as PageGlobals).Image();
          image.onload = () => resolve();
          image.onerror = () => resolve();
          image.src = src;
        }),
      `http://site-b.test:${siteB.port}/static/style.css`,
    );
    await pause(400);
    // 2. Redirection depuis site-a vers site-b (`no-cors` : la redirection est suivie sans en-tête CORS de la fixture).
    const redirected = await page.evaluate((u) => fetch(u, { cache: 'no-store', mode: 'no-cors' }).then((r) => r.type, () => 'error'), `http://site-a.test:${redirector.port}/redirect?to=${encodeURIComponent(`http://site-b.test:${siteB.port}/__ip`)}`);
    expect(['opaque', 'error']).toContain(redirected);
    await pause(400);
    // 3. WebSocket.
    const ws = await page.evaluate((u) => new Promise<string>((resolve) => { const s = new WebSocket(u); s.onopen = () => resolve('open'); s.onerror = () => resolve('error'); }), `ws://site-b.test:${siteB.port}/ws`);
    expect(ws).toBe('error');

    await settle(() => blockedOf(events).length >= 3);
    expect(blockedOf(events)).toEqual([0, 1, 2].map(() => ({ host: 'site-b.test', reason: 'domain_not_allowed', port: siteB.port, count: 1 })));
    expect(egress.state().blocked).toBe(3);
    expect(siteB.connections()).toBe(siteBBefore);
    expect(journalHosts()).not.toContain('site-b.test');
    // Rien n'est sorti par le proxy de lancement fermé : tout le trafic du contexte est passé par l'egress de la session.
    expect(closed.state().requests).toBe(0);
  }, 60_000);

  test('assert_session_egress_enforced C2 (dedicated) : 1 000 connexions (HTTP, CONNECT, WebSocket, WebRTC) toutes vues par l’egress, octets à ± 1 %', async () => {
    const sink = await startSink();
    cleanups.push(() => sink.close());
    const { egress, requests } = await sessionEgress({ allowedHosts: ['site-a.test'] });
    const browser = await launch({ args: dedicatedChromiumArgs(egress.url, {}) });
    const page = await browser.newPage();
    const before = { connections: siteA.connections(), read: siteA.bytesRead(), written: siteA.bytesWritten() };
    const egressBefore = egress.connections().length;

    await goto(page, `http://site-a.test:${siteA.port}/static/about.html`);
    // 700 WebSocket (un tunnel CONNECT chacun) et 300 requêtes HTTP en forme absolue, par lots.
    const opened = await page.evaluate(async (port) => {
      let ok = 0;
      // Une connexion ratée côté page sous charge (runner à 2 cœurs) est retentée une fois : le test exige toujours 1 000
      // connexions abouties, et l'invariant porte sur la destination (chaque connexion reçue vient de l'egress, plus bas).
      const ws = () => new Promise<boolean>((resolve) => {
        const s = new WebSocket(`ws://site-a.test:${port}/ws`);
        let got = false;
        s.onmessage = () => { got = true; s.close(); };
        s.onclose = () => resolve(got);
        s.onerror = () => resolve(false);
      });
      const http = (batch: number, i: number) => fetch(`/download/sample.txt?b=${batch}&i=${i}`, { cache: 'no-store', headers: { 'x-zz-test': String(i) } }).then((r) => r.text()).then(() => true, () => false);
      const once = async (attempt: () => Promise<boolean>) => { if ((await attempt()) || (await attempt())) ok += 1; };
      for (let batch = 0; batch < 14; batch++) await Promise.all(Array.from({ length: 50 }, () => once(ws)));
      for (let batch = 0; batch < 6; batch++) await Promise.all(Array.from({ length: 50 }, (_, i) => once(() => http(batch, i))));
      return ok;
    }, siteA.port);
    expect(opened).toBe(1_000);

    // WebRTC (STUN/UDP et TURN/TCP vers une IP littérale) et WebTransport : 0 paquet UDP, 0 connexion hors egress.
    await page.evaluate((a) => {
      const { RTCPeerConnection, WebTransport } = globalThis as unknown as PageGlobals;
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${a.udp}` }, { urls: `turn:127.0.0.1:${a.tcp}?transport=tcp`, username: 'zz_test', credential: 'zz_test' }] });
      pc.createDataChannel('zz_test');
      void pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
      try {
        void new WebTransport(`https://127.0.0.1:${a.udp}/zz_test`).ready.catch(() => {});
      } catch {
        /* absent */
      }
    }, { udp: sink.udpPort, tcp: sink.tcpPort });
    await pause(4_000);
    expect(sink.udpPackets()).toBe(0);
    expect(sink.tcpConnections()).toBe(0);
    expect(requests.some((r) => r.host === '127.0.0.1' && r.port === sink.tcpPort && r.via === 'connect')).toBe(true);

    await page.close();
    await settle(() => egress.state().bytesIn === siteA.bytesWritten() - before.written && egress.state().bytesOut === siteA.bytesRead() - before.read);
    // 100 % des connexions reçues par la destination sont des sockets ouverts par l'egress de la session (ports locaux).
    const seen = siteA.remotePorts.slice(before.connections);
    const fromEgress = egress.connections().slice(egressBefore).map((c) => c.localPort);
    expect(seen.length).toBeGreaterThanOrEqual(1_000);
    expect([...seen].sort()).toEqual([...fromEgress].sort());
    const state = egress.state();
    const fixtureIn = siteA.bytesWritten() - before.written;
    const fixtureOut = siteA.bytesRead() - before.read;
    expect(Math.abs(state.bytesIn - fixtureIn)).toBeLessThanOrEqual(fixtureIn * 0.01);
    expect(Math.abs(state.bytesOut - fixtureOut)).toBeLessThanOrEqual(fixtureOut * 0.01);
  }, 180_000);

  test('assert_session_egress_enforced C3 : noms résolus vers 127.0.0.1, 169.254.169.254 et une adresse privée → 403 address_not_public, 0 paquet vers la fixture', async () => {
    const { egress, events } = await sessionEgress({});
    const browser = await launch({ args: dedicatedChromiumArgs(egress.url, {}) });
    const page = await browser.newPage();
    const before = siteA.connections();
    for (const host of ['piege.test', 'meta.test', 'prive.test']) {
      const response = await page.goto(`http://${host}:${siteA.port}/__ip`).catch(() => null);
      expect(response?.status() ?? 403).toBe(403);
      const ws = await page.evaluate((u) => new Promise<string>((resolve) => { const s = new WebSocket(u); s.onopen = () => resolve('open'); s.onerror = () => resolve('error'); }), `ws://${host}:${siteA.port}/ws`);
      expect(ws).toBe('error');
    }
    expect(siteA.connections()).toBe(before);
    expect(new Set(blockedOf(events).map((d) => `${d.host}:${d.reason}`))).toEqual(new Set(['piege.test:address_not_public', 'meta.test:address_not_public', 'prive.test:address_not_public']));
  }, 60_000);

  test('assert_session_egress_enforced C4 : budgetBytes 100 000, la page télécharge 1 Mo → tunnels coupés avant 100 000 + 1 bloc, egress.budget_exceeded, demandes suivantes 403', async () => {
    const { egress, events } = await sessionEgress({ allowedHosts: ['site-a.test'], budgetBytes: 100_000 });
    const browser = await launch({ args: dedicatedChromiumArgs(egress.url, {}) });
    const page = await browser.newPage();
    await goto(page, `http://site-a.test:${siteA.port}/static/about.html`);
    const before = { read: siteA.bytesRead(), written: siteA.bytesWritten(), connections: siteA.connections() };
    const already = egress.state().bytesIn + egress.state().bytesOut;

    const got = await page.evaluate(() => fetch('/heavy/payload.js?bytes=1000000', { cache: 'no-store' }).then((r) => r.arrayBuffer()).then((b) => b.byteLength, () => -1));
    // La page n'a pas reçu le million d'octets : le tunnel a été coupé (fetch en échec) avant budget + 1 bloc.
    expect(got).toBeLessThan(100_000 + 65_536);
    await settle(() => egress.state().budgetExceeded);
    const state = egress.state();
    expect(state.budgetExceeded).toBe(true);
    expect(state.bytesIn + state.bytesOut).toBeLessThan(100_000 + 65_536);
    // Côté destination, seul l'envoi de l'egress est borné (la fixture a pu écrire davantage dans les tampons TCP du noyau).
    expect(siteA.bytesRead() - before.read + already).toBeLessThan(100_000 + 65_536);
    const exceeded = events.filter((e) => e.type === 'egress.budget_exceeded');
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.data).toMatchObject({ budgetBytes: 100_000, action: 'cut' });

    const connectionsAfterCut = siteA.connections();
    const next = await page.evaluate(() => fetch('/__ip', { cache: 'no-store' }).then((r) => r.status, () => -1));
    expect(next).not.toBe(200);
    expect(siteA.connections()).toBe(connectionsAfterCut);
    expect(blockedOf(events).some((d) => d.reason === 'budget_exceeded')).toBe(true);
    expect(connectionsAfterCut).toBeGreaterThanOrEqual(before.connections);
  }, 60_000);
});
