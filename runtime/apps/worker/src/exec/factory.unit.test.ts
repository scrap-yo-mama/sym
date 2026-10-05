// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur de production (tâche 1.6) : DISABLE_BROWSER sans Chromium ni proxy de lancement ; garde SSRF lue dans
// l'environnement (drapeau de test refusé hors NODE_ENV=test) ; ressources libérées à l'arrêt. Aucun Chromium lancé.
import { generateMasterKey } from '@runtime/core';
import pg from 'pg';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import { loadWorkerConfig } from '../config.js';
import { confirmAboveUsdFromEnv, INVESTIGATION_LLM_ROLES, productionExecutorFactory } from './factory.js';

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
        return Promise.resolve({ uid: 1500, parentEnviron: 'readable' as const, witness: 'denied' as const, noNewPrivs: true });
      },
      run: () => Promise.reject(new Error('jamais appelé')),
    };
    await expect(
      productionExecutorFactory({ NODE_ENV: 'production' }, { sandboxEngine: () => engine })({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger }),
    ).rejects.toMatchObject({ name: 'SandboxIsolationError', message: expect.stringMatching(/lit l'environnement du worker/) });
    expect(probed).toBe(1);
    // Témoin : sonde saine → le worker démarre.
    const sane = { ...engine, probeIsolation: () => Promise.resolve({ uid: 1500, parentEnviron: 'denied' as const, witness: 'denied' as const, noNewPrivs: true }) };
    const handle = await productionExecutorFactory({ NODE_ENV: 'production' }, { sandboxEngine: () => sane })({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger });
    await handle.close?.();
    await pool.end();
  });

  test('assert_sandbox_probe_discriminating — production, sonde d’isolation : uid autre que SANDBOX_UID, root, uid du worker, ou témoin du worker lisible → refus de démarrer (revue 4.1b)', async () => {
    // Sous no-new-privileges, /proc/<worker>/environ est refusé même à un enfant du MÊME uid : seul l’uid et le témoin
    // prouvent la séparation.
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    const sane = { uid: 1500, parentEnviron: 'denied' as const, witness: 'denied' as const, noNewPrivs: true };
    const start = (probe: object, extra: Record<string, string> = {}) =>
      productionExecutorFactory(
        { NODE_ENV: 'production', SANDBOX_UID: '1500', SANDBOX_GID: '1500', ...extra },
        { sandboxEngine: () => ({ id: 'isolated-vm' as const, probeIsolation: () => Promise.resolve(probe as typeof sane), run: () => Promise.reject(new Error('jamais appelé')) }) },
      )({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger });
    for (const probe of [{ ...sane, uid: 1600 }, { ...sane, uid: 0 }, { ...sane, uid: process.getuid?.() ?? 1001 }, { ...sane, uid: undefined }, { ...sane, witness: 'readable' }, { ...sane, witness: 'absent' }]) {
      await expect(start(probe), JSON.stringify(probe)).rejects.toMatchObject({ name: 'SandboxIsolationError' });
    }
    const handle = await start(sane);
    await handle.close?.();
    await pool.end();
  });

  test('assert_sandbox_child_no_namespaces — production, sonde : l’enfant peut créer un espace de noms utilisateur → refus de démarrer (revue 4.1b)', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    const sane = { uid: 1500, parentEnviron: 'denied' as const, witness: 'denied' as const, noNewPrivs: true, namespaces: 'denied' as const };
    const start = (probe: object) =>
      productionExecutorFactory(
        { NODE_ENV: 'production', SANDBOX_UID: '1500', SANDBOX_GID: '1500' },
        { sandboxEngine: () => ({ id: 'isolated-vm' as const, probeIsolation: () => Promise.resolve(probe as typeof sane), run: () => Promise.reject(new Error('jamais appelé')) }) },
      )({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger });
    await expect(start({ ...sane, namespaces: 'allowed' })).rejects.toMatchObject({ name: 'SandboxIsolationError', message: expect.stringMatching(/espace de noms/) });
    for (const probe of [sane, { ...sane, namespaces: 'absent' }]) {
      const handle = await start(probe);
      await handle.close?.();
    }
    await pool.end();
  });

  test('assert_chromium_sandbox_reported — production : bac à sable de Chromium indisponible → alerte claire au démarrage, worker démarré ; régime seccomp journalisé', async () => {
    // Render n'applique pas le profil seccomp du compose : sous le profil par défaut de Docker, Chromium s'arrêterait sur
    // « No usable sandbox! » à chaque run navigateur. Le worker le dit dès le démarrage, sans repli sur --no-sandbox.
    const pool = new pg.Pool({ connectionString: 'postgres://zz_test@127.0.0.1:1/zz_test' });
    const sane = { uid: 1500, parentEnviron: 'denied' as const, witness: 'denied' as const, noNewPrivs: true, namespaces: 'denied' as const };
    const start = async (available: boolean) => {
      const lines: Record<string, unknown>[] = [];
      const log = pino({ level: 'info' }, { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) });
      let checks = 0;
      const handle = await productionExecutorFactory(
        { NODE_ENV: 'production', SANDBOX_UID: '1500', SANDBOX_GID: '1500' },
        {
          sandboxEngine: () => ({ id: 'isolated-vm' as const, probeIsolation: () => Promise.resolve(sane), run: () => Promise.reject(new Error('jamais appelé')) }),
          chromiumSandbox: () => {
            checks += 1;
            return Promise.resolve(available ? { available: true } : { available: false, detail: 'unshare: unshare failed: Operation not permitted' });
          },
        },
      )({ pool, config: loadWorkerConfig(env()), checked, logger: log });
      await handle.close?.();
      expect(checks).toBe(1);
      return lines;
    };
    const down = await start(false);
    const alert = down.find((l) => l['alert'] === 'chromium_sandbox_unavailable');
    expect(alert, JSON.stringify(down)).toMatchObject({ level: 50, detail: expect.stringMatching(/Operation not permitted/) });
    expect(alert!['msg']).toMatch(/Chromium : bac à sable indisponible.*runs navigateur échoueront.*seccomp-chromium\.json/);
    expect(alert).toHaveProperty('seccomp');
    expect(down.find((l) => l['msg'] === 'bac à sable : isolation éprouvée')).toHaveProperty('seccomp');
    const up = await start(true);
    expect(up.find((l) => l['alert'] === 'chromium_sandbox_unavailable')).toBeUndefined();
    expect(up.find((l) => l['msg'] === 'Chromium : bac à sable disponible'), JSON.stringify(up)).toHaveProperty('seccomp');
    // DISABLE_BROWSER : aucune vérification.
    let checks = 0;
    const handle = await productionExecutorFactory(
      { NODE_ENV: 'production', SANDBOX_UID: '1500', SANDBOX_GID: '1500' },
      { sandboxEngine: () => ({ id: 'isolated-vm' as const, probeIsolation: () => Promise.resolve(sane), run: () => Promise.reject(new Error('jamais appelé')) }), chromiumSandbox: () => ((checks += 1), Promise.resolve({ available: true })) },
    )({ pool, config: loadWorkerConfig(env({ DISABLE_BROWSER: 'true' })), checked, logger });
    await handle.close?.();
    expect(checks).toBe(0);
    await pool.end();
  });

  test('DISABLE_BROWSER invalide → configuration refusée', () => {
    expect(() => loadWorkerConfig(env({ DISABLE_BROWSER: 'peut-être' }))).toThrow(/DISABLE_BROWSER/);
  });

  test('rôles de l’enquête : sans `judge` (résolu à part, erreurs ignorées) — un rôle judge illisible ne fait jamais échouer l’enquête', () => {
    expect([...INVESTIGATION_LLM_ROLES]).toEqual(['investigate', 'extract', 'agent']);
  });
});

describe('CONFIRM_ABOVE_USD (lot A du CDC UX, 09 § 9)', () => {
  test('défaut 0,10 $ ; valeur lue ; valeur invalide ou hors bornes : le défaut', () => {
    expect(confirmAboveUsdFromEnv({})).toBe(0.1);
    expect(confirmAboveUsdFromEnv({ CONFIRM_ABOVE_USD: ' 0.25 ' })).toBe(0.25);
    expect(confirmAboveUsdFromEnv({ CONFIRM_ABOVE_USD: '0' })).toBe(0);
    for (const bad of ['', 'abc', '-1', '101', 'NaN']) expect(confirmAboveUsdFromEnv({ CONFIRM_ABOVE_USD: bad }), bad).toBe(0.1);
  });
});
