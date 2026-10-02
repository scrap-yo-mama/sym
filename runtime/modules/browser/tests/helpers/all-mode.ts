// SPDX-License-Identifier: AGPL-3.0-only
// Instance SYM Browser en mode `all` (03 § 4 : passerelle et nœud dans un même processus), assemblée pour les tests de
// bout en bout du SDK (tâche 3.4, A13 `sdk_readme_example`) à partir des composants réels :
//   - PostgreSQL 16 jetable (Testcontainers), schéma migré (0.2) ; un client et une clé `sessions:write` + `sessions:read` ;
//   - passerelle : API REST `/v1` (2.2) et relais WSS `/playwright` et `/cdp` (2.3), jetons de connexion HMAC (core) ;
//   - nœud : pool de Chromium 153 (1.1), Chromium chauds pour `shared` et Chromium dédié pour `dedicated` (1.3, 1.4),
//     superviseur des sessions sur la base (1.2), egress par session (1.5), relais interne (2.3) ;
//   - le lanceur du mode `all` relie la passerelle au superviseur du nœud dans le processus (types.ts de la passerelle).
// Authentification : vraies clés argon2id et jetons HMAC de la tâche 2.1 (branchés à l'intégration).
// Le binaire `SYMB_MODE=all` ne sert pas encore l'API (aucune tâche fusionnée ne l'a câblé) : ce banc en est l'assemblage.
// Destination : le site de test de la tâche 0.5 sur 127.0.0.1, nommé `site-a.test` (résolveur et hôte privé admis du
// banc, comme tests/cdp-compat.chromium.test.ts). Prérequis : Docker, utilisateur non root, Chromium de Playwright 1.63.
// Sécurité : les Chromium sont arrêtés par le pool (groupes de processus enregistrés à leur lancement), jamais par un
// signal à un autre pid.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { ApiKeyAuthenticator, CAPACITY, ConnectTokens, MasterKey, newApiKey } from '../../packages/core/src/index.ts';
import { createPgSessionStore, insertApiKey, migrateUp, pgApiKeyStore, recordHeartbeat } from '../../packages/db/src/index.ts';
import { createGatewayApi, type SessionLauncher } from '../../apps/gateway/src/api/index.ts';
import { dedicatedLauncher, sessionDir } from '../../apps/node/src/dedicated/index.ts';
import { createEgressGuard, startSessionEgress, type SessionEgress } from '../../apps/node/src/egress/index.ts';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher, startClosedLaunchProxy, type AcquireRequest, type ClosedLaunchProxy, type PoolLease } from '../../apps/node/src/pool/index.ts';
import { createNodeRelay } from '../../apps/node/src/relay/index.ts';
import { SessionSupervisor } from '../../apps/node/src/sessions/supervisor.ts';
import { startSite, type SiteHandle } from '../../fixtures/src/site.ts';

export const SITE_HOST = 'site-a.test';
const NODE_ID = 'node-all';

export type AllModeInstance = {
  /** URL publique de la passerelle (`http://127.0.0.1:PORT`), à donner au SDK (`SYMB_URL`). */
  url: string;
  /** Clé d'API du client de test (`SYMB_API_KEY`) : jetable, tirée à chaque exécution. */
  apiKey: string;
  /** URL du site de test vue par Chromium (`http://site-a.test:PORT/`). */
  siteUrl: string;
  db: pg.Pool;
  /** Chromium encore tenus par le pool (0 après la fin de toutes les sessions). */
  liveBrowsers(): number;
  /** Erreurs internes journalisées par la passerelle et le nœud. */
  errors: unknown[];
  close(): Promise<void>;
};

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startAllMode(): Promise<AllModeInstance> {
  if (process.getuid?.() === 0) throw new Error('mode all sur vrais Chromium : lance les tests sous un utilisateur non root (bac à sable, 03 § 7).');
  const errors: unknown[] = [];
  const onError = (error: unknown): void => void errors.push(error);
  const cleanups: (() => Promise<unknown>)[] = [];
  const close = async (): Promise<void> => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(onError);
  };

  try {
    // Base.
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start();
    cleanups.push(() => container.stop());
    await migrateUp({ connectionString: container.getConnectionUri() });
    const db = new pg.Pool({ connectionString: container.getConnectionUri(), max: 8 });
    cleanups.push(() => db.end());
    const one = async (sql: string, params: unknown[]): Promise<string> => (await db.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
    const tenantId = await one('INSERT INTO tenants (name, max_session_seconds) VALUES ($1, $2) RETURNING id', ['sdk', 3600]);
    // Clé réelle (argon2id, tâche 2.1) : seule son empreinte est en base.
    const created = await newApiKey({ scopes: ['sessions:write', 'sessions:read'] });
    await insertApiKey(db, { tenantId, prefix: created.prefix, keyHash: created.keyHash, scopes: created.scopes, expiresAt: null });
    const apiKey = created.key.reveal();

    // Site de test (0.5) derrière le nom `site-a.test`.
    const site: SiteHandle = await startSite({ host: '127.0.0.1' });
    cleanups.push(() => site.close());
    const guard = createEgressGuard({
      privateHosts: [SITE_HOST],
      resolver: async (host) => (host === SITE_HOST ? [{ address: '127.0.0.1', family: 4 as const }] : Promise.reject(new Error('ENOTFOUND'))),
    });

    // Nœud : egress par session, pool (Chromium chauds sur un proxy de lancement fermé, dédiés sur l'egress de leur session).
    const egresses = new Map<string, SessionEgress>();
    const dataDir = await mkdtemp(join(tmpdir(), 'zz_symb_allmode_'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const closedProxy: ClosedLaunchProxy = await startClosedLaunchProxy();
    cleanups.push(() => closedProxy.close());
    const groups = new OwnedProcessGroups();
    const pool = new BrowserPool({
      slotsTotal: 4,
      warmBrowsers: 0,
      constants: PROVISIONAL_CAPACITY,
      sweepIntervalMs: 0,
      launch: playwrightLauncher({ launchProxyUrl: closedProxy.url, groups }),
      launchDedicated: async (purpose) => {
        const egress = purpose.sessionId === undefined ? undefined : egresses.get(purpose.sessionId);
        if (!egress) throw new Error('session dedicated sans egress');
        return dedicatedLauncher({ dataDir, launchProxyUrl: egress.url, groups })(purpose);
      },
    });
    await pool.start();
    cleanups.push(() => pool.close());

    // Baux tenus, pour l'annuaire du relais ; la fin d'un bail ferme ensuite l'egress de sa session (04c § 3.2).
    const leases = new Map<string, PoolLease>();
    const supervisor = new SessionSupervisor({
      nodeId: NODE_ID,
      store: createPgSessionStore(db),
      onError,
      pool: {
        acquire: async (request: AcquireRequest) => {
          const lease = await pool.acquire(request);
          leases.set(request.sessionId, lease);
          return {
            ...lease,
            signal: lease.signal,
            release: async () => {
              leases.delete(request.sessionId);
              await lease.release();
              const egress = egresses.get(request.sessionId);
              egresses.delete(request.sessionId);
              egress?.shut();
              await egress?.close();
            },
          };
        },
      },
    });
    cleanups.push(() => supervisor.shutdown());

    const nodeToken = randomBytes(24).toString('base64url');
    const nodeRelay = createNodeRelay({
      nodeToken,
      onActivity: (sessionId) => supervisor.activity(sessionId),
      onError,
      sessions: {
        get: (sessionId) => {
          const lease = leases.get(sessionId);
          const egress = egresses.get(sessionId);
          if (!lease || !egress || lease.signal.aborted) return undefined;
          return {
            type: lease.type,
            playwright: lease.wsEndpoint,
            cdp: lease.cdpEndpoint ?? null,
            egressProxyUrl: egress.url,
            downloadsDir: lease.type === 'dedicated' ? sessionDir(dataDir, sessionId).downloads : null,
            release: async () => void (await supervisor.end(sessionId, 'released')),
          };
        },
      },
    });
    const nodeServer: Server = createServer((_req, res) => res.writeHead(404).end());
    nodeServer.on('upgrade', (req, socket, head) => {
      if (!nodeRelay.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => nodeServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      await nodeRelay.close();
      nodeServer.closeAllConnections();
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
    });
    await recordHeartbeat(db, {
      nodeId: NODE_ID,
      url: `http://127.0.0.1:${(nodeServer.address() as AddressInfo).port}`,
      region: 'local',
      playwrightVersion: '1.63.0',
      chromiumVersion: '153.0.8010.12',
      appVersion: '0.0.0',
      // Unités de slot (0.6, 2.4) : slots du pool × SLOT_UNITS, comme le battement du nœud.
      slotsTotal: 4 * CAPACITY.SLOT_UNITS,
      slotsFree: 4 * CAPACITY.SLOT_UNITS,
      rssBytes: null,
      limitBytes: null,
    });

    // Lanceur du mode `all` : la passerelle démarre, libère et prolonge sur le superviseur du nœud, dans le processus.
    const launcher: SessionLauncher = {
      async launch(request) {
        const egress = await startSessionEgress((request.options.egress ?? {}) as Parameters<typeof startSessionEgress>[0], { guard, onDenied: () => undefined });
        egresses.set(request.sessionId, egress);
        const now = Date.now();
        const outcome = await supervisor.start({
          sessionId: request.sessionId,
          type: request.type,
          tenantId: request.tenantId,
          expiresAt: request.expiresAt.getTime(),
          maxExpiresAt: now + 3_600_000,
          idleTimeoutSeconds: request.idleTimeoutSeconds,
        });
        if (outcome.ok) return { ok: true };
        egresses.delete(request.sessionId);
        egress.shut();
        await egress.close();
        return { ok: false, code: 'launch_failed' };
      },
      async release(sessionId) {
        const outcome = await supervisor.end(sessionId, 'released');
        return outcome.ok ? 'released' : 'not_held';
      },
      async extend(sessionId, seconds) {
        return (await supervisor.extend(sessionId, seconds)).ok ? 'extended' : 'not_held';
      },
    };

    // Passerelle.
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const tokens = new ConnectTokens({ current: MasterKey.generate() });
    const gateway: FastifyInstance = await createGatewayApi({
      db,
      auth: new ApiKeyAuthenticator(pgApiKeyStore(db)),
      tokens,
      launcher,
      publicUrl: url,
      relay: { nodeToken },
      queueTimeoutMs: 60_000,
      onError,
    });
    await gateway.listen({ host: '127.0.0.1', port });
    cleanups.push(() => gateway.close());

    return { url, apiKey, siteUrl: `http://${SITE_HOST}:${site.port}/`, db, liveBrowsers: () => { const { warm, shared, dedicated } = pool.stats().browsers; return warm + shared + dedicated; }, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}
