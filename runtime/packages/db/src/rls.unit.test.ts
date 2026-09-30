// SPDX-License-Identifier: AGPL-3.0-only
import type pg from 'pg';
import { expect, test, vi } from 'vitest';
import { withActor } from './rls.js';

test('ROLLBACK en échec : la connexion est détruite (release(err)), jamais rendue au pool avec le rôle posé', async () => {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connexion perdue');
      return { rows: [] };
    }),
    release,
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  await expect(withActor(pool, null, async () => {
    throw new Error('zz_test échec métier');
  })).rejects.toThrow('zz_test échec métier');
  expect(release).toHaveBeenCalledTimes(1);
  expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
});

test('succès ou ROLLBACK réussi : connexion rendue normalement', async () => {
  const release = vi.fn();
  const client = { query: vi.fn(async () => ({ rows: [] })), release };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  await withActor(pool, null, async () => 1);
  await expect(withActor(pool, null, async () => {
    throw new Error('x');
  })).rejects.toThrow('x');
  expect(release.mock.calls).toEqual([[], []]);
});
