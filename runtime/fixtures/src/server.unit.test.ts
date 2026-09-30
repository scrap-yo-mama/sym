// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer } from './server.ts';
import { startClient, type Client } from './test-helpers.ts';

let fx: Client;
beforeAll(async () => {
  fx = await startClient();
});
afterAll(async () => {
  await fx.close();
});
beforeEach(async () => {
  await fx.reset();
});

describe('serveur de fixtures : socle', () => {
  it('écoute sur 127.0.0.1 seulement et refuse toute autre adresse', async () => {
    await expect(startFixtureServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('GET /health répond 200 sur chaque hôte virtuel et sur un hôte inconnu', async () => {
    for (const host of fx.server.hosts) expect((await fx.get(host, '/health')).status).toBe(200);
    expect((await fx.get('127.0.0.1', '/health')).status).toBe(200);
  });

  it('un hôte virtuel inconnu reçoit 421 hors routes de contrôle', async () => {
    expect((await fx.get('zz_test_unknown.localhost', '/')).status).toBe(421);
  });

  it('tous les hôtes sont préfixés zz_test_ et en .localhost', () => {
    for (const host of fx.server.hosts) expect(host).toMatch(/^zz_test_[a-z0-9_]+\.localhost$/);
  });

  it('GET /__stats compte par hôte et par chemin, sans compter les routes de contrôle ni la chaîne de requête', async () => {
    await fx.get('zz_test_ssr.localhost', '/?page=1');
    await fx.get('zz_test_ssr.localhost', '/?page=2');
    await fx.get('zz_test_spa.localhost', '/');
    await fx.get('zz_test_spa.localhost', '/health');
    const stats = await fx.stats();
    expect(stats.total).toBe(3);
    expect(stats.hosts['zz_test_ssr.localhost']?.paths).toEqual({ '/': 2 });
    expect(stats.hosts['zz_test_spa.localhost']?.paths).toEqual({ '/': 1 });
    expect((await fx.stats('?host=zz_test_spa.localhost')).total).toBe(1);
  });

  it('POST /__reset remet compteurs, horloge et états de site à zéro', async () => {
    await fx.control({ op: 'site', site: 'dom', version: 2 });
    await fx.control({ op: 'clock.advance', seconds: 90 });
    await fx.get('zz_test_dom.localhost', '/');
    await fx.reset();
    expect((await fx.stats()).total).toBe(0);
    expect((await fx.stats()).clock).toBe('2026-01-01T00:00:00.000Z');
    expect((await fx.get('zz_test_dom.localhost', '/')).body).toContain('class="item"');
  });

  it('GET /__stats?log=1 donne l\'ordre et l\'horodatage des requêtes', async () => {
    await fx.get('zz_test_robots_crawl_delay.localhost', '/a');
    await fx.get('zz_test_robots_crawl_delay.localhost', '/b');
    const stats = await fx.stats('?log=1&host=zz_test_robots_crawl_delay.localhost');
    expect(stats.log?.map((e) => e.path)).toEqual(['/a', '/b']);
    expect((stats.log?.[1]?.at_ms ?? 0) >= (stats.log?.[0]?.at_ms ?? 1)).toBe(true);
  });

  it('les routes de contrôle refusent la mauvaise méthode', async () => {
    expect((await fx.call('127.0.0.1', 'GET', '/__reset')).status).toBe(405);
    expect((await fx.call('127.0.0.1', 'POST', '/__stats')).status).toBe(405);
  });
});

describe('serveur de fixtures : POST /__control', () => {
  it('exige le jeton de test', async () => {
    expect((await fx.call('127.0.0.1', 'POST', '/__control', { body: '{}' })).status).toBe(401);
    expect((await fx.control({ op: 'clock.advance', ms: 1 }, 'mauvais-jeton')).status).toBe(401);
    expect((await fx.control({ op: 'clock.advance', ms: 1 })).status).toBe(200);
  });

  it('refuse un JSON invalide, une opération inconnue et un site inconnu', async () => {
    const bad = await fx.call('127.0.0.1', 'POST', '/__control', { headers: { 'x-zz-test-token': fx.server.token }, body: '{pas du json' });
    expect(bad.status).toBe(400);
    expect((await fx.control({ op: 'nope' })).status).toBe(400);
    expect((await fx.control({ op: 'site', site: 'zz_absent' })).status).toBe(400);
    expect((await fx.control({ op: 'site', site: 'ssr' })).status).toBe(400);
  });

  it('pilote l\'horloge : set, advance, et le 429 suit la fenêtre', async () => {
    expect(((await fx.control({ op: 'clock.set', iso: '2026-06-01T00:00:00Z' })).body)).toContain('2026-06-01T00:00:00.000Z');
    await fx.reset();
    for (let i = 0; i < 3; i++) expect((await fx.get('zz_test_429.localhost', '/')).status).toBe(200);
    expect((await fx.get('zz_test_429.localhost', '/')).status).toBe(429);
    await fx.control({ op: 'clock.advance', seconds: 61 });
    expect((await fx.get('zz_test_429.localhost', '/')).status).toBe(200);
  });
});

describe('serveur de fixtures : déterminisme et absence de ressource externe', () => {
  it('la graine fixe donne les mêmes données après un reset et sur un autre serveur', async () => {
    const first = (await fx.get('zz_test_api_json.localhost', '/api/contacts?per_page=50')).body;
    await fx.reset();
    expect((await fx.get('zz_test_api_json.localhost', '/api/contacts?per_page=50')).body).toBe(first);
    const other = await startClient();
    try {
      expect((await other.get('zz_test_api_json.localhost', '/api/contacts?per_page=50')).body).toBe(first);
    } finally {
      await other.close();
    }
  });

  it('une graine différente change les données', async () => {
    const other = await startClient(7);
    try {
      const body = (await other.get('zz_test_api_json.localhost', '/api/contacts?per_page=50')).body;
      expect(body).not.toBe((await fx.get('zz_test_api_json.localhost', '/api/contacts?per_page=50')).body);
    } finally {
      await other.close();
    }
  });

  it('le code source ne référence aucune URL externe (seulement .localhost, .invalid, IP de boucle/privées, schema.org)', () => {
    const allowed = /^https?:\/\/(?:[a-z0-9_.-]+\.localhost|localhost|127\.0\.0\.1|169\.254\.169\.254|10\.0\.0\.1|2130706433|0x7f000001|\[::1\]|schema\.org|\$\{)/i;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          for (const url of readFileSync(full, 'utf8').match(/https?:\/\/[^\s'"`<>)]+/g) ?? []) if (!allowed.test(url)) offenders.push(`${entry.name}: ${url}`);
        }
      }
    };
    walk(new URL('.', import.meta.url).pathname);
    expect(offenders).toEqual([]);
  });
});
