// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot (tâche 3.8b, 17 §5, 06 « Identité du robot ») sur base réelle : les réglages `identify_instance` et
// `instance_contact` s'écrivent par la route admin `PUT /api/settings/identity` (rôle admin ou owner, jamais member ni clé
// d'API), audités, contact validé par `normalizeInstanceContact` ; le User-Agent réel du moteur (publié par le worker) est
// rendu en lecture seule ; le contact peut aussi être saisi à l'assistant de premier démarrage. Ce que la route écrit est
// exactement ce que le worker lit : la chaîne de lecture du worker (factory.ts) est rejouée ici sur la même base.
import { buildUserAgent, engineUserAgent, resolveIdentifyInstance, resolveInstanceContact, robotFrom } from '@runtime/core/access';
import { publishRobotEngine, readIdentifyInstanceSetting, readInstanceContactSetting } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';

let srv: TestServer;
let owner: TestUser;
let ownerCookie: string;
let admin: TestUser;
let adminCookie: string;
let memberCookie: string;

const json = (cookie: string) => ({ cookie, origin: PUBLIC_URL });
const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => (await c.query<T>(text, params)).rows);
const put = (cookie: string, payload: unknown) => srv.app.inject({ method: 'PUT', url: '/api/settings/identity', headers: json(cookie), payload: payload as Record<string, unknown> });
const get = (cookie: string) => srv.app.inject({ method: 'GET', url: '/api/settings/identity', headers: { cookie } });
const auditOf = (action: string) => sql<{ actor_user_id: string | null; outcome: string; meta: Record<string, unknown> }>('SELECT actor_user_id, outcome, meta FROM audit_events WHERE action = $1 ORDER BY id', [action]);
const settingRows = (key: string) => sql<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]);

/** La lecture du worker (factory.ts) : réglage d'abord, puis la variable d'environnement (ici absente). */
async function workerView(env: Record<string, string> = {}): Promise<{ identify: boolean; contact: string | null }> {
  return withClient(srv.db.url, async (c) => ({
    identify: resolveIdentifyInstance(await readIdentifyInstanceSetting(c), env),
    contact: resolveInstanceContact(await readInstanceContactSetting(c), env),
  }));
}

beforeAll(async () => {
  srv = await startTestServer('identity');
  owner = await runSetup(srv);
  ownerCookie = await signIn(srv, owner);
  admin = await createUser(srv, 'zz_test_identity_admin@example.test', 'admin');
  adminCookie = await signIn(srv, admin);
  const member = await createUser(srv, 'zz_test_identity_member@example.test', 'member');
  memberCookie = await signIn(srv, member);
}, 120_000);

afterAll(async () => {
  await srv?.close();
});

describe('assert_identity_settings_admin_only : réglages d’identité du robot, rôle admin seul', () => {
  test('un membre reçoit 403 en lecture comme en écriture, sans rien écrire, et le refus est audité', async () => {
    expect((await get(memberCookie)).statusCode).toBe(403);
    expect((await put(memberCookie, { identify_instance: true, instance_contact: 'ops@zz-test.example' })).statusCode).toBe(403);
    expect(await settingRows('identify_instance')).toEqual([]);
    expect(await settingRows('instance_contact')).toEqual([]);
    expect((await auditOf('access.denied')).filter((e) => e.outcome === 'denied').length).toBeGreaterThanOrEqual(2);
  });

  test('une clé d’API ne lit ni n’écrit, même d’un admin (session d’interface seulement)', async () => {
    const key = await createKey(srv, adminCookie, admin, ['apis:read']);
    const headers = { authorization: `Bearer ${key.key}` };
    expect((await srv.app.inject({ method: 'GET', url: '/api/settings/identity', headers })).statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'PUT', url: '/api/settings/identity', headers, payload: { identify_instance: true } })).statusCode).toBe(403);
    expect(await settingRows('identify_instance')).toEqual([]);
  });

  test('sans réglage posé : rien d’inventé (null), le robot retombe sur l’environnement puis sur « désactivé »', async () => {
    const res = await get(adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ identify_instance: null, instance_contact: null });
    expect(await workerView()).toEqual({ identify: false, contact: null });
  });

  test('l’admin active l’identification et pose le contact : normalisé, audité (champs, jamais le contact), lu tel quel par le worker', async () => {
    const res = await put(adminCookie, { identify_instance: true, instance_contact: '  ops@zz-test.example ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ identify_instance: true, instance_contact: 'mailto:ops@zz-test.example' });
    expect(await settingRows('identify_instance')).toEqual([{ value: true }]);
    expect(await settingRows('instance_contact')).toEqual([{ value: 'mailto:ops@zz-test.example' }]);
    expect((await get(ownerCookie)).json()).toMatchObject({ identify_instance: true, instance_contact: 'mailto:ops@zz-test.example' });

    const events = await auditOf('settings.identity_updated');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_user_id: admin.id, outcome: 'success', meta: { fields: ['identify_instance', 'instance_contact'], identify_instance: true } });
    expect(JSON.stringify(await sql('SELECT * FROM audit_events'))).not.toContain('ops@zz-test.example');

    // Le run suivant : le worker lit ces réglages et le User-Agent porte le jeton, `From` le contact électronique.
    const view = await workerView();
    expect(view).toEqual({ identify: true, contact: 'mailto:ops@zz-test.example' });
    const engine = { version: '153.0.8010.12', platform: 'linux' };
    const ua = buildUserAgent({ engine, ...(view.identify ? { identify: { version: '1.2.3', contact: view.contact } } : {}) });
    expect(ua).toBe(`${engineUserAgent(engine)} (compatible; Scrapyomama/1.2.3; +mailto:ops@zz-test.example)`);
    expect(robotFrom(view.contact)).toBe('ops@zz-test.example');
  });

  test('contact refusé : espace, CR/LF, schéma ou identifiants interdits, trop long ; le réglage en place est inchangé', async () => {
    const refused = ['ops @zz-test.example', 'ops@zz-test.example\r\nX-Injected: 1', 'https://example.test/a b', 'ftp://example.test/contact', 'https://user:pw@example.test/', 'javascript:alert(1)', `https://example.test/${'a'.repeat(300)}`, '', '   '];
    for (const contact of refused) {
      const res = await put(adminCookie, { instance_contact: contact });
      expect(res.statusCode, JSON.stringify(contact)).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_instance_contact', message: expect.any(String) } });
      expect(res.body).not.toContain('Injected');
    }
    expect(await settingRows('instance_contact')).toEqual([{ value: 'mailto:ops@zz-test.example' }]);
    // Aucune écriture partielle : l'interrupteur envoyé avec un mauvais contact n'a pas bougé.
    expect((await put(adminCookie, { identify_instance: false, instance_contact: 'ops @zz-test.example' })).statusCode).toBe(400);
    expect(await settingRows('identify_instance')).toEqual([{ value: true }]);
  });

  test('corps invalide : vide, champ inconnu, interrupteur non booléen', async () => {
    for (const body of [{}, { other: 1 }, { identify_instance: 'yes' }, { identify_instance: null }]) {
      expect((await put(adminCookie, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  test('l’interrupteur seul (contact inchangé) ; désactiver l’emporte sur la variable d’environnement ; null efface le contact', async () => {
    const off = await put(ownerCookie, { identify_instance: false });
    expect(off.json()).toMatchObject({ identify_instance: false, instance_contact: 'mailto:ops@zz-test.example' });
    expect((await workerView({ IDENTIFY_INSTANCE: 'true' })).identify).toBe(false);
    expect((await auditOf('settings.identity_updated')).at(-1)).toMatchObject({ actor_user_id: owner.id, meta: { fields: ['identify_instance'], identify_instance: false } });

    const cleared = await put(adminCookie, { instance_contact: null });
    expect(cleared.json()).toMatchObject({ instance_contact: null });
    expect(await settingRows('instance_contact')).toEqual([]);
    expect((await workerView({ INSTANCE_CONTACT: 'https://zz-test.example/contact' })).contact).toBe('https://zz-test.example/contact');
  });

  test('User-Agent réel du moteur en lecture seule : publié par le worker, jamais écrit par la route', async () => {
    expect((await get(adminCookie)).json()).toMatchObject({ engine: null, user_agent: null, user_agent_identified: null });
    const engine = { version: '153.0.8010.12', platform: 'linux' };
    await withClient(srv.db.url, (c) => publishRobotEngine(c, engine));
    await put(adminCookie, { identify_instance: true, instance_contact: 'https://zz-test.example/robot' });
    const view = (await get(adminCookie)).json<{ user_agent: string; user_agent_identified: string; engine: unknown }>();
    expect(view.engine).toEqual(engine);
    expect(view.user_agent).toBe(engineUserAgent(engine));
    expect(view.user_agent).not.toMatch(/HeadlessChrome|Scrapyomama/);
    // La version publiée est celle du paquet (U4.1), non plus le placeholder 0.0.0.
    expect(view.user_agent_identified).toMatch(/\(compatible; Scrapyomama\/\d+\.\d+\.\d+; \+https:\/\/zz-test\.example\/robot\)$/);
    expect(view.user_agent_identified.startsWith(`${engineUserAgent(engine)} (compatible; Scrapyomama/`)).toBe(true);
    // Le User-Agent n'est pas un champ d'écriture.
    expect((await put(adminCookie, { user_agent: 'Mozilla/5.0 (X11) Firefox/130' })).statusCode).toBe(400);
    expect((await get(adminCookie)).json<{ user_agent: string }>().user_agent).toBe(engineUserAgent(engine));
  });

  test('réglages jamais posés : la console montre ce que le worker applique (environnement publié par le worker, sa version), comme sur le fil', async () => {
    await sql("DELETE FROM settings WHERE key IN ('identify_instance', 'instance_contact')");
    const engine = { version: '153.0.8010.12', platform: 'linux' };
    const env = { IDENTIFY_INSTANCE: 'true', INSTANCE_CONTACT: 'https://zz-test.example/env' };
    await withClient(srv.db.url, (c) => publishRobotEngine(c, { ...engine, productVersion: '4.5.6', identifyInstanceEnv: true, instanceContactEnv: 'https://zz-test.example/env' }));
    const view = (await get(adminCookie)).json<Record<string, unknown>>();
    expect(view).toMatchObject({
      identify_instance: null,
      identify_effective: true,
      identify_source: 'env',
      instance_contact: null,
      instance_contact_effective: 'https://zz-test.example/env',
      instance_contact_source: 'env',
      engine,
      worker_version: '4.5.6',
    });
    // Ce que le worker envoie avec ce même environnement : exactement l'aperçu de la console (version du worker, pas du serveur).
    const worker = await workerView(env);
    expect(worker).toEqual({ identify: true, contact: 'https://zz-test.example/env' });
    expect(view.user_agent_identified).toBe(buildUserAgent({ engine, identify: { version: '4.5.6', contact: worker.contact } }));
    // Le réglage l'emporte, dans les deux sens : désactivé ici, la source devient le réglage.
    const off = (await put(adminCookie, { identify_instance: false })).json<Record<string, unknown>>();
    expect(off).toMatchObject({ identify_instance: false, identify_effective: false, identify_source: 'setting' });
    expect((await workerView(env)).identify).toBe(false);
  });

  test('audit : seuls les champs dont la valeur change ; une écriture identique ne liste aucun champ', async () => {
    const before = (await auditOf('settings.identity_updated')).length;
    await put(adminCookie, { identify_instance: false, instance_contact: 'ops@zz-test.example' });
    await put(adminCookie, { identify_instance: false, instance_contact: 'ops@zz-test.example' });
    await put(adminCookie, { identify_instance: true, instance_contact: 'mailto:ops@zz-test.example' });
    const events = (await auditOf('settings.identity_updated')).slice(before).map((e) => e.meta);
    expect(events).toEqual([{ fields: ['instance_contact'] }, { fields: [] }, { fields: ['identify_instance'], identify_instance: true }]);
  });

  test('écriture et audit dans la même transaction : un audit impossible n’écrit aucun réglage', async () => {
    await sql(`CREATE FUNCTION zz_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'settings.identity_updated' THEN RAISE EXCEPTION 'zz_test audit indisponible'; END IF; RETURN NEW; END $$`);
    await sql('CREATE TRIGGER zz_test_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION zz_test_audit_fail()');
    try {
      expect((await put(adminCookie, { identify_instance: false, instance_contact: 'https://zz-test.example/other' })).statusCode).toBe(500);
      expect(await settingRows('identify_instance')).toEqual([{ value: true }]);
      expect(await settingRows('instance_contact')).toEqual([{ value: 'mailto:ops@zz-test.example' }]);
    } finally {
      await sql('DROP TRIGGER zz_test_audit_fail ON audit_events');
      await sql('DROP FUNCTION zz_test_audit_fail()');
    }
  });
});

describe('assert_setup_instance_contact : le contact d’instance à l’assistant de premier démarrage', () => {
  test('contact valide : enregistré avec la création de l’owner ; invalide : 400 et aucun owner créé', async () => {
    const fresh = await startTestServer('identsetup');
    try {
      const password = 'zz_test_long_password_1';
      const bad = await fresh.app.inject({ method: 'POST', url: '/api/setup', payload: { token: fresh.bootstrapToken, email: 'zz_test_o1@example.test', password, instanceContact: 'ops @x.test' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { code: 'invalid_instance_contact' } });
      const rows = (text: string) => withClient(fresh.db.url, async (c) => (await c.query(text)).rows);
      expect(await rows("SELECT 1 FROM users WHERE role = 'owner'")).toEqual([]);
      expect(await rows("SELECT 1 FROM settings WHERE key = 'instance_contact'")).toEqual([]);

      const ok = await fresh.app.inject({ method: 'POST', url: '/api/setup', payload: { token: fresh.bootstrapToken, email: 'zz_test_o1@example.test', password, instanceContact: 'ops@zz-test.example' } });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await rows("SELECT value FROM settings WHERE key = 'instance_contact'")).toEqual([{ value: 'mailto:ops@zz-test.example' }]);
    } finally {
      await fresh.close();
    }
  }, 120_000);
});
