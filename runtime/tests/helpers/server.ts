// SPDX-License-Identifier: AGPL-3.0-only
// Serveur de test (tâche 0.3b) : base migrée jetable, MASTER_KEY et jeton d'amorçage générés à l'exécution (aucun
// secret en dur), owner créé par l'assistant, membres créés en base (les invitations arrivent en 3.7).
import { randomBytes } from 'node:crypto';
import { generateMasterKey, hashPassword } from '@runtime/core';
import { migrateUp } from '@runtime/db';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { prepareServer, type Started } from '../../apps/server/src/start.js';
import { createTestDatabase, withClient, type TestDatabase } from './pg.js';

export const PUBLIC_URL = 'http://localhost:3000';

export type TestUser = { id: string; email: string; password: string; role: 'owner' | 'admin' | 'member' };

export type TestServer = {
  db: TestDatabase;
  app: FastifyInstance;
  started: Started;
  masterKey: string;
  bootstrapToken: string;
  close: () => Promise<void>;
};

const randomPassword = () => `zz_test_${randomBytes(12).toString('base64url')}`;

export function serverEnv(url: string, masterKey: string, bootstrapToken: string | null, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: url,
    MASTER_KEY: masterKey,
    PUBLIC_URL,
    ...(bootstrapToken ? { ADMIN_BOOTSTRAP_TOKEN: bootstrapToken } : {}),
    ...extra,
  };
}

/** Base migrée + serveur prêt (sans écoute : `inject`). L'owner n'existe pas encore. */
export async function startTestServer(prefix = 'srv', extra: NodeJS.ProcessEnv = {}): Promise<TestServer> {
  const db = await createTestDatabase(prefix);
  await migrateUp({ connectionString: db.url });
  const masterKey = generateMasterKey();
  const bootstrapToken = randomBytes(32).toString('base64url');
  const started = await prepareServer(serverEnv(db.url, masterKey, bootstrapToken, extra));
  return {
    db,
    app: started.app,
    started,
    masterKey,
    bootstrapToken,
    close: async () => {
      await started.close();
      await db.drop();
    },
  };
}

export async function runSetup(srv: TestServer, email = 'zz_test_owner@example.test'): Promise<TestUser> {
  const password = randomPassword();
  const res = await srv.app.inject({ method: 'POST', url: '/api/setup', payload: { token: srv.bootstrapToken, email, password } });
  if (res.statusCode !== 201) throw new Error(`setup : ${res.statusCode} ${res.body}`);
  return { id: res.json<{ userId: string }>().userId, email, password, role: 'owner' };
}

/** Compte actif créé directement en base (équivalent d'une invitation acceptée, tâche 3.7). */
export async function createUser(srv: TestServer, email: string, role: 'admin' | 'member' = 'member', status = 'active'): Promise<TestUser> {
  const password = randomPassword();
  const hash = await hashPassword(password);
  const id = await withClient(srv.db.url, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO users (email, role, status, email_verified) VALUES ($1, $2, $3, true) RETURNING id',
      [email, role, status],
    );
    const userId = rows[0]!.id;
    await c.query("INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)", [userId, userId, hash]);
    return userId;
  });
  return { id, email, password, role };
}

/** Cookie de session (`nom=valeur`) extrait d'une réponse. */
export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name.endsWith('sy.session'));
  if (!cookie) throw new Error(`aucun cookie de session (${res.statusCode} ${res.body})`);
  return `${cookie.name}=${cookie.value}`;
}

export async function signIn(srv: TestServer, user: Pick<TestUser, 'email' | 'password'>): Promise<string> {
  const res = await srv.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { origin: PUBLIC_URL },
    payload: { email: user.email, password: user.password },
  });
  if (res.statusCode !== 200) throw new Error(`connexion : ${res.statusCode} ${res.body}`);
  return sessionCookie(res);
}

export async function createKey(
  srv: TestServer,
  cookie: string,
  user: Pick<TestUser, 'password'>,
  scopes: string[] = ['apis:read', 'apis:run'],
): Promise<{ id: string; key: string; prefix: string }> {
  const res = await srv.app.inject({
    method: 'POST',
    url: '/api/api-keys',
    headers: { cookie, origin: PUBLIC_URL },
    payload: { label: 'zz_test_key', scopes, currentPassword: user.password },
  });
  if (res.statusCode !== 201) throw new Error(`création de clé : ${res.statusCode} ${res.body}`);
  return res.json();
}
