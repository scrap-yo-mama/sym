// SPDX-License-Identifier: AGPL-3.0-only
// Attente du conteneur PostgreSQL de l'étape image (tests/image/sandbox-privileges.image.test.ts). Constat de la gate W2 :
// sur une VM Docker chargée par une autre suite lourde, le conteneur PostgreSQL du test s'arrête (mémoire), `pg_isready`
// n'aboutit jamais et son nom ne se résout plus sur le réseau du test (getaddrinfo ENOTFOUND zz_test_img_pg_*). L'attente
// redémarre alors le conteneur une fois (il garde son nom et son réseau) et, à défaut, échoue avec l'état du conteneur.
import { describe, expect, test } from 'vitest';
import { waitForPostgres, type DockerRun } from './docker-wait.ts';

type State = { running: boolean; oom: boolean; readyAfter: number };

/** Docker simulé : `inspect` rend l'état, `start` relance le conteneur, `pg_isready` répond après `readyAfter` sondes. */
function fakeDocker(state: State): { run: DockerRun; calls: string[] } {
  const calls: string[] = [];
  let probes = 0;
  const run: DockerRun = (args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'inspect') return { status: 0, stdout: `${state.running} ${state.oom} ${state.running ? 0 : 137}\n`, stderr: '' };
    if (args[0] === 'start') {
      state.running = true;
      state.oom = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'exec' && args.includes('pg_isready')) {
      if (!state.running) return { status: 1, stdout: '', stderr: 'Error response from daemon: container is not running' };
      probes += 1;
      return probes > state.readyAfter ? { status: 0, stdout: 'accepting connections', stderr: '' } : { status: 2, stdout: 'no response', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const fastClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe('attente de PostgreSQL dans l’étape image', () => {
  test('conteneur arrêté par manque de mémoire : redémarré une fois, puis prêt', async () => {
    const docker = fakeDocker({ running: false, oom: true, readyAfter: 2 });
    await expect(waitForPostgres(docker.run, 'zz_test_img_pg_x', { timeoutMs: 60_000, ...fastClock() })).resolves.toBeUndefined();
    expect(docker.calls.filter((c) => c.startsWith('start'))).toHaveLength(1);
  });

  test('conteneur vivant mais lent : aucune relance, attente jusqu’à la réponse', async () => {
    const docker = fakeDocker({ running: true, oom: false, readyAfter: 30 });
    await expect(waitForPostgres(docker.run, 'zz_test_img_pg_x', { timeoutMs: 60_000, ...fastClock() })).resolves.toBeUndefined();
    expect(docker.calls.filter((c) => c.startsWith('start'))).toEqual([]);
  });

  test('jamais prêt : échec qui donne l’état du conteneur (arrêt mémoire) et la cause probable', async () => {
    const docker = fakeDocker({ running: true, oom: false, readyAfter: Number.POSITIVE_INFINITY });
    const error = await waitForPostgres(docker.run, 'zz_test_img_pg_x', { timeoutMs: 5_000, ...fastClock() }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('PostgreSQL prêt');
    expect((error as Error).message).toContain('running=true');
  });

  test('délai par défaut : au moins 180 s (le double de l’ancien délai de 90 s)', async () => {
    const docker = fakeDocker({ running: true, oom: false, readyAfter: Number.POSITIVE_INFINITY });
    const clock = fastClock();
    await waitForPostgres(docker.run, 'zz_test_img_pg_x', clock).catch(() => undefined);
    expect(clock.now()).toBeGreaterThanOrEqual(180_000);
  });
});
