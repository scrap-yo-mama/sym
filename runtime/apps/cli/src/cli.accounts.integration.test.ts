// SPDX-License-Identifier: AGPL-3.0-only
// `runtime user:reset-link` et `runtime owner:reset-link` (13 § 4 et § 6, tâche 3.7) : réinitialisation par la commande
// serveur d'un compte sans 2FA sur une instance sans SMTP. Lien affiché une fois, empreinte seule en base, sessions du
// compte fermées, action auditée et signalée au titulaire à sa connexion suivante (pas d'impersonation, INV5).
import { hashOpaqueToken } from '@runtime/core';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from '../../../tests/helpers/pg.js';
import { run } from './cli.js';

let tdb: TestDatabase;
const log = () => {};
const PUBLIC_URL = 'https://runtime.example.test';
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: tdb.url, PUBLIC_URL, ...extra });
const ids: Record<string, string> = {};

async function rows<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withClient(tdb.url, async (c) => (await c.query<T>(text, params)).rows);
}

beforeAll(async () => {
  tdb = await createTestDatabase('cliacct');
  expect((await run(['migrate'], { env: env(), log })).code).toBe(0);
  for (const [name, role, status] of [
    ['owner', 'owner', 'active'],
    ['member', 'member', 'active'],
    ['disabled', 'member', 'disabled'],
  ] as const) {
    const [row] = await rows<{ id: string }>('INSERT INTO users (email, role, status) VALUES ($1, $2, $3) RETURNING id', [`zz_test_cli_${name}@example.test`, role, status]);
    ids[name] = row!.id;
  }
  await rows("INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, 'zz_test_cli_session', now() + interval '1 hour')", [ids['member']]);
});
afterAll(async () => {
  await tdb.drop();
});

describe(`runtime user:reset-link / owner:reset-link (PostgreSQL ${inject('pgVersion')})`, () => {
  test('assert_operator_reset_link : lien affiché une fois, empreinte seule en base, sessions fermées, audit et signalement', async () => {
    const res = await run(['user:reset-link', 'ZZ_test_cli_member@example.test'], { env: env(), log });
    expect(res.code, res.out).toBe(0);
    const token = new RegExp(`${PUBLIC_URL}/reset-password/([A-Za-z0-9_-]{43})`).exec(res.out)?.[1];
    expect(token).toBeDefined();
    const stored = await rows<{ identifier: string; value: string }>("SELECT identifier, value FROM verifications WHERE identifier LIKE 'reset%'");
    expect(stored).toEqual([{ identifier: `reset-cli:${ids['member']}`, value: hashOpaqueToken(token!) }]);
    expect(JSON.stringify(await rows('SELECT * FROM verifications'))).not.toContain(token);
    expect(await rows('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1', [ids['member']])).toEqual([{ n: 0 }]);
    expect(await rows("SELECT value FROM verifications WHERE identifier = 'notice:' || $1::text", [ids['member']])).toEqual([{ value: 'password_reset_by_operator' }]);
    const events = await rows<{ actor_user_id: string | null; actor_via: string; target_id: string; outcome: string; meta: Record<string, unknown> }>(
      "SELECT actor_user_id, actor_via, target_id, outcome, meta FROM audit_events WHERE action = 'user.reset_link'",
    );
    expect(events).toEqual([{ actor_user_id: null, actor_via: 'system', target_id: ids['member'], outcome: 'success', meta: { via: 'cli' } }]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  test('l’owner a sa propre commande ; compte inconnu ou inactif refusé ; PUBLIC_URL exigée', async () => {
    const onOwner = await run(['user:reset-link', 'zz_test_cli_owner@example.test'], { env: env(), log });
    expect(onOwner.code).toBe(1);
    expect(onOwner.out).toContain('owner:reset-link');
    const owner = await run(['owner:reset-link'], { env: env(), log });
    expect(owner.code, owner.out).toBe(0);
    expect(owner.out).toContain(`${PUBLIC_URL}/reset-password/`);
    expect(await rows("SELECT count(*)::int AS n FROM verifications WHERE identifier = 'reset-cli:' || $1::text", [ids['owner']])).toEqual([{ n: 1 }]);
    expect((await run(['user:reset-link', 'zz_test_cli_nobody@example.test'], { env: env(), log })).code).toBe(1);
    expect((await run(['user:reset-link', 'zz_test_cli_disabled@example.test'], { env: env(), log })).code).toBe(1);
    expect((await run(['user:reset-link'], { env: env(), log })).code).toBe(1);
    const noUrl = await run(['owner:reset-link'], { env: { DATABASE_URL: tdb.url }, log });
    expect(noUrl.code).toBe(2);
    expect(noUrl.out).toContain('PUBLIC_URL');
  });

  test('PUBLIC_URL normalisée : point final retiré dans le lien émis, chemin refusé (code 2) sans lien émis (F-20261002-12)', async () => {
    const dotted = await run(['owner:reset-link'], { env: env({ PUBLIC_URL: `${PUBLIC_URL}.` }), log });
    expect(dotted.code, dotted.out).toBe(0);
    expect(dotted.out).toMatch(new RegExp(`(^|\\s)${PUBLIC_URL}/reset-password/[A-Za-z0-9_-]{43}`));
    expect(dotted.out).not.toContain(`${PUBLIC_URL}./`);
    const before = await rows<{ n: number }>("SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset-cli:%'");
    const withPath = await run(['owner:reset-link'], { env: env({ PUBLIC_URL: `${PUBLIC_URL}/console` }), log });
    expect(withPath.code).toBe(2);
    expect(withPath.out).toMatch(/PUBLIC_URL invalide : chemin interdit/);
    expect(withPath.out).not.toContain('/console');
    expect(await rows("SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset-cli:%'")).toEqual(before);
  });
});
