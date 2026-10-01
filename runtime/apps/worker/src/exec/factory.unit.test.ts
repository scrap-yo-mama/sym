// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur de production (tâche 1.6) : DISABLE_BROWSER sans Chromium ni proxy de lancement ; garde SSRF lue dans
// l'environnement (drapeau de test refusé hors NODE_ENV=test) ; ressources libérées à l'arrêt. Aucun Chromium lancé.
import { generateMasterKey } from '@runtime/core';
import pg from 'pg';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { loadWorkerConfig } from '../config.js';
import { productionExecutorFactory } from './factory.js';

const logger = pino({ level: 'silent' });
const checked = { status: 'ok' as const, version: 1, fingerprint: 'zz_test' };
const env = (extra: Record<string, string> = {}) => ({ DATABASE_URL: 'postgres://zz_test@127.0.0.1:1/zz_test', MASTER_KEY: generateMasterKey(), BROWSER_CONCURRENCY: '2', ...extra });

describe('productionExecutorFactory', () => {
  test('DISABLE_BROWSER : exécuteur prêt, aucun contexte Chromium', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    const config = loadWorkerConfig(env({ DISABLE_BROWSER: 'true' }));
    expect(config).toMatchObject({ disableBrowser: true, browserConcurrency: 2, browserConcurrencySource: 'env' });
    const handle = await productionExecutorFactory({})({ pool, config, checked, logger });
    expect(typeof handle.executor).toBe('function');
    expect(handle.browserContexts?.()).toBe(0);
    await handle.close?.();
    await pool.end();
  });

  test('navigateur actif : pool prêt sans lancement (à la demande), fermeture propre', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    const handle = await productionExecutorFactory({})({ pool, config: loadWorkerConfig(env()), checked, logger });
    expect(handle.browserContexts?.()).toBe(0);
    await handle.close?.();
    await pool.end();
  });

  test('drapeau de test « autoriser le privé » hors NODE_ENV=test → refus de démarrer', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    await expect(productionExecutorFactory({ RUNTIME_TEST_ALLOW_PRIVATE: '1', NODE_ENV: 'production' })({ pool, config: loadWorkerConfig(env()), checked, logger })).rejects.toThrow(
      /réservé aux tests/,
    );
    await pool.end();
  });

  test('production sans utilisateur dédié pour le bac à sable → refus de démarrer (D-30), avant tout Chromium', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    await expect(productionExecutorFactory({ NODE_ENV: 'production' })({ pool, config: loadWorkerConfig(env()), checked, logger })).rejects.toThrow(/utilisateur dédié/);
    await pool.end();
  });

  test('production, sonde d’isolation « environnement du worker lisible » → refus de démarrer (D-30), moteur jamais servi', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    let probed = 0;
    const engine = {
      id: 'isolated-vm' as const,
      probeIsolation: () => {
        probed += 1;
        return Promise.resolve({ uid: 1500, parentEnviron: 'readable' as const, noNewPrivs: true });
      },
      run: () => Promise.reject(new Error('jamais appelé')),
    };
    await expect(
      productionExecutorFactory({ NODE_ENV: 'production' }, { sandboxEngine: () => engine })({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger }),
    ).rejects.toMatchObject({ name: 'SandboxIsolationError', message: expect.stringMatching(/lit l'environnement du worker/) });
    expect(probed).toBe(1);
    // Témoin : sonde saine → le worker démarre.
    const sane = { ...engine, probeIsolation: () => Promise.resolve({ uid: 1500, parentEnviron: 'denied' as const, noNewPrivs: true }) };
    const handle = await productionExecutorFactory({ NODE_ENV: 'production' }, { sandboxEngine: () => sane })({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger });
    await handle.close?.();
    await pool.end();
  });

  test('DISABLE_BROWSER invalide → configuration refusée', () => {
    expect(() => loadWorkerConfig(env({ DISABLE_BROWSER: 'peut-être' }))).toThrow(/DISABLE_BROWSER/);
  });
});
