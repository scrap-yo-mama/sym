// SPDX-License-Identifier: AGPL-3.0-only
// E2 (tâche 2.7, 07 § 3-6) : l'extension construite, chargée dans Chromium, contre une instance réelle (passerelle WSS)
// et un worker réel (mode réseau `tunnel`), sur des sites de fixtures en boucle locale. Aucun site réel.
// - WSS ouverte par le service worker à l'appairage (jeton dans le premier message, Origin de l'extension) ;
// - run E2 en tunnel : `page_fetch` dans un onglet d'automatisation `active: false`, `autoDiscardable: false`, groupé
//   « Scrapyomama » ;
// - défi simulé → 0 commande après la détection, run arrêté `challenge_in_tunnel`, API en `action_requise`, aucune
//   prise de contrôle (assert_challenge_in_tunnel_stops) ;
// - run de 5 min en onglet caché abouti (07 § 4 ; `TUNNEL_HIDDEN_RUN_SECONDS`, défaut 300).
import { expect, test, type Page } from '@playwright/test';
import { createLogger, DomainPacer } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import { createRun, PgBossJobQueue, PgPacingStore, runQueueDefinition, withActor } from '@runtime/db';
import pg from 'pg';
import { loadWorkerConfig } from '../../worker/dist/config.js';
import { createStrategyExecutor } from '../../worker/dist/exec/strategy-executor.js';
import { TunnelJobClient } from '../../worker/dist/tunnel/client.js';
import { startWorker, type Worker } from '../../worker/dist/worker.js';
import { expectNoCspViolation, startHarness, type Harness, type User } from './harness.ts';

type Tab = { id?: number; url?: string; active: boolean; autoDiscardable: boolean; discarded: boolean; groupId: number };
type ChromeApi = {
  tabs: { query(q: object): Promise<Tab[]> };
  tabGroups: { get(id: number): Promise<{ title?: string }> };
};
type SwGlobal = { chrome: ChromeApi };

const SHOP = 'zz-test-shop.example';
const HIDDEN_RUN_SECONDS = Number(process.env['TUNNEL_HIDDEN_RUN_SECONDS'] ?? '300');
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

test.describe.configure({ mode: 'serial' });

/** Stratégie E2 déclarative : liste JSON paginée du site, par `fetch` dans la page. */
function itemsSpec(path: string, pages: number): Record<string, unknown> {
  return {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `http://${SHOP}:${h.sitePort}${path}?pages=${pages}`, allowed_hosts: [SHOP], params: [{ at: 'url.query.page', role: 'pagination' }] },
    sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
    fields: { id: { path: '$.id', type: 'string', required: true }, name: { path: '$.name', type: 'string', required: true } },
    pagination: {
      type: 'page_param',
      param: 'url.query.page',
      start: 1,
      stop: [{ when: 'records_empty' }, { when: 'path_equals', path: '$.has_more', value: false }],
      limits: { hard_max_pages: 50 },
    },
  };
}

async function insertApi(slug: string, spec: unknown, minDelayMs: number, execution = 'fetch_in_page'): Promise<string> {
  const [api] = await h.sql<{ id: string }>(
    "INSERT INTO apis (slug, owner_id, output_schema, domain_pacing, status, requires) VALUES ($1, $2, $3, $4, 'sain', $5) RETURNING id",
    [slug, alice.id, JSON.stringify(SCHEMA), JSON.stringify({ min_delay_ms: minDelayMs, max_requests_per_run: 50, max_wait_ms: Math.max(60_000, minDelayMs * 3) }), JSON.stringify({ session_domain: SHOP, tunnel: true })],
  );
  await h.sql("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, $4, 'tunnel', $3, 0, 'user')", [
    api!.id,
    alice.id,
    JSON.stringify(spec),
    execution,
  ]);
  await h.sql('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [api!.id]);
  return api!.id;
}

async function startRun(apiId: string): Promise<string> {
  const { runId } = await withActor(pool, { userId: alice.id, role: 'member' }, (tx) => createRun(tx, queue, { apiId, ownerId: alice.id, trigger: 'rest' }));
  return runId;
}

async function waitRun(runId: string, timeoutMs: number): Promise<{ state: string; failure_class: string | null; error_detail: string | null; items: number }> {
  await expect
    .poll(async () => (await h.sql<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId]))[0]!.state, { timeout: timeoutMs, intervals: [500] })
    .toMatch(/^(succeeded|failed)$/);
  return (await h.sql<{ state: string; failure_class: string | null; error_detail: string | null; items: number }>('SELECT state, failure_class, error_detail, items FROM runs WHERE id = $1', [runId]))[0]!;
}

async function automationTabs(): Promise<(Tab & { group: string | null })[]> {
  const sw = await h.serviceWorker();
  return sw.evaluate(async (host) => {
    const chrome = (globalThis as unknown as SwGlobal).chrome;
    const tabs = (await chrome.tabs.query({})).filter((t) => t.url?.includes(host));
    return Promise.all(tabs.map(async (t) => ({ ...t, group: t.groupId === -1 ? null : ((await chrome.tabGroups.get(t.groupId)).title ?? null) })));
  }, SHOP);
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  h = await startHarness();
  alice = await h.createMember('zz_test_tunnel_alice@example.test');
  pool = new pg.Pool({ connectionString: h.dbUrl, max: 6 });
  queue = new PgBossJobQueue({ connectionString: h.dbUrl, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  tunnel = new TunnelJobClient({ pool, sessionUrl: h.dbUrl, logger: silent, pollMs: 200 });
  await tunnel.start();
  const executor = createStrategyExecutor({
    pool,
    guard: new SsrfGuard({ policy: createSsrfPolicy({ allowedPorts: [], testAllowPrivate: false }) }),
    pacer: new DomainPacer(new PgPacingStore(pool)),
    browsers: null,
    tunnel,
  });
  worker = await startWorker({
    config: loadWorkerConfig({ DATABASE_URL: h.dbUrl, MASTER_KEY: h.masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '1', DISABLE_BROWSER: 'true' }),
    executor,
    logger: silent,
  });
});

// assert_no_csp_violation (tâche 3.15) : relevé du harnais vérifié après chaque test.
test.afterEach(() => expectNoCspViolation(h));

test.afterAll(async () => {
  await worker?.stop();
  await tunnel?.close();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await h?.close();
});

test('appairage et site connecté en tunnel : le service worker ouvre la WSS (une connexion, celle d’Alice)', async () => {
  const code = await h.console(alice.cookie, 'POST', '/api/extension/pairing-codes', { currentPassword: alice.password });
  expect(code.status).toBe(201);
  const page: Page = await h.popup();
  await page.fill('#instance-url', h.publicUrl);
  await page.fill('#pairing-code', (code.data as { code: string }).code);
  await h.grantHosts(['http://127.0.0.1/*']);
  await page.click('#pair');
  await expect(page.locator('#identity')).toHaveText(`Connected as ${alice.email}`);
  // Le site, connecté en mode tunnel (défaut) : aucun cookie ne quitte le navigateur.
  const site = await h.context.newPage();
  await site.goto(`http://${SHOP}:${h.sitePort}/`);
  await site.bringToFront();
  await page.reload();
  await expect(page.locator('#site-domain')).toHaveText(SHOP);
  await page.click('#connect-site');
  await h.grantHosts([`https://${SHOP}/*`, `http://${SHOP}/*`]);
  await page.click('#consent-accept');
  await expect(page.locator(`#sites li[data-domain="${SHOP}"]`)).toContainText('(tunnel)');
  await site.close();
  await page.close();
  await expect
    .poll(async () => h.sql<{ owner_id: string }>('SELECT owner_id FROM tunnels WHERE gateway_instance IS NOT NULL'), { timeout: 30_000 })
    .toEqual([{ owner_id: alice.id }]);
});

test('run E2 en tunnel : fetch dans un onglet du site, onglet caché, non déchargeable, groupé « Scrapyomama »', async () => {
  const apiId = await insertApi('zz_test_tunnel_e2', itemsSpec('/api/items', 3), 10);
  const runId = await startRun(apiId);
  let tabs: Awaited<ReturnType<typeof automationTabs>> = [];
  // L'onglet est créé puis groupé par le service worker : on attend le groupe, pas seulement l'onglet (course sinon).
  await expect.poll(async () => (tabs = await automationTabs()).filter((t) => t.group !== null).length, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(tabs.find((t) => t.group !== null)).toMatchObject({ active: false, autoDiscardable: false, group: 'Scrapyomama' });
  const run = await waitRun(runId, 60_000);
  // En échec : la cause du run et l'état de chaque commande du tunnel (le diff ne montre que les champs attendus).
  const detail = async () => JSON.stringify({ run, jobs: await h.sql("SELECT cmd, state, trace FROM tunnel_jobs WHERE run_id = $1 ORDER BY created_at", [runId]) }).slice(0, 3000);
  expect(run, run.state === 'succeeded' ? undefined : await detail()).toMatchObject({ state: 'succeeded', items: 30 });
  const attempts = await h.sql('SELECT execution, network, result_class FROM run_attempts WHERE run_id = $1', [runId]);
  expect(attempts).toEqual([{ execution: 'fetch_in_page', network: 'tunnel', result_class: 'ok' }]);
  expect(h.siteHits.filter((hit) => hit.startsWith(`${SHOP}/api/items`))).toHaveLength(3);
});

test('run E3 déclaratif en tunnel : page_script (Page.navigate, DOM.*) par le débogueur, méthodes de la liste blanche CDP', async () => {
  const spec = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `http://${SHOP}:${h.sitePort}/catalog`, allowed_hosts: [SHOP] },
    sources: [{ id: 'dom', from: 'html', records: 'article.item' }],
    fields: { id: { css: 'span.id', attr: 'text', type: 'string', required: true }, name: { css: 'h2', attr: 'text', type: 'string', required: true } },
  };
  const apiId = await insertApi('zz_test_tunnel_e3', spec, 10, 'playwright');
  const runId = await startRun(apiId);
  const run = await waitRun(runId, 60_000);
  expect(run).toMatchObject({ state: 'succeeded', items: 10 });
  const jobs = await h.sql<{ cmd: string; method: string }>("SELECT cmd, payload->>'method' AS method FROM tunnel_jobs WHERE run_id = $1 ORDER BY created_at", [runId]);
  expect(jobs.map((j) => j.cmd)).toEqual(jobs.map(() => 'page_script'));
  expect(jobs[0]!.method).toBe('Page.navigate');
  expect(jobs.map((j) => j.method)).toContain('DOM.getOuterHTML');
});

test('assert_challenge_in_tunnel_stops : défi simulé → 0 commande après la détection, challenge_in_tunnel, action_requise', async () => {
  const apiId = await insertApi('zz_test_tunnel_challenge', itemsSpec('/guarded/api/items', 5), 10);
  const before = h.siteHits.length;
  const runId = await startRun(apiId);
  const run = await waitRun(runId, 60_000);
  expect(run).toMatchObject({ state: 'failed', failure_class: null, error_detail: 'challenge_in_tunnel', items: 0 });
  // Page 1, puis la page 2 qui affiche le défi : rien après (ni requête au site, ni commande au tunnel).
  await new Promise((r) => setTimeout(r, 2000));
  const hits = h.siteHits.slice(before).filter((hit) => hit.includes('/guarded/'));
  expect(hits).toHaveLength(2);
  expect(hits[1]).toContain('page=2');
  expect(await h.sql<{ n: number }>('SELECT count(*)::int AS n FROM tunnel_jobs WHERE run_id = $1', [runId])).toEqual([{ n: 2 }]);
  expect(await h.sql('SELECT status, status_reason FROM apis WHERE id = $1', [apiId])).toEqual([{ status: 'action_requise', status_reason: 'challenge_in_tunnel' }]);
});

test(`run de ${HIDDEN_RUN_SECONDS} s en onglet caché : abouti, même onglet tout du long, jamais au premier plan ni déchargé`, async () => {
  test.setTimeout((HIDDEN_RUN_SECONDS + 180) * 1000);
  const delayMs = 20_000;
  const pages = Math.max(2, Math.ceil((HIDDEN_RUN_SECONDS * 1000) / delayMs) + 1);
  const apiId = await insertApi('zz_test_tunnel_hidden', itemsSpec('/api/items', pages), delayMs);
  // Onglets d'avant (celui laissé à l'utilisateur après le défi) : hors observation.
  const preexisting = new Set((await automationTabs()).map((t) => t.id));
  const ours = async () => (await automationTabs()).filter((t) => !preexisting.has(t.id));
  const started = Date.now();
  const runId = await startRun(apiId);
  const seen = new Map<number, Tab & { group: string | null }>();
  let tabs: Awaited<ReturnType<typeof automationTabs>> = [];
  await expect.poll(async () => (tabs = await ours()).length, { timeout: 60_000 }).toBeGreaterThan(0);
  const tabId = tabs[0]!.id!;
  // Observation toutes les 15 s pendant le run : l'onglet reste caché, non déchargé, dans le groupe.
  for (;;) {
    const state = (await h.sql<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId]))[0]!.state;
    if (state === 'succeeded' || state === 'failed') break;
    for (const t of await ours()) seen.set(t.id!, t);
    expect(Date.now() - started).toBeLessThan((HIDDEN_RUN_SECONDS + 150) * 1000);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const elapsed = (Date.now() - started) / 1000;
  const run = await waitRun(runId, 10_000);
  expect(run, `run : ${JSON.stringify(run)}`).toMatchObject({ state: 'succeeded', items: pages * 10 });
  expect(elapsed).toBeGreaterThanOrEqual(HIDDEN_RUN_SECONDS);
  expect([...seen.keys()]).toEqual([tabId]);
  for (const t of seen.values()) expect(t).toMatchObject({ active: false, autoDiscardable: false, discarded: false, group: 'Scrapyomama' });
  console.log(`run en onglet caché : ${pages} pages, ${elapsed.toFixed(0)} s, onglet ${tabId}`);
});
