// SPDX-License-Identifier: AGPL-3.0-only
// Surcouche de l'adaptateur : la base (ici un faux adaptateur) ne reçoit jamais le jeton de session en clair.
import type { DBAdapter } from 'better-auth/types';
import { expect, test } from 'vitest';
import { hashSessionToken, withHashedSessionTokens } from './hashed-session-adapter.js';

function fakeAdapter() {
  const rows: Record<string, unknown>[] = [];
  const calls: unknown[] = [];
  const match = (where: { field: string; value: unknown; operator?: string }[] = []) => (r: Record<string, unknown>) =>
    where.every((w) => (w.operator === 'in' ? (w.value as unknown[]).includes(r[w.field]) : r[w.field] === w.value));
  const adapter = {
    id: 'fake',
    create: async ({ data }: { data: Record<string, unknown> }) => {
      calls.push(data);
      rows.push({ ...data });
      return { ...data };
    },
    findOne: async ({ where }: { where: never[] }) => rows.find(match(where)) ?? null,
    findMany: async ({ where }: { where: never[] }) => rows.filter(match(where)),
    update: async ({ where, update }: { where: never[]; update: Record<string, unknown> }) => {
      const r = rows.find(match(where));
      if (r) Object.assign(r, update);
      return r ? { ...r } : null;
    },
    delete: async ({ where }: { where: never[] }) => {
      const i = rows.findIndex(match(where));
      if (i >= 0) rows.splice(i, 1);
    },
    transaction: async <R>(cb: (trx: unknown) => Promise<R>) => cb(adapter),
  };
  return { adapter: adapter as unknown as DBAdapter, rows, calls };
}

test('jeton haché à l’écriture et dans les recherches, rendu en clair à l’appelant', async () => {
  const { adapter, rows } = fakeAdapter();
  const wrapped = withHashedSessionTokens(() => adapter)({});
  const token = 'zz_test_session_token_0123456789abcdef';
  const created = await wrapped.create<Record<string, unknown>>({ model: 'session', data: { token, userId: 'u1' } });
  expect(created.token).toBe(token);
  expect(rows[0]!.token).toBe(hashSessionToken(token));
  expect(JSON.stringify(rows)).not.toContain(token);

  const found = await wrapped.findOne<Record<string, unknown>>({ model: 'session', where: [{ field: 'token', value: token }] });
  expect(found?.token).toBe(token);
  const many = await wrapped.findMany<Record<string, unknown>>({ model: 'session', where: [{ field: 'token', value: [token], operator: 'in' }] });
  expect(many.map((r) => r.token)).toEqual([token]);
  // Liste par utilisateur : le jeton n'est pas connu, l'empreinte ne sert pas de jeton.
  const byUser = await wrapped.findMany<Record<string, unknown>>({ model: 'session', where: [{ field: 'userId', value: 'u1' }] });
  expect(byUser[0]!.token).toBe(hashSessionToken(token));

  await wrapped.transaction(async (trx) => {
    const updated = await trx.update<Record<string, unknown>>({ model: 'session', where: [{ field: 'token', value: token }], update: { userId: 'u2' } });
    expect(updated?.token).toBe(token);
  });
  await wrapped.delete({ model: 'session', where: [{ field: 'token', value: token }] });
  expect(rows).toHaveLength(0);
});

test('les autres modèles passent inchangés', async () => {
  const { adapter, rows } = fakeAdapter();
  const wrapped = withHashedSessionTokens(() => adapter)({});
  await wrapped.create({ model: 'verification', data: { token: 'zz_test_plain' } });
  expect(rows[0]!.token).toBe('zz_test_plain');
});
