// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { BackupDeclarationError, declareBackup } from './backup.js';
import { connectionBudget } from './budget.js';
import { doctorExitCode, formatDoctor, type DoctorCheck } from './doctor.js';
import { schemaCompatibility, schemaVersionRefusal } from './schema-version.js';

test('budget de connexions : le profil S du CDC (pool 5, 1 web, 1 worker) fait 18 connexions, à la limite sur 20', () => {
  const b = connectionBudget({ poolMax: 5, webInstances: 1, workerInstances: 1, maxConnections: 20 });
  expect(b).toMatchObject({ web: 6, workers: 9, reserved: 3, total: 18, level: 'warn' });
});

test('budget de connexions : 0,8 inclus passe, au-delà avertit, au-delà de 1,0 refuse', () => {
  const at = (maxConnections: number) => connectionBudget({ poolMax: 5, webInstances: 1, workerInstances: 1, maxConnections }).level;
  expect(at(100)).toBe('ok');
  expect(at(23)).toBe('ok'); // 18 / 23 = 0,78
  expect(at(22)).toBe('warn'); // 18 / 22 = 0,82
  expect(at(18)).toBe('warn'); // exactement 1,0 : pas encore un refus
  expect(at(17)).toBe('error');
  // Un second `server` n'a plus de place sur Essential-0 (20 connexions) : 24 > 20.
  expect(connectionBudget({ poolMax: 5, webInstances: 2, workerInstances: 1, maxConnections: 20 }).level).toBe('error');
});

test('compatibilité code / schéma : en retard = migrer, en avance = image trop ancienne, pas de migration descendante', () => {
  expect(schemaCompatibility(6, 6)).toBe('ok');
  expect(schemaCompatibility(5, 6)).toBe('behind');
  expect(schemaCompatibility(7, 6)).toBe('ahead');
  expect(schemaVersionRefusal(6, 6, 'server')).toBeNull();
  expect(schemaVersionRefusal(5, 6, 'worker')).toMatch(/version 5, 6 attendue : lancez `runtime migrate` avant `worker`/);
  const ahead = schemaVersionRefusal(7, 6, 'server') ?? '';
  expect(ahead).toMatch(/version 7, ce code n'attend que la version 6/);
  expect(ahead).toMatch(/restaurez la sauvegarde prise avant la mise à jour/);
  expect(ahead).not.toMatch(/runtime migrate/);
});

const c = (status: DoctorCheck['status']): DoctorCheck => ({ id: 'database', status, code: 'x', message: 'm' });

test('doctor : code de sortie 0 / 1 / 2 et rapport lisible', () => {
  expect(doctorExitCode([c('ok'), c('ok')])).toBe(0);
  expect(doctorExitCode([c('ok'), c('warn')])).toBe(1);
  expect(doctorExitCode([c('warn'), c('error'), c('ok')])).toBe(2);
  const text = formatDoctor({ checks: [c('ok'), c('warn'), c('error')], exitCode: 2 });
  expect(text).toMatch(/\[ok +\] database : m/);
  expect(text).toMatch(/\[avertissement\]/);
  expect(text).toMatch(/1 ok, 1 avertissement\(s\), 1 erreur\(s\) \(code de sortie 2\)/);
});

test('sauvegarde déclarée : date illisible ou future refusée, sans écrire', async () => {
  const calls: unknown[] = [];
  const db = { query: (...args: unknown[]) => (calls.push(args), Promise.resolve({ rows: [], rowCount: 0 })) };
  const now = new Date('2026-10-01T08:00:00Z');
  await expect(declareBackup(db as never, new Date('pas une date'), now)).rejects.toThrow(BackupDeclarationError);
  await expect(declareBackup(db as never, new Date('2026-10-02T08:00:00Z'), now)).rejects.toThrow(/futur/);
  expect(calls).toHaveLength(0);
  await declareBackup(db as never, new Date('2026-10-01T07:00:00Z'), now);
  expect(calls).toHaveLength(1);
});
