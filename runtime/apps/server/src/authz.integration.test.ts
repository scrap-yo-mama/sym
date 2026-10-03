// SPDX-License-Identifier: AGPL-3.0-only
// INV12 et INV5 sur les routes existantes (tâche 0.3b) : harnais paramétré par le registre des routes.
// Toute nouvelle route rejoint routes/registry.ts ; si elle porte une ressource, RESOURCE_CASES doit savoir créer un
// objet de A (sinon le test échoue), et si elle prend un corps, VALID_BODIES doit en fournir un.
import { readFileSync } from 'node:fs';
import { can, GRANTABLE_SCOPES } from '@runtime/core';
import { withActor } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun, seedSchedule, seedWebhook } from '../../../tests/helpers/rest-seed.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { buildServer, UnregisteredRouteError } from './app.js';
import { ROUTES, type OwnedResource, type RouteSpec } from './routes/registry.js';

type Party = { user: TestUser; cookie: string; /** Jeton d'extension (routes `auth: extension`, tâche 2.6). */ ext: string };

let srv: TestServer;
let owner: Party;
let admin: Party;
let a: Party;
let b: Party;

/** Jeton d'un nouvel appareil de `party` (code d'appairage avec ré-authentification, puis échange). */
async function pairDevice(party: Pick<Party, 'user' | 'cookie'>, deviceId: string): Promise<{ token: string; tunnelId: string }> {
  const code = await srv.app.inject({ method: 'POST', url: '/api/extension/pairing-codes', headers: { cookie: party.cookie, origin: PUBLIC_URL }, payload: { currentPassword: party.user.password } });
  const res = await srv.app.inject({ method: 'POST', url: '/api/extension/pair', payload: { code: code.json<{ code: string }>().code, deviceId } });
  const token = res.json<{ token: string }>().token;
  const tunnelId = await withClient(srv.db.url, async (c) => (await c.query<{ id: string }>('SELECT id FROM tunnels WHERE owner_id = $1 AND device_id = $2 AND revoked_at IS NULL', [party.user.id, deviceId])).rows[0]!.id);
  return { token, tunnelId };
}

let seq = 0;
/** État d'un objet relevé à sa création (`intact` le compare après les appels croisés). */
const snapshots = new Map<string, string>();
const apiSnapshot = (id: string) => withClient(srv.db.url, async (c) => (await c.query<{ s: string }>('SELECT row_to_json(a)::text AS s FROM apis a WHERE id = $1', [id])).rows[0]?.s ?? '');
const scheduleSnapshot = (id: string) => withClient(srv.db.url, async (c) => (await c.query<{ s: string }>('SELECT row_to_json(s)::text AS s FROM schedules s WHERE id = $1', [id])).rows[0]?.s ?? '');
/** Paramètres de chemin d'un objet (`:id`, `:slug`, `:version`) ; le premier sert de marqueur dans les listes. */
type Params = Record<string, string>;
/**
 * Un cas par type de ressource : `create` crée un objet appartenant à `party` et renvoie ses paramètres de chemin ;
 * `intact` vérifie qu'il existe toujours, inchangé, pour son propriétaire.
 */
const RESOURCE_CASES: Record<OwnedResource, { create: (party: Party) => Promise<Params>; intact: (party: Party, params: Params) => Promise<boolean> }> = {
  api_key: {
    create: async (party) => ({ id: (await createKey(srv, party.cookie, party.user, ['apis:read'])).id }),
    intact: async (party, { id }) => {
      const list = await srv.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: party.cookie } });
      return list.json<{ items: { id: string; revokedAt: string | null }[] }>().items.some((k) => k.id === id && k.revokedAt === null);
    },
  },
  tunnel: {
    create: async (party) => ({ id: (await pairDevice(party, `zz_test_authz_dev_${(seq += 1)}`)).tunnelId }),
    intact: async (party, { id }) => {
      const list = await srv.app.inject({ method: 'GET', url: '/api/extension/devices', headers: { cookie: party.cookie } });
      return list.json<{ items: { id: string; revokedAt: string | null }[] }>().items.some((d) => d.id === id && d.revokedAt === null);
    },
  },
  auth_session: {
    // Une nouvelle connexion de la partie : sa session la plus récente.
    create: async (party) => {
      await signIn(srv, party.user);
      return { id: await withClient(srv.db.url, async (c) => (await c.query<{ id: string }>('SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [party.user.id])).rows[0]!.id) };
    },
    intact: async (party, { id }) => {
      const list = await srv.app.inject({ method: 'GET', url: '/api/me/sessions', headers: { cookie: party.cookie } });
      return list.json<{ sessions: { id: string }[] }>().sessions.some((s) => s.id === id);
    },
  },
  audit_event: {
    // Un événement de la partie (échec de connexion sur son compte), reconnaissable à un agent utilisateur unique
    // (l'identifiant numérique serait ambigu).
    create: async (party) => {
      const marker = `zz_test_ua_${(seq += 1)}_${party.user.id.slice(0, 8)}`;
      await srv.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin: PUBLIC_URL, 'user-agent': marker }, payload: { email: party.user.email, password: 'zz_test_wrong_password' } });
      return { id: marker };
    },
    intact: async (party, { id: marker }) => {
      const list = await srv.app.inject({ method: 'GET', url: '/api/me/audit?limit=200', headers: { cookie: party.cookie } });
      return marker !== undefined && list.body.includes(marker);
    },
  },
  auth_identity: {
    // Une identité OIDC liée au compte de la partie (issuer|sub unique).
    create: async (party) => ({
      id: await withClient(srv.db.url, async (c) =>
        (await c.query<{ id: string }>('INSERT INTO auth_accounts (user_id, provider_id, account_id) VALUES ($1, $2, $3) RETURNING id', [party.user.id, 'oidc:zz-test-authz', `https://idp.example.test|zz_test_sub_${(seq += 1)}`])).rows[0]!.id,
      ),
    }),
    intact: async (party, { id }) => {
      const list = await srv.app.inject({ method: 'GET', url: '/api/me/identities', headers: { cookie: party.cookie } });
      return list.json<{ identities: { id: string }[] }>().identities.some((i) => i.id === id);
    },
  },
  site_session: {
    create: async (party) => {
      const res = await srv.app.inject({ method: 'PUT', url: `/api/extension/sites/zz-test-authz-${(seq += 1)}.example`, headers: { authorization: `Bearer ${party.ext}` }, payload: { serverUseAllowed: false } });
      return { id: res.json<{ id: string }>().id };
    },
    intact: async (party, { id }) => {
      const list = await srv.app.inject({ method: 'GET', url: '/api/sites', headers: { cookie: party.cookie } });
      return list.json<{ items: { id: string }[] }>().items.some((s) => s.id === id);
    },
  },
  // API REST (3.1) : objets privés de la partie (API privée sans session, runs, datasets, planifications, cibles).
  api: {
    create: async (party) => {
      const api = await seedApi(srv.db.url, party.user.id);
      snapshots.set(api.id, await apiSnapshot(api.id));
      return { slug: api.slug, version: '1', id: api.id };
    },
    // Visible par A, et INCHANGÉE (description, politiques, statut, versions, `updated_at`) : une écriture croisée qui
    // répondrait quand même 404 serait vue.
    intact: async (party, { slug, id }) =>
      (await srv.app.inject({ method: 'GET', url: `/api/apis/${slug}`, headers: { cookie: party.cookie } })).statusCode === 200 && (await apiSnapshot(id!)) === snapshots.get(id!),
  },
  api_investigation: {
    create: async (party) => {
      const api = await seedApi(srv.db.url, party.user.id, { status: 'enquete', strategy: false });
      return { id: api.id, slug: api.slug };
    },
    intact: async (party, { slug }) => (await srv.app.inject({ method: 'GET', url: `/api/apis/${slug}`, headers: { cookie: party.cookie } })).json<{ status: string }>().status === 'enquete',
  },
  run: {
    create: async (party) => {
      const api = await seedApi(srv.db.url, party.user.id);
      return { id: (await seedRun(srv.db.url, { apiId: api.id, ownerId: party.user.id, items: [{ title: 'zz_test_item' }] })).runId };
    },
    intact: async (party, { id }) => (await srv.app.inject({ method: 'GET', url: `/api/runs/${id}`, headers: { cookie: party.cookie } })).json<{ state: string }>().state === 'succeeded',
  },
  dataset: {
    create: async (party) => {
      const api = await seedApi(srv.db.url, party.user.id);
      return { id: (await seedRun(srv.db.url, { apiId: api.id, ownerId: party.user.id, items: [{ title: 'zz_test_item' }] })).datasetId! };
    },
    intact: async (party, { id }) => (await srv.app.inject({ method: 'GET', url: `/api/datasets/${id}/items`, headers: { cookie: party.cookie } })).body.includes('zz_test_item'),
  },
  schedule: {
    // Planification ACTIVE : le PATCH { enabled: false } de VALID_BODIES aurait un effet visible s'il passait.
    create: async (party) => {
      const api = await seedApi(srv.db.url, party.user.id);
      const id = await seedSchedule(srv.db.url, api.id, party.user.id, { enabled: true });
      snapshots.set(id, await scheduleSnapshot(id));
      return { id, slug: api.slug };
    },
    intact: async (party, { id, slug }) =>
      (await srv.app.inject({ method: 'GET', url: `/api/apis/${slug}/schedules/${id}`, headers: { cookie: party.cookie } })).statusCode === 200 && (await scheduleSnapshot(id!)) === snapshots.get(id!),
  },
  webhook_subscription: {
    create: async (party) => ({ id: await seedWebhook(srv.db.url, party.user.id) }),
    intact: async (party, { id }) => (await srv.app.inject({ method: 'GET', url: `/api/webhook-subscriptions/${id}`, headers: { cookie: party.cookie } })).statusCode === 200,
  },
};

/** Corps valide par route à corps (sert aux cas 1 et 4 de 08b § 4). */
const VALID_BODIES: Record<string, (party: Party) => Record<string, unknown>> = {
  'POST /api/setup': () => ({ token: 'zz_test_token_not_used_000000000000', email: 'zz_test_x@example.test', password: 'zz_test_long_password' }),
  'POST /api/auth/sign-in/email': (p) => ({ email: p.user.email, password: p.user.password }),
  'POST /api/auth/sign-out': () => ({}),
  'POST /api/api-keys': (p) => ({ label: 'zz_test', scopes: ['apis:read'], currentPassword: p.user.password }),
  'POST /api/extension/pairing-codes': (p) => ({ currentPassword: p.user.password }),
  'POST /api/extension/pair': () => ({ code: 'ZZZZZ-ZZZZZ', deviceId: 'zz_test_authz_body' }),
  'PUT /api/extension/sites/:domain': () => ({ serverUseAllowed: false }),
  'PUT /api/extension/sites/:domain/cookies': () => ({ cookies: [] }),
  // Comptes avancés (3.7).
  'POST /api/auth/two-factor/verify': () => ({ code: '123456' }),
  'POST /api/auth/password-reset/request': () => ({ email: 'zz_test_nobody@example.test' }),
  'POST /api/auth/password-reset/confirm': () => ({ token: 'zz_test_not_a_token', password: 'zz_test_long_password_1' }),
  'POST /api/me/password': (p) => ({ current_password: p.user.password, new_password: 'zz_test_long_password_1' }),
  'POST /api/me/2fa/enroll': (p) => ({ current_password: p.user.password }),
  'POST /api/me/2fa/confirm': () => ({ code: '123456' }),
  'POST /api/me/2fa/backup-codes': (p) => ({ current_password: p.user.password, code: '123456' }),
  'POST /api/me/identities/oidc': (p) => ({ current_password: p.user.password }),
  'PATCH /api/users/:id': () => ({ role: 'member' }),
  'POST /api/users/:id/reset-link': () => ({}),
  'POST /api/users/:id/revoke-access': () => ({}),
  'POST /api/owner/transfer': (p) => ({ to_user_id: ZERO_UUID, current_password: p.user.password, totp_code: '123456' }),
  'POST /api/invitations': () => ({ email: 'zz_test_authz_invite@example.test', role: 'member' }),
  'POST /api/invitations/:id/resend': () => ({}),
  'POST /api/invitations/accept': () => ({ token: 'zz_test_not_a_token', password: 'zz_test_long_password_1' }),
  'PUT /api/settings/security': () => ({ session_idle_minutes: 720, session_absolute_hours: 168, allowed_email_domains: [], api_key_max_lifetime_days: 365 }),
  'PUT /api/settings/identity': () => ({ identify_instance: false }),
  'PUT /api/settings/sso': () => ({ enabled: false, slug: 'zz-test', issuer_url: 'https://idp.example.test/', client_id: 'zz_test_client' }),
  // API REST (3.1).
  'POST /api/apis': () => ({ description: 'zz_test authz', url: 'https://zz-test-authz.example/' }),
  'POST /api/apis/:id/validate-schema': () => ({}),
  'PATCH /api/apis/:slug': () => ({ description: 'zz_test authz' }),
  'POST /api/apis/:slug/runs': () => ({ input: {} }),
  'POST /api/apis/:slug/investigate': () => ({}),
  // Portabilité (3.12) : un modèle de templates/ (aperçu, sans `confirm`).
  'POST /api/apis/import': () => JSON.parse(readFileSync(new URL('../../../templates/livres-demo.api.json', import.meta.url), 'utf8')) as Record<string, unknown>,
  'POST /api/apis/:slug/versions/:version/revert': () => ({}),
  'POST /api/apis/:slug/schedules': () => ({ cron: '0 3 * * *', timezone: 'UTC', input: {} }),
  'PATCH /api/apis/:slug/schedules/:id': () => ({ enabled: false }),
  'POST /api/runs/:id/cancel': () => ({}),
  'POST /api/runs/:id/pause': () => ({}),
  'POST /api/runs/:id/resume': () => ({}),
  'POST /api/webhook-subscriptions': () => ({ url: 'https://zz-test-hook.example/in', events: ['run.failed'] }),
  'PATCH /api/webhook-subscriptions/:id': () => ({ events: ['run.failed'] }),
  'POST /api/webhook-subscriptions/:id/test': () => ({}),
  'PUT /api/settings/llm': () => ({ providers: [] }),
  'POST /api/settings/llm/test': () => ({ provider: 'zz-test', model: 'zz-model' }),
  'POST /api/settings/proxies': () => ({ label: 'zz_test', type: 'dc', url: 'http://zz-test-proxy.example:8080' }),
  'PATCH /api/settings/proxies/:id': () => ({ label: 'zz_test 2' }),
  'POST /api/settings/proxies/:id/test': () => ({}),
  'PUT /api/settings/smtp': () => ({ host: 'smtp.zz-test.example', port: 587, security: 'starttls', from: 'zz_test@example.test' }),
  'POST /api/settings/smtp/test': () => ({ to: 'zz_test@example.test' }),
  'POST /api/subjects/export': () => ({ identifier: 'zz_test_person@example.test' }),
  'POST /api/subjects/erase': () => ({ identifier: 'zz_test_person@example.test', dry_run: true }),
  'POST /api/tunnel/pairing-code': (p) => ({ current_password: p.user.password }),
  'POST /api/me/responsible-use': () => ({ version: '2026-10-01' }),
  // Serveur MCP (3.2) : message JSON-RPC ; ses outils ont leur propre test B contre A (mcp.integration.test.ts).
  'POST /mcp': () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
};

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

/** Clé d'API d'un acteur (routes `auth: key`, serveur MCP), créée une fois. */
const keys = new Map<string, string>();
async function partyKey(party: Party): Promise<string> {
  if (!keys.has(party.user.id)) keys.set(party.user.id, (await createKey(srv, party.cookie, party.user, ['apis:read'])).key);
  return keys.get(party.user.id)!;
}
const keyOf = (r: RouteSpec) => `${r.method} ${r.url}`;
const hasBody = (r: RouteSpec) => r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH';

/** Paramètres par défaut : un objet qui n'existe pas (même réponse qu'un objet d'autrui). */
const MISSING: Params = { id: ZERO_UUID, slug: 'zz-test-missing', version: '1', domain: 'zz-test-authz.example' };

async function call(route: RouteSpec, headers: Record<string, string>, params: Params | string = MISSING, payload?: Record<string, unknown>) {
  const p: Params = typeof params === 'string' ? { ...MISSING, id: params } : { ...MISSING, ...params };
  return srv.app.inject({
    method: route.method,
    url: route.url.replace(/:(\w+)/g, (_m, name: string) => p[name] ?? ''),
    headers: route.method === 'GET' ? headers : { origin: PUBLIC_URL, ...headers },
    ...(hasBody(route) ? { payload: payload ?? {} } : {}),
  });
}

beforeAll(async () => {
  srv = await startTestServer('authz');
  const o = await runSetup(srv);
  const party = async (user: TestUser): Promise<Party> => {
    const cookie = await signIn(srv, user);
    return { user, cookie, ext: (await pairDevice({ user, cookie }, `zz_test_authz_main_${user.id}`)).token };
  };
  owner = await party(o);
  admin = await party(await createUser(srv, 'zz_test_admin@example.test', 'admin'));
  a = await party(await createUser(srv, 'zz_test_user_a@example.test'));
  b = await party(await createUser(srv, 'zz_test_user_b@example.test'));
});
afterAll(async () => {
  await srv.close();
});

describe('registre des routes', () => {
  test('chaque route Fastify enregistrée est dans le registre, et réciproquement', () => {
    expect([...srv.app.registeredRoutes].sort()).toEqual(ROUTES.map(keyOf).sort());
  });

  test('une route hors registre ne peut pas être enregistrée', () => {
    const app = buildServer(srv.started.ctx);
    expect(() => app.get('/api/zz-test-unlisted', async () => ({}))).toThrow(UnregisteredRouteError);
  });

  test('chaque ressource du registre a son cas « B contre les objets de A », chaque route à corps un corps valide', () => {
    for (const route of ROUTES) {
      if (route.resource) expect(RESOURCE_CASES[route.resource.type]?.create, keyOf(route)).toBeTypeOf('function');
      if (hasBody(route)) expect(VALID_BODIES[keyOf(route)], keyOf(route)).toBeTypeOf('function');
    }
  });
});

describe('assert_cross_user_denied (INV12) : B contre les objets de A, sur chaque route à ressource', () => {
  const resourceRoutes = ROUTES.filter((r) => r.resource);
  test.each(resourceRoutes.map((r) => [keyOf(r), r] as const))('%s', async (_name, route) => {
    const resource = RESOURCE_CASES[route.resource!.type];
    const ofA = await resource.create(a);
    const markers = [ofA['id'], ofA['slug']].filter((v): v is string => typeof v === 'string');
    if (route.resource!.kind === 'item') {
      const cross = await call(route, { cookie: b.cookie }, ofA, VALID_BODIES[keyOf(route)]?.(b));
      const missing = await call(route, { cookie: b.cookie }, MISSING, VALID_BODIES[keyOf(route)]?.(b));
      expect(cross.statusCode).toBe(404);
      // Même réponse qu'un objet inexistant : aucun indice d'existence.
      expect({ status: cross.statusCode, body: cross.body }).toEqual({ status: missing.statusCode, body: missing.body });
      // L'objet de A est intact et toujours visible par A.
      expect(await resource.intact(a, ofA)).toBe(true);
    } else {
      const res = await call(route, { cookie: b.cookie });
      expect(res.statusCode).toBe(200);
      for (const marker of markers) expect(res.body).not.toContain(marker);
    }
    // L'admin et l'owner non plus ne voient ni ne touchent l'objet d'un membre par ces routes. Seule exception (INV5,
    // 05 § 4.4 `assert_no_impersonation`) : `GET /api/runs/{id}` leur rend les MÉTADONNÉES du run, jamais son contenu.
    for (const other of [admin, owner]) {
      const res = await call(route, { cookie: other.cookie }, ofA, VALID_BODIES[keyOf(route)]?.(other));
      if (route.resource!.kind === 'item' && keyOf(route) === 'GET /api/runs/:id') {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ metadata_only: true, attempts: [], dataset_id: null });
        expect(res.body).not.toMatch(/"input"|zz_test_item|zz_test_private/);
      } else if (route.resource!.kind === 'item') expect(res.statusCode).toBe(404);
      else for (const marker of markers) expect(res.body).not.toContain(marker);
    }
    expect(await resource.intact(a, ofA)).toBe(true);
  });
});

describe('assert_no_impersonation (INV5)', () => {
  test('aucun plugin de la bibliothèque d’auth, aucune fonction « se faire passer pour »', async () => {
    const auth = srv.started.ctx.auth;
    // Seule notre extension `runtime-session` (3.7) : points d'entrée SERVEUR SEULEMENT, sans chemin HTTP.
    const plugins = auth.options.plugins ?? [];
    expect(plugins.map((p) => p.id)).toEqual(['runtime-session']);
    for (const plugin of plugins) {
      for (const endpoint of Object.values(plugin.endpoints ?? {}) as { path?: string; options: { metadata?: { SERVER_ONLY?: boolean } } }[]) {
        expect(endpoint.options.metadata?.SERVER_ONLY).toBe(true);
        expect(endpoint.path).toBeUndefined();
      }
    }
    for (const path of ['/api/auth/issue-session', '/api/auth/issueSession']) {
      const res = await auth.handler(new Request(`${PUBLIC_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PUBLIC_URL }, body: JSON.stringify({ userId: a.user.id }) }));
      expect(res.status, path).toBe(404);
    }
    expect(Object.keys(auth.api).filter((k) => /imperson|admin|setRole|banUser|listUsers/i.test(k))).toEqual([]);
    expect(ROUTES.filter((r) => /imperson|act-?as|sudo|switch-user|\/users\/:id\/session/i.test(r.url))).toEqual([]);
  });

  test('aucune route ne change d’identité : en-têtes d’usurpation ignorés, route d’impersonation 404', async () => {
    for (const header of ['x-user-id', 'x-impersonate-user', 'x-act-as', 'x-forwarded-user']) {
      const res = await srv.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: admin.cookie, [header]: a.user.id } });
      expect(res.json<{ id: string }>().id).toBe(admin.user.id);
    }
    for (const url of ['/api/auth/admin/impersonate-user', '/api/auth/admin/stop-impersonating', '/api/users/' + a.user.id + '/impersonate']) {
      const res = await srv.app.inject({ method: 'POST', url, headers: { cookie: owner.cookie, origin: PUBLIC_URL }, payload: { userId: a.user.id } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  test('un admin ne lit que les métadonnées d’un run d’autrui (vue admin_run_metadata), jamais son contenu', async () => {
    const runId = await withClient(srv.db.url, async (c) => {
      const api = await c.query<{ id: string }>("INSERT INTO apis (slug, owner_id, requires_session) VALUES ('zz_test_session_api', $1, true) RETURNING id", [a.user.id]);
      const run = await c.query<{ id: string }>(
        `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, input, error_detail)
         VALUES ($1, $2, $2, 'rest', 'succeeded', '{"q": "zz_test_private_input"}', 'zz_test_private_error') RETURNING id`,
        [api.rows[0]!.id, a.user.id],
      );
      return run.rows[0]!.id;
    });
    for (const party of [admin, owner]) {
      const actor = { userId: party.user.id, role: party.user.role };
      await withActor(srv.started.ctx.pool, actor, async (db) => {
        expect((await db.query('SELECT * FROM runs WHERE id = $1', [runId])).rowCount).toBe(0);
        expect((await db.query('SELECT * FROM apis WHERE owner_id = $1', [a.user.id])).rowCount).toBe(0);
        const meta = await db.query('SELECT * FROM admin_run_metadata WHERE id = $1', [runId]);
        expect(meta.rowCount).toBe(1);
        expect(meta.fields.map((f) => f.name)).not.toEqual(expect.arrayContaining(['input']));
        expect(meta.fields.map((f) => f.name).filter((n) => ['input', 'error_detail', 'output', 'items_content'].includes(n))).toEqual([]);
        expect(JSON.stringify(meta.rows)).not.toContain('zz_test_private');
      });
    }
    // Un membre ne voit pas les métadonnées d'un autre.
    await withActor(srv.started.ctx.pool, { userId: b.user.id, role: 'member' }, async (db) => {
      expect((await db.query('SELECT * FROM admin_run_metadata WHERE id = $1', [runId])).rowCount).toBe(0);
    });
  });
});

describe('assert_authz_matrix (squelette, 08b § 4) : paramétré sur le registre', () => {
  const protectedRoutes = ROUTES.filter((r) => r.auth !== 'public');
  test.each(protectedRoutes.map((r) => [keyOf(r), r] as const))('cas 1, sans identifiant → 401 : %s', async (_name, route) => {
    const res = await call(route, {}, ZERO_UUID, VALID_BODIES[keyOf(route)]?.(a));
    expect(res.statusCode).toBe(401);
  });

  test.each(ROUTES.filter((r) => r.auth === 'session').map((r) => [keyOf(r), r] as const))(
    'clé d’API sur une route réservée à la session → 403 : %s',
    async (_name, route) => {
      const { key } = await createKey(srv, a.cookie, a.user, ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read', 'schedules:write', 'sites:read']);
      const res = await call(route, { authorization: `Bearer ${key}` }, ZERO_UUID, VALID_BODIES[keyOf(route)]?.(a));
      expect(res.statusCode).toBe(403);
    },
  );

  test.each(ROUTES.filter((r) => r.auth === 'session_or_key' && r.scope).map((r) => [keyOf(r), r] as const))(
    'cas 2, clé sans le scope requis → 403 insufficient_scope (05 § 4.4) : %s',
    async (_name, route) => {
      // Tous les scopes accordables sauf celui de la route.
      const { key } = await createKey(srv, a.cookie, a.user, GRANTABLE_SCOPES.filter((s) => s !== route.scope));
      const res = await call(route, { authorization: `Bearer ${key}` }, ZERO_UUID, VALID_BODIES[keyOf(route)]?.(a));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'insufficient_scope' } });
    },
  );

  test('cas 3, membre sur une route d’admin → 403', async () => {
    const adminRoutes = protectedRoutes.filter((r) => r.permission && !can('member', r.permission));
    expect(adminRoutes.length).toBeGreaterThan(15);
    for (const route of adminRoutes) {
      expect((await call(route, { cookie: b.cookie }, ZERO_UUID, VALID_BODIES[keyOf(route)]?.(b))).statusCode, keyOf(route)).toBe(403);
    }
  });

  // Les routes `mfa: 'pending'` ne sont joignables que par une session en attente du second facteur : leur corps est
  // contrôlé par accounts.integration.test.ts (« le second facteur refuse un corps étranger »).
  test.each(ROUTES.filter((r) => hasBody(r) && r.mfa !== 'pending').map((r) => [keyOf(r), r] as const))(
    'cas 4, corps avec owner_id, user_id, status ou server_use_allowed → rejeté : %s',
    async (_name, route) => {
      // Route d'administration : l'owner (un membre serait refusé avant la lecture du corps).
      const party = route.permission && !can('member', route.permission) ? owner : b;
      for (const extra of [{ owner_id: a.user.id }, { user_id: a.user.id }, { status: 'active' }, { server_use_allowed: true }]) {
        const headers: Record<string, string> =
          route.auth === 'extension' ? { authorization: `Bearer ${party.ext}` } : route.auth === 'key' ? { authorization: `Bearer ${await partyKey(party)}` } : { cookie: party.cookie };
        const res = await call(route, headers, ZERO_UUID, { ...VALID_BODIES[keyOf(route)]!(party), ...extra });
        // 400 (additionalProperties: false) ; 404 pour l'assistant, clos après l'owner.
        expect([400, 404], `${keyOf(route)} ${Object.keys(extra)[0]}`).toContain(res.statusCode);
      }
    },
  );

  test('cas 5, aucune réponse ne contient de champ chiffré ou haché', async () => {
    await createKey(srv, a.cookie, a.user, ['apis:read']);
    // Flux SSE sans fin (lu à part par rest.integration.test.ts) et document OpenAPI (il NOMME des champs, dont `token`).
    for (const route of ROUTES.filter((r) => r.method === 'GET' && !r.stream && r.url !== '/api/openapi.json')) {
      const res = await call(route, route.auth === 'extension' ? { authorization: `Bearer ${a.ext}` } : { cookie: a.cookie });
      expect(res.body, keyOf(route)).not.toMatch(/ciphertext|"nonce"|wrapped_dek|dek_wrapped|key_hash|keyHash|token_hash|tokenHash|password_hash|passwordHash|"token"/);
    }
  });
});
