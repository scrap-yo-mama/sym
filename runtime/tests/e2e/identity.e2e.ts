// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot dans la console, en Chromium contre une instance réelle (tâche 3.8b, 17 §5, 06 « Identité du robot ») :
//   contact d'instance saisi à l'assistant de premier démarrage (refusé s'il est invalide) → l'admin ouvre Réglages > Identité du robot,
//   voit le User-Agent réel du moteur en lecture seule, active `identify_instance` et pose un contact → le run suivant porte le jeton
//   (l'identité que le worker calcule à chaque run, sur cette base, vaut le User-Agent du moteur suivi de `compatible; Scrapyomama/…`)
//   → un contact avec espace est refusé → le changement est audité → un membre n'a ni l'écran ni la route (403).
// assert_identity_settings_admin_only (stade E2E ; la matrice des refus et la validation sont dans apps/server/src/identity.integration.test.ts).
// Aucun site réel. assert_no_csp_violation : chaque test échoue s'il laisse une violation de la CSP stricte de la console.
import { readFileSync } from 'node:fs';
import { hashPassword } from '@runtime/core';
import { engineUserAgent, resolveIdentifyInstance, resolveInstanceContact } from '@runtime/core/access';
import { publishRobotEngine, readIdentifyInstanceSetting, readInstanceContactSetting } from '@runtime/db';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { robotIdentity } from '../../apps/worker/dist/exec/robot-identity.js';
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
/** Le moteur que « le worker » publie : version réelle du Chromium épinglé, plateforme réelle (jamais une constante). */
const ENGINE = { version: '153.0.8010.12', platform: process.platform };

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
async function createAccount(instance: Instance, who: { email: string; password: string }, role: 'admin' | 'member'): Promise<void> {
  const [{ id }] = await instance.sql<{ id: string }>("INSERT INTO users (email, role, status, email_verified) VALUES ($1, $2, 'active', true) RETURNING id", [who.email, role]) as [{ id: string }];
  await instance.sql("INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)", [id, id, await hashPassword(who.password)]);
}

/** Enregistre et attend la réponse du serveur (le message « enregistré » d'un envoi précédent peut encore être affiché). */
async function save(page: Page, status = 200): Promise<void> {
  const answered = page.waitForResponse((response) => response.url().endsWith('/api/settings/identity') && response.request().method() === 'PUT' && response.status() === status);
  await page.getByTestId('identity-save').click();
  await answered;
}

/** La lecture du worker (factory.ts) sur cette base : réglages d'abord, puis l'environnement (ici vide). */
function runIdentity(instance: Instance): () => Promise<{ userAgent: string; from: string | null }> {
  const db = { query: async (text: string, params?: unknown[]) => ({ rows: await instance.sql(text, params) }) } as Parameters<typeof readIdentifyInstanceSetting>[0];
  return robotIdentity({
    version: '9.9.9',
    engine: () => ENGINE,
    instanceContact: async () => resolveInstanceContact(await readInstanceContactSetting(db), {}),
    identifyInstance: async () => resolveIdentifyInstance(await readIdentifyInstanceSetting(db), {}),
    warn: () => undefined,
  });
}

test.describe.serial('assert_identity_settings_admin_only : du contact de premier démarrage au run suivant', () => {
  let instance: Instance;
  let owner: Person;
  let admin: Person;
  let member: Person;

  test.beforeAll(async ({ browser }) => {
    instance = await startInstance();
    baseURL = instance.url;
    owner = await person(browser);
    admin = await person(browser);
    member = await person(browser);
  });
  test.afterAll(async () => {
    for (const p of [owner, admin, member]) await p?.context.close();
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
    await createAccount(instance, ADMIN, 'admin');
    await createAccount(instance, MEMBER, 'member');
  });

  test('l’admin active identify_instance dans l’UI : User-Agent du moteur en lecture seule, puis le run suivant porte le jeton', async () => {
    const { page } = admin;
    await signIn(page, ADMIN);
    const identity = runIdentity(instance);
    const engineUa = engineUserAgent(ENGINE);

    // Avant tout : désactivé par défaut, le robot envoie le User-Agent du moteur, sans jeton ni From.
    expect(await identity()).toEqual({ userAgent: engineUa, from: null });

    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: t('settings.nav.label') });
    await expect(nav.getByRole('link', { name: t('settings.nav.security') })).toHaveCount(0); // Sécurité : owner seul
    await nav.getByRole('link', { name: t('settings.nav.robot') }).click();
    await expect(page.locator('h1')).toHaveText(t('instance.identity.title'));

    // Aucun worker n'a encore publié son moteur : rien d'inventé.
    await expect(page.getByTestId('identity-ua-unknown')).toHaveText(t('instance.identity.userAgentUnknown'));
    await publishRobotEngine({ query: async (text: string, params?: unknown[]) => ({ rows: await instance.sql(text, params) }) } as Parameters<typeof publishRobotEngine>[0], ENGINE);
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

    // Activation + contact : enregistrés, normalisés, affichés.
    await page.locator('#identity-contact').fill('https://zz-test.example/robot');
    await page.getByTestId('identity-identify').check();
    await save(page);
    await expect(page.getByTestId('identity-saved')).toBeVisible();
    await expect(page.getByTestId('identity-error')).toHaveCount(0);
    const token = `${engineUa} (compatible; Scrapyomama/${'0.0.0'}; +https://zz-test.example/robot)`;
    await expect(page.getByTestId('identity-ua-identified')).toHaveValue(token);
    await expect(ua).toHaveValue(engineUa); // le User-Agent du moteur n'a pas bougé

    // Le run suivant porte le jeton (version annoncée : celle du worker).
    expect(await identity()).toEqual({ userAgent: `${engineUa} (compatible; Scrapyomama/9.9.9; +https://zz-test.example/robot)`, from: null });

    // Contact électronique : l'en-tête From part aussi. Désactivation : retour au User-Agent seul.
    await page.locator('#identity-contact').fill('ops@zz-test.example');
    await save(page);
    await expect(page.getByTestId('identity-saved')).toBeVisible();
    expect(await identity()).toEqual({ userAgent: `${engineUa} (compatible; Scrapyomama/9.9.9; +mailto:ops@zz-test.example)`, from: 'ops@zz-test.example' });
    await page.getByTestId('identity-identify').uncheck();
    await save(page);
    await expect(page.getByTestId('identity-saved')).toBeVisible();
    expect(await identity()).toEqual({ userAgent: engineUa, from: null });

    // Audité : champs modifiés et état de l'interrupteur, jamais le contact.
    const events = await instance.sql<{ outcome: string; meta: { fields: string[]; identify_instance?: boolean } }>("SELECT outcome, meta FROM audit_events WHERE action = 'settings.identity_updated' ORDER BY id");
    expect(events.map((e) => e.outcome)).toEqual(['success', 'success', 'success']);
    expect(events.map((e) => e.meta.identify_instance)).toEqual([true, true, false]);
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
