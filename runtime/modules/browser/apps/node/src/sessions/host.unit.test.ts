// SPDX-License-Identifier: AGPL-3.0-only
// Hôte des sessions du nœud (tâche 1.7) sans navigateur : ordre de destruction de 04c § 3.2 (egress fermé AVANT l'arrêt du
// navigateur, navigateur arrêté AVANT le détachement des clients, objets copiés AVANT la suppression de sessions/{id},
// egress arrêté en dernier), destruction menée jusqu'au bout malgré une étape en échec, une seule destruction par session,
// répertoire de session pour les deux types, balayeur des répertoires orphelins, branchement sur le superviseur (1.2).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemorySessionStore } from '@sym-browser/core';
import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, describe, expect, test } from 'vitest';
import type { AcquireRequest, PoolLease } from '../pool/index.js';
import { SessionHost, SessionTeardownError, TEARDOWN_STEPS, type SessionEgress } from './host.js';
import { SessionSupervisor } from './supervisor.js';

const roots: string[] = [];
const newRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'symb-host-'));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type FakeOptions = { failContextClose?: boolean; failEgressClose?: boolean };

function setup(options: FakeOptions = {}) {
  const log: string[] = [];
  const dataDir = newRoot();
  const controllers = new Map<string, AbortController>();
  const pool = {
    async acquire(request: AcquireRequest): Promise<PoolLease> {
      log.push(`pool.acquire ${request.type} ${request.sessionId}${request.launchArgs ? ` ${request.launchArgs.join(',')}` : ''}`);
      const controller = new AbortController();
      controllers.set(request.sessionId, controller);
      const browser = {
        newContext: async () =>
          ({
            close: async () => {
              log.push(`context.close ${request.sessionId}`);
              if (options.failContextClose) throw new Error('fermeture du contexte impossible');
            },
          }) as unknown as BrowserContext,
      } as unknown as Browser;
      return {
        sessionId: request.sessionId,
        type: request.type,
        tenantId: request.tenantId,
        browserId: `b-${request.sessionId}`,
        wsEndpoint: 'ws://127.0.0.1:1/x',
        cdpEndpoint: request.type === 'dedicated' ? 'ws://127.0.0.1:2/devtools/browser/x' : undefined,
        browser,
        signal: controller.signal,
        release: async () => {
          log.push(request.type === 'dedicated' ? `pool.release(SIGKILL) ${request.sessionId}` : `pool.release ${request.sessionId}`);
        },
      };
    },
  };
  const egress = async ({ sessionId }: { sessionId: string }): Promise<SessionEgress> => ({
    close: async () => {
      log.push(`egress.close ${sessionId}`);
      if (options.failEgressClose) throw new Error('egress récalcitrant');
    },
    stop: async () => {
      log.push(`egress.stop ${sessionId}`);
    },
  });
  const host = new SessionHost({
    pool,
    dataDir,
    egress,
    saveObjects: async (lease) => {
      log.push(`objects ${lease.sessionId} dir=${existsSync(lease.dir.root)}`);
    },
    onStep: (sessionId, step) => log.push(`step ${step} ${sessionId}`),
  });
  return { log, dataDir, host, controllers };
}

const steps = (log: string[]) => log.filter((l) => !l.startsWith('step '));

describe('ordre de destruction (04c § 3.2)', () => {
  test('les sept étapes du nœud, dans l’ordre de la spécification', () => {
    expect(TEARDOWN_STEPS).toEqual(['gate', 'egress_closed', 'browser_stopped', 'clients_detached', 'objects_saved', 'dir_removed', 'egress_stopped']);
  });

  test('dedicated : egress fermé, SIGKILL, clients détachés, objets, sessions/{id} supprimé, egress arrêté', async () => {
    const { log, host, dataDir } = setup();
    const lease = await host.acquire({ sessionId: 'd1', type: 'dedicated', tenantId: 'A', launchArgs: ['mute-audio'] });
    expect(lease.cdpEndpoint).toBe('ws://127.0.0.1:2/devtools/browser/x');
    expect(lease.dir.root).toBe(join(dataDir, 'sessions', 'd1'));
    host.attachClient('d1', { close: () => void log.push('client.close d1') });
    log.length = 0;
    await lease.release();
    expect(steps(log)).toEqual([
      'egress.close d1',
      'pool.release(SIGKILL) d1',
      'client.close d1',
      'objects d1 dir=true',
      'egress.stop d1',
    ]);
    expect(log.filter((l) => l.startsWith('step ')).map((l) => l.split(' ')[1])).toEqual([...TEARDOWN_STEPS]);
    expect(existsSync(lease.dir.root)).toBe(false);
  });

  test('shared : egress fermé, contexte fermé puis slot rendu, clients, objets, répertoire, egress arrêté', async () => {
    const { log, host } = setup();
    const lease = await host.acquire({ sessionId: 's1', type: 'shared', tenantId: 'A', options: { locale: 'fr-FR' } });
    expect(lease.context).toBeDefined();
    expect(lease.cdpEndpoint).toBeUndefined();
    expect(statSync(lease.dir.root).mode & 0o777).toBe(0o700);
    host.attachClient('s1', { close: async () => void log.push('client.close s1') });
    log.length = 0;
    await lease.release();
    expect(steps(log)).toEqual(['egress.close s1', 'context.close s1', 'pool.release s1', 'client.close s1', 'objects s1 dir=true', 'egress.stop s1']);
    expect(existsSync(lease.dir.root)).toBe(false);
  });

  test('porte fermée dès la première étape : plus de nouvelle connexion, un client tardif est fermé aussitôt', async () => {
    const { log, host } = setup();
    const lease = await host.acquire({ sessionId: 'd2', type: 'dedicated', tenantId: 'A' });
    expect(host.accepting('d2')).toBe(true);
    const release = lease.release();
    expect(host.accepting('d2')).toBe(false);
    expect(host.attachClient('d2', { close: () => void log.push('late.close d2') })).toBe(false);
    expect(log).toContain('late.close d2');
    await release;
    expect(host.accepting('inconnue')).toBe(false);
  });

  test('une étape en échec n’arrête pas la destruction : répertoire supprimé, egress arrêté, erreur rapportée', async () => {
    const { log, host } = setup({ failContextClose: true, failEgressClose: true });
    const lease = await host.acquire({ sessionId: 's2', type: 'shared', tenantId: 'A' });
    writeFileSync(join(lease.dir.root, 'downloads', 'fichier.bin'), 'x');
    log.length = 0;
    const error = await lease.release().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SessionTeardownError);
    expect((error as SessionTeardownError).steps).toEqual(['egress_closed', 'browser_stopped']);
    expect(steps(log)).toEqual(['egress.close s2', 'context.close s2', 'pool.release s2', 'objects s2 dir=true', 'egress.stop s2']);
    expect(existsSync(lease.dir.root)).toBe(false);
  });

  test('une seule destruction, quel que soit le nombre de déclencheurs', async () => {
    const { log, host, controllers } = setup();
    const lease = await host.acquire({ sessionId: 'd3', type: 'dedicated', tenantId: 'A' });
    log.length = 0;
    controllers.get('d3')!.abort('crash');
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe('crash');
    await Promise.all([lease.release(), lease.release()]);
    await lease.release();
    expect(steps(log).filter((l) => l.startsWith('egress.close'))).toHaveLength(1);
    expect(host.active()).toEqual([]);
  });

  test('acquisition en échec : répertoire de session retiré, egress arrêté', async () => {
    const { host, dataDir } = setup();
    const failing = new SessionHost({
      pool: { acquire: async () => Promise.reject(new Error('lancement impossible')) },
      dataDir,
    });
    await expect(failing.acquire({ sessionId: 'f1', type: 'dedicated', tenantId: 'A' })).rejects.toThrow('lancement impossible');
    expect(existsSync(join(dataDir, 'sessions', 'f1'))).toBe(false);
    expect(host.active()).toEqual([]);
  });

  test('identifiant de session déjà actif : refus', async () => {
    const { host } = setup();
    const lease = await host.acquire({ sessionId: 'dup', type: 'shared', tenantId: 'A' });
    await expect(host.acquire({ sessionId: 'dup', type: 'shared', tenantId: 'A' })).rejects.toThrow(/déjà/);
    await lease.release();
  });
});

describe('balayeur des répertoires de session (04c § 3.2)', () => {
  test('supprime les sessions/* sans session active, garde les actives, ignore les noms hors format', async () => {
    const { host, dataDir } = setup();
    const lease = await host.acquire({ sessionId: 'vivante', type: 'shared', tenantId: 'A' });
    for (const orphan of ['orpheline-1', 'orpheline-2']) {
      mkdirSync(join(dataDir, 'sessions', orphan, 'profile'), { recursive: true });
      writeFileSync(join(dataDir, 'sessions', orphan, 'profile', 'Cookies'), 'zz');
    }
    mkdirSync(join(dataDir, 'sessions', '.cache'), { recursive: true });
    expect((await host.sweep()).sort()).toEqual(['orpheline-1', 'orpheline-2']);
    expect(readdirSync(join(dataDir, 'sessions')).sort()).toEqual(['.cache', 'vivante']);
    await lease.release();
    expect(await host.sweep()).toEqual([]);
  });

  test('sans répertoire sessions/ : rien à faire', async () => {
    const host = new SessionHost({ pool: { acquire: async () => Promise.reject(new Error('x')) }, dataDir: newRoot() });
    expect(await host.sweep()).toEqual([]);
  });
});

describe('branchement sur le superviseur (1.2) : état final écrit APRÈS la destruction (étape 8)', () => {
  test('libération : destruction complète puis `ended released`', async () => {
    const { log, host } = setup();
    const store = createMemorySessionStore();
    const tracked = {
      ...store,
      transition: async (input: Parameters<typeof store.transition>[0]) => {
        log.push(`store ${input.to}`);
        return store.transition(input);
      },
    };
    const supervisor = new SessionSupervisor({ nodeId: 'n1', pool: host, store: tracked });
    const now = Date.now();
    store.create({ sessionId: 'sv1', createdAt: now, expiresAt: now + 60_000 });
    expect(await supervisor.start({ sessionId: 'sv1', type: 'dedicated', tenantId: 'A', expiresAt: now + 60_000, maxExpiresAt: now + 60_000, idleTimeoutSeconds: 300, launchArgs: ['disable-gpu'] })).toEqual({ ok: true });
    expect(log).toContain('pool.acquire dedicated sv1 disable-gpu');
    log.length = 0;
    await supervisor.end('sv1', 'released');
    expect(steps(log)).toEqual(['egress.close sv1', 'pool.release(SIGKILL) sv1', 'objects sv1 dir=true', 'egress.stop sv1', 'store ended']);
    expect(store.get('sv1')).toMatchObject({ state: 'ended', endReason: 'released' });
  });
});
