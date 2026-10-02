// SPDX-License-Identifier: AGPL-3.0-only
// Hôte de service de SYM Browser (04d § 3.3 santé, 04b § 9 drainage) : `/healthz`, `/readyz`, arrêt, refus de démarrer.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig, runService, startService, type ReadinessCheck, type ServiceHandle } from '../index.js';

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  MASTER_KEY: randomBytes(32).toString('base64'),
  DATABASE_URL: 'postgres://symb:secret@db.invalid:5432/symb',
  PORT: '0',
  ...extra,
});
const MODES: Record<string, Record<string, string>> = {
  all: {},
  gateway: { SYMB_MODE: 'gateway', NODE_TOKEN: 'n'.repeat(32) },
  node: { SYMB_MODE: 'node', NODE_TOKEN: 'n'.repeat(32), NODE_PUBLIC_URL: 'http://node-1.internal:3000' },
};

const running: ServiceHandle[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.close()));
});
async function start(extra: Record<string, string> = {}, options: Parameters<typeof startService>[1] = {}): Promise<ServiceHandle> {
  const service = await startService(loadConfig(env(extra)), { log: () => undefined, ...options });
  running.push(service);
  return service;
}
const get = async (service: ServiceHandle, path: string, method = 'GET'): Promise<{ status: number; body: Record<string, unknown>; type: string | null }> => {
  const response = await fetch(`http://127.0.0.1:${service.port}${path}`, { method });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>), type: response.headers.get('content-type') };
};

describe('santé', () => {
  test.each(Object.keys(MODES))('Given le mode %s / When démarrage / Then /healthz 200 et /readyz 200', async (mode) => {
    const service = await start(MODES[mode]);
    const health = await get(service, '/healthz');
    expect(health).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(health.type).toMatch(/^application\/json/);
    const ready = await get(service, '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', mode, checks: { master_key: 'ok' } });
  });

  test('aucune clé ni URL de base dans les réponses de santé', async () => {
    const service = await start();
    const text = JSON.stringify([await get(service, '/healthz'), await get(service, '/readyz')]);
    expect(text).not.toContain('db.invalid');
    expect(text).not.toContain('secret');
  });

  test('/readyz 503 {status: unready} dès qu’une vérification échoue, avec son motif', async () => {
    let up = false;
    const database: ReadinessCheck = { name: 'database', run: () => (up ? 'ok' : 'injoignable') };
    const service = await start({}, { checks: [database] });
    expect(await get(service, '/readyz')).toMatchObject({ status: 503, body: { status: 'unready', checks: { master_key: 'ok', database: 'injoignable' } } });
    up = true;
    expect(await get(service, '/readyz')).toMatchObject({ status: 200, body: { status: 'ready', checks: { database: 'ok' } } });
  });

  test('une vérification qui lève une exception rend /readyz 503 sans faire tomber le service ni exposer le message', async () => {
    const boom: ReadinessCheck = { name: 'database', run: () => { throw new Error('connexion à postgres://u:motdepasse@h refusée'); } };
    const service = await start({}, { checks: [boom] });
    const ready = await get(service, '/readyz');
    expect(ready.status).toBe(503);
    expect(JSON.stringify(ready.body)).not.toContain('motdepasse');
    expect((await get(service, '/healthz')).status).toBe(200);
  });

  test('autres routes : 404 JSON ; autres méthodes : 405 ; HEAD accepté', async () => {
    const service = await start();
    expect(await get(service, '/v1/sessions')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await get(service, '/healthz', 'POST')).toMatchObject({ status: 405 });
    expect((await get(service, '/healthz', 'HEAD')).status).toBe(200);
  });
});

describe('drainage (04b § 9)', () => {
  test('Given SIGTERM reçu / Then /readyz 503 {status: draining} tant que les crochets de drainage tournent, /healthz reste 200', async () => {
    let release = (): void => undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const service = await start({}, { onDrain: [() => waiting] });
    const closing = service.shutdown();
    expect(service.draining).toBe(true);
    expect(await get(service, '/readyz')).toMatchObject({ status: 503, body: { status: 'draining' } });
    expect((await get(service, '/healthz')).status).toBe(200);
    release();
    await closing;
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
  });

  test('la grâce de drainage borne l’attente (SHUTDOWN_GRACE_SECONDS) : un crochet bloqué ne retient pas l’arrêt', async () => {
    const service = await start({ SHUTDOWN_GRACE_SECONDS: '1' }, { onDrain: [() => new Promise<void>(() => undefined)] });
    const started = Date.now();
    await service.shutdown();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('shutdown est idempotent', async () => {
    const service = await start();
    await Promise.all([service.shutdown(), service.shutdown()]);
  });
});

describe('runService : refus de démarrer', () => {
  function harness(): { out: string[]; err: string[]; exits: number[]; io: Parameters<typeof runService>[0] & object } {
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    return {
      out,
      err,
      exits,
      io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), exit: (code) => { exits.push(code); }, handleSignals: false },
    };
  }

  test('Given MASTER_KEY invalide / Then sortie code ≠ 0 et message nommant la variable, sans écouter', async () => {
    const h = harness();
    const handle = await runService({ ...h.io, env: env({ MASTER_KEY: 'pas-une-cle' }) });
    expect(handle).toBeUndefined();
    expect(h.exits).toEqual([1]);
    expect(h.err.join('\n')).toMatch(/MASTER_KEY invalide/);
    expect(h.err.join('\n')).not.toContain('pas-une-cle');
    expect(h.out).toEqual([]);
  });

  test('plusieurs variables invalides : toutes nommées dans le message', async () => {
    const h = harness();
    await runService({ ...h.io, env: env({ MASTER_KEY: 'x', PORT: 'abc', SYMB_MODE: 'all', SYMB_LOG_LEVEL: 'bavard' }) });
    expect(h.exits).toEqual([1]);
    for (const name of ['MASTER_KEY', 'PORT', 'SYMB_LOG_LEVEL']) expect(h.err.join('\n')).toContain(name);
  });

  test('--check-config : valide la configuration, l’affiche sans secret et sort avec 0 sans écouter', async () => {
    const h = harness();
    const handle = await runService({ ...h.io, env: env(), argv: ['--check-config'] });
    expect(handle).toBeUndefined();
    expect(h.exits).toEqual([0]);
    const text = h.out.join('\n');
    expect(text).toMatch(/configuration valide/);
    expect(text).toMatch(/mode all/);
    expect(text).not.toContain('db.invalid');
  });

  test('--check-config avec une configuration invalide : code 1', async () => {
    const h = harness();
    await runService({ ...h.io, env: env({ MASTER_KEY: 'x' }), argv: ['--check-config'] });
    expect(h.exits).toEqual([1]);
  });

  test('defaultMode : appliqué seulement si SYMB_MODE est absent', async () => {
    const h = harness();
    const handle = await runService({ ...h.io, env: env({ ...MODES['node'] }), defaultMode: 'node', argv: ['--check-config'] });
    expect(handle).toBeUndefined();
    expect(h.out.join('\n')).toMatch(/mode node/);
    const withoutMode = harness();
    await runService({ ...withoutMode.io, env: env({ NODE_TOKEN: 'n'.repeat(32), NODE_PUBLIC_URL: 'http://n.internal:3000' }), defaultMode: 'node', argv: ['--check-config'] });
    expect(withoutMode.out.join('\n')).toMatch(/mode node/);
    const override = harness();
    await runService({ ...override.io, env: env({ SYMB_MODE: 'all' }), defaultMode: 'node', argv: ['--check-config'] });
    expect(override.out.join('\n')).toMatch(/mode all/);
  });

  test('port déjà pris : message clair, code 1', async () => {
    const first = await start();
    const h = harness();
    const handle = await runService({ ...h.io, env: env({ PORT: String(first.port) }) });
    expect(handle).toBeUndefined();
    expect(h.exits).toEqual([1]);
    expect(h.err.join('\n')).toMatch(/PORT .*déjà utilisé/);
  });

  test('démarrage : journal JSON au niveau info (mode, port), avertissement sur variable inconnue', async () => {
    const h = harness();
    const handle = await runService({ ...h.io, env: env({ SYMB_MODEE: 'node' }) });
    expect(handle).toBeDefined();
    if (handle) running.push(handle);
    const lines = h.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line['msg'] === 'listening' && line['mode'] === 'all' && line['port'] === handle?.port)).toBe(true);
    expect(h.err.join('\n')).toContain('SYMB_MODEE');
  });
});
