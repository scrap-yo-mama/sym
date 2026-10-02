// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { expectedSchemaVersion, loadMigrations, MIGRATION_LOCK_KEY, MIGRATIONS_DIR, MIN_SERVER_VERSION_NUM } from './migrate.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'symb-migrations-'));
  dirs.push(dir);
  for (const n of names) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, 'up.sql'), 'SELECT 1;');
    writeFileSync(join(dir, n, 'down.sql'), 'SELECT 1;');
  }
  return dir;
}

describe('runner de migrations (sans base)', () => {
  test('les migrations livrées se chargent : numérotation continue, up et down présents, somme de contrôle', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    for (const m of migrations) {
      expect(m.up.trim().length).toBeGreaterThan(0);
      expect(m.down.trim().length).toBeGreaterThan(0);
      expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(expectedSchemaVersion(migrations)).toBe(migrations.length);
  });

  test('numérotation non continue : refus', () => {
    expect(() => loadMigrations(fakeDir(['0001_a', '0003_c']))).toThrow(/numérotation non continue/);
  });

  test('nom de dossier invalide : refus', () => {
    expect(() => loadMigrations(fakeDir(['0001_a', 'bad name']))).toThrow(/nom de dossier invalide/);
  });

  test('verrou propre au module, distinct de celui de SYM, et PostgreSQL 16 minimum', () => {
    expect(MIGRATION_LOCK_KEY).toMatch(/^\d+$/);
    expect(BigInt(MIGRATION_LOCK_KEY)).toBeLessThan(2n ** 63n);
    // Clés de SYM (migrations 8315178094305570145, secrets …146) : le module peut partager un serveur, jamais un verrou.
    expect(['8315178094305570145', '8315178094305570146']).not.toContain(MIGRATION_LOCK_KEY);
    expect(MIN_SERVER_VERSION_NUM).toBe(160000);
  });
});
