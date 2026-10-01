// Sondes, métriques et journal du `server` (tâche 1.10, 14 § 3) sur base réelle : `/api/health` (vivant, sans base),
// `/api/ready` (503 tant que les migrations manquent, `key_check` en échec ou base coupée), `/metrics` FERMÉ par défaut
// (assert_metrics_closed), détail réservé aux administrateurs, journal de requêtes masqué.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createKeyCheck, createLogger, generateMasterKey, MasterKey, secretValues } from '@runtime/core';
import { beatWorker, KEY_CHECK_SETTING, migrateDown, migrateUp } from '@runtime/db';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDatabase, withClient } from '../../../tests/helpers/pg.js';
import { createUser, PUBLIC_URL, runSetup, serverEnv, sessionCookie, signIn, startTestServer, type TestServer } from '../../../tests/helpers/server.js';
import { prepareServer } from './start.js';

const token = () => randomBytes(32).toString('base64url');
const open: TestServer[] = [];
async function server(extra: NodeJS.ProcessEnv = {}): Promise<TestServer> {
  const srv = await startTestServer('obs', extra);
  open.push(srv);
  return srv;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  secretValues.clear();
});
afterAll(() => secretValues.clear());

const get = (srv: TestServer, url: string, headers: Record<string, string> = {}) => srv.app.inject({ method: 'GET', url, headers });

describe('sondes', () => {
  test('`/api/health` : 200 sans accès base, avant l’initialisation, sans version ni nom d’hôte', async () => {
    const srv = await server();
    const res = await get(srv, '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  test('`/api/ready` : 200 quand tout va bien, avec les contrôles en booléens', async () => {
    const srv = await server();
    const res = await get(srv, '/api/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: true, schema: true, key_check: true }, initialized: false });
  });

  test('`/api/ready` = 503 tant que les migrations manquent ; `/api/health` reste 200 ; 200 dès qu’elles sont appliquées', async () => {
    const srv = await server();
    await migrateDown({ connectionString: srv.db.url, steps: 1 });
    const down = await get(srv, '/api/ready');
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: 'not_ready', checks: { database: true, schema: false, key_check: false } });
    expect((await get(srv, '/api/health')).statusCode).toBe(200);
    await migrateUp({ connectionString: srv.db.url });
    expect((await get(srv, '/api/ready')).statusCode).toBe(200);
  });

  test('`/api/ready` = 503 si `key_check` ne correspond pas à la clé du processus (liste des contrôles en échec)', async () => {
    const srv = await server();
    // Témoin d'une autre clé (instance restaurée avec la mauvaise MASTER_KEY).
    const other = createKeyCheck(MasterKey.parse(generateMasterKey()), 1);
    await withClient(srv.db.url, (c) => c.query('UPDATE settings SET value = $2::jsonb WHERE key = $1', [KEY_CHECK_SETTING, JSON.stringify(other)]));
    const res = await get(srv, '/api/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json<{ checks: Record<string, boolean> }>().checks).toEqual({ database: true, schema: true, key_check: false });
    expect((await get(srv, '/api/health')).statusCode).toBe(200);
  });

  test('base coupée : `/api/ready` = 503 (database false), `/api/health` = 200, aucun message d’erreur de la base dans la réponse', async () => {
    const srv = await server();
    await srv.db.drop(); // DROP DATABASE … WITH (FORCE) : les connexions du pool sont coupées
    const ready = await get(srv, '/api/ready');
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready', checks: { database: false, schema: false, key_check: false } });
    expect(ready.body).not.toMatch(/ECONN|password|127\.0\.0\.1|FATAL|terminat/i);
    expect((await get(srv, '/api/health')).statusCode).toBe(200);
  });

  test('`/api/ready?detail=1` : réservé aux administrateurs ; workers vivants et profondeur de file, sans nom d’hôte', async () => {
    const srv = await server();
    const owner = await runSetup(srv);
    const member = await createUser(srv, 'zz_test_member@example.test', 'member');
    await withClient(srv.db.url, (c) => beatWorker(c, { workerId: 'zz-hostname-42-abcdef', version: '1.0.0', browserContexts: 1, rssMb: 200 }));

    expect((await get(srv, '/api/ready?detail=1')).statusCode).toBe(401);
    expect((await get(srv, '/api/ready?detail=1', { cookie: await signIn(srv, member) })).statusCode).toBe(403);
    const res = await get(srv, '/api/ready?detail=1', { cookie: await signIn(srv, owner) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ workers: { id: string; alive: boolean; browser_contexts: number }[]; queue: { queued: number } }>();
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0]).toMatchObject({ alive: true, browser_contexts: 1 });
    expect(res.body).not.toContain('zz-hostname-42-abcdef');
    expect(body.queue).toMatchObject({ queued: 0, running: 0 });
    // Sans `detail`, rien de plus que les booléens.
    expect(Object.keys((await get(srv, '/api/ready')).json())).toEqual(['status', 'checks', 'initialized']);
  });

  test('les workers vivants n’entrent pas dans le code de retour de `/api/ready` (aucun worker : 200)', async () => {
    const srv = await server();
    expect((await get(srv, '/api/ready')).statusCode).toBe(200);
  });
});

describe('assert_metrics_closed', () => {
  test('sans METRICS_TOKEN : 404 (route inexistante), avec ou sans en-tête ; jamais de contenu', async () => {
    const srv = await server();
    for (const headers of [{}, { authorization: 'Bearer quelque-chose' }] as Record<string, string>[]) {
      const res = await get(srv, '/metrics', headers);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('scrapyomama_');
    }
    // Avant l'initialisation comme après : toujours fermé.
    await runSetup(srv);
    expect((await get(srv, '/metrics')).statusCode).toBe(404);
  });

  test('avec METRICS_TOKEN : 401 sans jeton ou avec un faux jeton, 200 avec le bon ; texte Prometheus préfixé, étiquettes bornées', async () => {
    const metricsToken = token();
    const srv = await server({ METRICS_TOKEN: metricsToken });
    expect((await get(srv, '/metrics')).statusCode).toBe(401);
    expect((await get(srv, '/metrics', { authorization: `Bearer ${token()}` })).statusCode).toBe(401);
    expect((await get(srv, '/metrics', { authorization: `Basic ${metricsToken}` })).statusCode).toBe(401);
    expect((await get(srv, '/metrics', { authorization: metricsToken })).statusCode).toBe(401);

    const owner = await runSetup(srv);
    await withClient(srv.db.url, async (c) => {
      const api = await c.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_metrics', $1) RETURNING id", [owner.id]);
      await c.query("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, failure_class, cost_llm_usd) VALUES ($1, $2, $2, 'rest', 'failed', 'failed', 'network', 0.5)", [api.rows[0]!.id, owner.id]);
      await beatWorker(c, { workerId: 'zz-host-1', version: '1.0.0', browserContexts: 2 });
    });
    const res = await get(srv, '/metrics', { authorization: `Bearer ${metricsToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('scrapyomama_runs_total{state="failed",outcome="failed",trigger="rest"} 1');
    expect(res.body).toContain('scrapyomama_failures_total{failure_class="network"} 1');
    expect(res.body).toContain('scrapyomama_run_cost_usd_total{kind="llm"} 0.5');
    expect(res.body).toContain('scrapyomama_apis{status="enquete"} 1');
    expect(res.body).toContain('scrapyomama_workers_alive 1');
    expect(res.body).toContain('scrapyomama_browser_contexts_active 2');
    expect(res.body).toContain('scrapyomama_process_cpu_user_seconds_total');
    // Étiquettes interdites : run_id, api_id, domaine, URL ; jamais le jeton ni le nom d'hôte d'un worker.
    expect(res.body).not.toMatch(/run_id|api_id|zz_test_metrics/);
    expect(res.body).not.toContain(metricsToken);
    expect(res.body).not.toContain('zz-host-1');
    // Métrique du worker exposée sous un identifiant opaque.
    expect(res.body).toMatch(/scrapyomama_worker_last_heartbeat_age_seconds\{worker="[0-9a-f]{10}"\}/);
  });

  test('METRICS_TOKEN trop court : démarrage refusé', async () => {
    const tdb = await createTestDatabase('obs_short');
    try {
      await migrateUp({ connectionString: tdb.url });
      await expect(prepareServer(serverEnv(tdb.url, generateMasterKey(), token(), { METRICS_TOKEN: 'court' }))).rejects.toThrow(/METRICS_TOKEN trop court/);
    } finally {
      await tdb.drop();
    }
  });
});

describe('journal du server', () => {
  test('requêtes avec jeton en paramètre, en-tête Authorization et cookie : 0 occurrence dans la sortie du journal', async () => {
    const canary = `zz_test_canary_${randomBytes(8).toString('hex')}`;
    const metricsToken = token();
    secretValues.add(canary);
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _e, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const tdb = await createTestDatabase('obs_log');
    let closeServer: (() => Promise<void>) | undefined;
    try {
      await migrateUp({ connectionString: tdb.url });
      const started = await prepareServer(serverEnv(tdb.url, generateMasterKey(), token(), { METRICS_TOKEN: metricsToken }), {
        loggerInstance: createLogger({ name: 'server', destination }) as FastifyBaseLogger,
      });
      closeServer = started.close;
      await started.app.inject({ method: 'GET', url: `/api/ready?token=${canary}&api_key=${canary}` });
      await started.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${canary}`, cookie: `sid=${canary}` } });
      await started.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${metricsToken}` } });
      await started.app.inject({ method: 'POST', url: '/api/setup', payload: { token: canary, email: 'x@example.test', password: canary } });
      const out = lines.join('');
      expect(out.length).toBeGreaterThan(0); // le journal a bien écrit
      expect(out).not.toContain(canary);
      expect(out).not.toContain(metricsToken);
      expect(out).toContain('"name":"server"');
    } finally {
      await closeServer?.();
      await tdb.drop();
    }
  });
});

test('PUBLIC_URL et session : la connexion d’un administrateur fonctionne après les sondes (témoin de non-régression)', async () => {
  const srv = await server();
  const owner = await runSetup(srv);
  const res = await srv.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: PUBLIC_URL }, payload: { email: owner.email, password: owner.password } });
  expect(sessionCookie(res)).toContain('sy.session');
});
