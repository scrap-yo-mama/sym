// SPDX-License-Identifier: AGPL-3.0-only
// B1 de bout en bout sur base réelle (CDC V1 sym-sessions) : une session consentie qui ne sert plus arrête le run en
// « session à rafraîchir » SANS requête, SANS réparation et sans changer le statut de l'API ; la cible qui répond 401 pendant
// le rejeu fait de même ; une session neuve repousse le run ; le test de validité (file `site-session-check`) passe par le
// chemin gardé du rejeu. Le serveur HTTP local enregistre ce qu'il reçoit.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DomainPacer, generateMasterKey, kekFor, MasterKey, secretValues } from '@runtime/core';
import * as net from '@runtime/core/net';
import {
  connectSite,
  consentedSessionForRun,
  createRun,
  enqueueSiteSessionCheck,
  keyCheck,
  listRefreshRequests,
  migrateUp,
  PgBossJobQueue,
  PgPacingStore,
  readRun,
  runQueueDefinition,
  storeSiteCookies,
  withActor,
} from '@runtime/db';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { EVIL_EXAMPLE, fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { createTestDatabase, type TestDatabase } from '../../../../tests/helpers/pg.js';
import { loadWorkerConfig } from '../config.js';
import { startWorker, type Worker } from '../worker.js';
import { createStrategyRuntime } from './strategy-executor.js';

const HOST = 'zz-sess-b1.example.test';
const FRESH = 'zz_test_b1_fresh_cookie_value';
const STALE = 'zz_test_b1_stale_cookie_value';
const A = randomUUID();
const B = randomUUID();
const actorA = { userId: A, role: 'member' as const };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let worker: Worker;
let kek: ReturnType<typeof kekFor>;
let port = 0;
const received: { host: string; path: string; cookie: string | undefined; method: string; authorization: string | undefined }[] = [];
const server = createServer((req, res) => {
  received.push({ host: (req.headers.host ?? '').split(':')[0]!, path: req.url ?? '', cookie: req.headers.cookie, method: req.method ?? '', authorization: req.headers.authorization });
  const cookie = req.headers.cookie ?? '';
  const path = req.url ?? '';
  if (path.startsWith('/login')) return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><title>Connexion</title></html>');
  if (path === '/' || path.startsWith('/api/')) {
    if (cookie.includes('zz_test_dead_redirect')) return void res.writeHead(302, { location: '/login?next=/' }).end();
    if (!cookie.includes(FRESH)) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: [{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Beta' }] }));
  }
  res.writeHead(404).end();
});

const SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false };
const spec = (path = '/api/items') => ({
  schema_version: 1,
  kind: 'declarative',
  request: { method: 'GET', url: `http://${HOST}:${port}${path}`, allowed_hosts: [HOST] },
  sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
  fields: { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true } },
});

async function insertApi(slug: string): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO apis (slug, owner_id, output_schema, domain_pacing, requires_session, requires, status) VALUES ($1, $2, $3, '{"min_delay_ms": 5, "max_requests_per_run": 50, "max_wait_ms": 60000}', true, $4, 'sain') RETURNING id`,
      [slug, A, JSON.stringify(SCHEMA), JSON.stringify({ session_domain: HOST })],
    )
  ).rows[0]!.id;
  await pool.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'tunnel', $3, 0, 'user')", [id, A, JSON.stringify(spec())]);
  await pool.query('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

const cookie = (value: string, over: object = {}) => ({ name: 'sid', value, domain: `.${HOST}`, path: '/', secure: false, httpOnly: true, expirationDate: Date.now() / 1000 + 30 * 86_400, ...over });
const push = (value: string) => withActor(pool, actorA, (db) => storeSiteCookies(db, kek, { ownerId: A, domain: HOST, cookies: [cookie(value)] as never }));

const runOf = async (apiId: string) => {
  const { runId } = await withActor(pool, actorA, (tx) => createRun(tx, queue, { apiId, ownerId: A, trigger: 'rest' }));
  await vi.waitFor(async () => expect(['succeeded', 'failed']).toContain((await pool.query<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId])).rows[0]!.state), { timeout: 30_000, interval: 100 });
  // Le statut est appliqué après la clôture du run : on attend la trace du worker.
  await vi.waitFor(async () => expect((await pool.query('SELECT 1 FROM run_logs WHERE run_id = $1 AND event = $2', [runId, 'run_finished'])).rowCount).toBe(1), { timeout: 10_000, interval: 100 });
  const run = (await withActor(pool, actorA, (tx) => readRun(tx, runId)))!;
  const trace = JSON.stringify([run, (await pool.query('SELECT to_jsonb(l)::text AS t FROM run_logs l WHERE run_id = $1', [runId])).rows, (await pool.query('SELECT to_jsonb(r)::text AS t FROM runs r WHERE id = $1', [runId])).rows]);
  return { run, runId, trace };
};

const events = async (owner = A) =>
  (await pool.query<{ event: string; outcome: string | null; run_id: string | null; site_session_id: string | null }>('SELECT event, outcome, run_id, site_session_id FROM site_session_events WHERE owner_id = $1 AND domain = $2 ORDER BY created_at, id', [owner, HOST])).rows;
const apiStatus = async (id: string) => (await pool.query<{ status: string; status_reason: string | null }>('SELECT status, status_reason FROM apis WHERE id = $1', [id])).rows[0]!;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  tdb = await createTestDatabase('sessb1');
  await migrateUp({ connectionString: tdb.url });
  const masterKey = generateMasterKey();
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  await keyCheck(pool, { current: MasterKey.parse(masterKey) });
  kek = kekFor(MasterKey.parse(masterKey), 0, 'site_sessions');
  await pool.query("INSERT INTO users (id, email, status) VALUES ($1, 'zz_test_b1_a@example.test', 'active'), ($2, 'zz_test_b1_b@example.test', 'active')", [A, B]);
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  const guard = fixtureGuard(port, [HOST, EVIL_EXAMPLE], net);
  const runtime = createStrategyRuntime({
    pool,
    guard,
    pacer: new DomainPacer(new PgPacingStore(pool), { policy: { minDelayMs: 50 } }),
    browsers: null,
    siteSessions: { kek },
    sessionProbeUrl: (domain) => new URL(`http://${domain}:${port}/`),
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: tdb.url, MASTER_KEY: masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '5', BROWSER_CONCURRENCY: '1' }),
    executorFactory: async () => ({ executor: runtime.executor, ...(runtime.sessionCheck === undefined ? {} : { sessionCheck: runtime.sessionCheck }) }),
    logger: pino({ level: 'silent' }),
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('session à rafraîchir (B1, F2, R7)', () => {
  test('assert_renewal_or_action_required : session expirée → run arrêté « à rafraîchir » sans aucune requête, sans réparation, statut inchangé ; refresh_requested ; signal ; poussée neuve → refreshed et le run repasse', async () => {
    await connectSite(pool, { ownerId: A, domain: HOST, serverUseAllowed: true });
    await push(STALE);
    // La session expire (fin de la dernière date de cookie dépassée).
    await pool.query("UPDATE site_sessions SET expires_at = now() - interval '1 minute' WHERE owner_id = $1 AND domain = $2", [A, HOST]);
    const apiId = await insertApi('zz_test_b1_expired');
    received.length = 0;
    const { run, runId, trace } = await runOf(apiId);
    expect(run.state).toBe('failed');
    expect(run.attempts.map((a) => a.result)).toEqual(['auth_required']);
    // Cause nommée, sans domaine d'un autre, sans valeur de secret.
    expect((await pool.query<{ error_detail: string; failure_class: string | null }>('SELECT error_detail, failure_class FROM runs WHERE id = $1', [runId])).rows[0]).toEqual({ error_detail: `session_to_refresh:${HOST}`, failure_class: null });
    // Aucune tentative réseau, aucune réparation, aucune autre version, statut de l'API inchangé.
    expect(received).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM runs WHERE api_id = $1 AND kind <> $2', [apiId, 'run'])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM strategy_versions WHERE api_id = $1', [apiId])).rowCount).toBe(1);
    expect(await apiStatus(apiId)).toEqual({ status: 'sain', status_reason: null });
    expect(trace).not.toContain(STALE);
    // refresh_requested écrit par le système, rattaché au run, sans valeur.
    const written = (await events()).filter((e) => e.event === 'refresh_requested');
    expect(written).toEqual([{ event: 'refresh_requested', outcome: 'cookie_expired', run_id: runId, site_session_id: expect.any(String) }]);
    // Signal pour l'extension : le domaine à rafraîchir.
    expect((await withActor(pool, actorA, (db) => listRefreshRequests(db, A))).map((r) => r.domain)).toEqual([HOST]);
    expect((await withActor(pool, { userId: B, role: 'member' }, (db) => listRefreshRequests(db, B))).map((r) => r.domain)).toEqual([]);
    // Poussée neuve : `refreshed`, signal éteint, le run repasse avec le Cookie neuf.
    expect(await push(FRESH)).toBe('stored');
    expect((await events()).map((e) => e.event)).toEqual(['refresh_requested', 'refreshed']);
    expect(await withActor(pool, actorA, (db) => listRefreshRequests(db, A))).toEqual([]);
    received.length = 0;
    const again = await runOf(apiId);
    expect(again.run).toMatchObject({ state: 'succeeded', items: 2 });
    expect(received.map((r) => [r.path, r.cookie, r.method, r.authorization])).toEqual([['/api/items', `sid=${FRESH}`, 'GET', undefined]]);
    expect(await apiStatus(apiId)).toEqual({ status: 'sain', status_reason: null });
  });

  test('assert_renewal_or_action_required : la cible répond 401 pendant le rejeu → arrêt « à rafraîchir », une seule requête, aucune réparation, refresh_requested', async () => {
    await push(STALE);
    const apiId = await insertApi('zz_test_b1_401');
    const before = (await events()).length;
    received.length = 0;
    const { run, runId, trace } = await runOf(apiId);
    expect(run.state).toBe('failed');
    expect(received.map((r) => [r.path, r.cookie])).toEqual([['/api/items', `sid=${STALE}`]]);
    expect((await pool.query<{ error_detail: string }>('SELECT error_detail FROM runs WHERE id = $1', [runId])).rows[0]!.error_detail).toBe(`session_to_refresh:${HOST}`);
    // Aucune réparation ni ré-enquête, aucune version de plus, statut inchangé.
    expect((await pool.query('SELECT 1 FROM runs WHERE api_id = $1 AND kind <> $2', [apiId, 'run'])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM strategy_versions WHERE api_id = $1', [apiId])).rowCount).toBe(1);
    expect(await apiStatus(apiId)).toEqual({ status: 'sain', status_reason: null });
    const added = (await events()).slice(before);
    expect(added.map((e) => e.event).sort()).toEqual(['refresh_requested', 'used']);
    expect(added.find((e) => e.event === 'used')).toMatchObject({ outcome: 'auth_required', run_id: runId });
    expect(added.find((e) => e.event === 'refresh_requested')).toMatchObject({ outcome: 'http_401', run_id: runId });
    expect(trace).not.toContain(STALE);
    expect((await withActor(pool, actorA, (db) => listRefreshRequests(db, A))).map((r) => r.domain)).toEqual([HOST]);
    // Session neuve : le run repasse.
    await push(FRESH);
    expect(await withActor(pool, actorA, (db) => listRefreshRequests(db, A))).toEqual([]);
    expect((await runOf(apiId)).run).toMatchObject({ state: 'succeeded', items: 2 });
  });

  test('sans consentement serveur (mode tunnel) ou pour un autre propriétaire : aucune demande de rafraîchissement, comportement d’avant', async () => {
    const apiId = await insertApi('zz_test_b1_consent');
    const runFor = async (owner: string, apiOwner: string) =>
      (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state) VALUES ($1, $2, $3, 'rest', 'queued') RETURNING id", [apiId, owner, apiOwner])).rows[0]!.id;
    // Consenti, run du propriétaire : oui.
    expect(await consentedSessionForRun(pool, { runId: await runFor(A, A), domain: HOST })).toMatchObject({ ownerId: A });
    // Run de B sur l'API de A : jamais la session de A (pas d'événement pour autrui).
    expect(await consentedSessionForRun(pool, { runId: await runFor(B, A), domain: HOST })).toBeNull();
    // Domaine non connecté, ou connecté en mode tunnel : pas de consentement serveur.
    expect(await consentedSessionForRun(pool, { runId: await runFor(A, A), domain: 'zz-sess-unknown.example.test' })).toBeNull();
    await connectSite(pool, { ownerId: A, domain: 'zz-sess-tunnel.example.test', serverUseAllowed: false });
    expect(await consentedSessionForRun(pool, { runId: await runFor(A, A), domain: 'zz-sess-tunnel.example.test' })).toBeNull();
  });
});

describe('test de validité (B1, F4) par le chemin gardé du rejeu', () => {
  async function check(): Promise<{ outcome: string | null; added: number }> {
    const site = (await pool.query<{ id: string }>('SELECT id FROM site_sessions WHERE owner_id = $1 AND domain = $2', [A, HOST])).rows[0]!;
    const before = (await events()).filter((e) => e.event === 'checked').length;
    await enqueueSiteSessionCheck(queue, { owner_id: A, site_session_id: site.id, domain: HOST });
    await vi.waitFor(async () => expect((await events()).filter((e) => e.event === 'checked').length).toBe(before + 1), { timeout: 30_000, interval: 100 });
    const all = (await events()).filter((e) => e.event === 'checked');
    return { outcome: all.at(-1)!.outcome, added: all.length - before };
  }

  test('assert_session_live_status : vivante → alive ; 401 → dead_http_401 ; redirection vers la connexion → dead_login_redirect ; last_checked_at écrit, GET seul, Cookie du domaine, jamais Authorization', async () => {
    await push(FRESH);
    received.length = 0;
    expect((await check()).outcome).toBe('alive');
    expect(received.map((r) => [r.method, r.path, r.cookie, r.authorization])).toEqual([['GET', '/', `sid=${FRESH}`, undefined]]);
    const site = (await pool.query<{ last_checked_at: Date | null }>('SELECT last_checked_at FROM site_sessions WHERE owner_id = $1 AND domain = $2', [A, HOST])).rows[0]!;
    expect(site.last_checked_at).not.toBeNull();
    await push(STALE);
    expect((await check()).outcome).toBe('dead_http_401');
    await push('zz_test_dead_redirect');
    received.length = 0;
    expect((await check()).outcome).toBe('dead_login_redirect');
    // La redirection n'est pas suivie jusqu'à la page de connexion : une seule requête.
    expect(received.map((r) => r.path)).toEqual(['/']);
    // Les codes sont courts, sans valeur ; rien d'autre n'est écrit que `checked` (pas de `used`).
    expect(JSON.stringify(await events())).not.toMatch(/zz_test_b1_|zz_test_dead_redirect/);
  });

  test('session expirée ou disparue : morte sans requête ; session supprimée : rien d’écrit ; secrets absents des événements', async () => {
    await push(FRESH);
    await pool.query("UPDATE site_sessions SET expires_at = now() - interval '1 minute' WHERE owner_id = $1 AND domain = $2", [A, HOST]);
    received.length = 0;
    expect((await check()).outcome).toBe('dead_expired');
    expect(received).toHaveLength(0);
    expect(secretValues.values()).toContain(FRESH);
    // La session disparaît avant que le worker ne traite le job : rien n'est écrit, aucune erreur.
    const site = (await pool.query<{ id: string }>('SELECT id FROM site_sessions WHERE owner_id = $1 AND domain = $2', [A, HOST])).rows[0]!;
    await pool.query('DELETE FROM site_sessions WHERE id = $1', [site.id]);
    const before = (await events()).length;
    await enqueueSiteSessionCheck(queue, { owner_id: A, site_session_id: site.id, domain: HOST });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await events()).length).toBe(before);
  });

  test('assert_ssrf_guard : le test d’un domaine qui résout vers une adresse privée est refusé par la garde, aucun octet ni cookie ne part', async () => {
    await connectSite(pool, { ownerId: A, domain: EVIL_EXAMPLE, serverUseAllowed: true });
    await withActor(pool, actorA, (db) => storeSiteCookies(db, kek, { ownerId: A, domain: EVIL_EXAMPLE, cookies: [cookie(FRESH, { domain: `.${EVIL_EXAMPLE}` })] as never }));
    const id = (await pool.query<{ id: string }>('SELECT id FROM site_sessions WHERE owner_id = $1 AND domain = $2', [A, EVIL_EXAMPLE])).rows[0]!.id;
    received.length = 0;
    await enqueueSiteSessionCheck(queue, { owner_id: A, site_session_id: id, domain: EVIL_EXAMPLE });
    await vi.waitFor(async () => expect((await pool.query("SELECT outcome FROM site_session_events WHERE site_session_id = $1 AND event = 'checked'", [id])).rows).toEqual([{ outcome: 'inconclusive_network' }]), { timeout: 30_000, interval: 100 });
    expect(received).toHaveLength(0);
  });

  test('propriétaire : un job qui nomme la session d’un autre propriétaire n’écrit rien', async () => {
    await connectSite(pool, { ownerId: B, domain: HOST, serverUseAllowed: true });
    const bSession = (await pool.query<{ id: string }>('SELECT id FROM site_sessions WHERE owner_id = $1 AND domain = $2', [B, HOST])).rows[0]!.id;
    const before = (await pool.query('SELECT 1 FROM site_session_events')).rowCount;
    // Le job réclame la session de B au nom de A : introuvable pour A.
    await enqueueSiteSessionCheck(queue, { owner_id: A, site_session_id: bSession, domain: HOST });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await pool.query('SELECT 1 FROM site_session_events')).rowCount).toBe(before);
    expect((await pool.query('SELECT last_checked_at FROM site_sessions WHERE id = $1', [bSession])).rows[0]).toEqual({ last_checked_at: null });
  });
});
