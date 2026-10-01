// SPDX-License-Identifier: AGPL-3.0-only
// Multilingue côté serveur (tâche 3.20, 21b M2, M3 à M5, M9, M10, M11) sur base réelle : langue du compte matérialisée une
// seule fois, PATCH /api/me (langue, fuseau), message REST localisé (`Content-Language`, `Vary`), invitation et e-mails dans
// la langue de leur destinataire, audit exporté en codes seulement, `DEFAULT_LOCALE`.
import { defaultI18n, findRenderedSentences, sentenceMatcher } from '@runtime/i18n';
import { saveSmtpSettings } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { startFakeSmtp } from '../../../tests/helpers/smtp-server.js';
import { createUser, nextTestIp, PUBLIC_URL, sessionCookie, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { loadServerConfig } from './config.js';

let srv: TestServer;
let owner: TestUser;
let ownerCookie: string;
const json = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, origin: PUBLIC_URL, ...extra });
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);

beforeAll(async () => {
  srv = await startTestServer('i18n');
  // Premier démarrage depuis un navigateur en français : la langue de l'owner et de l'instance en découlent (21 § 3).
  const password = `zz_test_${Math.random().toString(36).slice(2)}_Aa1!xyz`;
  const res = await srv.app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8' },
    payload: { token: srv.bootstrapToken, email: 'zz_test_owner_fr@example.test', password },
  });
  expect(res.statusCode, res.body).toBe(201);
  owner = { id: res.json<{ userId: string }>().userId, email: 'zz_test_owner_fr@example.test', password, role: 'owner' };
  ownerCookie = await signIn(srv, owner);
}, 120_000);
afterAll(async () => {
  await srv.close();
});

describe('M2 : la langue du compte est matérialisée une seule fois', () => {
  test('assert_locale_materialized_once : Accept-Language initialise users.locale et default_locale au premier démarrage, jamais ensuite', async () => {
    expect(await sql('SELECT locale, timezone FROM users WHERE id = $1', [owner.id])).toEqual([{ locale: 'fr', timezone: null }]);
    expect(await sql("SELECT value FROM settings WHERE key = 'default_locale'")).toEqual([{ value: 'fr' }]);
    // Le navigateur passe en anglais : à la reconnexion, users.locale reste fr (le compte gagne, 21 § 3).
    const again = await srv.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: nextTestIp(),
      headers: { origin: PUBLIC_URL, 'accept-language': 'en-US,en;q=0.9' },
      payload: { email: owner.email, password: owner.password },
    });
    expect(again.statusCode).toBe(200);
    expect(await sql('SELECT locale FROM users WHERE id = $1', [owner.id])).toEqual([{ locale: 'fr' }]);
    const me = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sessionCookie(again), 'accept-language': 'en-US,en;q=0.9' } });
    expect(me.json()).toMatchObject({ locale: 'fr', timezone: null });
  });

  test('PATCH /api/me : langue livrée seulement, fuseau IANA contrôlé, audit sans la valeur du fuseau', async () => {
    const patch = (payload: Record<string, unknown>, cookie = ownerCookie) => srv.app.inject({ method: 'PATCH', url: '/api/me', headers: json(cookie), payload });
    const bad = await patch({ locale: 'xx' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_locale' } });
    const badZone = await patch({ timezone: 'Paris' });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json()).toMatchObject({ error: { code: 'invalid_timezone' } });
    const ok = await patch({ timezone: 'Europe/Paris' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ locale: 'fr', timezone: 'Europe/Paris' });
    expect((await patch({ locale: 'en' })).json()).toMatchObject({ locale: 'en', timezone: 'Europe/Paris' });
    expect((await patch({ locale: 'fr' })).json()).toMatchObject({ locale: 'fr' });
    // Le fuseau est une donnée personnelle : l'audit garde le nom du champ, jamais sa valeur (17 § 6).
    const rows = await sql<{ meta: { fields: string[] } }>("SELECT meta FROM audit_events WHERE action = 'account.preferences_updated' ORDER BY id");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(rows)).not.toContain('Europe/Paris');
    expect(rows.map((r) => r.meta.fields)).toContainEqual(['timezone']);
    // Effacer le fuseau.
    expect((await patch({ timezone: null })).json()).toMatchObject({ timezone: null });
    expect((await patch({})).statusCode).toBe(400);
  });
});

describe('REST : message localisé, code stable', () => {
  test('Accept-Language valide → message dans la langue, Content-Language et Vary ; le code ne change pas', async () => {
    const fr = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { 'accept-language': 'fr-CA,fr;q=0.9' } });
    const en = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { 'accept-language': 'en-US,en;q=0.9' } });
    expect(fr.statusCode).toBe(401);
    expect(fr.json()).toEqual({ error: { code: 'unauthorized', message: 'Identifiant absent, expiré ou révoqué.' } });
    expect(en.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing, expired or revoked credentials.' } });
    expect(fr.headers['content-language']).toBe('fr');
    expect(en.headers['content-language']).toBe('en');
    expect(String(fr.headers['vary'])).toContain('Accept-Language');
  });

  test('sans en-tête : langue de l’instance (fr, initialisée par le premier démarrage) ; langue inconnue : repli sur la langue de l’instance', async () => {
    const none = await srv.app.inject({ method: 'GET', url: '/api/me' });
    expect(none.json<{ error: { message: string } }>().error.message).toBe('Identifiant absent, expiré ou révoqué.');
    const odd = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { 'accept-language': 'ja,zh;q=0.5' } });
    expect(odd.headers['content-language']).toBe('fr');
  });

  test('compte connecté sans en-tête : users.locale du propriétaire de la session ; la langue d’un en-tête valide passe avant', async () => {
    await sql("UPDATE users SET locale = 'en' WHERE id = $1", [owner.id]);
    try {
      const forbidden = await srv.app.inject({ method: 'DELETE', url: `/api/users/${owner.id}`, headers: json(ownerCookie) });
      expect(forbidden.headers['content-language']).toBe('en');
      const header = await srv.app.inject({ method: 'DELETE', url: `/api/users/${owner.id}`, headers: json(ownerCookie, { 'accept-language': 'fr' }) });
      expect(header.headers['content-language']).toBe('fr');
      expect(header.json<{ error: { code: string } }>().error.code).toBe(forbidden.json<{ error: { code: string } }>().error.code);
    } finally {
      await sql("UPDATE users SET locale = 'fr' WHERE id = $1", [owner.id]);
    }
  });

  test('un message sans entrée de catalogue garde son texte d’origine (aucune clé brute)', async () => {
    const res = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', headers: { 'accept-language': 'fr' }, payload: { token: 'zz', password: 'x' } });
    expect(res.json<{ error: { message: string } }>().error.message).not.toMatch(/^srv\./);
  });
});

describe('M9 : invitation et réinitialisation dans la langue de leur destinataire', () => {
  test('assert_email_locale_resolution : invitation créée en fr → sujet et corps en français, Content-Language fr, lang du HTML, aucun suivi, compte créé en fr', async () => {
    const smtp = await startFakeSmtp();
    try {
      await saveSmtpSettings(srv.started.ctx.pool, srv.started.ctx.secrets!, { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'runtime@scrapyomama.zz-test' }, { userId: owner.id, role: 'owner' });
      const created = await srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(ownerCookie), payload: { email: 'zz_test_inv_fr@example.test', role: 'member', locale: 'fr' } });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json()).toMatchObject({ locale: 'fr', emailed: true });
      const mail = smtp.mails.at(-1)!;
      expect(mail.headers['content-language']).toBe('fr');
      expect(mail.headers['subject']).toMatch(/^=\?UTF-8\?B\?|t'invite sur/);
      const subject = /^=\?UTF-8\?B\?/.test(mail.headers['subject'] ?? '') ? Buffer.from((mail.headers['subject'] ?? '').replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8') : (mail.headers['subject'] ?? '');
      expect(subject).toContain("t'invite sur");
      expect(mail.text).toContain('Ouvre ce lien pour créer ton compte');
      expect(mail.text).not.toMatch(/Open this link/);
      expect(mail.html).toContain('<html lang="fr">');
      expect(`${mail.text}${mail.html}`).not.toMatch(/[{}]|undefined|<img|pixel/i);
      const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
      expect(token).toBeDefined();
      const accepted = await srv.app.inject({ method: 'POST', url: '/api/invitations/accept', payload: { token, password: `zz_test_${Math.random().toString(36).slice(2)}_Aa1!xyz` } });
      expect(accepted.statusCode, accepted.body).toBe(200);
      // Copiée dans users.locale à l'acceptation.
      expect(await sql("SELECT locale FROM users WHERE email = 'zz_test_inv_fr@example.test'")).toEqual([{ locale: 'fr' }]);
      // Sans `locale`, l'invitation prend la langue de l'invitant ; une langue inconnue est refusée.
      const defaulted = await srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(ownerCookie), payload: { email: 'zz_test_inv_def@example.test', role: 'member' } });
      expect(defaulted.json()).toMatchObject({ locale: 'fr' });
      const refused = await srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(ownerCookie), payload: { email: 'zz_test_inv_xx@example.test', role: 'member', locale: 'xx' } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: { code: 'invalid_locale' } });
      // Invitation en anglais : sujet anglais.
      const en = await srv.app.inject({ method: 'POST', url: '/api/invitations', headers: json(ownerCookie), payload: { email: 'zz_test_inv_en@example.test', role: 'member', locale: 'en' } });
      expect(en.statusCode).toBe(201);
      expect(smtp.mails.at(-1)!.text).toContain('Open this link to create your account');
      expect(smtp.mails.at(-1)!.headers['content-language']).toBe('en');
    } finally {
      await smtp.close();
    }
  });

  test('assert_user_timezone_used_in_messages : l’e-mail de réinitialisation est dans users.locale et l’heure dans users.timezone, sinon UTC étiqueté', async () => {
    const smtp = await startFakeSmtp();
    try {
      await saveSmtpSettings(srv.started.ctx.pool, srv.started.ctx.secrets!, { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'runtime@scrapyomama.zz-test' }, { userId: owner.id, role: 'owner' });
      const user: TestUser = await createUser(srv, 'zz_test_tz@example.test');
      await sql("UPDATE users SET locale = 'fr', timezone = 'Asia/Tokyo' WHERE id = $1", [user.id]);
      const ask = async () => {
        const before = smtp.mails.length;
        const res = await srv.app.inject({ method: 'POST', url: '/api/auth/password-reset/request', remoteAddress: nextTestIp(), payload: { email: user.email } });
        expect(res.statusCode).toBe(202);
        for (let i = 0; i < 100 && smtp.mails.length === before; i++) await new Promise((r) => setTimeout(r, 50));
        return smtp.mails.at(-1)!;
      };
      const tokyo = await ask();
      expect(tokyo.headers['content-language']).toBe('fr');
      expect(tokyo.text).toContain('Réinitialise');
      expect(tokyo.text).toMatch(/UTC\+9|GMT\+9/);
      await sql('UPDATE users SET timezone = NULL WHERE id = $1', [user.id]);
      const utc = await ask();
      expect(utc.text).toContain('UTC');
      expect(utc.text).not.toMatch(/UTC\+9|GMT\+9/);
    } finally {
      await smtp.close();
    }
  });
});

describe('M5 : audit exporté en codes seulement', () => {
  test('assert_audit_export_codes_only : aucune ligne de l’export NDJSON ne contient une phrase du catalogue ; le détecteur en voit une', async () => {
    const res = await srv.app.inject({ method: 'GET', url: '/api/audit/export', headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(5);
    const matches = sentenceMatcher(defaultI18n().catalogs);
    for (const line of lines) expect(findRenderedSentences({ action: line['action'], meta: line['meta'] }, matches), String(line['action'])).toEqual([]);
    expect(findRenderedSentences({ action: 'x', meta: { reason: defaultI18n().renderer.render('srv.error.not_found', {}, 'en') + ' now' } }, matches).length).toBe(0);
    expect(findRenderedSentences({ meta: { detail: 'The instance is starting up: the database schema is not up to date yet (runtime migrate).' } }, matches)).toEqual(['$.meta.detail']);
  });
});

describe('DEFAULT_LOCALE', () => {
  test('une langue livrée est acceptée ; une langue inconnue arrête le démarrage', () => {
    const env = { DATABASE_URL: 'postgres://x', PUBLIC_URL: 'http://localhost:3000', MASTER_KEY: srv.masterKey };
    expect(loadServerConfig({ ...env, DEFAULT_LOCALE: 'FR' }).defaultLocale).toBe('fr');
    expect(loadServerConfig({ ...env }).defaultLocale).toBeNull();
    expect(() => loadServerConfig({ ...env, DEFAULT_LOCALE: 'xx' })).toThrow(/DEFAULT_LOCALE invalide/);
  });
});
