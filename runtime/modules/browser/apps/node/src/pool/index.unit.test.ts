// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.1 : la configuration validée (tâche 0.4) pilote le pool ; MAX_SESSIONS et CONTEXTS_PER_BROWSER priment sur le calcul.
import { randomBytes } from 'node:crypto';
import { loadConfig } from '@sym-browser/core';
import { expect, test } from 'vitest';
import { BrowserPool, CGROUP_V2_MEMORY_CURRENT, CGROUP_V2_MEMORY_MAX, nodePoolOptions, PROVISIONAL_CAPACITY, type BrowserLauncher } from './index.js';

const GIB = 1024 ** 3;
// Clé jetable tirée à chaque exécution : aucune valeur versionnée.
const masterKey = randomBytes(32).toString('base64');
// Objet neuf à chaque lecture : loadConfig retire les secrets de l’environnement lu.
const env = () => ({ SYMB_MODE: 'all', DATABASE_URL: 'postgres://u@h/db', MASTER_KEY: masterKey });
const launch: BrowserLauncher = () => Promise.reject(new Error('aucun lancement dans ce test'));

test('capacity_from_cgroup depuis la configuration : 4 Go → 2 slots ; MAX_SESSIONS et CONTEXTS_PER_BROWSER prioritaires', async () => {
  const read = (path: string) => ({ [CGROUP_V2_MEMORY_MAX]: `${4 * GIB}`, [CGROUP_V2_MEMORY_CURRENT]: `${Math.round(3.7 * GIB)}` })[path];
  const computed = nodePoolOptions(loadConfig(env()).node, { launch, probe: { read } });
  expect(computed.capacity).toEqual({ slotsTotal: 2, source: 'cgroup', limitBytes: 4 * GIB });
  expect(computed.options).toMatchObject({ slotsTotal: 2, warmBrowsers: 1, contextsPerBrowser: null, recycleAfterSessions: 50, recycleAfterMs: 3_600_000, constants: PROVISIONAL_CAPACITY });
  // 3,7 Go sur 4 Go ≥ 90 % : la sonde mémoire du recyclage est branchée sur RECYCLE_RSS_PERCENT.
  expect(computed.options.memoryHigh?.()).toBe(true);

  const set = loadConfig({ ...env(), MAX_SESSIONS: '9', CONTEXTS_PER_BROWSER: '3', WARM_BROWSERS: '0', RECYCLE_RSS_PERCENT: '95' });
  const forced = nodePoolOptions(set.node, { launch, probe: { read } });
  expect(forced.capacity.source).toBe('env');
  expect(forced.options).toMatchObject({ slotsTotal: 9, contextsPerBrowser: 3, warmBrowsers: 0 });
  expect(forced.options.memoryHigh?.()).toBe(false);
  const pool = new BrowserPool({ ...forced.options, sweepIntervalMs: 0 });
  await pool.start();
  expect(pool.stats()).toMatchObject({ slotsTotal: 9, slotsFree: 9 });
  await pool.close();
});
