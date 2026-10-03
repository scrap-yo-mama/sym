// SPDX-License-Identifier: AGPL-3.0-only
// Module d'accès (tâche 1.11, D-91) contre les fixtures d'accès O8 (0.5), par la vraie couche réseau (garde SSRF,
// session N1) : un robots.txt publié par le site (Disallow, 5xx, redirections…) ne conditionne aucune requête et n'est
// jamais lu de lui-même ; rapport d'accès (signaux des en-têtes, sitemap et llms.txt en sondes passives), 402 avec
// `crawler-price`. Le compteur `GET /__stats` des fixtures dit quels chemins ont reçu une requête.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { runFetchExecutor } from '../exec/fetch.js';
import { failureRoute } from '../exec/guard.js';
import { openNetworkSession, type NetworkSession } from '../net/modes/session.js';
import { buildUserAgent } from './identity.js';
import { accessFactsForPrompt, accessReportView, buildAccessReport, sessionAccessProbe } from './report.js';

const HOSTS = [
  'zz_test_robots.localhost',
  'zz_test_robots_5xx.localhost',
  'zz_test_robots_redirect.localhost',
  'zz_test_content_signal.localhost',
  'zz_test_payment_402.localhost',
];
// Moteur fictif : la chaîne exacte de Chromium, plus le jeton de l'instance (identify_instance activé).
const UA = buildUserAgent({ engine: { version: '153.0.8010.12', platform: 'linux' }, identify: { version: '1.2.3', contact: 'ops@zz-test.example' } });
const signal = new AbortController().signal;

let client: Client;
let port: number;
let session: NetworkSession;
const base = (host: string) => `http://${host}:${port}`;

beforeAll(async () => {
  client = await startClient();
  port = client.server.port;
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await client.reset();
  await session?.close();
  session = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(port, HOSTS), userAgent: UA });
});

const paths = async (host: string): Promise<Record<string, number>> => (await client.stats()).hosts[host]?.paths ?? {};

function spec(host: string, path: string): DeclarativeSpec {
  const check = validateDeclarativeSpec({
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `${base(host)}${path}`, allowed_hosts: [host] },
    sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
    fields: { id: { path: '$.id', type: 'string', required: true } },
  });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

describe('assert_robots_not_gating : un robots.txt qui interdit le chemin ne bloque rien (D-91)', () => {
  it('E1 sur un chemin que robots.txt interdit : collecte normale, robots.txt jamais demandé', async () => {
    const host = 'zz_test_robots.localhost';
    const out = await runFetchExecutor(session, { spec: spec(host, '/prive/liste'), input: {}, signal });
    expect(out).toMatchObject({ ok: true, pages: 1, requests: 1 });
    const seen = await paths(host);
    expect(seen['/prive/liste']).toBe(1);
    expect(seen['/robots.txt']).toBeUndefined();
  });

  it('robots.txt injoignable (5xx, coupure) ou redirigé : sans effet sur la collecte', async () => {
    const out = await runFetchExecutor(session, { spec: spec('zz_test_robots_5xx.localhost', '/liste'), input: {}, signal });
    expect(out).toMatchObject({ ok: true, pages: 1 });
    await client.control({ op: 'site', site: 'robots_redirect', loop: true });
    const redirected = await runFetchExecutor(session, { spec: spec('zz_test_robots_redirect.localhost', '/prive/x'), input: {}, signal });
    expect(redirected).toMatchObject({ ok: true, pages: 1 });
    expect((await paths('zz_test_robots_5xx.localhost'))['/robots.txt']).toBeUndefined();
    expect((await paths('zz_test_robots_redirect.localhost'))['/robots.txt']).toBeUndefined();
  });

  it('URL saisie à la main et saut de redirection vers un chemin interdit par robots.txt : suivis, même User-Agent', async () => {
    const hits: string[] = [];
    const agents: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      agents.push(String(req.headers['user-agent'] ?? ''));
      if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /\n');
      if (req.url === '/depart') return void res.writeHead(302, { location: '/prive/cible' }).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const local = (server.address() as { port: number }).port;
    const own = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(local, ['zz_test_redirect_local.localhost']), userAgent: UA });
    try {
      const origin = `http://zz_test_redirect_local.localhost:${local}`;
      expect((await own.fetch(`${origin}/depart`)).status).toBe(200);
      expect((await own.fetch(`${origin}/prive/manuel`)).status).toBe(200);
      expect(hits).toEqual(['/depart', '/prive/cible', '/prive/manuel']);
      expect(new Set(agents)).toEqual(new Set([UA]));
      expect(UA).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 (compatible; Scrapyomama/1.2.3; +mailto:ops@zz-test.example)');
    } finally {
      await own.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rapport d’accès sur un chemin que robots.txt interdit : la suite est permise, aucune section robots, robots.txt jamais demandé', async () => {
    const host = 'zz_test_robots.localhost';
    const report = await buildAccessReport({ url: `${base(host)}/prive/page`, probe: sessionAccessProbe(session), signal });
    expect(report.verdict).toEqual({ proceed: true });
    expect(report).not.toHaveProperty('robots');
    const view = accessReportView(report);
    expect(view).not.toHaveProperty('robots');
    expect(view.signal).toBe('allowed');
    expect(accessFactsForPrompt(report)).not.toHaveProperty('robots');
    const seen = await paths(host);
    expect(seen['/prive/page']).toBe(1);
    expect(seen['/robots.txt']).toBeUndefined();
  });
});

describe('rapport d’accès : sondes, signaux, sitemap (D-91 : découverte directe par /sitemap.xml)', () => {
  it('sitemap.xml servi en XML : déclaré ; page HTML de repli ou JSON : aucun sitemap ; llms.txt lu en sonde passive', async () => {
    for (const [body, type, expected] of [
      ['<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/a</loc></url></urlset>', 'application/xml', true],
      ['<sitemapindex><sitemap><loc>/s.xml</loc></sitemap></sitemapindex>', 'text/xml', true],
      ['<!doctype html><html><body>accueil</body></html>', 'text/html', false],
      ['{"items":[]}', 'application/json', false],
    ] as const) {
      const hits: string[] = [];
      const server: Server = createServer((req, res) => {
        hits.push(req.url ?? '');
        if (req.url === '/sitemap.xml') return void res.writeHead(200, { 'content-type': type }).end(body);
        if (req.url === '/llms.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('# zz_test\n');
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>zz</title><p>page</p>');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const local = (server.address() as { port: number }).port;
      const own = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(local, ['zz_test_sitemap.localhost']), userAgent: UA });
      try {
        const origin = `http://zz_test_sitemap.localhost:${local}`;
        const report = await buildAccessReport({ url: `${origin}/liste`, probe: sessionAccessProbe(own), signal });
        expect(report.declared.sitemaps, type).toEqual(expected ? [`${origin}/sitemap.xml`] : []);
        expect(report.declared.llms_txt).toBe(true);
        expect(accessFactsForPrompt(report).sitemap_declared).toBe(expected);
        expect(hits).toEqual(['/liste', '/llms.txt', '/sitemap.xml']);
        // Sondes coupées : seule la page est demandée.
        hits.length = 0;
        await buildAccessReport({ url: `${origin}/liste`, probe: sessionAccessProbe(own), signal, probeLlmsTxt: false, probeSitemap: false });
        expect(hits).toEqual(['/liste']);
      } finally {
        await own.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it('une stratégie ne remplace pas le User-Agent du robot (aucun masquage, X2)', async () => {
    const agents: string[] = [];
    const server: Server = createServer((req, res) => {
      agents.push(String(req.headers['user-agent'] ?? ''));
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const local = (server.address() as { port: number }).port;
    const own = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(local, ['zz_test_ua.localhost']), userAgent: UA });
    try {
      await own.fetch(`http://zz_test_ua.localhost:${local}/x`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' } });
      expect(agents).toEqual([UA]);
    } finally {
      await own.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Content-Signal ai-train=no (en-têtes) : affiché dans le rapport, n’arrête rien, n’atteint jamais un prompt', async () => {
    const host = 'zz_test_content_signal.localhost';
    const report = await buildAccessReport({ url: `${base(host)}/liste`, probe: sessionAccessProbe(session), signal });
    expect(report.verdict.proceed).toBe(true);
    expect(report.signals).toEqual([
      { kind: 'content_signal', value: 'ai-train=no, search=yes, ai-input=no', source: 'header' },
      { kind: 'content_usage', value: 'train-ai=n', source: 'header' },
      { kind: 'tdm_reservation', value: '1', source: 'header' },
    ]);
    expect(accessReportView(report).signal).toBe('review');
    const facts = JSON.stringify(accessFactsForPrompt(report));
    expect(facts).not.toMatch(/ai-train|train-ai|search=yes|tdm/);
    expect(accessFactsForPrompt(report).usage_signals_present).toBe(true);
    // Le signal ne bloque pas : la collecte se fait.
    const out = await runFetchExecutor(session, { spec: spec(host, '/liste'), input: {}, signal });
    expect(out.ok).toBe(true);
    expect((await paths(host))['/robots.txt']).toBeUndefined();
  });

  it('réponse 402 avec crawler-price : payment_required, action_requise, prix affiché, aucun paiement', async () => {
    const host = 'zz_test_payment_402.localhost';
    const report = await buildAccessReport({ url: `${base(host)}/catalogue`, probe: sessionAccessProbe(session), signal });
    expect(report.payment).toEqual({ required: true, offer: 'USD 0.01' });
    expect(report.verdict).toMatchObject({ proceed: false, status: 'action_requise', failure: { failure_class: 'payment_required', retryable: false } });
    if (!report.verdict.proceed) expect(report.verdict.message).toContain('prix USD 0.01');
    expect(accessReportView(report)).toMatchObject({ payment_offer: 'USD 0.01', signal: 'review' });
    // Une seule requête vers la page payante (la sonde du rapport), aucune autre tentative, aucun paiement.
    expect((await paths(host))['/catalogue']).toBe(1);
    const out = await runFetchExecutor(session, { spec: spec(host, '/catalogue'), input: {}, signal });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'payment_required' } });
    if (!out.ok) expect(failureRoute(out.failure.failure_class)).toMatchObject({ next: 'action_required', agent: false, status: 'action_requise' });
  });
});
