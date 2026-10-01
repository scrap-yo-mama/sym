// SPDX-License-Identifier: AGPL-3.0-only
// INV9 et INV8 de bout en bout (tâche 1.10) : `server` + `worker` réels sur base réelle, un run exécuté, un intercepteur
// réseau global et un collecteur OTLP de test.
// - assert_otel_off_by_default / assert_no_telemetry : sans OTEL_ENABLED (même avec un endpoint posé), 0 requête vers le
//   collecteur, 0 connexion vers lui, 0 destination non locale, aucun `_trace` dans la charge du job ; et, dans un processus
//   `server` + `worker` réel (crochet de résolution), 0 module `@opentelemetry/*` résolu (auth Better Auth et run compris) ;
// - assert_otel_optin_local_only : avec OTEL_ENABLED=true, des spans partent vers le collecteur local ; l'ensemble des
//   destinations, comparé au même scénario OTel coupé, ne gagne que le collecteur ; le span du worker est l'enfant du span
//   qui a mis le job en file (`_trace`) ;
// - assert_no_traceparent_outbound : ni traceparent, ni tracestate, ni baggage vers la cible, le faux LLM et le proxy (forme
//   absolue et CONNECT), en HTTP comme en fetch ;
// - assert_no_secret_in_logs (toutes les sorties) : canaris passés par le dépôt de secrets (clé LLM, proxy, cookie,
//   Authorization), relus par le run, absents de stdout, run_logs, spans, métriques et artefacts.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import {
  createLogger,
  currentTraceparent,
  generateMasterKey,
  registeredPropagationFields,
  RUN_QUEUE,
  secretValues,
  withSpan,
  type RunExecutor,
} from '@runtime/core';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, runQueueDefinition, secretStore, withActor, writeRunArtifact } from '@runtime/db';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadWorkerConfig } from '../apps/worker/src/config.js';
import { startWorker, type Worker } from '../apps/worker/src/worker.js';
import { prepareServer, type Started } from '../apps/server/src/start.js';
import { captureNetwork, destinations, startProxy, startRecorder, type NetCapture, type RecordedRequest } from './helpers/net-capture.js';
import { createTestDatabase, type TestDatabase } from './helpers/pg.js';
import { PUBLIC_URL, serverEnv } from './helpers/server.js';

// Client proxy du runtime : undici (dépendance de @runtime/core), `ProxyAgent` en forme absolue et en CONNECT.
type Undici = {
  ProxyAgent: new (options: { uri: string; proxyTunnel?: boolean }) => { close(): Promise<void> };
  fetch: (url: string, init?: Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown }) => Promise<Response>;
};
const undici = createRequire(new URL('../packages/core/package.json', import.meta.url))('undici') as Undici;

const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const token = () => randomBytes(32).toString('base64url');

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let masterKey: string;
const A = randomUUID();
const actorA = { userId: A, role: 'member' as const };
let apiId: string;

type Recorder = Awaited<ReturnType<typeof startRecorder>>;
let collector: Recorder;
let target: Recorder;
let llm: Recorder;
let proxy: Awaited<ReturnType<typeof startProxy>>;
let capture: NetCapture;
const servers: Started[] = [];
const workers: Worker[] = [];

beforeAll(async () => {
  tdb = await createTestDatabase('obs_e2e');
  await migrateUp({ connectionString: tdb.url });
  masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_e2e@example.test', 'active')", [A]);
  apiId = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_e2e', $1) RETURNING id", [A])).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 2, $2, 'fetch', 'direct', 'user')", [apiId, A]);
  await pool.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [apiId]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
});

async function stopInstances(): Promise<void> {
  for (const w of workers.splice(0)) await w.stop();
  for (const s of servers.splice(0)) await s.close();
}

afterEach(async () => {
  capture?.stop();
  await stopInstances();
  for (const r of [collector, target, llm, proxy]) await r?.close();
  secretValues.clear();
  await pool.query("DELETE FROM runs; DELETE FROM worker_heartbeats; DELETE FROM pgboss.job WHERE name = 'run'");
});

afterAll(async () => {
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

/** Collecteur OTLP de test (JSON ou protobuf), cible, faux LLM et proxy locaux, puis capture du réseau. */
async function fixtures(): Promise<void> {
  collector = await startRecorder(() => ({ body: '{}', type: 'application/json' }));
  target = await startRecorder();
  llm = await startRecorder(() => ({ body: '{"choices":[]}', type: 'application/json' }));
  proxy = await startProxy();
  capture = captureNetwork();
}

const fastWorkerEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL: tdb.url,
  MASTER_KEY: masterKey,
  RUN_HEARTBEAT_SECONDS: '0.5',
  RUN_STALE_SECONDS: '2',
  SWEEP_INTERVAL_SECONDS: '0.5',
  WORKER_HEARTBEAT_SECONDS: '0.5',
  QUEUE_POLLING_SECONDS: '0.5',
  SHUTDOWN_TIMEOUT_SECONDS: '1',
  ...extra,
});

const get = (url: string, headers: Record<string, string> = {}) =>
  new Promise<void>((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });

/** Appels par le proxy (client undici du runtime) : forme absolue vers la cible, tunnel CONNECT vers le faux LLM. */
async function viaProxy(): Promise<void> {
  const absolute = new undici.ProxyAgent({ uri: proxy.url });
  const tunnel = new undici.ProxyAgent({ uri: proxy.url, proxyTunnel: true });
  try {
    await (await undici.fetch(`${target.url}/via-proxy`, { dispatcher: absolute })).text();
    await (await undici.fetch(`${llm.url}/v1/via-tunnel`, { method: 'POST', body: '{}', dispatcher: tunnel })).text();
  } finally {
    await absolute.close();
    await tunnel.close();
  }
}

/** Un run « réel » : appels à la cible et au faux LLM, par fetch, par http et par le proxy, journal de run. */
const callingExecutor: RunExecutor = async (ctx) => {
  await ctx.log('info', 'fixture_calls', { target: target.url });
  await fetch(`${target.url}/page`);
  await fetch(`${llm.url}/v1/chat/completions`, { method: 'POST', body: '{}' });
  await get(`${target.url}/http`);
  await get(`${llm.url}/http`);
  await viaProxy();
  return { state: 'succeeded', outcome: 'clean', items: 0 };
};

async function startInstance(env: NodeJS.ProcessEnv, executor: RunExecutor, options: { metricsToken?: string; workerId?: string; destination?: Writable } = {}) {
  const started = await prepareServer(serverEnv(tdb.url, masterKey, token(), { ...(options.metricsToken ? { METRICS_TOKEN: options.metricsToken } : {}), ...env }));
  servers.push(started);
  const worker = await startWorker({
    config: loadWorkerConfig(fastWorkerEnv(env)),
    executor,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.destination ? { logger: createLogger({ name: 'worker', destination: options.destination }) } : {}),
  });
  workers.push(worker);
  return { started, worker };
}

const createRunRow = () => withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
const waitDone = (runId: string) =>
  vi.waitFor(async () => expect((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]?.state).toBe('succeeded'), { timeout: 30_000, interval: 100 });
const jobData = async (runId: string) =>
  (await pool.query<{ data: Record<string, unknown> }>("SELECT data FROM pgboss.job WHERE name = $1 AND data ->> 'run_id' = $2", [RUN_QUEUE, runId])).rows[0]?.data;

const headerNames = (requests: Pick<RecordedRequest, 'headers'>[]) => requests.flatMap((r) => Object.keys(r.headers));

type OtlpJson = { resourceSpans: { scopeSpans: { spans: { name: string; traceId: string; spanId: string; parentSpanId?: string; attributes?: { key: string; value: Record<string, string> }[] }[] }[] }[] };
const exportedSpans = (c: Recorder) =>
  c.requests.filter((r) => r.url === '/v1/traces').flatMap((r) => (JSON.parse(r.body.toString()) as OtlpJson).resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));

const on = (collectorUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OTEL_ENABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_TRACES_SAMPLER: 'always_on',
  OTEL_SERVICE_NAME: 'zz_test',
  ...extra,
});

describe('OTel coupé par défaut', () => {
  test('assert_otel_off_by_default + assert_no_telemetry : un run complet, 0 requête vers le collecteur (endpoint posé mais non activé), 0 destination non locale', async () => {
    await fixtures();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer zz_test' };
    const { started } = await startInstance(env, callingExecutor);
    expect(started.telemetry.enabled).toBe(false);
    expect(currentTraceparent()).toBeUndefined();

    await started.app.inject({ method: 'GET', url: '/api/health' });
    await started.app.inject({ method: 'GET', url: '/api/ready' });
    const { runId } = await createRunRow();
    await waitDone(runId);
    await new Promise((r) => setTimeout(r, 1500)); // plus qu'un délai d'export : rien ne doit partir

    expect(collector.requests).toHaveLength(0);
    expect(capture.connections.filter((c) => c.endsWith(`:${collector.port}`))).toEqual([]);
    expect(capture.nonLocal).toEqual([]);
    // Témoin : le trafic voulu (cible, faux LLM) est bien vu par l'intercepteur.
    expect(capture.connections.some((c) => c.endsWith(`:${target.port}`))).toBe(true);
    expect(capture.connections.some((c) => c.endsWith(`:${llm.port}`))).toBe(true);
    // Aucun contexte de trace dans la charge du job.
    expect(await jobData(runId)).toEqual({ run_id: runId });
    // Le run a un journal : run_logs écrits par le worker, masqués, en ordre.
    const logs = (await pool.query<{ event: string }>('SELECT event FROM run_logs WHERE run_id = $1 ORDER BY seq', [runId])).rows.map((r) => r.event);
    expect(logs).toEqual(['run_claimed', 'fixture_calls', 'run_finished']);
    // Aucun en-tête de trace chez les cibles ni au proxy non plus.
    expect(proxy.requests.map((r) => r.method).sort()).toEqual(['CONNECT', 'GET']);
    for (const name of headerNames([...target.requests, ...llm.requests, ...proxy.requests])) expect(TRACE_HEADERS).not.toContain(name);
  });
});

describe('assert_otel_off_by_default : modules chargés par le server et le worker réels', () => {
  const dist = (path: string) => new URL(`../${path}`, import.meta.url).href;

  test('OTel coupé : un processus server + worker (assistant, connexion Better Auth, session, un run) ne résout AUCUN module @opentelemetry/*', async () => {
    const db = await createTestDatabase('obs_mod');
    try {
      await migrateUp({ connectionString: db.url });
      const key = generateMasterKey();
      const owner = randomUUID();
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        await c.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_mod@example.test', 'active')", [owner]);
        const api = (await c.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_mod', $1) RETURNING id", [owner])).rows[0]!.id;
        await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', 'user')", [api, owner]);
        await c.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [api]);
        const bootstrap = token();
        const config = {
          start: dist('apps/server/dist/start.js'),
          worker: dist('apps/worker/dist/worker.js'),
          workerConfig: dist('apps/worker/dist/config.js'),
          db: dist('packages/db/dist/index.js'),
          dbUrl: db.url,
          publicUrl: PUBLIC_URL,
          // Endpoint posé mais OTel non activé : rien ne doit être chargé.
          serverEnv: serverEnv(db.url, key, bootstrap, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }),
          workerEnv: fastWorkerEnv({ DATABASE_URL: db.url, MASTER_KEY: key, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' }),
          bootstrap,
          email: 'zz_test_mod_owner@example.test',
          password: `zz_test_${randomBytes(12).toString('base64url')}`,
          actor: { userId: owner, role: 'member' },
          apiId: api,
        };
        const script = `
          import { registerHooks } from 'node:module';
          const resolved = [];
          const attempted = [];
          registerHooks({
            resolve(specifier, context, next) {
              if (!specifier.includes('@opentelemetry/')) return next(specifier, context);
              attempted.push(specifier);
              const result = next(specifier, context); // lève si le module est introuvable
              resolved.push(specifier + ' <- ' + (context.parentURL ?? '?'));
              return result;
            },
          });
          const cfg = JSON.parse(process.env.ZZ_CFG);
          const { prepareServer } = await import(cfg.start);
          const { startWorker } = await import(cfg.worker);
          const { loadWorkerConfig } = await import(cfg.workerConfig);
          const db = await import(cfg.db);
          const started = await prepareServer(cfg.serverEnv);
          const inject = (o) => started.app.inject(o);
          const setup = await inject({ method: 'POST', url: '/api/setup', payload: { token: cfg.bootstrap, email: cfg.email, password: cfg.password } });
          const signIn = await inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: cfg.publicUrl }, payload: { email: cfg.email, password: cfg.password } });
          const cookie = signIn.cookies.find((k) => k.name.endsWith('sy.session'));
          const session = await inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: cookie.name + '=' + cookie.value } });
          const worker = await startWorker({ config: loadWorkerConfig(cfg.workerEnv), executor: async () => ({ state: 'succeeded', outcome: 'clean', items: 0 }) });
          const queue = new db.PgBossJobQueue({ connectionString: cfg.dbUrl, max: 2, supervise: false });
          await queue.start();
          const { pool } = db.createDb(cfg.dbUrl, 2);
          const { runId } = await db.withActor(pool, cfg.actor, (tx) => db.createRun(tx, queue, { apiId: cfg.apiId, ownerId: cfg.actor.userId, trigger: 'rest' }));
          let state = '';
          for (let i = 0; i < 300 && state !== 'succeeded'; i++) {
            await new Promise((r) => setTimeout(r, 100));
            state = (await pool.query('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]?.state;
          }
          await new Promise((r) => setTimeout(r, 300)); // imports dynamiques éventuels encore en vol
          await worker.stop();
          await queue.stop({ timeoutMs: 1000 });
          await pool.end();
          await started.close();
          process.stdout.write('\\n' + JSON.stringify({ resolved, attempted, setup: setup.statusCode, signIn: signIn.statusCode, session: session.statusCode, state }) + '\\n');
          process.exit(0);
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: new URL('..', import.meta.url).pathname,
          env: { PATH: process.env['PATH'] ?? '', ZZ_CFG: JSON.stringify(config) },
          encoding: 'utf8',
          timeout: 90_000,
        });
        if (result.status !== 0) throw new Error(`processus enfant (${result.status}) : ${result.stderr}`);
        const out = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { resolved: string[]; attempted: string[]; setup: number; signIn: number; session: number; state: string };
        // Témoins : le scénario a bien eu lieu (assistant, connexion, session, run terminé).
        expect(out).toMatchObject({ setup: 201, signIn: 200, session: 200, state: 'succeeded' });
        // Better Auth tente bien `import("@opentelemetry/api")` (son pair optionnel) : le crochet le voit…
        expect(out.attempted).toContain('@opentelemetry/api');
        // … mais rien ne se résout : ni l'API ni le SDK OTel ne sont chargés tant que l'admin ne l'active pas. Seule
        // exception (décision consignée au journal) : `@opentelemetry/semantic-conventions`, constantes de chaînes sans code
        // d'exécution ni réseau, importé statiquement par Better Auth 1.7.5 (déjà le cas avant 1.10).
        const semconv = (r: string) => r.startsWith('@opentelemetry/semantic-conventions <- ') && r.includes('/node_modules/@better-auth/core/');
        expect(out.resolved.filter((r) => !semconv(r))).toEqual([]);
        expect(out.resolved.some((r) => r.startsWith('@opentelemetry/api'))).toBe(false);
      } finally {
        await c.end();
      }
    } finally {
      await db.drop();
    }
  }, 120_000);
});

describe('OTel opt-in explicite', () => {
  test('assert_otel_optin_local_only : même scénario, OTel coupé puis actif → seule destination en plus : le collecteur', async () => {
    await fixtures();
    const scenario = async (env: NodeJS.ProcessEnv) => {
      const { started } = await startInstance(env, callingExecutor);
      const { runId } = await createRunRow();
      await waitDone(runId);
      await started.app.inject({ method: 'GET', url: '/api/health' });
      await started.telemetry.forceFlush();
      await stopInstances();
      const seen = destinations(capture);
      capture.connections.length = 0;
      return seen;
    };
    const off = await scenario({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url });
    const on_ = await scenario(on(collector.url));
    expect(collector.requests.length).toBeGreaterThan(0); // témoin : le collecteur a reçu les spans du second passage
    // Témoins : la base, la cible, le faux LLM et le proxy sont vus dans les deux passages.
    for (const port of [target.port, llm.port, proxy.port]) {
      expect([...off].some((d) => d.endsWith(`:${port}`))).toBe(true);
      expect([...on_].some((d) => d.endsWith(`:${port}`))).toBe(true);
    }
    expect([...on_].filter((d) => !off.has(d))).toEqual([`127.0.0.1:${collector.port}`]);
    expect([...off].filter((d) => !on_.has(d))).toEqual([]);
    expect(capture.nonLocal).toEqual([]);
  });

  test('OTel actif : des spans partent vers le collecteur local, le worker prolonge la trace de la mise en file', async () => {
    await fixtures();
    const { started } = await startInstance(on(collector.url), callingExecutor);
    expect(started.telemetry.enabled).toBe(true);

    let runId = '';
    let enqueueSpan = '';
    await withSpan('test.enqueue', {}, async () => {
      enqueueSpan = currentTraceparent() ?? '';
      runId = (await createRunRow()).runId;
    });
    expect(enqueueSpan).toMatch(/^00-/);
    expect((await jobData(runId))?.['_trace']).toBe(enqueueSpan); // contexte W3C porté par la charge du job
    await waitDone(runId);
    await started.app.inject({ method: 'GET', url: '/api/health' });
    await started.telemetry.forceFlush();

    expect(collector.requests.length).toBeGreaterThan(0);
    for (const r of collector.requests) {
      expect(r.method).toBe('POST');
      expect(r.url).toBe('/v1/traces');
      expect(r.headers['content-type']).toContain('application/json');
    }
    const spans = exportedSpans(collector);
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['test.enqueue', 'run.execute', 'http.request']));
    const root = spans.find((s) => s.name === 'test.enqueue')!;
    const exec = spans.find((s) => s.name === 'run.execute')!;
    expect(exec.traceId).toBe(root.traceId);
    expect(exec.parentSpanId).toBe(root.spanId);
    expect(exec.attributes).toEqual(expect.arrayContaining([{ key: 'run_id', value: { stringValue: runId } }]));
    const http = spans.find((s) => s.name === 'http.request' && s.attributes?.some((a) => a.value['stringValue'] === '/api/health'));
    expect(http).toBeDefined();
    expect(capture.connections.some((c) => c.endsWith(`:${collector.port}`))).toBe(true);
    expect(capture.nonLocal).toEqual([]);
  });

  test('assert_no_traceparent_outbound : OTel actif, le run appelle la cible et le faux LLM → ni traceparent, ni tracestate, ni baggage', async () => {
    await fixtures();
    const { started } = await startInstance(on(collector.url), callingExecutor);
    let runId = '';
    await withSpan('test.enqueue', {}, async () => {
      runId = (await createRunRow()).runId;
      // Appels faits DANS un span actif, par toutes les voies sortantes courantes.
      await fetch(`${target.url}/dans-le-span`);
      await get(`${target.url}/http-dans-le-span`);
    });
    await waitDone(runId);
    await started.telemetry.forceFlush();

    expect(target.requests.length).toBeGreaterThanOrEqual(5); // témoin : les appels sont bien arrivés (dont via le proxy)
    expect(llm.requests.length).toBeGreaterThanOrEqual(3);
    // Proxy : la requête en forme absolue et le CONNECT sont arrivés au proxy, dans le span actif du run.
    expect(proxy.requests.map((r) => `${r.method} ${r.url}`).sort()).toEqual([`CONNECT 127.0.0.1:${llm.port}`, `GET ${target.url}/via-proxy`]);
    for (const req of [...target.requests, ...llm.requests, ...proxy.requests]) {
      for (const name of TRACE_HEADERS) expect(req.headers[name], `${name} reçu par ${req.url}`).toBeUndefined();
    }
    // Les spans, eux, sont bien partis vers le collecteur (le contexte existe, il ne sort pas vers les cibles).
    expect(exportedSpans(collector).some((s) => s.name === 'run.execute')).toBe(true);
    expect(registeredPropagationFields()).toEqual([]); // aucun propagateur global enregistré
  });

  test('protocole par défaut http/protobuf : le collecteur reçoit du protobuf', async () => {
    await fixtures();
    const { started } = await startInstance(on(collector.url, { OTEL_EXPORTER_OTLP_PROTOCOL: '' }), callingExecutor);
    await withSpan('test.proto', {}, () => undefined);
    await started.telemetry.forceFlush();
    expect(collector.requests.length).toBeGreaterThan(0);
    expect(collector.requests[0]!.headers['content-type']).toContain('application/x-protobuf');
    expect(collector.requests[0]!.body.length).toBeGreaterThan(0);
  });

  test('en-têtes d’export (secret) transmis au collecteur, jamais journalisés', async () => {
    await fixtures();
    const secretHeader = `zz_test_otlp_${randomBytes(6).toString('hex')}`;
    const { started } = await startInstance(on(collector.url, { OTEL_EXPORTER_OTLP_HEADERS: `x-zz-auth=${secretHeader}` }), callingExecutor);
    await withSpan('test.headers', {}, () => undefined);
    await started.telemetry.forceFlush();
    expect(collector.requests[0]!.headers['x-zz-auth']).toBe(secretHeader);
    expect(secretValues.redactText(`en-tête ${secretHeader}`)).not.toContain(secretHeader);
  });
});

describe('assert_no_secret_in_logs : toutes les sorties', () => {
  test('canaris passés par le dépôt de secrets (clé LLM, proxy, cookie, Authorization), relus par le run : absents de stdout, run_logs, spans, métriques et artefacts', async () => {
    await fixtures();
    const llmKey = `zz_test_llm_${randomBytes(8).toString('hex')}`;
    const proxyPass = `zz_test_proxy_${randomBytes(8).toString('hex')}`;
    const cookie = `zz_test_cookie_${randomBytes(8).toString('hex')}`;
    const authz = `zz_test_authz_${randomBytes(8).toString('hex')}`;
    const host = `zz-host-${randomBytes(4).toString('hex')}`;
    const canaries = [llmKey, proxyPass, cookie, authz];
    const metricsToken = token();
    const stdout: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _e, done) {
        stdout.push(chunk.toString());
        done();
      },
    });
    // Le run relit ses secrets par le dépôt (comme la config LLM et proxy), seule source de leurs valeurs.
    const ids: Partial<Record<'llm' | 'proxy' | 'cookie' | 'authz', string>> = {};
    const executor: RunExecutor = async (ctx) => {
      const [instance] = servers;
      const store = secretStore(pool, instance!.config.keyring, await keyCheck(pool, { current: instance!.config.keyring.current }));
      const read = async (id: string) => (await store.get(id)).reveal();
      const [llmKey, proxyPass, cookie, authz] = [await read(ids.llm!), await read(ids.proxy!), await read(ids.cookie!), await read(ids.authz!)];
      // Utilisés pour de vrai : identifiants du proxy (Proxy-Authorization) et en-têtes vers la cible.
      const agent = new undici.ProxyAgent({ uri: `http://zz:${proxyPass}@127.0.0.1:${proxy.port}` });
      await (await undici.fetch(`${target.url}/avec-secrets`, { dispatcher: agent, headers: { authorization: `Bearer ${authz}`, cookie: `sid=${cookie}` } })).text();
      await agent.close();
      await ctx.log('info', `appel LLM avec ${llmKey}`, {
        llm: { apiKey: 'autre' },
        proxy: `http://user:${proxyPass}@proxy.example.test:8080`,
        headers: { Authorization: `Bearer ${authz}`, Cookie: `sid=${cookie}` },
        note: `x ${cookie} y`,
      });
      await withSpan('llm.call', { attributes: { proxy: `http://user:${proxyPass}@p.example.test`, 'gen_ai.prompt': `clé ${llmKey}`, cookie } }, () => undefined);
      return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: `échec ${authz}` };
    };
    const { started, worker } = await startInstance(on(collector.url), executor, { metricsToken, workerId: host, destination });
    // Dépôt de secrets : écriture (comme la configuration LLM et proxy de l'admin), puis oubli des valeurs par ce processus.
    const store = secretStore(pool, started.config.keyring, await keyCheck(pool, { current: started.config.keyring.current }));
    Object.assign(ids, {
      llm: await store.put({ ownerId: null, kind: 'llm.api_key', label: 'zz_test LLM', value: llmKey }),
      proxy: await store.put({ ownerId: null, kind: 'proxy.password', label: 'zz_test proxy', value: proxyPass }),
      cookie: await store.put({ ownerId: A, kind: 'site.cookie', label: 'zz_test cookie', value: cookie }),
      authz: await store.put({ ownerId: A, kind: 'http.authorization', label: 'zz_test authz', value: authz }),
    });
    for (const c of canaries) secretValues.delete(c);
    for (const c of canaries) expect(secretValues.redactText(c)).toBe(c); // le masquage par valeur ne les connaît plus
    const { runId } = await createRunRow();
    await vi.waitFor(async () => expect((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]?.state).toBe('failed'), { timeout: 30_000, interval: 100 });
    worker.sweep().catch(() => undefined);

    // Un artefact de niveau supérieur, avec canaris dans HAR (en-têtes, cookies).
    const checked = await keyCheck(pool, { current: started.config.keyring.current });
    const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'Authorization', value: `Bearer ${authz}` }], cookies: [{ name: 's', value: cookie }] }, response: {} }] } });
    const stored = await writeRunArtifact(pool, started.config.keyring, checked, { level: 'har_minimal', maxBytes: 1_000_000, quotaBytes: 10_000_000 }, {
      runId,
      ownerId: A,
      kind: 'har',
      content: har,
      run: { failed: true, serverSession: false, tunnel: false, challenge: false },
    });
    expect(stored.stored).toBe(true);

    await started.telemetry.forceFlush();
    await new Promise((r) => setTimeout(r, 600)); // un battement de worker au moins
    const metrics = await started.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${metricsToken}` } });
    expect(metrics.statusCode).toBe(200);

    const dump = async (sql: string) => JSON.stringify((await pool.query(sql)).rows);
    const sinks: Record<string, string> = {
      stdout: stdout.join(''),
      run_logs: await dump('SELECT event, data FROM run_logs'),
      run_error_detail: await dump('SELECT error_detail FROM runs'),
      spans: collector.requests.map((r) => r.body.toString()).join(''),
      metrics: metrics.body,
      artefacts: await dump('SELECT encode(ciphertext, \'hex\') AS c, encode(nonce, \'hex\') AS n FROM run_artifacts'),
    };
    // Témoins : les sorties existent et contiennent bien du contenu (le test ne passe pas à vide).
    expect(sinks['stdout']).toContain('worker');
    expect(sinks['run_logs']).toContain('run_claimed');
    expect(sinks['spans']).toContain('llm.call');
    expect(sinks['metrics']).toContain('scrapyomama_runs_total');
    expect(target.requests.find((r) => r.url === '/avec-secrets')?.headers['authorization']).toBe(`Bearer ${authz}`); // le secret a bien servi
    expect(sinks['metrics']).not.toContain(host); // nom d'hôte du worker jamais exposé
    for (const [name, text] of Object.entries(sinks)) {
      for (const c of canaries) expect(text, `${name} contient un canari`).not.toContain(c);
      expect(text, `${name} contient le jeton de métriques`).not.toContain(metricsToken);
    }
    // Contenu LLM coupé des spans.
    expect(sinks['spans']).not.toContain('gen_ai.prompt');
    // Artefact relisible (chiffré au repos), sans canari.
    const { readRunArtifact } = await import('@runtime/db');
    const opened = await readRunArtifact(pool, started.config.keyring, checked, (stored as { id: string }).id);
    for (const c of canaries) expect(opened!.content.toString()).not.toContain(c);
  });
});
