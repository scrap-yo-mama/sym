// SPDX-License-Identifier: AGPL-3.0-only
// Passerelle tunnel WSS sur base réelle et serveurs en écoute (tâche 2.7, 07 § 5-6 et § 8) : jeton hors URL, Origin,
// révocation et expiration (4401), une WSS par utilisateur (4409), routage INV5 (assert_tunnel_single_user), découpage
// (assert_ws_chunking_maxpayload), garde SSRF à la passerelle (assert_ssrf_guard), rejeu après coupure, hors ligne, et
// routage par instance (assert_gateway_instance_routing : deux passerelles, 200 extensions simulées, aucune perte).
import { randomUUID } from 'node:crypto';
import { createLogger, generateExtensionToken } from '@runtime/core';
import { enqueueTunnelJob, readTunnelJob, type TunnelJobInput } from '@runtime/db';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { prepareServer, type Started } from '../../apps/server/src/start.js';
import { TunnelJobClient } from '../../apps/worker/src/tunnel/client.js';
import { createTestPool, closeTestPool } from '../helpers/pg.js';
import { createUser, PUBLIC_URL, runSetup, serverEnv, signIn, startTestServer, type TestServer, type TestUser } from '../helpers/server.js';
import { okFetch, SimExtension } from '../helpers/tunnel-sim.js';

const SHOP = 'zz-test-shop.example';
const silent = createLogger({ name: 'zz_test', level: 'fatal' });

let srv: TestServer;
let base: string;
let pool: pg.Pool;
let client: TunnelJobClient;
let owner: TestUser;
let ownerCookie: string;
let a: TestUser;
let b: TestUser;
const sims: SimExtension[] = [];

async function listen(started: Started): Promise<string> {
  await started.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = started.app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('adresse');
  return `http://127.0.0.1:${addr.port}`;
}

/** Appareil appairé directement en base (même empreinte que l'échange de code) : jeton en clair pour le test. */
async function device(userId: string, label = 'zz_test_device'): Promise<{ token: string; tunnelId: string }> {
  const { token, hash } = generateExtensionToken();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tunnels (owner_id, device_id, device_label, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '90 days') RETURNING id`,
    [userId, `zz_test_${randomUUID().slice(0, 12)}`, label, hash],
  );
  return { token, tunnelId: rows[0]!.id };
}

async function runOf(userId: string): Promise<string> {
  const api = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, output_schema) VALUES ($1, $2, '{}') RETURNING id", [`zz_test_${randomUUID().slice(0, 8)}`, userId])).rows[0]!.id;
  return (await pool.query<{ id: string }>("INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state) VALUES ($1, $2, $2, 'rest', 'running') RETURNING id", [api, userId])).rows[0]!.id;
}

function sim(token: string | null, opts: ConstructorParameters<typeof SimExtension>[2] = {}, url = base): SimExtension {
  const s = new SimExtension(url, token, opts);
  sims.push(s);
  return s;
}

const job = (runId: string, ownerId: string, extra: Partial<TunnelJobInput> = {}): TunnelJobInput => ({
  runId,
  ownerId,
  cmd: 'page_fetch',
  domain: SHOP,
  args: { url: `https://${SHOP}/api/data` },
  timeoutMs: 10_000,
  replayable: true,
  allowWriteActions: false,
  execution: 'fetch',
  ...extra,
});

const send = (input: TunnelJobInput, offlineGraceMs = 10_000) => {
  const c = new TunnelJobClient({ pool, sessionUrl: srv.db.url, logger: silent, offlineGraceMs, pollMs: 100 });
  return c.send(input, { signal: AbortSignal.timeout(60_000) });
};

async function auditActions(action: string): Promise<{ outcome: string; meta: Record<string, unknown> }[]> {
  return (await pool.query<{ outcome: string; meta: Record<string, unknown> }>('SELECT outcome, meta FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows;
}

beforeAll(async () => {
  srv = await startTestServer('tun', { GATEWAY_INSTANCE: 'zz_test_gw_a' });
  base = await listen(srv.started);
  pool = createTestPool(srv.db.url, 6);
  client = new TunnelJobClient({ pool, sessionUrl: srv.db.url, logger: silent, pollMs: 100 });
  await client.start();
  owner = await runSetup(srv);
  ownerCookie = await signIn(srv, owner);
  a = await createUser(srv, 'zz_test_tunnel_a@example.test');
  b = await createUser(srv, 'zz_test_tunnel_b@example.test');
}, 120_000);

afterAll(async () => {
  await Promise.all(sims.map((s) => s.close()));
  await client?.close();
  await closeTestPool(pool);
  await srv?.close();
});

describe('ouverture de la WSS', () => {
  test('assert_ws_token_not_in_url : jeton (ou tout paramètre) dans l’URL → 400, aucune WSS', async () => {
    const { token } = await device(a.id);
    const s = sim(null, { path: `/api/extension/tunnel?token=${token}` });
    await expect(s.welcome).rejects.toThrow('HTTP 400');
  });

  test('assert_ws_origin_checked : sans Origin ou Origin web → 403 ; Origin d’extension → ouverte', async () => {
    const { token } = await device(a.id);
    await expect(sim(token, { origin: null }).welcome).rejects.toThrow('HTTP 403');
    await expect(sim(token, { origin: 'https://evil.example' }).welcome).rejects.toThrow('HTTP 403');
    await expect(sim(token, { origin: PUBLIC_URL }).welcome).rejects.toThrow('HTTP 403');
    const ok = sim(token);
    expect(await ok.welcome).toBe(true);
    await ok.close();
  });

  test('jeton inconnu → 4401 ; premier message autre que hello, ou message hors schéma → 4400', async () => {
    const bad = sim('sy_ext_zz_test_unknown_token_0000000000000000000000');
    expect(await bad.welcome).toBe(false);
    expect(await bad.closed).toBe(4401);
    const { token } = await device(a.id);
    const noHello = sim(null);
    await new Promise<void>((r) => noHello.socket.on('open', () => r()));
    noHello.send(JSON.stringify({ type: 'ping' }));
    expect(await noHello.closed).toBe(4400);
    const strict = sim(token);
    expect(await strict.welcome).toBe(true);
    strict.send(JSON.stringify({ type: 'ping', owner_id: b.id }));
    expect(await strict.closed).toBe(4400);
  });

  test('assert_token_expiry_90d : appareil sans usage depuis plus de 90 jours → 4401 à l’ouverture', async () => {
    const { token, tunnelId } = await device(a.id);
    await pool.query("UPDATE tunnels SET expires_at = now() - interval '1 day', last_seen_at = now() - interval '91 days' WHERE id = $1", [tunnelId]);
    const s = sim(token);
    expect(await s.welcome).toBe(false);
    expect(await s.closed).toBe(4401);
  });

  test('assert_admin_revoke_only : révocation par un admin → WSS fermée aussitôt (4401)', async () => {
    const { token, tunnelId } = await device(a.id);
    const s = sim(token);
    expect(await s.welcome).toBe(true);
    const res = await srv.app.inject({ method: 'DELETE', url: `/api/admin/tunnels/${tunnelId}`, headers: { cookie: ownerCookie, origin: PUBLIC_URL } });
    expect(res.statusCode).toBe(204);
    expect(await s.closed).toBe(4401);
    expect((await pool.query('SELECT gateway_instance FROM tunnels WHERE id = $1', [tunnelId])).rows[0]).toEqual({ gateway_instance: null });
  });
});

describe('assert_tunnel_single_user (INV5)', () => {
  test('deux appareils du même utilisateur : la seconde WSS gagne, la première est fermée en 4409', async () => {
    const first = await device(a.id, 'zz_test_laptop');
    const second = await device(a.id, 'zz_test_desktop');
    const s1 = sim(first.token);
    expect(await s1.welcome).toBe(true);
    const s2 = sim(second.token);
    expect(await s2.welcome).toBe(true);
    expect(await s1.closed).toBe(4409);
    const connected = await pool.query<{ id: string }>('SELECT id FROM tunnels WHERE owner_id = $1 AND gateway_instance IS NOT NULL', [a.id]);
    expect(connected.rows.map((r) => r.id)).toEqual([second.tunnelId]);
    await s2.close();
  });

  test('run de B routé vers l’extension de A : refusé en base, et par la passerelle si la base était contournée ; journalisé', async () => {
    const devA = await device(a.id);
    const sA = sim(devA.token, { handler: () => okFetch('{}') });
    expect(await sA.welcome).toBe(true);
    const runB = await runOf(b.id);
    // 1. Base : un job ne vise que l'extension du propriétaire de son run.
    await expect(
      pool.query(
        "INSERT INTO tunnel_jobs (run_id, tunnel_id, owner_id, cmd, domain, payload) VALUES ($1, $2, $3, 'page_fetch', $4, '{}')",
        [runB, devA.tunnelId, a.id, SHOP],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // 2. Passerelle : même job forcé en base (déclencheurs contournés) puis notifié à l'instance de A.
    const forged = randomUUID();
    const c = await pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(
        `INSERT INTO tunnel_jobs (job_id, run_id, tunnel_id, owner_id, cmd, domain, payload) VALUES ($1, $2, $3, $4, 'page_fetch', $5, $6)`,
        [forged, runB, devA.tunnelId, a.id, SHOP, JSON.stringify({ url: `https://${SHOP}/b-data` })],
      );
      await c.query('SET session_replication_role = origin');
    } finally {
      c.release();
    }
    await pool.query("SELECT pg_notify('tunnel_cmd_zz_test_gw_a', $1)", [`j:${forged}`]);
    await vi.waitFor(async () => expect((await readTunnelJob(pool, forged))?.state).toBe('failed'), { timeout: 10_000 });
    expect(await readTunnelJob(pool, forged)).toMatchObject({ error: 'owner_mismatch', dispatched: false });
    expect(sA.received).toEqual([]);
    expect((await auditActions('tunnel.route_denied')).at(-1)).toMatchObject({ outcome: 'denied', meta: { jobId: forged, reason: 'owner_mismatch' } });
    expect(srv.started.ctx.tunnel!.routeDenied).toBeGreaterThanOrEqual(1);
    await sA.close();
  });
});

describe('commandes', () => {
  test('aller-retour : la commande du run de A part vers SA WSS, la réponse revient au worker', async () => {
    const devA = await device(a.id);
    const sA = sim(devA.token, { handler: () => okFetch('{"items":[1,2,3]}') });
    expect(await sA.welcome).toBe(true);
    const out = await client.send(job(await runOf(a.id), a.id), { signal: AbortSignal.timeout(30_000) });
    expect(out).toMatchObject({ kind: 'result', result: { ok: true, body: { status: 200, body: '{"items":[1,2,3]}' } } });
    expect(sA.received).toHaveLength(1);
    expect(sA.received[0]).toMatchObject({ cmd: 'page_fetch', domain: SHOP, args: { url: `https://${SHOP}/api/data` }, allow_write_actions: false });
    // Réponse lue puis effacée de la table (contenu de page).
    const jobs = await pool.query<{ result: unknown }>('SELECT result FROM tunnel_jobs WHERE run_id = $1', [sA.received[0]!.run_id]);
    expect(jobs.rows).toEqual([{ result: null }]);
    await sA.close();
  });

  test('assert_ws_chunking_maxpayload : réponse de page de 3 Mio → arrive entière, en morceaux ≤ 1 Mio', async () => {
    const devA = await device(a.id);
    const page = '<div class="zz_test">é😀</div>'.repeat(110_000);
    expect(Buffer.byteLength(page)).toBeGreaterThan(3 * 1024 * 1024);
    const sA = sim(devA.token, { handler: () => okFetch(page, 200) });
    expect(await sA.welcome).toBe(true);
    const out = await client.send(job(await runOf(a.id), a.id), { signal: AbortSignal.timeout(30_000) });
    expect(out.kind).toBe('result');
    expect(((out as { result: { body: { body: string } } }).result.body.body)).toBe(page);
    await sA.close();
  });

  test('assert_ssrf_guard (passerelle) : evil.example, 169.254.169.254, localhost, IP privée → refus avant émission', async () => {
    const devA = await device(a.id);
    const sA = sim(devA.token);
    expect(await sA.welcome).toBe(true);
    const runA = await runOf(a.id);
    const cases: Partial<TunnelJobInput>[] = [
      { args: { url: 'https://evil.example/' } },
      { domain: '169.254.169.254', args: { url: 'http://169.254.169.254/latest/meta-data/' } },
      { domain: 'localhost', args: { url: 'http://localhost/' } },
      { domain: '10.0.0.7', args: { url: 'http://10.0.0.7/' } },
      { domain: 'printer.local', args: { url: 'http://printer.local/' } },
      { cmd: 'page_script', args: { method: 'Page.navigate', params: { url: 'http://192.168.1.1/' } } },
    ];
    for (const extra of cases) {
      const out = await client.send(job(runA, a.id, extra), { signal: AbortSignal.timeout(30_000) });
      expect(out, JSON.stringify(extra)).toMatchObject({ kind: 'error', error: 'domain_not_allowed' });
    }
    expect(sA.received).toEqual([]);
    await sA.close();
  });

  test('assert_cdp_allowlist / assert_no_remote_logic (passerelle) : Runtime.evaluate, code dans un argument → refus avant émission', async () => {
    const devA = await device(a.id);
    const sA = sim(devA.token);
    expect(await sA.welcome).toBe(true);
    const runA = await runOf(a.id);
    for (const args of [{ method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }, { method: 'Page.navigate', params: { url: `https://${SHOP}/`, expression: '1' } }, { code: 'alert(1)' }]) {
      const out = await client.send(job(runA, a.id, { cmd: 'page_script', args }), { signal: AbortSignal.timeout(30_000) });
      expect(out).toMatchObject({ kind: 'error', error: 'method_not_allowed' });
    }
    // E6 : refusé en base (CHECK), jamais inscrit.
    await expect(enqueueTunnelJob(pool, job(runA, a.id, { cmd: 'agent_step', execution: 'agent', args: { action: 'read' } }))).rejects.toMatchObject({ code: '23514' });
    expect(sA.received).toEqual([]);
    await sA.close();
  });

  test('coupure pendant une commande : lecture rejouée sur la nouvelle connexion, écriture mise en échec (jamais perdue)', async () => {
    const devA = await device(a.id);
    const s1 = sim(devA.token, { handler: () => null }); // ne répond jamais
    expect(await s1.welcome).toBe(true);
    const runA = await runOf(a.id);
    const read = client.send(job(runA, a.id), { signal: AbortSignal.timeout(30_000) });
    const write = client.send(job(runA, a.id, { args: { url: `https://${SHOP}/api/order`, method: 'POST', body: '{}' }, replayable: false, allowWriteActions: true }), { signal: AbortSignal.timeout(30_000) });
    await vi.waitFor(() => expect(s1.received).toHaveLength(2), { timeout: 10_000 });
    await s1.close();
    expect(await write).toMatchObject({ kind: 'error', error: 'tunnel_disconnected' });
    const s2 = sim(devA.token, { handler: () => okFetch('{"replayed":true}') });
    expect(await s2.welcome).toBe(true);
    expect(await read).toMatchObject({ kind: 'result', result: { ok: true, body: { body: '{"replayed":true}' } } });
    expect(s2.received.map((f) => f.job_id)).toEqual([s1.received[0]!.job_id]);
    await s2.close();
  });

  test('extension hors ligne : le run attend (waiting_tunnel), puis tunnel_offline ; rattrapage dès la connexion', async () => {
    const runA = await runOf(a.id);
    const waits: boolean[] = [];
    const c = new TunnelJobClient({ pool, sessionUrl: srv.db.url, logger: silent, offlineGraceMs: 800, pollMs: 100 });
    const out = await c.send(job(runA, a.id), { signal: AbortSignal.timeout(30_000), onWaiting: async (w) => void waits.push(w) });
    expect(out).toMatchObject({ kind: 'error', error: 'tunnel_offline' });
    expect(waits).toEqual([true, false]);
    // Rattrapage : une commande en attente part dès que l'extension se connecte.
    const pending = send(job(runA, a.id));
    await new Promise((r) => setTimeout(r, 300));
    const devA = await device(a.id);
    const s = sim(devA.token, { handler: () => okFetch('{"late":true}') });
    expect(await s.welcome).toBe(true);
    expect(await pending).toMatchObject({ kind: 'result', result: { body: { body: '{"late":true}' } } });
    await s.close();
  });
});

describe('assert_gateway_instance_routing : deux instances, 200 extensions simulées', () => {
  test('seule l’instance qui tient la connexion reçoit la commande ; aucune commande perdue', async () => {
    const second = await prepareServer(serverEnv(srv.db.url, srv.masterKey, null, { GATEWAY_INSTANCE: 'zz_test_gw_b' }));
    const baseB = await listen(second);
    try {
      const users: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        users.push((await pool.query<{ id: string }>("INSERT INTO users (email, role, status) VALUES ($1, 'member', 'active') RETURNING id", [`zz_test_route_${i}@example.test`])).rows[0]!.id);
      }
      const extensions = await Promise.all(
        users.map(async (userId, i) => {
          const { token } = await device(userId);
          const s = sim(token, { handler: (f) => okFetch(JSON.stringify({ to: userId, job: f.job_id })) }, i % 2 === 0 ? base : baseB);
          return { userId, s, instance: i % 2 === 0 ? 'zz_test_gw_a' : 'zz_test_gw_b' };
        }),
      );
      expect((await Promise.all(extensions.map((e) => e.s.welcome))).every(Boolean)).toBe(true);
      const where = await pool.query<{ owner_id: string; gateway_instance: string }>('SELECT owner_id, gateway_instance FROM tunnels WHERE owner_id = ANY($1::uuid[]) AND gateway_instance IS NOT NULL', [users]);
      expect(where.rows).toHaveLength(200);
      for (const e of extensions) expect(where.rows.find((r) => r.owner_id === e.userId)?.gateway_instance).toBe(e.instance);

      const beforeA = srv.started.ctx.tunnel!.dispatched;
      const beforeB = second.ctx.tunnel!.dispatched;
      const PER_USER = 3;
      const outcomes = await Promise.all(
        extensions.map(async (e) => {
          const runId = await runOf(e.userId);
          return Promise.all(Array.from({ length: PER_USER }, () => client.send(job(runId, e.userId), { signal: AbortSignal.timeout(60_000) })));
        }),
      );
      // Aucune perte : chaque commande a sa réponse, venue de l'extension de SON propriétaire.
      outcomes.forEach((list, i) => {
        for (const out of list) {
          expect(out.kind).toBe('result');
          const body = JSON.parse(((out as { result: { body: { body: string } } }).result.body.body)) as { to: string };
          expect(body.to).toBe(extensions[i]!.userId);
        }
      });
      for (const e of extensions) expect(e.s.received).toHaveLength(PER_USER);
      // Chaque instance n'a émis que les commandes des connexions qu'elle tient.
      expect(srv.started.ctx.tunnel!.dispatched - beforeA).toBe(100 * PER_USER);
      expect(second.ctx.tunnel!.dispatched - beforeB).toBe(100 * PER_USER);
      const lost = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tunnel_jobs t JOIN tunnels u ON u.owner_id = t.owner_id WHERE u.owner_id = ANY($1::uuid[]) AND t.state <> 'done'", [users]);
      expect(lost.rows[0]!.n).toBe(0);
      await Promise.all(extensions.map((e) => e.s.close()));
    } finally {
      await second.close();
    }
  }, 120_000);
});
