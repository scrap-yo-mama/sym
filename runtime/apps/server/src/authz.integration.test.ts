// SPDX-License-Identifier: AGPL-3.0-only
// INV12 et INV5 sur les routes existantes (tâche 0.3b) : harnais paramétré par le registre des routes.
// Toute nouvelle route rejoint routes/registry.ts ; si elle porte une ressource, RESOURCE_CASES doit savoir créer un
// objet de A (sinon le test échoue), et si elle prend un corps, VALID_BODIES doit en fournir un.
import { can } from '@runtime/core';
import { withActor } from '@runtime/db';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { createKey, createUser, PUBLIC_URL, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { buildServer, UnregisteredRouteError } from './app.js';
import { ROUTES, type OwnedResource, type RouteSpec } from './routes/registry.js';

type Party = { user: TestUser; cookie: string };

let srv: TestServer;
let owner: Party;
let admin: Party;
let a: Party;
let b: Party;

/** Un cas par type de ressource : crée un objet appartenant à `party` et renvoie son identifiant. */
const RESOURCE_CASES: Record<OwnedResource, (party: Party) => Promise<string>> = {
  api_key: async (party) => (await createKey(srv, party.cookie, party.user, ['apis:read'])).id,
};

/** Corps valide par route à corps (sert aux cas 1 et 4 de 08b § 4). */
const VALID_BODIES: Record<string, (party: Party) => Record<string, unknown>> = {
  'POST /api/setup': () => ({ token: 'zz_test_token_not_used_000000000000', email: 'zz_test_x@example.test', password: 'zz_test_long_password' }),
  'POST /api/auth/sign-in/email': (p) => ({ email: p.user.email, password: p.user.password }),
  'POST /api/auth/sign-out': () => ({}),
  'POST /api/api-keys': (p) => ({ label: 'zz_test', scopes: ['apis:read'], currentPassword: p.user.password }),
};

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const keyOf = (r: RouteSpec) => `${r.method} ${r.url}`;
const hasBody = (r: RouteSpec) => r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH';

async function call(route: RouteSpec, headers: Record<string, string>, id = ZERO_UUID, payload?: Record<string, unknown>) {
  return srv.app.inject({
    method: route.method,
    url: route.url.replace(':id', id),
    headers: route.method === 'GET' ? headers : { origin: PUBLIC_URL, ...headers },
    ...(hasBody(route) ? { payload: payload ?? {} } : {}),
  });
}

beforeAll(async () => {
  srv = await startTestServer('authz');
  const o = await runSetup(srv);
  owner = { user: o, cookie: await signIn(srv, o) };
  const ad = await createUser(srv, 'zz_test_admin@example.test', 'admin');
  admin = { user: ad, cookie: await signIn(srv, ad) };
  const ua = await createUser(srv, 'zz_test_user_a@example.test');
  a = { user: ua, cookie: await signIn(srv, ua) };
  const ub = await createUser(srv, 'zz_test_user_b@example.test');
  b = { user: ub, cookie: await signIn(srv, ub) };
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
      if (route.resource) expect(RESOURCE_CASES[route.resource.type], keyOf(route)).toBeTypeOf('function');
      if (hasBody(route)) expect(VALID_BODIES[keyOf(route)], keyOf(route)).toBeTypeOf('function');
    }
  });
});

describe('assert_cross_user_denied (INV12) : B contre les objets de A, sur chaque route à ressource', () => {
  const resourceRoutes = ROUTES.filter((r) => r.resource);
  test.each(resourceRoutes.map((r) => [keyOf(r), r] as const))('%s', async (_name, route) => {
    const idOfA = await RESOURCE_CASES[route.resource!.type](a);
    if (route.resource!.kind === 'item') {
      const cross = await call(route, { cookie: b.cookie }, idOfA);
      const missing = await call(route, { cookie: b.cookie }, ZERO_UUID);
      expect(cross.statusCode).toBe(404);
      // Même réponse qu'un objet inexistant : aucun indice d'existence.
      expect({ status: cross.statusCode, body: cross.body }).toEqual({ status: missing.statusCode, body: missing.body });
      // L'objet de A est intact et toujours visible par A seul.
      const list = await srv.app.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: a.cookie } });
      expect(list.json<{ items: { id: string; revokedAt: string | null }[] }>().items).toContainEqual(expect.objectContaining({ id: idOfA, revokedAt: null }));
    } else {
      const res = await call(route, { cookie: b.cookie });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(idOfA);
    }
    // L'admin et l'owner non plus ne voient ni ne touchent l'objet d'un membre par ces routes.
    for (const other of [admin, owner]) {
      const res = await call(route, { cookie: other.cookie }, idOfA);
      if (route.resource!.kind === 'item') expect(res.statusCode).toBe(404);
      else expect(res.body).not.toContain(idOfA);
    }
  });
});

describe('assert_no_impersonation (INV5)', () => {
  test('aucun plugin de la bibliothèque d’auth, aucune fonction « se faire passer pour »', () => {
    const auth = srv.started.ctx.auth;
    expect(auth.options.plugins ?? []).toEqual([]);
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

  test('cas 3, membre sur une route d’admin → 403 (aucune route d’admin avant 3.7 : la liste se remplira)', async () => {
    const adminRoutes = protectedRoutes.filter((r) => r.permission && !can('member', r.permission));
    for (const route of adminRoutes) {
      expect((await call(route, { cookie: b.cookie }, ZERO_UUID, VALID_BODIES[keyOf(route)]?.(b))).statusCode, keyOf(route)).toBe(403);
    }
  });

  test.each(ROUTES.filter(hasBody).map((r) => [keyOf(r), r] as const))(
    'cas 4, corps avec owner_id, user_id, status ou server_use_allowed → rejeté : %s',
    async (_name, route) => {
      for (const extra of [{ owner_id: a.user.id }, { user_id: a.user.id }, { status: 'active' }, { server_use_allowed: true }]) {
        const res = await call(route, { cookie: b.cookie }, ZERO_UUID, { ...VALID_BODIES[keyOf(route)]!(b), ...extra });
        // 400 (additionalProperties: false) ; 404 pour l'assistant, clos après l'owner.
        expect([400, 404], `${keyOf(route)} ${Object.keys(extra)[0]}`).toContain(res.statusCode);
      }
    },
  );

  test('cas 5, aucune réponse ne contient de champ chiffré ou haché', async () => {
    await createKey(srv, a.cookie, a.user, ['apis:read']);
    for (const route of ROUTES.filter((r) => r.method === 'GET')) {
      const res = await call(route, { cookie: a.cookie });
      expect(res.body, keyOf(route)).not.toMatch(/ciphertext|"nonce"|wrapped_dek|dek_wrapped|key_hash|keyHash|token_hash|tokenHash|password_hash|passwordHash|"token"/);
    }
  });
});
