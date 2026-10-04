// SPDX-License-Identifier: AGPL-3.0-only
// Parcours d'invitation de la console en Chromium contre une instance réelle (tâche 3.8, 13 § 4, § 6, § 7) :
//   premier démarrage (empreinte de clé une fois, rappel MASTER_KEY, /setup introuvable ensuite) → enrôlement 2FA forcé de l'owner →
//   invitation d'un membre (lien copiable montré une fois) → acceptation → écrans d'admin absents pour le membre → lien rejoué = même
//   réponse qu'un lien inconnu → clé d'API vue une fois → invitation d'un admin (2FA forcée) → audit lisible et exporté sans secret.
// Une instance (MFA_ENFORCED=admins), des contextes de navigateur distincts par personne. Aucun site réel.
// assert_no_csp_violation (tâche 3.15, 20b § 3.1) : le relais sert la console avec sa CSP stricte (08b § 2, apps/web/e2e/csp.ts) ;
// chaque contexte relève ses événements `securitypolicyviolation` et chaque test échoue s'il en a laissé un (afterEach) ; un témoin
// prouve que le contrôle sait échouer.
import { readFileSync } from 'node:fs';
import { base32Decode, totpCode, totpStep } from '@runtime/core';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CONSOLE_CSP, watchCspViolations } from '../../apps/web/e2e/csp.ts';
import { startInstance, type Instance } from './instance.ts';

const EN = JSON.parse(readFileSync(new URL('../../packages/i18n/locales/en.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** Texte anglais d'une clé de la console, pour attendre le texte exact affiché. */
function t(key: string): string {
  const found = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), EN);
  if (typeof found !== 'string') throw new Error(`clé absente : ${key}`);
  return found;
}

const strong = (): string => `zz_test_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}_long`;
const OWNER = { email: 'zz_test_owner@example.test', password: strong() };
const MEMBER = { email: 'zz_test_membre@example.test', password: strong() };
const ADMIN = { email: 'zz_test_admin@example.test', password: strong() };

type Person = { context: BrowserContext; page: Page; errors: string[] };

/** Origine de l'instance, posée au démarrage : les pages s'ouvrent par chemin relatif. */
let baseURL = '';

/** Violations de la CSP de la console relevées dans tous les contextes ouverts, depuis la fin du test précédent. */
const cspViolations: string[] = [];
test.afterEach(() => expect(cspViolations.splice(0), 'violations de la CSP de la console (assert_no_csp_violation)').toEqual([]));

/** Une personne devant la console : contexte isolé (cookies à elle), anglais, erreurs de console et violations de CSP relevées. */
async function person(browser: Browser, grantClipboard = false): Promise<Person> {
  const context = await browser.newContext({ locale: 'en-US', baseURL });
  if (grantClipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await watchCspViolations(context, cspViolations);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', (error) => errors.push(`exception : ${error.message}`));
  return { context, page, errors };
}

/**
 * Erreurs de console hors réponses 4xx voulues (mauvais jeton, mot de passe refusé, lien périmé : Chromium les journalise) et, tant que
 * l'instance n'a pas d'owner, le 503 `not_initialized` de la sonde de session (13 § 4 : toutes les routes répondent 503 avant l'assistant).
 */
const unexpected = (errors: string[]): string[] =>
  errors.filter((entry) => !/Failed to load resource: the server responded with a status of (4\d\d|503 \(Service Unavailable\) \(\S+\/api\/auth\/get-session\))/.test(entry));

/** Code TOTP courant d'une graine base32 (`offset` pas de 30 s). */
const codeFor = (secret: string, offset = 0): string => totpCode(base32Decode(secret), totpStep() + offset);

/** Enrôle la 2FA depuis la page d'enrôlement forcé ou Mon compte ; renvoie la graine et les codes de secours. */
async function enroll(page: Page, password: string): Promise<{ secret: string; backupCodes: string[] }> {
  await page.locator('#two-factor-password').fill(password);
  await page.getByTestId('two-factor-start').locator('button[type="submit"]').click();
  const secret = (await page.getByTestId('two-factor-seed').innerText()).trim();
  await page.locator('#two-factor-code').fill(codeFor(secret));
  await page.getByTestId('two-factor-confirm').locator('button[type="submit"]').click();
  const reveal = page.getByTestId('secret-value');
  await expect(reveal).toBeVisible();
  const backupCodes = (await reveal.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
  return { secret, backupCodes };
}

/** Connexion par mot de passe, puis second facteur si la console le demande. */
async function signIn(page: Page, who: { email: string; password: string }, secret?: string, offset = 0): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(who.email);
  await page.locator('#login-password').fill(who.password);
  await page.locator('form button[type="submit"]').click();
  if (secret) {
    await page.locator('#login-code').fill(codeFor(secret, offset));
    await page.getByTestId('second-factor-form').locator('button[type="submit"]').click();
  }
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

/** Invite `email` depuis Utilisateurs et renvoie le lien montré une fois (puis le ferme). */
async function invite(page: Page, email: string, role: 'member' | 'admin'): Promise<string> {
  await page.goto('/admin/users');
  await expect(page.locator('h1')).toHaveText(t('users.title'));
  await page.locator('#invite-email').fill(email);
  await page.locator('#invite-role').selectOption(role);
  await page.getByTestId('invite-form').locator('button[type="submit"]').click();
  const link = (await page.getByTestId('secret-value').innerText()).trim();
  await page.getByRole('button', { name: t('users.invite.dismiss') }).click();
  await expect(page.getByTestId('secret-value')).toHaveCount(0);
  return link;
}

const navLabels = (page: Page): Promise<string[]> => page.getByRole('navigation', { name: t('nav.main') }).getByRole('link').allInnerTexts();

test.describe.serial('assert_invitation_journey : du premier démarrage à l’audit', () => {
  let instance: Instance;
  let owner: Person;
  let ownerSecret = '';
  let memberLink = '';

  test.beforeAll(async ({ browser }) => {
    instance = await startInstance({ MFA_ENFORCED: 'admins' });
    baseURL = instance.url;
    owner = await person(browser, true);
  });
  test.afterAll(async () => {
    await owner?.context.close();
    await instance?.close();
  });

  test('premier démarrage : l’assistant est la seule page, l’empreinte de clé s’affiche une fois avec le rappel de sauvegarde, /setup est ensuite introuvable', async () => {
    const { page } = owner;
    await page.goto(`${instance.url}/`);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.locator('h1')).toHaveText(t('setup.title'));
    // Un autre chemin de la console mène aussi à l'assistant tant qu'aucun owner n'existe.
    await page.goto(`${instance.url}/apis`);
    await expect(page).toHaveURL(/\/setup$/);

    // Mauvais jeton : refus, rien n'est créé.
    await page.locator('#setup-token').fill('zz_test_mauvais_jeton');
    await page.locator('#setup-email').fill(OWNER.email);
    await page.locator('#setup-password').fill(OWNER.password);
    await page.getByTestId('setup-form').locator('button[type="submit"]').click();
    await expect(page.getByTestId('setup-error')).toHaveText(t('setup.errors.forbidden'));
    // Les champs secrets ont été vidés à l'envoi.
    await expect(page.locator('#setup-token')).toHaveValue('');
    await expect(page.locator('#setup-password')).toHaveValue('');

    // Mot de passe refusé par la politique : message dédié.
    await page.locator('#setup-token').fill(instance.bootstrapToken);
    await page.locator('#setup-password').fill('court');
    await page.getByTestId('setup-form').locator('button[type="submit"]').click();
    await expect(page.getByTestId('setup-error')).toHaveText(t('setup.errors.weak_password'));

    // Création de l'owner : l'empreinte de la clé revient avec la réponse et s'affiche.
    await page.locator('#setup-token').fill(instance.bootstrapToken);
    await page.locator('#setup-password').fill(OWNER.password);
    await page.locator('#setup-name').fill('Owner');
    const created = page.waitForResponse((response) => response.url().endsWith('/api/setup') && response.status() === 201);
    await page.getByTestId('setup-form').locator('button[type="submit"]').click();
    const { keyFingerprint } = (await (await created).json()) as { keyFingerprint: string };
    expect(keyFingerprint).toMatch(/\S+/);
    await expect(page.getByTestId('key-fingerprint')).toHaveText(keyFingerprint);
    await expect(page.getByTestId('key-reminder')).toHaveText(t('setup.done.reminder'));
    // Le jeton et le mot de passe ne sont nulle part dans la page.
    const html = await page.content();
    expect(html).not.toContain(instance.bootstrapToken);
    expect(html).not.toContain(OWNER.password);

    // On ne continue pas sans avoir confirmé la sauvegarde de MASTER_KEY.
    await expect(page.getByTestId('setup-continue')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('setup-continue').click({ force: true });
    await expect(page.getByTestId('key-fingerprint')).toBeVisible();
    await page.getByTestId('key-acknowledge').check();
    await expect(page.getByTestId('setup-continue')).toHaveAttribute('aria-disabled', 'false');
    await page.getByTestId('setup-continue').click();
    await expect(page.getByTestId('setup-next')).toBeVisible();
    // L'empreinte a quitté la page : elle n'est plus affichée nulle part.
    expect(await page.content()).not.toContain(keyFingerprint);
    await expect(page.getByTestId('setup-next').getByRole('link')).toHaveCount(4); // modèles, proxys, alertes, console

    // /setup répond « introuvable » pour toujours, et l'API aussi (404), même avec le bon jeton.
    await page.goto(`${instance.url}/setup`);
    await expect(page.locator('h1')).toHaveText(t('notFound.title'));
    expect(await page.content()).not.toContain(keyFingerprint);
    const again = await page.evaluate(
      async ({ token, email }) => (await fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, email, password: 'zz_test_une_autre_phrase_longue' }) })).status,
      { token: instance.bootstrapToken, email: 'zz_test_autre@example.test' },
    );
    expect(again).toBe(404);
    expect(unexpected(owner.errors)).toEqual([]);
  });

  test('assert_mfa_enforced (console) : l’owner est mené à l’enrôlement 2FA avant toute autre page, puis la console s’ouvre', async () => {
    const { page } = owner;
    // L'owner est connecté (par l'assistant) mais MFA_ENFORCED=admins l'exige : toute page mène à l'enrôlement, sans navigation.
    for (const path of ['/', '/admin/users', '/settings/account']) {
      await page.goto(`${instance.url}${path}`);
      await expect(page).toHaveURL(/\/two-factor-setup$/);
    }
    await expect(page.locator('h1')).toHaveText(t('twoFactorSetup.title'));
    await expect(page.getByRole('navigation', { name: t('nav.main') })).toHaveCount(0);
    // Un mauvais mot de passe est refusé.
    await page.locator('#two-factor-password').fill('zz_test_mauvais_mot_de_passe');
    await page.getByTestId('two-factor-start').locator('button[type="submit"]').click();
    await expect(page.getByTestId('two-factor-error')).toHaveText(t('errors.reauth_failed'));

    const enrolled = await enroll(page, OWNER.password);
    ownerSecret = enrolled.secret;
    expect(enrolled.backupCodes).toHaveLength(10);
    // La console ne s'ouvre qu'une fois les codes de secours rangés.
    await expect(page.getByTestId('two-factor-continue')).toHaveCount(0);
    await page.getByRole('button', { name: t('account.twoFactor.backupDone') }).click();
    await expect(page.getByTestId('secret-value')).toHaveCount(0);
    await page.getByTestId('two-factor-continue').click();
    await expect(page).toHaveURL(`${instance.url}/`);
    await expect(page.getByTestId('role-banner')).toHaveText(t('nav.roleBanner.owner'));
    expect(await navLabels(page)).toEqual(expect.arrayContaining([t('nav.users'), t('nav.audit'), t('nav.account')]));
    expect(unexpected(owner.errors)).toEqual([]);
  });

  test('invitation d’un membre : le lien copiable est montré une fois, jamais relu, l’invitation est en attente', async () => {
    const { page } = owner;
    await page.goto(`${instance.url}/admin/users`);
    await expect(page.locator('h1')).toHaveText(t('users.title'));
    // L'owner peut inviter un membre ou un admin.
    await expect(page.locator('#invite-role option')).toHaveText([t('users.roles.member'), t('users.roles.admin')]);
    await page.locator('#invite-email').fill(MEMBER.email);
    await page.getByTestId('invite-form').locator('button[type="submit"]').click();
    const reveal = page.getByTestId('secret-value');
    memberLink = (await reveal.innerText()).trim();
    expect(memberLink).toMatch(new RegExp(`^${instance.url}/invite/\\S+$`));

    // Copier : le presse-papiers reçoit le lien.
    await page.getByRole('button', { name: t('users.invite.copy') }).click();
    await expect(page.getByTestId('copy-result')).toHaveText(t('ui.copied'));
    expect(await page.evaluate(() => (globalThis as unknown as { navigator: { clipboard: { readText: () => Promise<string> } } }).navigator.clipboard.readText())).toBe(memberLink);

    // Le fermer l'efface ; recharger ne le ramène pas ; l'invitation est en attente dans la liste (sans le lien).
    await page.getByRole('button', { name: t('users.invite.dismiss') }).click();
    await expect(reveal).toHaveCount(0);
    await page.reload();
    await expect(page.locator('h1')).toHaveText(t('users.title'));
    await expect(page.getByTestId('secret-value')).toHaveCount(0);
    const row = page.getByTestId('invitation-row').filter({ hasText: MEMBER.email });
    await expect(row).toContainText(t('users.invitations.pending'));
    expect(await page.content()).not.toContain(memberLink.slice(memberLink.lastIndexOf('/') + 1));
    // Inviter deux fois la même adresse est refusé.
    await page.locator('#invite-email').fill(MEMBER.email);
    await page.getByTestId('invite-form').locator('button[type="submit"]').click();
    await expect(page.getByTestId('users-error')).toHaveText(t('errors.invitation_pending'));
    expect(unexpected(owner.errors)).toEqual([]);
  });

  test('l’invité crée son compte : mots de passe différents et mot de passe faible refusés, puis session de membre sans écrans d’admin', async ({ browser }) => {
    const invited = await person(browser);
    try {
      const { page } = invited;
      await page.goto(memberLink);
      await expect(page.locator('h1')).toHaveText(t('auth.invite.title'));
      await page.locator('#invite-name').fill('Membre');
      await page.locator('#invite-password').fill(MEMBER.password);
      await page.locator('#invite-confirm').fill('zz_test_autre_chose_entierement');
      await page.getByTestId('invite-form').locator('button[type="submit"]').click();
      await expect(page.locator('#invite-confirm-error')).toHaveText(t('auth.invite.mismatch'));
      await page.locator('#invite-password').fill('court');
      await page.locator('#invite-confirm').fill('court');
      await page.getByTestId('invite-form').locator('button[type="submit"]').click();
      await expect(page.getByTestId('invite-error')).toHaveText(t('auth.invite.errors.weak_password'));

      await page.locator('#invite-password').fill(MEMBER.password);
      await page.locator('#invite-confirm').fill(MEMBER.password);
      await page.getByTestId('invite-form').locator('button[type="submit"]').click();
      await expect(page).toHaveURL(`${instance.url}/`);
      // Un membre : ni Utilisateurs, ni Audit, ni bandeau d'admin ; ses routes réservées redirigent vers l'accueil.
      const labels = await navLabels(page);
      expect(labels).not.toContain(t('nav.users'));
      expect(labels).not.toContain(t('nav.audit'));
      expect(labels).toEqual(expect.arrayContaining([t('nav.catalog'), t('nav.account')]));
      await expect(page.getByTestId('role-banner')).toHaveCount(0);
      for (const path of ['/admin/users', '/admin/audit', '/settings/security', '/settings/sso']) {
        await page.goto(`${instance.url}${path}`);
        await expect(page, path).toHaveURL(`${instance.url}/`);
      }
      // Le menu des réglages n'a ni Sécurité ni SSO ; le compte montre ses sessions et la 2FA désactivée (non exigée pour un membre).
      await page.goto(`${instance.url}/settings/account`);
      await expect(page.locator('h1')).toHaveText(t('account.title'));
      const sections = await page.getByRole('navigation', { name: t('settings.nav.label') }).getByRole('link').allInnerTexts();
      expect(sections).not.toContain(t('settings.nav.security'));
      expect(sections).not.toContain(t('settings.nav.sso'));
      await expect(page.getByTestId('two-factor-state')).toHaveText(t('account.twoFactor.off'));
      await expect(page.getByTestId('session-row')).toHaveCount(1);

      // Clé d'API : mot de passe exigé, secret montré une fois, absent de la liste.
      await page.goto(`${instance.url}/settings/keys`);
      await page.locator('#key-label').fill('Outil MCP');
      await page.getByTestId('scope-apis:read').check();
      await page.locator('#key-password').fill(MEMBER.password);
      await page.getByTestId('key-form').locator('button[type="submit"]').click();
      const secret = (await page.getByTestId('secret-value').innerText()).trim();
      expect(secret).toMatch(/^sy_live_/);
      await page.getByRole('button', { name: t('keys.created.dismiss') }).click();
      await expect(page.getByTestId('secret-value')).toHaveCount(0);
      await expect(page.getByTestId('key-row')).toHaveCount(1);
      expect(await page.content()).not.toContain(secret);
      await page.reload();
      expect(await page.content()).not.toContain(secret);
      expect(unexpected(invited.errors)).toEqual([]);
    } finally {
      await invited.context.close();
    }
  });

  test('assert_invitation_single_use (console) : le lien rejoué reçoit exactement le message d’un lien inventé', async ({ browser }) => {
    const stranger = await person(browser);
    try {
      const { page } = stranger;
      const messageFor = async (link: string): Promise<string> => {
        await page.goto(link);
        await page.locator('#invite-password').fill(strong());
        const password = await page.locator('#invite-password').inputValue();
        await page.locator('#invite-confirm').fill(password);
        await page.getByTestId('invite-form').locator('button[type="submit"]').click();
        return (await page.getByTestId('invite-error').innerText()).trim();
      };
      const replayed = await messageFor(memberLink);
      const invented = await messageFor(`${instance.url}/invite/zz_test_lien_invente_0123456789abcdef0123456789abcdef`);
      expect(replayed).toBe(t('auth.invite.errors.invitation_invalid'));
      expect(invented).toBe(replayed);
      // Aucune session n'est ouverte.
      await page.goto(`${instance.url}/apis`);
      await expect(page).toHaveURL(/\/login/);
      expect(unexpected(stranger.errors)).toEqual([]);
    } finally {
      await stranger.context.close();
    }
  });

  test('invitation d’un admin : l’acceptation mène à l’enrôlement forcé, puis Utilisateurs et Audit, sans Sécurité ni SSO ni export', async ({ browser }) => {
    const { page } = owner;
    const adminLink = await invite(page, ADMIN.email, 'admin');
    const admin = await person(browser);
    try {
      const adminPage = admin.page;
      await adminPage.goto(adminLink);
      await adminPage.locator('#invite-password').fill(ADMIN.password);
      await adminPage.locator('#invite-confirm').fill(ADMIN.password);
      await adminPage.getByTestId('invite-form').locator('button[type="submit"]').click();
      await expect(adminPage).toHaveURL(/\/two-factor-setup$/);
      await expect(adminPage.getByRole('navigation', { name: t('nav.main') })).toHaveCount(0);
      await adminPage.goto(`${instance.url}/admin/users`);
      await expect(adminPage).toHaveURL(/\/two-factor-setup$/);
      await enroll(adminPage, ADMIN.password);
      await adminPage.getByRole('button', { name: t('account.twoFactor.backupDone') }).click();
      await adminPage.getByTestId('two-factor-continue').click();
      await expect(adminPage.getByTestId('role-banner')).toHaveText(t('nav.roleBanner.admin'));
      const labels = await navLabels(adminPage);
      expect(labels).toEqual(expect.arrayContaining([t('nav.users'), t('nav.audit')]));
      await adminPage.goto(`${instance.url}/settings/account`);
      const sections = await adminPage.getByRole('navigation', { name: t('settings.nav.label') }).getByRole('link').allInnerTexts();
      expect(sections).not.toContain(t('settings.nav.security'));
      for (const path of ['/settings/security', '/settings/sso']) {
        await adminPage.goto(`${instance.url}${path}`);
        await expect(adminPage, path).toHaveURL(`${instance.url}/`);
      }
      // Un admin invite un membre mais ne peut pas inviter un admin.
      await adminPage.goto(`${instance.url}/admin/users`);
      await expect(adminPage.locator('#invite-role option')).toHaveText([t('users.roles.member')]);
      await expect(adminPage.getByTestId('transfer-form')).toHaveCount(0);
      // Audit : lecture seule, pas d'export (réservé à l'owner).
      await adminPage.goto(`${instance.url}/admin/audit`);
      await expect(adminPage.getByTestId('audit-row').first()).toBeVisible();
      await expect(adminPage.getByTestId('audit-export')).toHaveCount(0);
      expect(unexpected(admin.errors)).toEqual([]);
    } finally {
      await admin.context.close();
    }
  });

  test('audit : l’owner lit les événements du parcours, filtre, exporte en NDJSON ; aucun lien, jeton, mot de passe ni graine', async () => {
    const { page } = owner;
    await page.goto(`${instance.url}/admin/audit`);
    await expect(page.locator('h1')).toHaveText(t('audit.title'));
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    const table = page.getByTestId('audit-table');
    for (const action of ['invitation.created', 'invitation.accepted', 'setup.owner_created', 'mfa.enabled']) await expect(table, action).toContainText(t(`audit.action.${action.replaceAll('.', '_')}`));
    // L'action brute reste lisible à côté du libellé.
    await expect(table.locator('code').filter({ hasText: 'invitation.accepted' }).first()).toBeVisible();

    // Filtre par action et par résultat : seules les lignes correspondantes restent.
    await page.locator('#audit-action').fill('invitation.accepted');
    await page.getByTestId('audit-filters').locator('button[type="submit"]').click();
    const rows = page.getByTestId('audit-row');
    await expect
      .poll(async () => {
        const texts = await rows.allInnerTexts();
        return texts.length >= 2 && texts.every((row) => row.includes(t('audit.action.invitation_accepted'))); // membre et admin
      })
      .toBe(true);
    await page.locator('#audit-action').fill('');

    // Export : le fichier téléchargé est du NDJSON de métadonnées seulement.
    const download = page.waitForEvent('download');
    await page.getByTestId('audit-export').click();
    const file = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of file) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const events = body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { action: string });
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(['setup.owner_created', 'invitation.created', 'invitation.accepted']));
    const inviteToken = memberLink.slice(memberLink.lastIndexOf('/') + 1);
    for (const secret of [memberLink, inviteToken, OWNER.password, MEMBER.password, ADMIN.password, ownerSecret, instance.bootstrapToken, instance.masterKey]) expect(body, secret.slice(0, 6)).not.toContain(secret);
    expect(body).not.toMatch(/sy_live_[A-Za-z0-9]{20,}/);
    expect(unexpected(owner.errors)).toEqual([]);
  });

  test('l’owner se reconnecte : mot de passe puis second facteur, et la page Utilisateurs montre les comptes sans aucun contrôle d’impersonation', async ({ browser }) => {
    const again = await person(browser);
    try {
      const { page } = again;
      // Le code de l'enrôlement a consommé un pas : on attend le suivant (fenêtre de ±1 pas du serveur).
      await signIn(page, OWNER, ownerSecret, 1);
      await page.goto(`${instance.url}/admin/users`);
      const rows = page.getByTestId('account-row');
      await expect(rows).toHaveCount(3);
      const html = await page.content();
      expect(html).not.toMatch(/impersonat|sign in as|act as|log in as/i);
      // Chaque action proposée est une action de gestion de compte.
      const actions = await page.locator('[data-testid^="action-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) expect(['action-makeAdmin', 'action-makeMember', 'action-disable', 'action-enable', 'action-delete', 'action-revokeAccess', 'action-resetTwoFactor', 'action-resetLink']).toContain(action);
      // Désactiver le membre : confirmation en ligne annulable (Échap), puis exécution.
      const memberRow = rows.filter({ hasText: MEMBER.email });
      await memberRow.getByTestId('action-disable').click();
      await expect(page.getByTestId('confirm-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('confirm-panel')).toHaveCount(0);
      await memberRow.getByTestId('action-disable').click();
      await page.getByTestId('confirm-yes').click();
      await expect(page.getByTestId('users-notice')).toHaveText(t('users.done.disabled'));
      await expect(memberRow).toContainText(t('users.statuses.disabled'));
      expect(unexpected(again.errors)).toEqual([]);
    } finally {
      await again.context.close();
    }
  });
});

test.describe('assert_no_csp_violation (instance réelle)', () => {
  let instance: Instance;
  test.beforeAll(async () => {
    instance = await startInstance();
    baseURL = instance.url;
  });
  test.afterAll(async () => {
    await instance?.close();
  });

  test('témoin : le relais sert la CSP de la console et une violation est bien relevée (le contrôle sait donc échouer), puis le relevé est vidé', async ({ browser }) => {
    const visitor = await person(browser);
    try {
      const { page } = visitor;
      const served = page.waitForResponse((response) => new URL(response.url()).pathname === '/setup');
      await page.goto('/setup');
      expect((await served).headers()['content-security-policy']).toBe(CONSOLE_CSP);
      await expect(page.locator('h1')).toHaveText(t('setup.title'));
      expect(cspViolations).toEqual([]);
      // Un script en ligne est refusé par `script-src 'self'` : le relevé doit l'avoir vu.
      await page.evaluate(() => {
        const scope = globalThis as unknown as { document: { createElement: (tag: string) => { textContent: string }; head: { append: (node: unknown) => void } } };
        const script = scope.document.createElement('script');
        script.textContent = 'void 0;';
        scope.document.head.append(script);
      });
      await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
      expect(cspViolations[0]).toContain('script-src');
      cspViolations.length = 0;
    } finally {
      await visitor.context.close();
    }
  });
});
