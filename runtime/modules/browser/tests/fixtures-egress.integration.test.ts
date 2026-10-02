// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 0.5 (cdc/sym-browser 06) : les fixtures démarrent en Docker Compose et les deux proxys sortent par des IP distinctes,
// vues par le site et journalisées. Nécessite Docker ; `ci:local --skip-image` pose SYM_BROWSER_SKIP_DOCKER=1 (saut déclaré).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getViaHttpConnect, getViaHttpProxy, getViaSocks5 } from '../fixtures/src/client.ts';
import { composeDown, composeUp, dockerAvailable, type ComposePorts } from '../fixtures/src/compose.ts';
import { EGRESS_IPS, PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS, SITE_HOST, SITE_PORT } from '../fixtures/src/config.ts';

const SKIP = process.env.SYM_BROWSER_SKIP_DOCKER === '1';
const PORTS: ComposePorts = { site: 28_080, http: 28_081, socks5: 28_082 };
const PROJECT = 'sym-browser-fixtures-test';
const FIXTURE = { host: SITE_HOST, port: SITE_PORT };

type Seen = { ip: string };
const parse = (body: string): Seen => JSON.parse(body) as Seen;

describe.skipIf(SKIP)('fixtures en Docker Compose (tâche 0.5)', () => {
  beforeAll(async () => {
    expect(await dockerAvailable(), 'Docker est requis (ou SYM_BROWSER_SKIP_DOCKER=1)').toBe(true);
    await composeUp({ project: PROJECT, ports: PORTS });
  }, 600_000);
  afterAll(async () => {
    await composeDown({ project: PROJECT, ports: PORTS });
  }, 120_000);

  test('assert_fixtures_egress_ips_distinct : site, proxy HTTP et proxy SOCKS5 voient 3 IP sources distinctes, dont 10.88.0.11 et 10.88.0.12', async () => {
    const direct = parse(await (await fetch(`http://127.0.0.1:${PORTS.site}/__ip`)).text());
    const viaHttpForward = parse((await getViaHttpProxy({ port: PORTS.http }, PROXY_HTTP_CREDENTIALS, FIXTURE, '/__ip')).body);
    const viaHttpConnect = parse((await getViaHttpConnect({ port: PORTS.http }, PROXY_HTTP_CREDENTIALS, FIXTURE, '/__ip')).body);
    const viaSocks = parse((await getViaSocks5({ port: PORTS.socks5 }, PROXY_SOCKS5_CREDENTIALS, FIXTURE, '/__ip')).body);

    expect(viaHttpForward.ip).toBe(EGRESS_IPS.http);
    expect(viaHttpConnect.ip).toBe(EGRESS_IPS.http);
    expect(viaSocks.ip).toBe(EGRESS_IPS.socks5);
    expect(new Set([direct.ip, viaHttpConnect.ip, viaSocks.ip]).size).toBe(3);
    expect([EGRESS_IPS.http, EGRESS_IPS.socks5]).not.toContain(direct.ip);

    // Le journal du site a bien enregistré chaque IP source avec le nom d'hôte demandé.
    const journal = (await (await fetch(`http://127.0.0.1:${PORTS.site}/__ips`)).json()) as { ip: string; path: string; host: string }[];
    const ips = journal.filter((entry) => entry.path === '/__ip').map((entry) => entry.ip);
    expect(ips).toEqual(expect.arrayContaining([direct.ip, EGRESS_IPS.http, EGRESS_IPS.socks5]));
    expect(journal.some((entry) => entry.host.startsWith(SITE_HOST) && entry.ip === EGRESS_IPS.socks5)).toBe(true);
  });

  test('les proxys refusent les requêtes sans identifiants valides, même en Docker', async () => {
    expect((await getViaHttpProxy({ port: PORTS.http }, undefined, FIXTURE, '/__ip')).status).toBe(407);
    await expect(getViaSocks5({ port: PORTS.socks5 }, { username: PROXY_SOCKS5_CREDENTIALS.username, password: 'faux' }, FIXTURE, '/__ip')).rejects.toThrow();
  });

  test('le site de test est joignable par le proxy sous fixtures.local : SPA, connexion, page lourde de 5 Mo', async () => {
    const heavy = await getViaHttpConnect({ port: PORTS.http }, PROXY_HTTP_CREDENTIALS, FIXTURE, '/heavy/payload.js');
    expect(heavy.status).toBe(200);
    expect(heavy.body.length).toBe(5 * 1024 * 1024);
    expect((await getViaSocks5({ port: PORTS.socks5 }, PROXY_SOCKS5_CREDENTIALS, FIXTURE, '/spa/items/3')).body).toContain('SYM SPA fixture');
  });
});
