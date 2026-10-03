// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest';
import { describeUrl, resolveConnections, transactionPoolerHint } from './connection.js';
import { expectedSchemaVersion, loadMigrations } from './migrate.js';

const never = () => Promise.reject(new Error('sonde appelée à tort'));

describe('heuristique de pooler transactionnel', () => {
  test.each([
    ['postgres://u:p@aws-0-eu-west-3.pooler.supabase.com:6543/postgres', /6543/],
    ['postgres://u:p@ep-cool-name-123-pooler.eu-central-1.aws.neon.tech/db', /Neon/],
    ['postgres://u:p@host:5432/db?pgbouncer=true', /pgbouncer/],
  ])('%s → pooler', (url, reason) => {
    expect(transactionPoolerHint(url)).toMatch(reason);
  });

  test.each(['postgres://u:p@aws-0-eu-west-3.pooler.supabase.com:5432/postgres', 'postgres://u:p@localhost/db'])(
    '%s → rien (la sonde tranche)',
    (url) => {
      expect(transactionPoolerHint(url)).toBeNull();
    },
  );

  test('message sans identifiants', () => {
    expect(describeUrl('postgres://user:s3cret@db.example:6543/x')).toBe('db.example:6543');
  });
});

describe('resolveConnections', () => {
  test('pooler transactionnel sans DATABASE_URL_DIRECT : refus, sans sonde', async () => {
    await expect(
      resolveConnections({ DATABASE_URL: 'postgres://u:s3cret@x.pooler.supabase.com:6543/postgres' }, never),
    ).rejects.toThrow(/^connexion de session requise : DATABASE_URL \(x\.pooler\.supabase\.com:6543\).*DATABASE_URL_DIRECT/);
  });

  test('DATABASE_URL_DIRECT elle-même derrière un pooler : refus', async () => {
    await expect(
      resolveConnections(
        { DATABASE_URL: 'postgres://u:p@db:5432/x', DATABASE_URL_DIRECT: 'postgres://u:p@db:6543/x' },
        never,
      ),
    ).rejects.toThrow(/DATABASE_URL_DIRECT \(db:6543\) passe par un pooler/);
  });

  test('sonde en échec (pooler simulé) : refus avec la raison', async () => {
    const probe = () => Promise.resolve({ ok: false as const, reason: 'pg_backend_pid change entre deux requêtes' });
    await expect(resolveConnections({ DATABASE_URL: 'postgres://u:p@db:6432/x' }, probe)).rejects.toThrow(
      /connexion de session requise.*pg_backend_pid change/,
    );
  });

  test('sonde OK : URL de session = URL directe si fournie', async () => {
    const probe = () => Promise.resolve({ ok: true as const });
    expect(
      await resolveConnections({ DATABASE_URL: 'postgres://a@pool:6543/x', DATABASE_URL_DIRECT: 'postgres://a@db:5432/x' }, probe),
    ).toEqual({ appUrl: 'postgres://a@pool:6543/x', sessionUrl: 'postgres://a@db:5432/x' });
  });
});

test('migrations : numérotées sans trou, up et down présents', () => {
  const migrations = loadMigrations();
  expect(migrations.length).toBeGreaterThan(0);
  expect(expectedSchemaVersion(migrations)).toBe(migrations.length);
  for (const m of migrations) {
    expect(m.up.trim().length).toBeGreaterThan(0);
    expect(m.down.trim().length).toBeGreaterThan(0);
  }
});

test('migrations : noms uniques ; i18n (3.20) numérotée après run_rejected_items (2.3) et rule_files (2.10), fusionnées avant', () => {
  const migrations = loadMigrations();
  expect(new Set(migrations.map((m) => m.name)).size).toBe(migrations.length);
  const byName = new Map(migrations.map((m) => [m.name, m.version]));
  expect(byName.get('run_rejected_items')).toBe(18);
  expect(byName.get('rule_files')).toBe(19);
  expect(byName.get('i18n')).toBe(20);
});
