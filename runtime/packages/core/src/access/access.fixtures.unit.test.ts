// SPDX-License-Identifier: AGPL-3.0-only
// Module d'accès (tâche 1.11) contre les fixtures d'accès O8 (0.5), par la vraie couche réseau (garde SSRF, session N1) :
// robots.txt (Disallow, 4xx, 5xx, coupure, redirections, boucle, plus de 500 Kio, Crawl-delay, Content-Signal), 402 avec
// `crawler-price`. Le compteur `GET /__stats` des fixtures dit si un chemin a reçu une requête : 0 sur tout chemin
// interdit (INV11), dans l'exécuteur E1 comme pour une URL saisie à la main et sur un saut de redirection.
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startClient, type Client } from '../../../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { domainRequestPacer } from '../exec/pacer.js';
import { runFetchExecutor } from '../exec/fetch.js';
import { failureRoute } from '../exec/guard.js';
import { openNetworkSession, type NetworkSession } from '../net/modes/session.js';
import type { DomainPacer } from '../pacing/pacer.js';
import { RobotsCache, RobotsGate, sessionRobotsFetcher } from './gate.js';
import { buildUserAgent } from './identity.js';
import { accessFactsForPrompt, accessReportView, buildAccessReport, BLOCKED_NEXT_STEPS, sessionAccessProbe } from './report.js';

const HOSTS = [
  'zz_test_robots.localhost',
  'zz_test_robots_4xx.localhost',
  'zz_test_robots_5xx.localhost',
  'zz_test_robots_redirect.localhost',
  'zz_test_robots_big.localhost',
  'zz_test_robots_crawl_delay.localhost',
  'zz_test_content_signal.localhost',
  'zz_test_payment_402.localhost',
];
const UA = buildUserAgent({ version: '1.2.3', contact: 'ops@zz-test.example' });
const signal = new AbortController().signal;

let client: Client;
let port: number;
let robotsSession: NetworkSession;
const base = (host: string) => `http://${host}:${port}`;

beforeAll(async () => {
  client = await startClient();
  port = client.server.port;
  robotsSession = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(port, HOSTS), userAgent: UA });
});
afterAll(async () => {
  await robotsSession.close();
  await client.close();
});
beforeEach(async () => {
  await client.reset();
});

/** Garde robots d'un essai et sa session de contenu (contrôle robots à chaque saut). */
function trial(options: { cache?: RobotsCache; pacer?: ReturnType<typeof domainRequestPacer> } = {}) {
  const gate = new RobotsGate({ fetch: sessionRobotsFetcher(robotsSession), ...(options.cache ? { cache: options.cache } : {}), ...(options.pacer ? { pacer: options.pacer } : {}) });
  const session = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(port, HOSTS), checkUrl: gate.checkUrl, userAgent: UA });
  return { gate, session };
}

const paths = async (host: string): Promise<Record<string, number>> => (await client.stats()).hosts[host]?.paths ?? {};
const contentRequests = async (host: string): Promise<number> => Object.entries(await paths(host)).filter(([p]) => !/^\/robots/.test(p)).reduce((n, [, c]) => n + c, 0);

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

describe('assert_robots_respected : 0 requête sur un chemin interdit (INV11), robots_disallowed → bloquee', () => {
  it('E1 : chemin interdit → robots_disallowed, statut visé bloquee, aucun agent, 0 requête sur le chemin', async () => {
    const host = 'zz_test_robots.localhost';
    const { gate, session } = trial();
    try {
      const out = await runFetchExecutor(session, { spec: spec(host, '/prive/liste'), input: {}, signal, access: gate.access });
      expect(out).toMatchObject({ ok: false, requests: 0, failure: { failure_class: 'robots_disallowed', retryable: false } });
      if (!out.ok) {
        const route = failureRoute(out.failure.failure_class);
        expect(route).toMatchObject({ next: 'stop', agent: false, status: 'bloquee' });
      }
      const seen = await paths(host);
      expect(seen['/prive/liste']).toBeUndefined();
      expect(seen['/robots.txt']).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('E1 : Allow plus long (/prive/ouvert) → collecte normale', async () => {
    const host = 'zz_test_robots.localhost';
    const { gate, session } = trial();
    try {
      const out = await runFetchExecutor(session, { spec: spec(host, '/prive/ouvert'), input: {}, signal, access: gate.access });
      expect(out).toMatchObject({ ok: true, pages: 1 });
      expect((await paths(host))['/prive/ouvert']).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('URL saisie à la main (session seule, sans exécuteur) : même refus, 0 requête, classe robots_disallowed', async () => {
    const host = 'zz_test_robots.localhost';
    const { session } = trial();
    try {
      await expect(session.fetch(`${base(host)}/prive/manuel`)).rejects.toMatchObject({ name: 'AccessRefusedError', failureClass: 'robots_disallowed' });
      expect((await paths(host))['/prive/manuel']).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('saut de redirection vers un chemin interdit : refusé avant connexion (0 requête sur le chemin)', async () => {
    // Serveur local de test : /depart redirige vers /prive/cible ; robots.txt interdit /prive/.
    const hits: string[] = [];
    const agents: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? '');
      agents.push(String(req.headers['user-agent'] ?? ''));
      if (req.url === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /prive/\n');
      if (req.url === '/depart') return void res.writeHead(302, { location: '/prive/cible' }).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"items":[]}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const local = (server.address() as { port: number }).port;
    const guard = fixtureGuard(local, ['zz_test_redirect_local.localhost']);
    const robots = openNetworkSession({ rung: { mode: 'direct' }, guard, userAgent: UA });
    const gate = new RobotsGate({ fetch: sessionRobotsFetcher(robots) });
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard, checkUrl: gate.checkUrl, userAgent: UA });
    try {
      const url = `http://zz_test_redirect_local.localhost:${local}/depart`;
      await expect(session.fetch(url)).rejects.toMatchObject({ failureClass: 'robots_disallowed' });
      expect(hits).toEqual(['/robots.txt', '/depart']);
      // User-Agent honnête avec le contact de l'instance, sur robots.txt comme sur le contenu.
      expect(new Set(agents)).toEqual(new Set([UA]));
      expect(UA).toBe('Scrapyomama/1.2.3 (+mailto:ops@zz-test.example)');
    } finally {
      await session.close();
      await robots.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard: fixtureGuard(local, ['zz_test_ua.localhost']), userAgent: UA });
    try {
      await session.fetch(`http://zz_test_ua.localhost:${local}/x`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' } });
      expect(agents).toEqual([UA]);
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rapport d’accès sur un chemin interdit : bloquee, texte dédié, suites sans tunnel ni « ignorer », 0 requête de contenu', async () => {
    const host = 'zz_test_robots.localhost';
    const { gate, session } = trial();
    try {
      const report = await buildAccessReport({ url: `${base(host)}/prive/page`, gate, probe: sessionAccessProbe(session), signal });
      expect(report.robots).toMatchObject({ status: 'disallowed', rule: 'Disallow: /prive/', http_status: 200 });
      expect(report.verdict).toMatchObject({ proceed: false, status: 'bloquee', failure: { failure_class: 'robots_disallowed' } });
      if (!report.verdict.proceed) {
        expect(report.verdict.message).toBe("Ce site demande aux robots de ne pas visiter cette page. Scrapyomama respecte cette règle. Options : utiliser l'API officielle, contacter l'éditeur.");
        expect(report.verdict.what_to_do).toEqual([...BLOCKED_NEXT_STEPS]);
        expect(JSON.stringify(report.verdict)).not.toMatch(/tunnel|ignore|ignorer|override/i);
      }
      expect(accessReportView(report)).toMatchObject({ signal: 'disallowed', robots: { status: 'disallowed' } });
      expect(await contentRequests(host)).toBe(0);
    } finally {
      await session.close();
    }
  });
});

describe('module d’accès : statuts de robots.txt (RFC 9309) sur les fixtures O8', () => {
  it('robots.txt en 4xx (404, 401, 403, 410) : aucune règle, chemin autorisé, rapport affiché', async () => {
    const host = 'zz_test_robots_4xx.localhost';
    for (const status of [404, 401, 403, 410]) {
      await client.reset();
      if (status !== 404) expect((await client.control({ op: 'site', site: 'robots_4xx', status })).status).toBe(200);
      const { gate, session } = trial();
      try {
        const report = await buildAccessReport({ url: `${base(host)}/liste`, gate, probe: sessionAccessProbe(session), signal, probeLlmsTxt: false });
        expect(report.robots, String(status)).toMatchObject({ status: 'absent', http_status: status });
        expect(report.verdict.proceed).toBe(true);
        expect((await paths(host))['/liste']).toBe(1);
      } finally {
        await session.close();
      }
    }
  });

  it('robots.txt en 5xx persistant ou connexion coupée : robots_unreachable, erreur, 0 collecte', async () => {
    const host = 'zz_test_robots_5xx.localhost';
    for (const mode of [503, 500, 502, 'drop'] as const) {
      await client.reset();
      if (mode !== 503) expect((await client.control({ op: 'site', site: 'robots_5xx', mode })).status).toBe(200);
      const { gate, session } = trial();
      try {
        const report = await buildAccessReport({ url: `${base(host)}/liste`, gate, probe: sessionAccessProbe(session), signal });
        expect(report.robots.status, String(mode)).toBe('unreachable');
        expect(report.verdict).toMatchObject({ proceed: false, status: 'erreur', failure: { failure_class: 'robots_unreachable', retryable: true } });
        if (!report.verdict.proceed) expect(report.verdict.message).toBe('robots.txt injoignable : par précaution rien n\'est collecté');
        const out = await runFetchExecutor(session, { spec: spec(host, '/liste'), input: {}, signal, access: gate.access });
        expect(out).toMatchObject({ ok: false, requests: 0, failure: { failure_class: 'robots_unreachable' } });
        expect(await contentRequests(host)).toBe(0);
      } finally {
        await session.close();
      }
    }
  });

  it('robots.txt derrière des redirections : suivies jusqu’à 5 ; au-delà ou en boucle, injoignable', async () => {
    const host = 'zz_test_robots_redirect.localhost';
    const run = async () => {
      const { gate, session } = trial();
      try {
        return await gate.check(`${base(host)}/prive/x`);
      } finally {
        await session.close();
      }
    };
    expect(await run()).toMatchObject({ allowed: false, failure: { failure_class: 'robots_disallowed' } });
    await client.control({ op: 'site', site: 'robots_redirect', hops: 5 });
    expect(await run()).toMatchObject({ allowed: false, failure: { failure_class: 'robots_disallowed' } });
    await client.control({ op: 'site', site: 'robots_redirect', hops: 6 });
    expect(await run()).toMatchObject({ allowed: false, failure: { failure_class: 'robots_unreachable', detail: 'robots_too_many_redirects' } });
    await client.control({ op: 'site', site: 'robots_redirect', loop: true });
    expect(await run()).toMatchObject({ allowed: false, failure: { failure_class: 'robots_unreachable' } });
    expect(await contentRequests(host)).toBe(0);
  });

  it('robots.txt de plus de 500 Kio : les 500 premiers Kio s’appliquent, le reste est ignoré', async () => {
    const host = 'zz_test_robots_big.localhost';
    const { gate, session } = trial();
    try {
      expect(await gate.check(`${base(host)}/early/x`)).toMatchObject({ allowed: false, rule: 'Disallow: /early/' });
      expect(await gate.check(`${base(host)}/late/x`)).toMatchObject({ allowed: true });
      const state = await gate.state(`${base(host)}/`);
      expect(state).toMatchObject({ kind: 'rules', truncated: true });
    } finally {
      await session.close();
    }
  });

  it('Crawl-delay devient un plancher de cadence (passé à la cadence par domaine)', async () => {
    const host = 'zz_test_robots_crawl_delay.localhost';
    const calls: { url: string; crawlDelayMs: number | null | undefined }[] = [];
    const fake = {
      acquire: async (url: string, opts: { crawlDelayMs?: number | null } = {}) => {
        calls.push({ url, crawlDelayMs: opts.crawlDelayMs });
        return { granted: true, domain: 'x', waitedMs: 0, probe: false };
      },
      report: async () => ({ circuit: 'closed', opened: false, consecutiveFailures: 0, penaltyUntil: null, adaptiveDelayMs: 0 }),
    } as unknown as DomainPacer;
    const ref: { gate?: RobotsGate } = {};
    const pacer = domainRequestPacer(fake, { minDelayMs: 0, crawlDelayMs: (url) => ref.gate?.crawlDelayMs(url) ?? null });
    const { gate, session } = trial({ pacer });
    ref.gate = gate;
    try {
      const out = await runFetchExecutor(session, { spec: spec(host, '/liste'), input: {}, signal, access: gate.access, pacer });
      expect(out.ok).toBe(true);
      // Première réservation : robots.txt lui-même (délai encore inconnu) ; puis la requête de contenu, au plancher de 5 s.
      expect(calls[0]).toMatchObject({ url: `${base(host)}/robots.txt` });
      expect(calls.at(-1)).toMatchObject({ url: `${base(host)}/liste`, crawlDelayMs: 5000 });
    } finally {
      await session.close();
    }
  });

  it('Content-Signal ai-train=no : affiché dans le rapport, n’arrête rien, n’atteint jamais un prompt', async () => {
    const host = 'zz_test_content_signal.localhost';
    const { gate, session } = trial();
    try {
      const report = await buildAccessReport({ url: `${base(host)}/liste`, gate, probe: sessionAccessProbe(session), signal });
      expect(report.verdict.proceed).toBe(true);
      expect(report.signals).toEqual(
        expect.arrayContaining([
          { kind: 'content_signal', value: 'ai-train=no, search=yes, ai-input=no', source: 'robots' },
          { kind: 'content_signal', value: 'ai-train=no, search=yes, ai-input=no', source: 'header' },
          { kind: 'content_usage', value: 'train-ai=n', source: 'header' },
          { kind: 'tdm_reservation', value: '1', source: 'header' },
        ]),
      );
      expect(accessReportView(report).signal).toBe('review');
      const facts = JSON.stringify(accessFactsForPrompt(report));
      expect(facts).not.toMatch(/ai-train|train-ai|search=yes|tdm/);
      expect(accessFactsForPrompt(report).usage_signals_present).toBe(true);
      // Le signal ne bloque pas : la collecte se fait.
      const out = await runFetchExecutor(session, { spec: spec(host, '/liste'), input: {}, signal, access: gate.access });
      expect(out.ok).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('réponse 402 avec crawler-price : payment_required, action_requise, prix affiché, aucun paiement', async () => {
    const host = 'zz_test_payment_402.localhost';
    const { gate, session } = trial();
    try {
      const report = await buildAccessReport({ url: `${base(host)}/catalogue`, gate, probe: sessionAccessProbe(session), signal });
      expect(report.payment).toEqual({ required: true, offer: 'USD 0.01' });
      expect(report.verdict).toMatchObject({ proceed: false, status: 'action_requise', failure: { failure_class: 'payment_required', retryable: false } });
      if (!report.verdict.proceed) expect(report.verdict.message).toContain('prix USD 0.01');
      expect(accessReportView(report)).toMatchObject({ payment_offer: 'USD 0.01', signal: 'review' });
      // Une seule requête vers la page payante (la sonde du rapport), aucune autre tentative, aucun paiement.
      expect((await paths(host))['/catalogue']).toBe(1);
      const out = await runFetchExecutor(session, { spec: spec(host, '/catalogue'), input: {}, signal, access: gate.access });
      expect(out).toMatchObject({ ok: false, failure: { failure_class: 'payment_required' } });
      if (!out.ok) expect(failureRoute(out.failure.failure_class)).toMatchObject({ next: 'action_required', agent: false, status: 'action_requise' });
    } finally {
      await session.close();
    }
  });

  it('cache par origine partagé entre essais (24 h au plus) : robots.txt lu une fois', async () => {
    const host = 'zz_test_robots.localhost';
    const cache = new RobotsCache();
    for (let i = 0; i < 3; i++) {
      const { gate, session } = trial({ cache });
      expect((await gate.check(`${base(host)}/prive/x`)).allowed).toBe(false);
      await session.close();
    }
    expect((await paths(host))['/robots.txt']).toBe(1);
  });
});
