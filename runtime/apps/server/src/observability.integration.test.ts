// SPDX-License-Identifier: AGPL-3.0-only
// Sondes, métriques et journal du `server` (tâche 1.10, 14 § 3) sur base réelle : `/api/health` (vivant, sans base),
// `/api/ready` (503 tant que les migrations manquent, `key_check` en échec ou base coupée), `/metrics` FERMÉ par défaut
// (assert_metrics_closed), détail réservé aux administrateurs, journal de requêtes masqué.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { createKeyCheck, createLogger, generateMasterKey, MasterKey, secretValues } from '@runtime/core';
import { beatWorker, expectedSchemaVersion, KEY_CHECK_SETTING, loadMigrations, migrateDown, migrateUp, schemaVersionRefusal } from '@runtime/db';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { createTestDatabase, withClient } from '../../../tests/helpers/pg.js';
import { createUser, PUBLIC_URL, runSetup, serverEnv, sessionCookie, signIn, startTestServer, type TestServer } from '../../../tests/helpers/server.js';
import { DEFERRED_METRICS } from './metrics.js';
import { prepareServer, type Started } from './start.js';

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
  test('`/api/health` : 200 sans accès base, avant l’initialisation, `{status, version}` (version de l’application seule, aucun nom d’hôte)', async () => {
    const srv = await server();
    const res = await get(srv, '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '0.0.0' });
    const versioned = await server({ RUNTIME_VERSION: '1.4.2-beta.1' });
    expect((await get(versioned, '/api/health')).json()).toEqual({ status: 'ok', version: '1.4.2-beta.1' });
  });

  test('RUNTIME_VERSION hors format (espaces, chemin, longueur) : démarrage refusé', async () => {
    const tdb = await createTestDatabase('obs_ver');
    try {
      await migrateUp({ connectionString: tdb.url });
      for (const bad of ['1.0 beta', 'node/24.1', 'x'.repeat(65)]) {
        await expect(prepareServer(serverEnv(tdb.url, generateMasterKey(), token(), { RUNTIME_VERSION: bad }))).rejects.toThrow(/RUNTIME_VERSION/);
      }
    } finally {
      await tdb.drop();
    }
  });

  test('`/api/ready` : 200 quand tout va bien, avec les contrôles en booléens', async () => {
    const srv = await server();
    const res = await get(srv, '/api/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: true, schema: true, key_check: true }, initialized: false });
  });

  test('base vierge : le server démarre en mode dégradé (`/api/health` 200, `/api/ready` 503, le reste 503) puis `runtime migrate` → 200 sans redémarrage', async () => {
    const tdb = await createTestDatabase('obs_fresh');
    const bootstrap = token();
    let started: Started | undefined;
    try {
      started = await prepareServer(serverEnv(tdb.url, generateMasterKey(), bootstrap), { schemaPollMs: 60_000 });
      const inject = (method: 'GET' | 'POST', url: string, payload?: object) => started!.app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect((await inject('GET', '/api/health')).json()).toEqual({ status: 'ok', version: '0.0.0' });
      const before = await inject('GET', '/api/ready');
      expect(before.statusCode).toBe(503);
      expect(before.json()).toEqual({ status: 'not_ready', checks: { database: true, schema: false, key_check: false } });
      // Aucune autre route tant que le schéma manque (ni assistant, ni auth, ni métriques).
      const setupEarly = await inject('POST', '/api/setup', { token: bootstrap, email: 'zz_test_owner@example.test', password: 'zz_test_password_123456' });
      expect(setupEarly.statusCode).toBe(503);
      expect(setupEarly.json()).toMatchObject({ error: { code: 'not_ready', message: expect.any(String) } });
      expect((await inject('POST', '/api/auth/sign-in/email', { email: 'a@example.test', password: 'x' })).statusCode).toBe(503);
      expect((await inject('GET', '/api/ready?detail=1')).statusCode).toBe(503);
      // Aucun effet de bord avant la migration : pas de key_check écrit.
      await migrateUp({ connectionString: tdb.url });
      const after = await inject('GET', '/api/ready');
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ status: 'ready', checks: { database: true, schema: true, key_check: true }, initialized: false });
      // Initialisation terminée : l'assistant s'ouvre avec le jeton d'amorçage.
      const setup = await inject('POST', '/api/setup', { token: bootstrap, email: 'zz_test_owner@example.test', password: `zz_test_${randomBytes(12).toString('base64url')}` });
      expect(setup.statusCode).toBe(201);
    } finally {
      await started?.close();
      await tdb.drop();
    }
  });

  test('base en retard d’une migration (image N déployée avant `runtime migrate`) : mode dégradé, puis prêt après la migration', async () => {
    const tdb = await createTestDatabase('obs_late');
    const migrations = loadMigrations();
    let started: Started | undefined;
    try {
      await migrateUp({ connectionString: tdb.url, migrations: migrations.slice(0, -1) });
      started = await prepareServer(serverEnv(tdb.url, generateMasterKey(), token()), { schemaPollMs: 60_000 });
      expect((await started.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(503);
      expect((await started.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      await migrateUp({ connectionString: tdb.url });
      expect((await started.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
    } finally {
      await started?.close();
      await tdb.drop();
    }
  });

  test('schéma déjà migré mais 503 si une migration disparaît en cours de route ; 200 dès qu’elle est rejouée', async () => {
    const srv = await server();
    await migrateDown({ connectionString: srv.db.url, steps: 1 });
    const down = await get(srv, '/api/ready');
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: 'not_ready', checks: { database: true, schema: false, key_check: false } });
    expect((await get(srv, '/api/health')).statusCode).toBe(200);
    await migrateUp({ connectionString: srv.db.url });
    expect((await get(srv, '/api/ready')).statusCode).toBe(200);
  });

  test('initialisation différée impossible (aucun owner, aucun ADMIN_BOOTSTRAP_TOKEN) : erreur fatale signalée, `/api/ready` reste 503', async () => {
    const tdb = await createTestDatabase('obs_fatal');
    let started: Started | undefined;
    try {
      await migrateUp({ connectionString: tdb.url, migrations: loadMigrations().slice(0, -1) });
      const fatal: Error[] = [];
      started = await prepareServer(serverEnv(tdb.url, generateMasterKey(), null), { schemaPollMs: 60_000, onFatal: (e) => fatal.push(e) });
      await migrateUp({ connectionString: tdb.url });
      expect((await started.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(503);
      expect(fatal.map((e) => e.message)).toEqual([expect.stringMatching(/premier démarrage sans ADMIN_BOOTSTRAP_TOKEN/)]);
    } finally {
      await started?.close();
      await tdb.drop();
    }
  });

  test('base vierge sans ADMIN_BOOTSTRAP_TOKEN : refus immédiat (aucun owner possible) ; schéma plus récent que le code : refus avec les versions', async () => {
    const tdb = await createTestDatabase('obs_refuse');
    try {
      await expect(prepareServer(serverEnv(tdb.url, generateMasterKey(), null))).rejects.toThrow(/premier démarrage sans ADMIN_BOOTSTRAP_TOKEN/);
      await migrateUp({ connectionString: tdb.url });
      const newer = loadMigrations().at(-1)!.version + 1;
      await withClient(tdb.url, (c) => c.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'zz_test_future', 'x')", [newer]));
      await expect(prepareServer(serverEnv(tdb.url, generateMasterKey(), token()))).rejects.toThrow(schemaVersionRefusal(newer, expectedSchemaVersion(), 'server')!);
    } finally {
      await tdb.drop();
    }
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
    await srv.db.dropForce(); // DROP DATABASE … WITH (FORCE) : les connexions du pool sont coupées (panne de base voulue)
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
      await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 1, $2, 'fetch', 'dc_proxy', 'user')", [api.rows[0]!.id, owner.id]);
      await c.query("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, strategy_version, duration_ms) VALUES ($1, $2, $2, 'rest', 'succeeded', 'clean', 1, 3200)", [api.rows[0]!.id, owner.id]);
      await beatWorker(c, { workerId: 'zz-host-1', version: '1.0.0', browserContexts: 2, rssMb: 321 });
    });
    const res = await get(srv, '/metrics', { authorization: `Bearer ${metricsToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('scrapyomama_runs_total{state="failed",outcome="failed",trigger="rest"} 1');
    expect(res.body).toContain('scrapyomama_failures_total{failure_class="network"} 1');
    // Durée des runs (histogramme calculé depuis la base) par exécution et réseau.
    expect(res.body).toContain('# TYPE scrapyomama_run_duration_seconds histogram');
    expect(res.body).toContain('scrapyomama_run_duration_seconds_bucket{le="1",execution="fetch",network="dc_proxy"} 0');
    expect(res.body).toContain('scrapyomama_run_duration_seconds_bucket{le="5",execution="fetch",network="dc_proxy"} 1');
    expect(res.body).toContain('scrapyomama_run_duration_seconds_bucket{le="+Inf",execution="fetch",network="dc_proxy"} 1');
    expect(res.body).toContain('scrapyomama_run_duration_seconds_sum{execution="fetch",network="dc_proxy"} 3.2');
    expect(res.body).toContain('scrapyomama_run_duration_seconds_count{execution="fetch",network="dc_proxy"} 1');
    // Mémoire des workers (battement) sous l'identifiant opaque.
    expect(res.body).toMatch(/scrapyomama_worker_rss_mb\{worker="[0-9a-f]{10}"\} 321/);
    // Aucune version de dépendance (ni Node) dans ce qui sort.
    expect(res.body).not.toMatch(/version_info|nodejs_version|v\d+\.\d+\.\d+/);
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

  test('14 § 3 : chaque métrique clé est exposée avec ses étiquettes, ou son report est consigné vers la tâche qui la produira', async () => {
    const SPEC: Record<string, string[]> = {
      runs_total: ['state', 'outcome', 'trigger'],
      run_duration_seconds: ['execution', 'network'],
      run_cost_usd_total: ['kind'],
      failures_total: ['failure_class'],
      apis: ['status'],
      status_transitions_total: ['from', 'to'],
      queue_jobs: ['queue', 'state'],
      queue_oldest_job_age_seconds: [],
      llm_requests_total: ['role', 'status'],
      llm_tokens_total: ['role', 'direction'],
      browser_contexts_active: [],
      browser_crashes_total: [],
      worker_last_heartbeat_age_seconds: ['worker'],
      sandbox_violations_total: ['kind'],
      tunnel_connected: [],
    };
    const metricsToken = token();
    const srv = await server({ METRICS_TOKEN: metricsToken });
    const owner = await runSetup(srv);
    await withClient(srv.db.url, async (c) => {
      const api = await c.query<{ id: string }>("INSERT INTO apis (slug, owner_id) VALUES ('zz_test_spec', $1) RETURNING id", [owner.id]);
      await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', 'user')", [api.rows[0]!.id, owner.id]);
      await c.query("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, failure_class, strategy_version, duration_ms) VALUES ($1, $2, $2, 'rest', 'failed', 'failed', 'network', 1, 10)", [api.rows[0]!.id, owner.id]);
      await c.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason) VALUES ($1, $2, NULL, 'enquete', 'zz_test')", [api.rows[0]!.id, owner.id]);
      await c.query("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger) VALUES ($1, $2, $2, 'rest')", [api.rows[0]!.id, owner.id]);
      await beatWorker(c, { workerId: 'zz-host-spec', version: '1.0.0', browserContexts: 0 });
    });
    const body = (await get(srv, '/metrics', { authorization: `Bearer ${metricsToken}` })).body;
    const missing: string[] = [];
    for (const [name, labels] of Object.entries(SPEC)) {
      const deferred = DEFERRED_METRICS.filter((d) => d.metric === name);
      for (const d of deferred) expect(d.task, `${name} : tâche de report`).toMatch(/^\d\.\d+[ab]?$/);
      if (deferred.some((d) => d.labels === undefined)) continue; // métrique entière reportée
      if (!body.includes(`# TYPE scrapyomama_${name} `)) {
        missing.push(name);
        continue;
      }
      const expected = labels.filter((l) => !deferred.some((d) => d.labels?.includes(l)));
      const sample = body.split('\n').find((line) => line.startsWith(`scrapyomama_${name}{`) || line.startsWith(`scrapyomama_${name}_bucket{`) || line.startsWith(`scrapyomama_${name} `));
      expect(sample, `${name} : aucune valeur`).toBeDefined();
      for (const l of expected) expect(sample, `${name} : étiquette ${l}`).toContain(`${l}="`);
    }
    expect(missing).toEqual([]);
    // Un report n'existe que pour une métrique (ou une étiquette) réellement absente.
    for (const d of DEFERRED_METRICS) {
      if (d.labels === undefined) expect(body, `${d.metric} reportée mais exposée`).not.toContain(`# TYPE scrapyomama_${d.metric} `);
      else expect(body, `${d.metric} : étiquette reportée mais exposée`).not.toMatch(new RegExp(`scrapyomama_${d.metric}\\{[^}]*\\b${d.labels[0]}="`));
    }
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
