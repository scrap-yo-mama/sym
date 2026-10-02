// SPDX-License-Identifier: AGPL-3.0-only
// Assemblage des rôles au démarrage (cdc/sym-browser 03 § 4, 04b § 5, § 9 et § 11, 04d § 3.3 ; tâche 5.1), sur PostgreSQL
// réel : migrations et première clé par la passerelle, enregistrement et battement du nœud, `/readyz` selon le rôle
// (base, migrations, nœud prêt ; Chromium lançable), ordre de démarrage indifférent, ajout d'un nœud sans interruption
// (`cold_install_two_nodes`, partie processus ; la partie conteneurs est dans tests/deploy.e2e.test.ts), drainage.
// Chromium est remplacé par un lanceur factice : le vrai est exercé dans l'image (tests/deploy.e2e.test.ts).
import { randomBytes } from 'node:crypto';
import { generateApiKey, runService, type RunOptions, type ServiceHandle } from '@sym-browser/core';
import { expectedSchemaVersion } from '@sym-browser/db';
import type { BrowserLauncher, LaunchedBrowser } from '@sym-browser/node';
import pg from 'pg';
import { afterEach, describe, expect, inject, test } from 'vitest';
import { prepareRuntime, type RuntimeDeps } from './index.js';

type Db = { url: string; drop: () => Promise<void> };

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function freshDatabase(): Promise<Db> {
  const name = `rt_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => admin(async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))) };
}

function fakeLauncher(state: { launched: number; fail: boolean }): BrowserLauncher {
  return async () => {
    if (state.fail) throw new Error('Chromium : lancement impossible (test)');
    state.launched += 1;
    let connected = true;
    const browser: LaunchedBrowser = {
      id: `fake-${state.launched}`,
      pid: undefined,
      wsEndpoint: 'ws://127.0.0.1:1/fake',
      browser: {} as LaunchedBrowser['browser'],
      isConnected: () => connected,
      onDisconnected: () => undefined,
      close: async () => void (connected = false),
      kill: async () => void (connected = false),
    };
    return browser;
  };
}

const running: ServiceHandle[] = [];
const databases: Db[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  await Promise.all(databases.splice(0).map((d) => d.drop()));
});

const NODE_TOKEN = 't'.repeat(40);

async function boot(db: Db, extra: Record<string, string>, deps: Partial<RuntimeDeps> = {}, chromium = { launched: 0, fail: false }): Promise<ServiceHandle> {
  const lines: string[] = [];
  const options: RunOptions = {
    env: { MASTER_KEY: randomBytes(32).toString('base64'), DATABASE_URL: db.url, PORT: '0', HEARTBEAT_MS: '100', WARM_BROWSERS: '1', MAX_SESSIONS: '2', ...extra },
    handleSignals: false,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    exit: (code) => {
      throw new Error(`sortie ${code} : ${lines.join('\n')}`);
    },
    prepare: (config, log) => prepareRuntime(config, { log, launcher: fakeLauncher(chromium), retry: { initialMs: 50, maxMs: 200 }, sweepIntervalMs: 200, ...deps }),
  };
  const service = await runService(options);
  if (!service) throw new Error(lines.join('\n'));
  running.push(service);
  return service;
}

type Ready = { status: number; body: { status?: string; checks?: Record<string, string> } };
const readyz = async (service: ServiceHandle): Promise<Ready> => {
  const response = await fetch(`http://127.0.0.1:${service.port}/readyz`);
  return { status: response.status, body: (await response.json()) as Ready['body'] };
};
async function until(service: ServiceHandle, predicate: (r: Ready) => boolean, timeoutMs = 20_000): Promise<Ready> {
  const deadline = Date.now() + timeoutMs;
  let last = await readyz(service);
  while (!predicate(last)) {
    if (Date.now() > deadline) throw new Error(`/readyz attendu non atteint : ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await readyz(service);
  }
  return last;
}
const query = async <T extends pg.QueryResultRow>(db: Db, sql: string): Promise<T[]> => {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
};

describe('mode all (une machine)', () => {
  test('installation à froid : migrations, première clé, nœud local enregistré, Chromium chaud ; /readyz 200 avec chaque vérification', async () => {
    const db = await freshDatabase();
    databases.push(db);
    const chromium = { launched: 0, fail: false };
    const service = await boot(db, { SYMB_BOOTSTRAP_API_KEY: generateApiKey().key.reveal(), NODE_ID: 'all-1' }, {}, chromium);
    const ready = await until(service, (r) => r.status === 200);
    expect(ready.body).toMatchObject({ status: 'ready', checks: { master_key: 'ok', database: 'ok', schema: 'ok', nodes: 'ok', heartbeat: 'ok', chromium: 'ok' } });
    expect(chromium.launched).toBeGreaterThanOrEqual(1);
    const [version] = await query<{ v: number }>(db, 'SELECT max(version)::int AS v FROM symb_schema_migrations');
    expect(version?.v).toBe(expectedSchemaVersion());
    expect(await query(db, 'SELECT id, url, state, slots_total FROM nodes')).toEqual([{ id: 'all-1', url: `http://127.0.0.1:${service.port}`, state: 'ready', slots_total: 2 }]);
    expect(await query(db, 'SELECT t.name FROM api_keys k JOIN tenants t ON t.id = k.tenant_id')).toEqual([{ name: 'sym' }]);
  });

  test('Chromium non lançable : /readyz 503, motif chromium, sans secret', async () => {
    const db = await freshDatabase();
    databases.push(db);
    const service = await boot(db, {}, {}, { launched: 0, fail: true });
    const ready = await until(service, (r) => r.body.checks?.schema === 'ok' && r.body.checks?.chromium !== undefined && r.body.checks.chromium !== 'en attente');
    expect(ready.status).toBe(503);
    expect(ready.body.checks?.chromium).toBe('échec du lancement');
    expect(JSON.stringify(ready.body)).not.toContain(db.url);
  });

  test('base injoignable au démarrage : le service écoute, /healthz 200, /readyz 503 database, aucune URL de base exposée', async () => {
    const url = 'postgres://symb:motdepasse-test@127.0.0.1:1/absente';
    const service = await boot({ url, drop: async () => undefined }, {});
    expect((await fetch(`http://127.0.0.1:${service.port}/healthz`)).status).toBe(200);
    const ready = await readyz(service);
    expect(ready.status).toBe(503);
    expect(ready.body.checks?.database).not.toBe('ok');
    expect(JSON.stringify(ready.body)).not.toContain('motdepasse-test');
  });
});

describe('passerelle et nœuds séparés', () => {
  const nodeEnv = (id: string) => ({ SYMB_MODE: 'node', NODE_TOKEN, NODE_ID: id, NODE_PUBLIC_URL: `http://${id}.internal:3000` });

  test('cold_install_two_nodes (processus) : passerelle 503 sans nœud, 200 au premier ; un 2e nœud rejoint sans aucune réponse non 200', async () => {
    const db = await freshDatabase();
    databases.push(db);
    const gateway = await boot(db, { SYMB_MODE: 'gateway', NODE_TOKEN });
    const alone = await until(gateway, (r) => r.body.checks?.schema === 'ok');
    expect(alone).toMatchObject({ status: 503, body: { checks: { nodes: 'aucun nœud prêt' } } });
    expect(alone.body.checks).not.toHaveProperty('chromium');

    const node1 = await boot(db, nodeEnv('node-1'));
    await until(node1, (r) => r.status === 200);
    await until(gateway, (r) => r.status === 200);

    const statuses: number[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        statuses.push((await readyz(gateway)).status);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const node2 = await boot(db, nodeEnv('node-2'));
    await until(node2, (r) => r.status === 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    polling = false;
    await poller;
    expect(statuses.length).toBeGreaterThan(5);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    expect(await query(db, 'SELECT id, url, state FROM nodes ORDER BY id')).toEqual([
      { id: 'node-1', url: 'http://node-1.internal:3000', state: 'ready' },
      { id: 'node-2', url: 'http://node-2.internal:3000', state: 'ready' },
    ]);
  });

  test('ordre indifférent : un nœud démarré avant la passerelle attend les migrations (503 schema), puis devient prêt', async () => {
    const db = await freshDatabase();
    databases.push(db);
    const node = await boot(db, nodeEnv('early'));
    const waiting = await until(node, (r) => r.body.checks?.database === 'ok');
    expect(waiting.status).toBe(503);
    expect(waiting.body.checks?.schema).not.toBe('ok');
    await boot(db, { SYMB_MODE: 'gateway', NODE_TOKEN });
    await until(node, (r) => r.status === 200);
  });

  test('deux passerelles démarrées ensemble : migrations appliquées une fois (verrou), une seule première clé', async () => {
    const db = await freshDatabase();
    databases.push(db);
    const key = generateApiKey().key.reveal();
    const [a, b] = await Promise.all([1, 2].map(() => boot(db, { SYMB_MODE: 'gateway', NODE_TOKEN, SYMB_BOOTSTRAP_API_KEY: key })));
    await until(a!, (r) => r.body.checks?.schema === 'ok');
    await until(b!, (r) => r.body.checks?.schema === 'ok');
    // La clé suit les migrations dans la même tâche de démarrage : on attend qu'elle soit écrite, puis on vérifie l'unicité.
    const deadline = Date.now() + 10_000;
    while ((await query<{ n: number }>(db, 'SELECT count(*)::int AS n FROM api_keys'))[0]!.n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    expect(await query(db, 'SELECT count(*)::int AS n FROM api_keys')).toEqual([{ n: 1 }]);
  });
});

describe('drainage (point d’accroche de la tâche 2.7)', () => {
  test('SIGTERM du nœud : draining en base et /readyz 503 pendant drainSessions, puis Chromium fermés et nœud down', async () => {
    const db = await freshDatabase();
    databases.push(db);
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await boot(db, { SYMB_MODE: 'gateway', NODE_TOKEN });
    const node = await boot(db, { SYMB_MODE: 'node', NODE_TOKEN, NODE_ID: 'drain-1', NODE_PUBLIC_URL: 'http://drain-1.internal:3000', SHUTDOWN_GRACE_SECONDS: '5' }, {
      drainSessions: async ({ deadline }) => {
        seen.push(`drain:${deadline instanceof Date}`);
        const [row] = await query<{ state: string }>(db, "SELECT state FROM nodes WHERE id = 'drain-1'");
        seen.push(`state:${row?.state}`);
        await gate;
      },
    });
    await until(node, (r) => r.status === 200);
    const stopping = node.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await readyz(node).catch(() => ({ status: 0, body: {} }))).toMatchObject({ status: 503, body: { status: 'draining' } });
    release();
    await stopping;
    expect(seen).toEqual(['drain:true', 'state:draining']);
    expect(await query(db, "SELECT state FROM nodes WHERE id = 'drain-1'")).toEqual([{ state: 'down' }]);
  });
});
