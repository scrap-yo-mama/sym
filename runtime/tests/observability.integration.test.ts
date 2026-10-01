// INV9 et INV8 de bout en bout (tâche 1.10) : `server` + `worker` réels sur base réelle, un run exécuté, un intercepteur
// réseau global et un collecteur OTLP de test.
// - assert_otel_off_by_default / assert_no_telemetry : sans OTEL_ENABLED (même avec un endpoint posé), 0 requête vers le
//   collecteur, 0 connexion vers lui, 0 destination non locale, aucun `_trace` dans la charge du job ;
// - assert_otel_optin_local_only : avec OTEL_ENABLED=true, des spans partent vers le collecteur local et c'est le seul trafic
//   en plus ; le span du worker est l'enfant du span qui a mis le job en file (`_trace`) ;
// - assert_no_traceparent_outbound : ni traceparent, ni tracestate, ni baggage vers la cible, le faux LLM, en HTTP comme en fetch ;
// - assert_no_secret_in_logs (toutes les sorties) : canaris absents de stdout, run_logs, spans, métriques et artefacts.
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createLogger,
  currentTraceparent,
  generateMasterKey,
  RUN_QUEUE,
  secretValues,
  withSpan,
  type RunExecutor,
} from '@runtime/core';
import { createRun, keyCheck, migrateUp, PgBossJobQueue, runQueueDefinition, withActor, writeRunArtifact } from '@runtime/db';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { loadWorkerConfig } from '../apps/worker/src/config.js';
import { startWorker, type Worker } from '../apps/worker/src/worker.js';
import { prepareServer, type Started } from '../apps/server/src/start.js';
import { captureNetwork, startRecorder, type NetCapture, type RecordedRequest } from './helpers/net-capture.js';
import { createTestDatabase, type TestDatabase } from './helpers/pg.js';
import { serverEnv } from './helpers/server.js';

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

afterEach(async () => {
  capture?.stop();
  for (const w of workers.splice(0)) await w.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const r of [collector, target, llm]) await r?.close();
  secretValues.clear();
  await pool.query("DELETE FROM runs; DELETE FROM worker_heartbeats; DELETE FROM pgboss.job WHERE name = 'run'");
});

afterAll(async () => {
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

/** Collecteur OTLP de test (JSON ou protobuf), cible et faux LLM locaux, puis capture du réseau. */
async function fixtures(): Promise<void> {
  collector = await startRecorder(() => ({ body: '{}', type: 'application/json' }));
  target = await startRecorder();
  llm = await startRecorder(() => ({ body: '{"choices":[]}', type: 'application/json' }));
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

/** Un run « réel » : appels à la cible et au faux LLM, par fetch et par http, journal de run. */
const callingExecutor: RunExecutor = async (ctx) => {
  await ctx.log('info', 'fixture_calls', { target: target.url });
  await fetch(`${target.url}/page`);
  await fetch(`${llm.url}/v1/chat/completions`, { method: 'POST', body: '{}' });
  await get(`${target.url}/http`);
  await get(`${llm.url}/http`);
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

const headerNames = (requests: RecordedRequest[]) => requests.flatMap((r) => Object.keys(r.headers));

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
    // Aucun en-tête de trace chez les cibles non plus.
    for (const name of headerNames([...target.requests, ...llm.requests])) expect(TRACE_HEADERS).not.toContain(name);
  });
});

describe('OTel opt-in explicite', () => {
  test('assert_otel_optin_local_only : des spans partent vers le collecteur local, le worker prolonge la trace de la mise en file, seul trafic en plus', async () => {
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
    // Le seul trafic en plus est vers le collecteur de test : aucune destination non locale.
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

    expect(target.requests.length).toBeGreaterThanOrEqual(4); // témoin : les appels sont bien arrivés
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
    for (const req of [...target.requests, ...llm.requests]) {
      for (const name of TRACE_HEADERS) expect(req.headers[name], `${name} reçu par ${req.url}`).toBeUndefined();
    }
    // Les spans, eux, sont bien partis vers le collecteur (le contexte existe, il ne sort pas vers les cibles).
    expect(exportedSpans(collector).some((s) => s.name === 'run.execute')).toBe(true);
    const { propagation } = await import('@opentelemetry/api');
    expect(propagation.fields()).toEqual([]); // aucun propagateur global enregistré
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
  test('canaris (clé LLM, proxy, cookie, Authorization) absents de stdout, run_logs, spans, métriques et artefacts', async () => {
    await fixtures();
    const llmKey = `zz_test_llm_${randomBytes(8).toString('hex')}`;
    const proxyPass = `zz_test_proxy_${randomBytes(8).toString('hex')}`;
    const cookie = `zz_test_cookie_${randomBytes(8).toString('hex')}`;
    const authz = `zz_test_authz_${randomBytes(8).toString('hex')}`;
    const canaries = [llmKey, proxyPass, cookie, authz];
    for (const c of canaries) secretValues.add(c);
    const metricsToken = token();
    const stdout: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _e, done) {
        stdout.push(chunk.toString());
        done();
      },
    });
    const executor: RunExecutor = async (ctx) => {
      await ctx.log('info', `appel LLM avec ${llmKey}`, {
        llm: { apiKey: 'autre' },
        proxy: `http://user:${proxyPass}@proxy.example.test:8080`,
        headers: { Authorization: `Bearer ${authz}`, Cookie: `sid=${cookie}` },
        note: `x ${cookie} y`,
      });
      await withSpan('llm.call', { attributes: { proxy: `http://user:${proxyPass}@p.example.test`, 'gen_ai.prompt': `clé ${llmKey}`, cookie } }, () => undefined);
      return { state: 'failed', failure_class: 'code_error', retryable: false, error_detail: `échec ${authz}` };
    };
    const { started, worker } = await startInstance(on(collector.url), executor, { metricsToken, workerId: `zz-host-${cookie}`, destination });
    const { runId } = await createRunRow();
    await vi.waitFor(async () => expect((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]?.state).toBe('failed'), { timeout: 30_000, interval: 100 });
    worker.sweep().catch(() => undefined);

    // Un artefact de niveau supérieur, avec canaris dans HAR (en-têtes, cookies).
    const checked = await keyCheck(pool, { current: started.config.keyring.current });
    const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'Authorization', value: `Bearer ${authz}` }], cookies: [{ name: 's', value: cookie }] }, response: {} }] } });
    const stored = await writeRunArtifact(pool, started.config.keyring, checked, { level: 'har_minimal', maxBytes: 1_000_000, quotaBytes: 10_000_000 }, { runId, ownerId: A, kind: 'har', content: har, run: { failed: true } });
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
