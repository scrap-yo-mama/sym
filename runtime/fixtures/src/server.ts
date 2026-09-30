// Serveur de fixtures : un processus Fastify, hôtes virtuels (en-tête Host), commandes de test sur /__*.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createClock } from './clock.ts';
import { ControlError, type Env, type FxRequest, type FxResponse, type Site } from './core.ts';
import { SITE_FACTORIES } from './sites/index.ts';

export const DEFAULT_SEED = 20_260_101;
export const DEFAULT_TOKEN = 'zz_test_control_token';
const RESERVED = new Set(['/health', '/__reset', '/__stats', '/__control', '/__sites']);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOG_LIMIT = 10_000;
const PERMISSIVE_ROBOTS = 'User-agent: *\nDisallow:\n';

export interface FixtureServerOptions {
  /** 0 = port éphémère (tests). */
  port?: number;
  /** Boucle locale uniquement : toute autre adresse est refusée. */
  host?: string;
  token?: string;
  seed?: number;
}

export interface FixtureServer {
  port: number;
  token: string;
  hosts: string[];
  close(): Promise<void>;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error(`Les fixtures n'écoutent que sur 127.0.0.1 (reçu : ${host}).`);
  const token = options.token ?? DEFAULT_TOKEN;
  const seed = options.seed ?? DEFAULT_SEED;

  const clock = createClock();
  let port = 0;
  const env: Env = { clock, seed, urlFor: (virtualHost, path) => `http://${virtualHost}:${port}${path}` };

  let sites: Site[] = [];
  let byHost = new Map<string, Site>();
  const build = (): void => {
    sites = SITE_FACTORIES.map((factory) => factory(env));
    byHost = new Map();
    for (const site of sites) {
      for (const h of site.hosts) {
        if (byHost.has(h)) throw new Error(`Hôte virtuel en double : ${h}`);
        byHost.set(h, site);
      }
    }
  };
  build();

  let counts = new Map<string, Map<string, number>>();
  let log: { host: string; path: string; method: string; at_ms: number }[] = [];
  const t0 = performance.now();

  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  const virtualHost = (req: FastifyRequest): string => (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const pathOf = (req: FastifyRequest): string => req.url.split('?')[0] ?? '/';

  app.addHook('onRequest', (req, _reply, done) => {
    const path = pathOf(req);
    if (!RESERVED.has(path)) {
      const h = virtualHost(req);
      const perHost = counts.get(h) ?? new Map<string, number>();
      perHost.set(path, (perHost.get(path) ?? 0) + 1);
      counts.set(h, perHost);
      if (log.length < LOG_LIMIT) log.push({ host: h, path, method: req.method, at_ms: Math.round(performance.now() - t0) });
    }
    done();
  });

  app.get('/health', (req) => ({ status: 'ok', host: virtualHost(req), site: byHost.get(virtualHost(req))?.id ?? null }));

  app.get('/__sites', () => ({
    sites: sites.map(({ id, lot, description, hosts, smoke }) => ({ id, lot, description, hosts, smoke })),
  }));

  app.post('/__reset', () => {
    clock.reset();
    counts = new Map();
    log = [];
    build();
    return { reset: true, clock: clock.iso() };
  });

  app.get('/__stats', (req) => {
    const query = req.query as Record<string, string | undefined>;
    const hosts: Record<string, { total: number; paths: Record<string, number> }> = {};
    let total = 0;
    for (const [h, perHost] of counts) {
      if (query['host'] !== undefined && query['host'] !== h) continue;
      const paths = Object.fromEntries(perHost);
      const sum = [...perHost.values()].reduce((a, b) => a + b, 0);
      hosts[h] = { total: sum, paths };
      total += sum;
    }
    const body: Record<string, unknown> = { clock: clock.iso(), total, hosts };
    if (query['log'] !== undefined) body['log'] = query['host'] === undefined ? log : log.filter((entry) => entry.host === query['host']);
    return body;
  });

  app.post('/__control', async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return reply.code(403).send({ error: 'loopback_only' });
    const given = req.headers['x-zz-test-token'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), digest(token))) {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(typeof req.body === 'string' && req.body !== '' ? req.body : '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('objet attendu');
      args = parsed as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: 'invalid_json' });
    }
    try {
      switch (args['op']) {
        case 'clock.set': {
          const ms = typeof args['ms'] === 'number' ? args['ms'] : typeof args['iso'] === 'string' ? Date.parse(args['iso']) : Number.NaN;
          if (!Number.isFinite(ms)) throw new ControlError('ms (nombre) ou iso (date) attendu');
          clock.set(ms);
          return { clock: clock.iso() };
        }
        case 'clock.advance': {
          const ms = typeof args['ms'] === 'number' ? args['ms'] : typeof args['seconds'] === 'number' ? args['seconds'] * 1000 : Number.NaN;
          if (!Number.isFinite(ms) || ms < 0) throw new ControlError('ms ou seconds (nombre >= 0) attendu');
          clock.advance(ms);
          return { clock: clock.iso() };
        }
        case 'site': {
          const site = sites.find((s) => s.id === args['site']);
          if (!site) throw new ControlError(`site inconnu : ${String(args['site'])}`);
          if (!site.control) throw new ControlError(`le site ${site.id} n'a pas de commande`);
          return { site: site.id, result: site.control(args) };
        }
        default:
          throw new ControlError('op attendu : clock.set, clock.advance ou site');
      }
    } catch (error) {
      if (error instanceof ControlError) return reply.code(400).send({ error: 'invalid_control', message: error.message });
      throw error;
    }
  });

  const send = (reply: FastifyReply, res: FxResponse): FastifyReply => {
    reply.code(res.status);
    for (const [name, value] of Object.entries(res.headers ?? {})) reply.header(name, value);
    return reply.send(res.body ?? '');
  };

  // Tout ce qui n'est pas une route de contrôle est dispatché par hôte virtuel.
  app.setNotFoundHandler(async (req, reply) => {
    const path = pathOf(req);
    if (RESERVED.has(path)) return reply.code(405).send({ error: 'method_not_allowed' });
    const h = virtualHost(req);
    const site = byHost.get(h);
    if (!site) return reply.code(421).send({ error: 'unknown_virtual_host', host: h });
    const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
    const fxReq: FxRequest = {
      method: req.method,
      path,
      query,
      headers: req.headers,
      body: typeof req.body === 'string' ? req.body : '',
      host: h,
    };
    try {
      const res = !site.ownsRobots && path === '/robots.txt'
        ? { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: PERMISSIVE_ROBOTS }
        : await site.handle(fxReq);
      if (res.destroy) {
        reply.hijack();
        req.raw.socket.destroy();
        return reply;
      }
      return send(reply, res);
    } catch (error) {
      return reply.code(500).send({ error: 'fixture_error', message: error instanceof Error ? error.message : String(error) });
    }
  });

  await app.listen({ port: options.port ?? 0, host });
  port = (app.server.address() as AddressInfo).port;
  return {
    port,
    token,
    hosts: [...byHost.keys()],
    close: () => app.close(),
  };
}

