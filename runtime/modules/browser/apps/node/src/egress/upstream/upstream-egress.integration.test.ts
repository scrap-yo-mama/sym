// SPDX-License-Identifier: AGPL-3.0-only
// BINV2 et BINV6, tâche 1.6 (recette étape 10 ; 04c § 6.2, C5 à C7) : Chromium 153 piloté par l'egress de sa session, branché
// sur les proxys de test de la tâche 0.5 en Docker Compose (proxy HTTP 10.88.0.11, SOCKS5 10.88.0.12, site fixtures.local
// qui journalise l'IP source). Profils de proxy nommés chiffrés ; IP vue par la fixture = IP du proxy ; octets de la session
// comptés contre un relais placé devant le proxy ; proxy injoignable ou mauvais mot de passe → 502 `proxy_unreachable`, aucun
// Chromium lancé, 0 connexion directe ; mot de passe absent du HAR, des événements, des compteurs et des erreurs.
// Nécessite Docker ; `ci:local --skip-image` pose SYM_BROWSER_SKIP_DOCKER=1 (saut déclaré, comme le test des fixtures 0.5).
// Chaque Chromium est fermé par son objet `Browser` (aucun signal à un autre processus).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MasterKey, kekFor } from '@sym-browser/core';
import { composeDown, composeUp, dockerAvailable, type ComposePorts } from '../../../../../fixtures/src/compose.ts';
import { EGRESS_IPS, PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS, SITE_HOST, SITE_PORT } from '../../../../../fixtures/src/config.ts';
import { startCountingRelay, type CountingRelay } from '../../testing/egress-fixtures.js';
import { createEgressGuard, dedicatedChromiumArgs, type EgressEvent } from '../index.js';
import { ProxyUnreachableError, createMemoryProxyProfileStore, createProxyProfiles, startUpstreamSessionEgress, type ProxyProfiles, type UpstreamSession } from './index.js';

const SKIP = process.env.SYM_BROWSER_SKIP_DOCKER === '1';
const PORTS: ComposePorts = { site: 28_180, http: 28_181, socks5: 28_182 };
const PROJECT = 'sym-browser-fixtures-upstream';
const TENANT = '00000000-0000-4000-8000-0000000000a1';
const SITE = `http://${SITE_HOST}:${SITE_PORT}`;
const SECRETS = [
  PROXY_HTTP_CREDENTIALS.password,
  PROXY_SOCKS5_CREDENTIALS.password,
  Buffer.from(`${PROXY_HTTP_CREDENTIALS.username}:${PROXY_HTTP_CREDENTIALS.password}`).toString('base64'),
];

type Seen = { ip: string; path: string; host: string };
const journal = async (): Promise<Seen[]> => (await (await fetch(`http://127.0.0.1:${PORTS.site}/__ips`)).json()) as Seen[];

describe.skipIf(SKIP)('assert_session_egress_enforced (C5 à C7) et assert_secrets_protected : proxys amont sur Chromium (tâche 1.6, recette 10)', () => {
  let profiles: ProxyProfiles;
  let httpRelay: CountingRelay;
  let socksRelay: CountingRelay;
  let harDir: string;

  beforeAll(async () => {
    expect(await dockerAvailable(), 'Docker est requis (ou SYM_BROWSER_SKIP_DOCKER=1)').toBe(true);
    await composeUp({ project: PROJECT, ports: PORTS });
    httpRelay = await startCountingRelay(PORTS.http);
    socksRelay = await startCountingRelay(PORTS.socks5);
    profiles = createProxyProfiles({ store: createMemoryProxyProfileStore(), keys: { current: kekFor(MasterKey.generate(), 1) } });
    harDir = mkdtempSync(join(tmpdir(), 'symb-upstream-har-'));
  }, 600_000);
  afterAll(async () => {
    rmSync(harDir, { recursive: true, force: true });
    await socksRelay?.close();
    await httpRelay?.close();
    await composeDown({ project: PROJECT, ports: PORTS });
  }, 120_000);

  /** Session `dedicated` : egress de session sur le profil, Chromium lancé seulement après le test de l'amont. */
  async function browse(profileId: string, relay: CountingRelay, label: string) {
    const events: EgressEvent[] = [];
    const session: UpstreamSession = await startUpstreamSessionEgress(
      { upstream: { profileId }, allowedHosts: [SITE_HOST], ports: [SITE_PORT] },
      { tenantId: TENANT, profiles, guard: createEgressGuard({ privateHosts: ['127.0.0.1'] }), echoUrl: `${SITE}/__ip`, onEvent: (e) => events.push(e), blockedWindowMs: 10 },
    );
    const before = { read: relay.bytesRead(), written: relay.bytesWritten() };
    const har = join(harDir, `${label}.har`);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true, args: dedicatedChromiumArgs(session.egress.url, {}) });
      const context = await browser.newContext({ recordHar: { path: har } });
      const page = await context.newPage();
      const response = await page.goto(`${SITE}/__ip`);
      const seen = JSON.parse((await response?.text()) ?? '{}') as { ip: string };
      // Hors politique : refusé par l'egress avant l'amont.
      await page.goto('http://interdit.example:8080/').catch(() => null);
      await page.goto(`${SITE}/heavy/payload.js?bytes=300000`);
      await context.close();
      const end = Date.now() + 3_000;
      while (session.egress.state().bytesIn !== relay.bytesWritten() - before.written && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      return { session, events, seen, har: readFileSync(har, 'utf8'), fixtureIn: relay.bytesWritten() - before.written, fixtureOut: relay.bytesRead() - before.read };
    } finally {
      await browser?.close();
      await session.egress.close();
    }
  }

  test('assert_session_egress_enforced C5 : profil HTTP avec identifiants → exitIp et IP vue = 10.88.0.11, octets comptés à ± 1 % ; assert_secrets_protected : mot de passe absent du HAR et des événements', async () => {
    const { id } = await profiles.create(TENANT, { name: 'http', type: 'http', host: '127.0.0.1', port: httpRelay.port, ...PROXY_HTTP_CREDENTIALS });
    const run = await browse(id, httpRelay, 'http');
    expect(run.session.exitIp).toBe(EGRESS_IPS.http);
    expect(run.seen.ip).toBe(EGRESS_IPS.http);
    const state = run.session.egress.state();
    expect(state.bytesIn).toBeGreaterThan(300_000);
    expect(Math.abs(state.bytesIn - run.fixtureIn)).toBeLessThanOrEqual(run.fixtureIn * 0.01);
    expect(Math.abs(state.bytesOut - run.fixtureOut)).toBeLessThanOrEqual(run.fixtureOut * 0.01);
    expect(run.events.filter((e) => e.type === 'egress.blocked').map((e) => e.data.host)).toContain('interdit.example');
    for (const text of [run.har, JSON.stringify(run.events), JSON.stringify(state)]) for (const secret of SECRETS) expect(text).not.toContain(secret);
  }, 120_000);

  test('assert_session_egress_enforced C6 : profil SOCKS5 authentifié → IP vue = 10.88.0.12 ; 0 requête directe vers la fixture', async () => {
    const { id } = await profiles.create(TENANT, { name: 'socks', type: 'socks5', host: '127.0.0.1', port: socksRelay.port, ...PROXY_SOCKS5_CREDENTIALS });
    const before = (await journal()).length;
    const run = await browse(id, socksRelay, 'socks5');
    expect(run.session.exitIp).toBe(EGRESS_IPS.socks5);
    expect(run.seen.ip).toBe(EGRESS_IPS.socks5);
    // `/health` vu depuis 127.0.0.1 : sonde de santé Docker du conteneur du site lui-même, pas une requête de la session.
    const fresh = (await journal()).slice(before).filter((e) => e.path !== '/__ips' && !(e.path === '/health' && e.ip === '127.0.0.1'));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((e) => e.ip === EGRESS_IPS.socks5)).toBe(true);
    for (const secret of SECRETS) expect(run.har).not.toContain(secret);
  }, 120_000);

  test('assert_session_egress_enforced C6/C7 : mauvais mot de passe SOCKS5 ou proxy injoignable → 502 proxy_unreachable, aucune session ni Chromium, 0 connexion directe', async () => {
    const wrong = await profiles.create(TENANT, { name: 'socks-faux', type: 'socks5', host: '127.0.0.1', port: PORTS.socks5, username: PROXY_SOCKS5_CREDENTIALS.username, password: 'zz_test_mauvais_pw' });
    const unreachable = await profiles.create(TENANT, { name: 'absent', type: 'http', host: '127.0.0.1', port: 1, ...PROXY_HTTP_CREDENTIALS });
    const before = (await journal()).length;
    for (const [profileId, reason] of [[wrong.id, 'upstream_auth_failed'], [unreachable.id, 'connect_failed']] as const) {
      let started = 0;
      const error = await startUpstreamSessionEgress(
        { upstream: { profileId }, allowedHosts: [SITE_HOST], ports: [SITE_PORT] },
        { tenantId: TENANT, profiles, guard: createEgressGuard({ privateHosts: ['127.0.0.1'] }), echoUrl: `${SITE}/__ip`, onEgressStarted: () => void (started += 1) },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProxyUnreachableError);
      expect(error).toMatchObject({ status: 502, code: 'proxy_unreachable', details: { reason } });
      expect(started).toBe(0);
      expect(JSON.stringify(error)).not.toContain('zz_test_mauvais_pw');
    }
    expect((await journal()).slice(before).filter((e) => e.path !== '/__ips' && !(e.path === '/health' && e.ip === '127.0.0.1'))).toEqual([]);
  }, 60_000);
});
