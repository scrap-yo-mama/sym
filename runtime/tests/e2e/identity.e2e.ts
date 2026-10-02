// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot dans la console, en Chromium contre une instance réelle (tâche 3.8b, 17 §5, 06 « Identité du robot ») :
//   contact d'instance saisi à l'assistant de premier démarrage (refusé s'il est invalide) → l'admin ouvre Réglages > Identité du robot,
//   voit le User-Agent réel du moteur en lecture seule (publié par un worker RÉEL branché sur la même base), active `identify_instance`
//   et pose un contact → le run suivant, un vrai run (file → worker → exécuteur E1 de production), arrive sur une cible locale qui relève
//   les en-têtes reçus : User-Agent du moteur suivi de `compatible; Scrapyomama/<version du worker>; +<contact>`, exactement l'aperçu
//   de la console, et `From` pour un contact électronique → un contact avec espace est refusé → le changement est audité → un membre
//   n'a ni l'écran ni la route (403).
// assert_identity_settings_admin_only (stade E2E ; la matrice des refus et la validation sont dans apps/server/src/identity.integration.test.ts).
// Aucun site réel. assert_no_csp_violation : chaque test échoue s'il laisse une violation de la CSP stricte de la console.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashPassword } from '@runtime/core';
import { engineUserAgent } from '@runtime/core/access';
import { createRun, PgBossJobQueue, withActor } from '@runtime/db';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { loadWorkerConfig } from '../../apps/worker/dist/config.js';
import { productionExecutorFactory } from '../../apps/worker/dist/exec/factory.js';
import { startWorker, type Worker } from '../../apps/worker/dist/worker.js';
import { CONSOLE_CSP, watchCspViolations } from '../../apps/web/e2e/csp.ts';
import { startInstance, type Instance } from './instance.ts';

const EN = JSON.parse(readFileSync(new URL('../../apps/web/src/i18n/locales/en.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** Texte anglais d'une clé de la console, pour attendre le texte exact affiché. */
function t(key: string): string {
  const found = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), EN);
  if (typeof found !== 'string') throw new Error(`clé absente : ${key}`);
  return found;
}

const strong = (): string => `zz_test_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}_long`;
const OWNER = { email: 'zz_test_id_owner@example.test', password: strong() };
const ADMIN = { email: 'zz_test_id_admin@example.test', password: strong() };
const MEMBER = { email: 'zz_test_id_membre@example.test', password: strong() };
/** Version que le worker annonce dans le jeton (sa RUNTIME_VERSION), distincte de celle du serveur (0.0.0) : l'aperçu doit suivre le worker. */
const WORKER_VERSION = '9.9.9';

type Person = { context: BrowserContext; page: Page };
let baseURL = '';
const cspViolations: string[] = [];
test.afterEach(() => expect(cspViolations.splice(0), 'violations de la CSP de la console (assert_no_csp_violation)').toEqual([]));

async function person(browser: Browser): Promise<Person> {
  const context = await browser.newContext({ locale: 'en-US', baseURL });
  await watchCspViolations(context, cspViolations);
  return { context, page: await context.newPage() };
}

async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(who.email);
  await page.locator('#login-password').fill(who.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

/** Compte actif créé en base (équivalent d'une invitation acceptée : ce parcours est celui de invitation.e2e.ts). */
async function createAccount(instance: Instance, who: { email: string; password: string }, role: 'admin' | 'member'): Promise<string> {
  const [{ id }] = await instance.sql<{ id: string }>("INSERT INTO users (email, role, status, email_verified) VALUES ($1, $2, 'active', true) RETURNING id", [who.email, role]) as [{ id: string }];
  await instance.sql("INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)", [id, id, await hashPassword(who.password)]);
  return id;
}

/** Enregistre et attend la réponse du serveur (le message « enregistré » d'un envoi précédent peut encore être affiché). */
async function save(page: Page, status = 200): Promise<void> {
  const answered = page.waitForResponse((response) => response.url().endsWith('/api/settings/identity') && response.request().method() === 'PUT' && response.status() === status);
  await page.getByTestId('identity-save').click();
  await answered;
}

/** Cible locale (aucun site réel) : relève le User-Agent et le `From` de chaque requête reçue ; `/ua` rend un item, robots.txt 404. */
type Seen = { path: string; ua: string | null; from: string | null };
async function startTarget(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const header = (name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : null);
    seen.push({ path: (req.url ?? '/').split('?')[0] ?? '/', ua: header('user-agent'), from: header('from') });
    if (req.url?.startsWith('/ua')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: String(seen.length) }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

/** API E1 (`fetch`, direct) de l'admin vers la cible locale, en base comme le ferait une enquête promue. */
async function createTargetApi(instance: Instance, ownerId: string, port: number): Promise<string> {
  const [{ id }] = (await instance.sql<{ id: string }>(
    `INSERT INTO apis (slug, owner_id, output_schema, network_policy, domain_pacing) VALUES ('zz_test_identity_ua', $1, '{}', '{"allow": ["direct"]}', '{"min_delay_ms": 5, "max_requests_per_run": 20, "max_wait_ms": 60000}') RETURNING id`,
    [ownerId],
  )) as [{ id: string }];
  const spec = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `http://127.0.0.1:${port}/ua`, allowed_hosts: ['127.0.0.1'] },
    sources: [{ id: 'api', from: 'response', records: '$.items[*]' }],
    fields: { id: { path: '$.id', type: 'string', required: true } },
  };
  await instance.sql("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, est_cost_usd, created_by) VALUES ($1, 1, $2, 'fetch', 'direct', $3, 0, 'user')", [id, ownerId, JSON.stringify(spec)]);
  await instance.sql('UPDATE apis SET current_strategy_version = 1 WHERE id = $1', [id]);
  return id;
}

test.describe.serial('assert_identity_settings_admin_only : du contact de premier démarrage au run suivant', () => {
  let instance: Instance;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let adminId = '';
  let target: Awaited<ReturnType<typeof startTarget>> | undefined;
  let worker: Worker | undefined;
  let queue: PgBossJobQueue | undefined;
  let pool: pg.Pool | undefined;

  /** Un vrai run de l'API de l'admin (file → worker → exécuteur E1) ; rend les en-têtes que la cible a reçus sur `/ua`. */
  async function nextRun(apiId: string): Promise<{ ua: string | null; from: string | null }> {
    const before = target!.seen.length;
    const { runId } = await withActor(pool!, { userId: adminId, role: 'admin' }, (tx) => createRun(tx, queue!, { apiId, ownerId: adminId, trigger: 'rest' }));
    await expect
      .poll(async () => (await instance.sql<{ state: string }>('SELECT state FROM runs WHERE id = $1', [runId]))[0]?.state, { timeout: 60_000 })
      .toMatch(/^(succeeded|failed)$/);
    const [run] = await instance.sql<{ state: string; error_detail: string | null }>('SELECT state, error_detail FROM runs WHERE id = $1', [runId]);
    expect(run, JSON.stringify(run)).toMatchObject({ state: 'succeeded' });
    const hits = target!.seen.slice(before).filter((s) => s.path === '/ua');
    expect(hits).toHaveLength(1);
    return { ua: hits[0]!.ua, from: hits[0]!.from };
  }

  test.beforeAll(async ({ browser }) => {
    instance = await startInstance();
    baseURL = instance.url;
    owner = await person(browser);
    admin = await person(browser);
    member = await person(browser);
  });
  test.afterAll(async () => {
    for (const p of [owner, admin, member]) await p?.context.close();
    await worker?.stop();
    await queue?.stop({ timeoutMs: 1000 });
    await pool?.end();
    if (target) await new Promise<void>((resolve) => target!.server.close(() => resolve()));
    await instance?.close();
  });

  test('assistant de premier démarrage : un contact invalide est refusé, un contact valide est enregistré avec l’owner', async () => {
    const { page } = owner;
    await page.goto('/setup');
    await expect(page.locator('h1')).toHaveText(t('setup.title'));
    await page.locator('#setup-token').fill(instance.bootstrapToken);
    await page.locator('#setup-email').fill(OWNER.email);
    await page.locator('#setup-password').fill(OWNER.password);
    await page.locator('#setup-contact').fill('ops @zz-test.example');
    await page.getByTestId('setup-form').locator('button[type="submit"]').click();
    await expect(page.getByTestId('setup-error')).toHaveText(t('setup.errors.invalid_instance_contact'));
    expect(await instance.sql("SELECT 1 FROM users WHERE role = 'owner'")).toEqual([]);

    await page.locator('#setup-token').fill(instance.bootstrapToken);
    await page.locator('#setup-password').fill(OWNER.password);
    await page.locator('#setup-contact').fill('ops@zz-test.example');
    await page.getByTestId('setup-form').locator('button[type="submit"]').click();
    await expect(page.getByTestId('key-fingerprint')).toBeVisible();
    expect(await instance.sql("SELECT value FROM settings WHERE key = 'instance_contact'")).toEqual([{ value: 'mailto:ops@zz-test.example' }]);
    adminId = await createAccount(instance, ADMIN, 'admin');
    await createAccount(instance, MEMBER, 'member');
  });

  test('l’admin active identify_instance dans l’UI : User-Agent du moteur en lecture seule, puis le run suivant (vrai run) porte le jeton', async () => {
    const { page } = admin;
    await signIn(page, ADMIN);

    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: t('settings.nav.label') });
    await expect(nav.getByRole('link', { name: t('settings.nav.security') })).toHaveCount(0); // Sécurité : owner seul
    await nav.getByRole('link', { name: t('settings.nav.robot') }).click();
    await expect(page.locator('h1')).toHaveText(t('instance.identity.title'));

    // Aucun worker n'a encore publié son moteur : rien d'inventé.
    await expect(page.getByTestId('identity-ua-unknown')).toHaveText(t('instance.identity.userAgentUnknown'));

    // Un worker réel démarre sur cette base (exécuteur de production, sans navigateur, cible locale permise en test) : il publie son
    // moteur, sa version et les replis de son environnement (ici aucun : identification désactivée par défaut).
    target = await startTarget();
    pool = new pg.Pool({ connectionString: instance.dbUrl, max: 2 });
    queue = new PgBossJobQueue({ connectionString: instance.dbUrl, max: 2, supervise: false });
    await queue.start();
    worker = await startWorker({
      config: loadWorkerConfig({ DATABASE_URL: instance.dbUrl, MASTER_KEY: instance.masterKey, QUEUE_POLLING_SECONDS: '0.5', RUN_HEARTBEAT_SECONDS: '0.5', RUN_STALE_SECONDS: '10', DISABLE_BROWSER: 'true', BROWSER_CONCURRENCY: '1', RUNTIME_VERSION: WORKER_VERSION, LOG_LEVEL: 'warn' }),
      executorFactory: productionExecutorFactory({ NODE_ENV: 'test', RUNTIME_TEST_ALLOW_PRIVATE: '1', DISABLE_BROWSER: 'true' }),
    });
    const [published] = await instance.sql<{ value: { version: string; platform: string } }>("SELECT value FROM settings WHERE key = 'robot_engine'");
    expect(published?.value.platform).toBe(process.platform);
    const engineUa = engineUserAgent(published!.value);
    const apiId = await createTargetApi(instance, adminId, target.port);

    // Avant tout : désactivé par défaut, le run envoie le User-Agent du moteur, sans jeton ni From.
    expect(await nextRun(apiId)).toEqual({ ua: engineUa, from: null });

    await page.reload();
    // User-Agent réel du moteur : champ en lecture seule, valeur exacte.
    const ua = page.getByTestId('identity-ua');
    await expect(ua).toHaveValue(engineUa);
    await expect(ua).not.toBeEditable();
    expect(engineUa).not.toMatch(/HeadlessChrome|Scrapyomama/);
    await expect(page.getByTestId('identity-identify')).not.toBeChecked();

    // Contact refusé : espace. Message dédié, aucun réglage écrit.
    await page.locator('#identity-contact').fill('ops @zz-test.example');
    await save(page, 400);
    await expect(page.getByTestId('identity-error')).toHaveText(t('errors.invalid_instance_contact'));
    expect(await instance.sql("SELECT 1 FROM settings WHERE key = 'identify_instance'")).toEqual([]);

    // Activation + contact : enregistrés, normalisés, affichés ; l'aperçu porte la version du WORKER.
    await page.locator('#identity-contact').fill('https://zz-test.example/robot');
    await page.getByTestId('identity-identify').check();
    await save(page);
    await expect(page.getByTestId('identity-saved')).toBeVisible();
    await expect(page.getByTestId('identity-error')).toHaveCount(0);
    const token = `${engineUa} (compatible; Scrapyomama/${WORKER_VERSION}; +https://zz-test.example/robot)`;
    await expect(page.getByTestId('identity-ua-identified')).toHaveValue(token);
    await expect(ua).toHaveValue(engineUa); // le User-Agent du moteur n'a pas bougé

    // Le run suivant porte le jeton : exactement l'aperçu de la console.
    expect(await nextRun(apiId)).toEqual({ ua: token, from: null });

    // Contact électronique seul (interrupteur non renvoyé) : l'en-tête From part aussi. Désactivation : retour au User-Agent seul.
    await page.locator('#identity-contact').fill('ops@zz-test.example');
    await save(page);
    await expect(page.getByTestId('identity-saved')).toBeVisible();
    expect(await nextRun(apiId)).toEqual({ ua: `${engineUa} (compatible; Scrapyomama/${WORKER_VERSION}; +mailto:ops@zz-test.example)`, from: 'ops@zz-test.example' });
    await page.getByTestId('identity-identify').uncheck();
    await save(page);
    await expect(page.getByTestId('identity-saved')).toBeVisible();
    expect(await nextRun(apiId)).toEqual({ ua: engineUa, from: null });

    // Audité : champs réellement modifiés et état de l'interrupteur quand il change, jamais le contact.
    const events = await instance.sql<{ outcome: string; meta: { fields: string[]; identify_instance?: boolean } }>("SELECT outcome, meta FROM audit_events WHERE action = 'settings.identity_updated' ORDER BY id");
    expect(events.map((e) => e.outcome)).toEqual(['success', 'success', 'success']);
    expect(events.map((e) => e.meta)).toEqual([
      { fields: ['identify_instance', 'instance_contact'], identify_instance: true },
      { fields: ['instance_contact'] },
      { fields: ['identify_instance'], identify_instance: false },
    ]);
    expect(JSON.stringify(await instance.sql('SELECT * FROM audit_events'))).not.toContain('zz-test.example/robot');
  });

  test('un membre n’a ni l’écran ni la route : redirigé, 403 en lecture comme en écriture, rien n’est écrit', async () => {
    const { page } = member;
    await signIn(page, MEMBER);
    await page.goto('/settings');
    await expect(page.getByRole('navigation', { name: t('settings.nav.label') }).getByRole('link', { name: t('settings.nav.robot') })).toHaveCount(0);
    await page.goto('/settings/robot');
    await expect(page).not.toHaveURL(/\/settings\/robot/);
    const before = await instance.sql("SELECT value FROM settings WHERE key = 'identify_instance'");
    expect((await page.request.get('/api/settings/identity')).status()).toBe(403);
    const put = await page.request.put('/api/settings/identity', { data: { identify_instance: true, instance_contact: 'x@zz-test.example' }, headers: { origin: baseURL } });
    expect(put.status()).toBe(403);
    expect(await instance.sql("SELECT value FROM settings WHERE key = 'identify_instance'")).toEqual(before);
    expect(await instance.sql("SELECT value FROM settings WHERE key = 'instance_contact'")).toEqual([{ value: 'mailto:ops@zz-test.example' }]);
  });

  test('témoin : la CSP du banc est bien celle de la console (le relevé sait échouer)', () => {
    expect(CONSOLE_CSP).toContain("script-src 'self'");
  });
});
