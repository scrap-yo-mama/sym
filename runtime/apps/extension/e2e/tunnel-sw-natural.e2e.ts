// SPDX-License-Identifier: AGPL-3.0-only
// Variante NOCTURNE du run en onglet caché (tâche 2.7, correctif 9 de la vérification ; 15 § 13 « test nocturne à
// attente naturelle ») : le service worker MV3 doit survivre SEUL, par le ping applicatif de 20 s (07 § 4), sans
// qu'aucun outil n'y soit attaché. Dans tunnel.e2e.ts, Playwright est attaché au service worker par CDP, ce qui
// neutralise l'arrêt pour inactivité de 30 s : ce test-là prouve l'onglet caché, pas la survie par le ping.
// Ici : appairage et site connecté sous Playwright, puis Chromium FERMÉ et relancé sur le même profil par un simple
// processus (aucun --remote-debugging, aucun CDP). Run en tunnel dont les commandes sont espacées de 45 s (> 30 s
// d'inactivité) : il aboutit, et la WSS n'a jamais été rouverte (même `conn_epoch` du début à la fin), donc le service
// worker n'a jamais été arrêté. Activé par `TUNNEL_SW_NATURAL=1` (≈ 4 min) ; ignoré sinon.
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, expect, test, type Page } from '@playwright/test';
import { createLogger, DomainPacer } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { createRun, PgBossJobQueue, PgPacingStore, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { loadWorkerConfig } from '../../worker/dist/config.js';
import { createStrategyExecutor } from '../../worker/dist/exec/strategy-executor.js';
import { TunnelJobClient } from '../../worker/dist/tunnel/client.js';
import { startWorker, type Worker } from '../../worker/dist/worker.js';
import { expectNoCspViolation, startHarness, type Harness, type User } from './harness.ts';

const SHOP = 'zz-test-shop.example';
const ENABLED = process.env['TUNNEL_SW_NATURAL'] === '1';
/** Écart entre deux commandes : au-delà des 30 s d'inactivité qui arrêtent un service worker MV3. */
const GAP_MS = Number(process.env['TUNNEL_SW_GAP_MS'] ?? '45000');
const PAGES = Number(process.env['TUNNEL_SW_PAGES'] ?? '4');
const silent = createLogger({ name: 'zz_test', level: 'fatal' });

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'name'],
  properties: { id: { type: 'string' }, name: { type: 'string' } },
  additionalProperties: false,
};

let h: Harness;
let alice: User;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let tunnel: TunnelJobClient;
let worker: Worker;
let browserProcess: ChildProcess | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!ENABLED, 'test nocturne à attente naturelle : TUNNEL_SW_NATURAL=1');

test.beforeAll(async () => {
  test.setTimeout(240_000);
  h = await startHarness();
  alice = await h.createMember('zz_test_tunnel_natural@example.test');
  pool = new pg.Pool({ connectionString: h.dbUrl, max: 4 });
  queue = new PgBossJobQueue({ connectionString: h.dbUrl, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  tunnel = new TunnelJobClient({ pool, sessionUrl: h.dbUrl, logger: silent, pollMs: 200 });
  await tunnel.start();
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: h.dbUrl, MASTER_KEY: h.masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '1', DISABLE_BROWSER: 'true' }),
    executor: createStrategyExecutor({
      pool,
      guard: new SsrfGuard({ policy: createSsrfPolicy({ allowedPorts: [], testAllowPrivate: false }) }),
      pacer: new DomainPacer(new PgPacingStore(pool)),
      browsers: null,
      tunnel,
    }),
    logger: silent,
  });
});

// assert_no_csp_violation (tâche 3.15) : relevé du harnais vérifié après chaque test.
test.afterEach(() => expectNoCspViolation(h));

test.afterAll(async () => {
  browserProcess?.kill('SIGKILL');
  await worker?.stop();
  await tunnel?.close();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await h?.close();
});

const connection = async () => (await h.sql<{ gateway_instance: string | null; conn_epoch: string }>('SELECT gateway_instance, conn_epoch::text FROM tunnels WHERE owner_id = $1', [alice.id]))[0];

test(`service worker sans CDP attaché : run aux commandes espacées de ${GAP_MS / 1000} s abouti sur la MÊME WSS (survie par le ping)`, async () => {
  test.setTimeout(PAGES * GAP_MS + 240_000);
  // 1. Appairage et site connecté (mode tunnel), sous Playwright.
  const code = await h.console(alice.cookie, 'POST', '/api/extension/pairing-codes', { currentPassword: alice.password });
  expect(code.status).toBe(201);
  const page: Page = await h.popup();
  await page.click('#manual summary'); // saisie à la main (secours de l'appairage en un collage)
  await page.fill('#instance-url', h.publicUrl);
  await page.fill('#pairing-code', (code.data as { code: string }).code);
  await h.grantHosts(['http://127.0.0.1/*']);
  await page.click('#pair');
  await expect(page.locator('#identity')).toHaveText(`Connected as ${alice.email}`);
  const site = await h.context.newPage();
  await site.goto(`http://${SHOP}:${h.sitePort}/`);
  await site.bringToFront();
  await page.reload();
  await page.click('#connect-site');
  await h.grantHosts([`https://${SHOP}/*`, `http://${SHOP}/*`]);
  await page.click('#consent-accept');
  await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('(tunnel)');

  // 2. Chromium fermé, puis relancé sur le même profil SANS Playwright : rien n'est attaché au service worker.
  await h.context.close();
  await expect.poll(async () => (await connection())?.gateway_instance ?? null, { timeout: 30_000 }).toBeNull();
  browserProcess = spawn(chromium.executablePath(), ['--headless', `--user-data-dir=${h.profile}`, '--no-first-run', '--no-default-browser-check', ...h.chromiumArgs, 'about:blank'], {
    stdio: 'ignore',
  });
  // L'extension se reconnecte d'elle-même (démarrage de Chrome, alarme de 30 s).
  await expect.poll(async () => (await connection())?.gateway_instance ?? null, { timeout: 90_000, intervals: [1000] }).not.toBeNull();
  // Démarrage du navigateur relancé : profil, permissions d'hôte et service worker stabilisés avant le run.
  await new Promise((r) => setTimeout(r, 5000));
  const before = (await connection())!.conn_epoch;

  // 3. Run en tunnel : PAGES commandes espacées de GAP_MS (cadence du domaine), observées par la base seulement.
  const [api] = await h.sql<{ id: string }>(
    "INSERT INTO apis (slug, owner_id, output_schema, domain_pacing, status, requires) VALUES ('zz_test_tunnel_natural', $1, $2, $3, 'sain', $4) RETURNING id",
    [alice.id, JSON.stringify(SCHEMA), JSON.stringify({ min_delay_ms: GAP_MS, max_requests_per_run: 50, max_wait_ms: GAP_MS * 3 }), JSON.stringify({ session_domain: SHOP, tunnel: true })],
  );
  const spec = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `http://${SHOP}:${h.sitePort}/api/items?pages=${PAGES}`, allowed_hosts: [SHOP], params: [{ at: 'url.query.page', role: 'pagination' }] },
    sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
    fields: { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true } },
    pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }, { when: 'path_equals', path: '$.has_more', value: false }], limits: { hard_max_pages: 50 } },
  };
  await h.sql("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch_in_page', 'tunnel', $3, 0, 'user')", [
    api!.id,
    alice.id,
    JSON.stringify(spec),
  ]);
  await h.sql('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [api!.id]);
  const { runId } = await withActor(pool, { userId: alice.id, role: 'member' }, (tx) => createRun(tx, queue, { apiId: api!.id, ownerId: alice.id, trigger: 'rest' }));
  const started = Date.now();
  const epochs = new Set<string>([before]);
  for (;;) {
    const [run] = await h.sql<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId]);
    const now = await connection();
    if (now?.gateway_instance !== null && now !== undefined) epochs.add(now.conn_epoch);
    if (run!.state !== 'queued' && run!.state !== 'running' && run!.state !== 'waiting_tunnel') break;
    expect(Date.now() - started).toBeLessThan(PAGES * GAP_MS + 150_000);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const [run] = await h.sql<{ state: string; items: number; failure_class: string | null; error_detail: string | null }>('SELECT state, items, failure_class, error_detail FROM runs WHERE id = $1', [runId]);
  const jobs = await h.sql<{ state: string; error: string | null }>('SELECT state, error FROM tunnel_jobs WHERE run_id = $1 ORDER BY created_at', [runId]);
  expect(run, JSON.stringify({ run, jobs })).toMatchObject({ state: 'succeeded', items: PAGES * 10 });
  expect((Date.now() - started) / 1000).toBeGreaterThanOrEqual(((PAGES - 1) * GAP_MS) / 1000);
  // Même connexion du début à la fin : le service worker n'a jamais été arrêté puis relancé par l'alarme.
  expect([...epochs]).toEqual([before]);
  expect((await connection())!.conn_epoch).toBe(before);
});
