// SPDX-License-Identifier: AGPL-3.0-only
// Instance SYM Browser assemblée pour rejouer le quickstart de la documentation (tâche 3.8), dans le process des tests, à
// partir des briques réelles du module :
//   - API REST de la passerelle (`createGatewayApi`, tâche 2.2) sur une base PostgreSQL jetable et migrée (0.2), servie en
//     HTTP sur 127.0.0.1, avec ses jetons de connexion HMAC (`ConnectTokens`) et son relais WSS public (2.3) ;
//   - nœud : relais interne (`createNodeRelay`, 2.3, NODE_TOKEN), pool de Chromium (1.1) et Chromium dédiés (1.4) lancés sur
//     l'egress propre à chaque session (1.5), qui applique la politique `egress` de la requête de création ;
//   - un nœud enregistré par battement en base (table de routage), comme le ferait le nœud en mode `all`.
// Le binaire `SYMB_MODE=all` (apps/gateway/src/runtime, F-20261002-01) rejoue le quickstart complet, étape 1 comprise, sur
// l'image construite (tests/deploy.e2e.test.ts, quickstart_replayed_on_image) ; ce banc rejoue les étapes 3 à 5 sans image.
// Simplification restante : un seul nœud. Sessions `dedicated` seulement (type par défaut du quickstart).
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createGatewayApi, type SessionLauncher } from '../../apps/gateway/src/api/index.ts';
import { dedicatedLauncher, sessionDir } from '../../apps/node/src/dedicated/index.ts';
import { createEgressGuard, startSessionEgress, type SessionEgress } from '../../apps/node/src/egress/index.ts';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, type BrowserLauncher, type PoolLease } from '../../apps/node/src/pool/index.ts';
import { createNodeRelay } from '../../apps/node/src/relay/index.ts';
import { ApiKeyAuthenticator, CAPACITY, ConnectTokens, MasterKey, newApiKey } from '../../packages/core/src/index.ts';
import { insertApiKey, migrateUp, pgApiKeyStore, recordHeartbeat, transitionSession } from '../../packages/db/src/index.ts';

export type QuickstartInstance = {
  /** `SYMB_URL` du quickstart. */
  url: string;
  /** `SYMB_API_KEY` du quickstart (clé de test, scopes `sessions:write` et `sessions:read`). */
  apiKey: string;
  sessionState(id: string): Promise<{ state: string; endReason: string | null } | undefined>;
  /** Hôtes demandés à l'egress de la session. */
  egressHosts(id: string): string[];
  /** Restes après la fin des sessions (BINV3) : processus Chromium vivants, répertoires `sessions/*`. */
  residue(): Promise<{ chromiumProcesses: number; sessionDirs: string[] }>;
  close(): Promise<void>;
};

export type QuickstartInstanceOptions = {
  /** URL d'un rôle PostgreSQL qui peut créer des bases (globalSetup). */
  pgAdminUrl: string;
  /** Noms des fixtures joignables par l'egress (hôte → adresse) : `SYMB_PRIVATE_HOSTS` de test. */
  fixtureHosts: Record<string, string>;
};

const NODE_ID = 'node-quickstart';

async function admin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Port libre de la boucle locale : l'URL publique de la passerelle doit être connue avant son assemblage. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Held = { lease: PoolLease; egress: SessionEgress; ending: Promise<'released' | 'not_held'> | null };

export async function startQuickstartInstance(options: QuickstartInstanceOptions): Promise<QuickstartInstance> {
  // Base jetable, migrée par le runner de la tâche 0.2.
  const dbName = `qs_${randomBytes(5).toString('hex')}`;
  await admin(options.pgAdminUrl, (c) => c.query(`CREATE DATABASE ${dbName}`));
  const dbUrl = new URL(options.pgAdminUrl);
  dbUrl.pathname = `/${dbName}`;
  await migrateUp({ connectionString: dbUrl.toString() });
  const db = new pg.Pool({ connectionString: dbUrl.toString(), max: 8 });

  const tenantId = (await db.query<{ id: string }>("INSERT INTO tenants (name) VALUES ('quickstart') RETURNING id")).rows[0]!.id;
  // Clé réelle (argon2id, tâche 2.1) : seule son empreinte est en base.
  const created = await newApiKey({ scopes: ['sessions:write', 'sessions:read'] });
  await insertApiKey(db, { tenantId, prefix: created.prefix, keyHash: created.keyHash, scopes: created.scopes, expiresAt: null });
  const apiKey = created.key.reveal();

  // Nœud : pool de Chromium dédiés, chacun lancé sur l'egress de sa session.
  const dataDir = await mkdtemp(join(tmpdir(), 'zz_symb_quickstart_'));
  const groups = new OwnedProcessGroups();
  const guard = createEgressGuard({
    privateHosts: Object.keys(options.fixtureHosts),
    resolver: async (host) => {
      const address = options.fixtureHosts[host];
      return address ? [{ address, family: 4 as const }] : Promise.reject(new Error('ENOTFOUND'));
    },
  });
  const egresses = new Map<string, SessionEgress>();
  const hosts = new Map<string, string[]>();
  const launchDedicated: BrowserLauncher = (purpose) => {
    const egress = purpose.sessionId === undefined ? undefined : egresses.get(purpose.sessionId);
    if (!egress) return Promise.reject(new Error('egress de la session absent'));
    return dedicatedLauncher({ dataDir, groups, launchProxyUrl: egress.url })(purpose);
  };
  const pool = new BrowserPool({ slotsTotal: 2, launch: launchDedicated, launchDedicated, warmBrowsers: 0, constants: PROVISIONAL_CAPACITY, sweepIntervalMs: 0 });
  await pool.start();

  const held = new Map<string, Held>();
  const release = (sessionId: string): Promise<'released' | 'not_held'> => {
    const entry = held.get(sessionId);
    if (!entry) return Promise.resolve('not_held');
    // Destruction (04c § 3.2) : egress fermé, Chromium arrêté et répertoire supprimé par le pool, puis état final en base.
    entry.ending ??= (async () => {
      await entry.egress.close();
      await entry.lease.release();
      held.delete(sessionId);
      const outcome = await transitionSession(db, { sessionId, to: 'ended', reason: 'released' });
      return outcome.ok ? 'released' : 'not_held';
    })();
    return entry.ending;
  };

  const launcher: SessionLauncher = {
    async launch({ sessionId, tenantId: tenant, type, options: request }) {
      if (type !== 'dedicated') return { ok: false, code: 'launch_failed' };
      const egress = await startSessionEgress(request.egress ?? {}, {
        guard,
        onRequest: (target) => hosts.set(sessionId, [...(hosts.get(sessionId) ?? []), target.host]),
      });
      egresses.set(sessionId, egress);
      let lease: PoolLease;
      try {
        lease = await pool.acquire({ sessionId, type: 'dedicated', tenantId: tenant, ...(request.launchArgs ? { launchArgs: request.launchArgs } : {}) });
      } catch {
        await egress.close();
        return { ok: false, code: 'launch_failed' };
      }
      held.set(sessionId, { lease, egress, ending: null });
      const outcome = await transitionSession(db, { sessionId, to: 'running', reason: null, nodeId: NODE_ID });
      if (!outcome.ok) {
        await release(sessionId);
        return { ok: false, code: 'launch_failed' };
      }
      return { ok: true };
    },
    release,
    async extend() {
      return 'not_held';
    },
  };

  const nodeToken = randomBytes(24).toString('base64url');
  const nodeRelay = createNodeRelay({
    nodeToken,
    sessions: {
      get: (id) => {
        const entry = held.get(id);
        if (!entry || entry.ending || entry.lease.signal.aborted) return undefined;
        return {
          type: 'dedicated',
          playwright: entry.lease.wsEndpoint,
          cdp: entry.lease.cdpEndpoint ?? null,
          egressProxyUrl: entry.egress.url,
          downloadsDir: sessionDir(dataDir, id).downloads,
          release: async () => {
            await release(id);
          },
        };
      },
    },
  });
  const nodeServer: Server = createServer((_req, res) => res.writeHead(404).end());
  nodeServer.on('upgrade', (req, socket, head) => {
    if (!nodeRelay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => nodeServer.listen(0, '127.0.0.1', resolve));
  const nodeUrl = `http://127.0.0.1:${(nodeServer.address() as AddressInfo).port}`;
  await recordHeartbeat(db, {
    nodeId: NODE_ID,
    url: nodeUrl,
    region: 'local',
    playwrightVersion: '1.63.0',
    chromiumVersion: '153.0.8010.12',
    appVersion: '0.0.0',
    // Unités de slot (0.6, 2.4) : slots du pool × SLOT_UNITS, comme le battement du nœud.
    slotsTotal: pool.slotsTotal * CAPACITY.SLOT_UNITS,
    slotsFree: pool.slotsTotal * CAPACITY.SLOT_UNITS,
    rssBytes: null,
    limitBytes: null,
  });

  // Passerelle publique.
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const app: FastifyInstance = await createGatewayApi({
    db,
    auth: new ApiKeyAuthenticator(pgApiKeyStore(db)),
    tokens: new ConnectTokens({ current: MasterKey.generate() }),
    launcher,
    publicUrl: url,
    relay: { nodeToken },
  });
  await app.listen({ host: '127.0.0.1', port });

  return {
    url,
    apiKey,
    async sessionState(id) {
      const row = (await db.query<{ state: string; end_reason: string | null }>('SELECT state, end_reason FROM sessions WHERE id = $1', [id])).rows[0];
      return row ? { state: row.state, endReason: row.end_reason } : undefined;
    },
    egressHosts: (id) => [...(hosts.get(id) ?? [])],
    async residue() {
      await pool.whenIdle();
      const chromiumProcesses = groups.owned().reduce((sum, pgid) => sum + groups.members(pgid).length, 0);
      const sessionDirs = await readdir(join(dataDir, 'sessions')).catch(() => [] as string[]);
      return { chromiumProcesses, sessionDirs };
    },
    async close() {
      await app.close();
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      for (const id of [...held.keys()]) await release(id).catch(() => 'not_held');
      await pool.close();
      for (const egress of egresses.values()) await egress.close().catch(() => undefined);
      await db.end();
      await admin(options.pgAdminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
