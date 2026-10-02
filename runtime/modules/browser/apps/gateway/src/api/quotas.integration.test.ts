// SPDX-License-Identifier: AGPL-3.0-only
// Quotas et capacité sur l'API REST (cdc/sym-browser 04b § 7, 04d § 4.2, 04 § 6, tâche 2.4 ; recette étape 17), sur
// PostgreSQL réel, chaque réponse validée contre l'OpenAPI. Tests nommés : quota_429 (A11, D10), queue_fifo (P9),
// queue_bounded_429 (P10), node_choice_least_loaded (P8).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

const created = (h: Harness, body: unknown = {}, query = '') => h.call({ method: 'POST', url: `/v1/sessions${query}`, body });
const state = async (h: Harness, id: string): Promise<string> => (await h.call({ method: 'GET', url: `/v1/sessions/${id}` })).body.state;

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function expectRetryAfter(res: { headers: Record<string, unknown> }, max = 60): number {
  const value = String(res.headers['retry-after']);
  expect(value).toMatch(/^\d+$/);
  const seconds = Number(value);
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(seconds).toBeLessThanOrEqual(max);
  return seconds;
}

describe('recette étape 17 : quota 3, 5 sessions demandées', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ maxConcurrentSessions: 3, queue: { queueMax: 50, queueMaxPerTenant: 2 }, queueTimeoutMs: 10_000 });
  });
  afterAll(async () => h.close());

  test('3 running, 2 en file servies dans l’ordre ; au-delà de la file → 429 avec Retry-After', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await created(h, { metadata: { n: String(i) } }, '?wait=false');
      expect(res.status).toBe(202);
      ids.push(res.body.id);
    }
    await until(async () => (await Promise.all(ids.slice(0, 3).map((id) => state(h, id)))).every((s) => s === 'running'));
    expect(await state(h, ids[3]!)).toBe('pending');
    expect(await state(h, ids[4]!)).toBe('pending');

    const over = await created(h, {}, '?wait=false');
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'quota_exceeded', retryable: true, details: { quota: 'concurrent_sessions' } });
    expectRetryAfter(over);

    // Un slot du client se libère : la 4e passe, pas la 5e ; puis la 5e.
    expect((await h.call({ method: 'DELETE', url: `/v1/sessions/${ids[0]}` })).status).toBe(200);
    await until(async () => (await state(h, ids[3]!)) === 'running');
    expect(await state(h, ids[4]!)).toBe('pending');
    expect((await h.call({ method: 'DELETE', url: `/v1/sessions/${ids[1]}` })).status).toBe(200);
    await until(async () => (await state(h, ids[4]!)) === 'running');
    expect(h.launcher.launched.filter((id) => ids.includes(id))).toEqual(ids);
  });

  test('wait=true : la demande attend en file et reçoit 201 running dès qu’un slot du client se libère', async () => {
    const running = (await h.call({ method: 'GET', url: '/v1/sessions?state=running' })).body.data.map((s: { id: string }) => s.id);
    expect(running).toHaveLength(3);
    const pending = created(h, { metadata: { cas: 'attente' } });
    await new Promise((r) => setTimeout(r, 200));
    await h.call({ method: 'DELETE', url: `/v1/sessions/${running[0]}` });
    const res = await pending;
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('running');
  });
});

describe('quota_429 (A11, D10) : quota de 2 sessions, sans file par client', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ maxConcurrentSessions: 2, queue: { queueMax: 50, queueMaxPerTenant: 0 } });
  });
  afterAll(async () => h.close());

  test('3e création → 429 quota_exceeded avec Retry-After, aucune session écrite ; une libération rouvre la place', async () => {
    const a = await created(h);
    const b = await created(h);
    expect([a.status, b.status]).toEqual([201, 201]);
    const { rows: before } = await h.pool.query('SELECT count(*)::int AS n FROM sessions');
    const third = await h.call({ method: 'POST', url: '/v1/sessions', body: {}, headers: { 'accept-language': 'fr' } });
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'quota_exceeded', retryable: true, details: { quota: 'concurrent_sessions' } });
    expect(third.body.error.what_to_do).toMatch(/Retry-After|libère/);
    expectRetryAfter(third);
    const { rows: after } = await h.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(after).toEqual(before);
    // Les sessions d'un autre client ne comptent pas.
    expect((await h.call({ method: 'POST', url: '/v1/sessions', body: {}, key: 'b' })).status).toBe(201);
    await h.call({ method: 'DELETE', url: `/v1/sessions/${a.body.id}` });
    expect((await created(h)).status).toBe(201);
  });
});

describe('capacité du parc : file bornée et ordre de service', () => {
  let h: Harness;
  beforeAll(async () => {
    // Un seul nœud d'un slot (4 unités) : une session dedicated à la fois.
    h = await createHarness({ maxConcurrentSessions: 50, queue: { queueMax: 2, queueMaxPerTenant: 10 }, nodes: [{ id: 'node-a', region: 'frankfurt', slotsTotal: 4 }], queueTimeoutMs: 10_000 });
  });
  afterAll(async () => h.close());

  test('queue_fifo (P9) : une file de 3 demandes est servie dans l’ordre d’arrivée à la libération des slots', async () => {
    const first = await created(h, {}, '?wait=false');
    await until(async () => (await state(h, first.body.id)) === 'running');
    const queued: string[] = [];
    for (let i = 0; i < 2; i += 1) queued.push((await created(h, { metadata: { q: String(i) } }, '?wait=false')).body.id);
    // Un autre client arrive après : il passe après eux.
    const other = await h.call({ method: 'POST', url: '/v1/sessions?wait=false', body: {}, key: 'b' });
    expect(other.status).toBe(429); // file globale (QUEUE_MAX = 2) pleine
    let current = first.body.id as string;
    for (const [i, next] of queued.entries()) {
      await h.call({ method: 'DELETE', url: `/v1/sessions/${current}` });
      await until(async () => (await state(h, next)) === 'running');
      for (const later of queued.slice(i + 1)) expect(await state(h, later)).toBe('pending');
      current = next;
    }
    await h.call({ method: 'DELETE', url: `/v1/sessions/${current}` });
  });

  test('queue_bounded_429 (P10) : QUEUE_MAX atteint, une demande de plus → 429 capacity_exceeded avec Retry-After', async () => {
    const holder = await created(h, {}, '?wait=false');
    await until(async () => (await state(h, holder.body.id)) === 'running');
    const waiting = [await created(h, {}, '?wait=false'), await created(h, {}, '?wait=false')];
    expect(waiting.map((r) => r.status)).toEqual([202, 202]);
    const over = await created(h, {}, '?wait=false');
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'capacity_exceeded', retryable: true, details: { limit: 'queue_max' } });
    expectRetryAfter(over);
    for (const id of [holder.body.id, ...waiting.map((r) => r.body.id)]) await h.call({ method: 'DELETE', url: `/v1/sessions/${id}` });
  });

  test('délai de file dépassé : 429 capacity_exceeded, session failed raison quota, file rendue', async () => {
    const short = await createHarness({ maxConcurrentSessions: 50, nodes: [{ id: 'node-a', region: 'frankfurt', slotsTotal: 4 }], queueTimeoutMs: 300 });
    try {
      const holder = await short.call({ method: 'POST', url: '/v1/sessions', body: {} });
      expect(holder.status).toBe(201);
      const late = await short.call({ method: 'POST', url: '/v1/sessions', body: { metadata: { cas: 'expirée' } } });
      expect(late.status).toBe(429);
      expect(late.body.error.code).toBe('capacity_exceeded');
      expectRetryAfter(late);
      const { rows } = await short.pool.query("SELECT state, end_reason, node_id FROM sessions WHERE metadata->>'cas' = 'expirée'");
      expect(rows).toEqual([{ state: 'failed', end_reason: 'quota', node_id: null }]);
    } finally {
      await short.close();
    }
  });
});

describe('node_choice_least_loaded (P8)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({
      maxConcurrentSessions: 50,
      nodes: [
        { id: 'node-20', region: 'frankfurt', slotsTotal: 20 },
        { id: 'node-60', region: 'frankfurt', slotsTotal: 20 },
      ],
    });
  });
  afterAll(async () => h.close());

  test('nœuds à 20 % et 60 % → la session part sur celui à 20 % ; région absente → 503 no_node', async () => {
    const fill = async (nodeId: string, units: number) => {
      for (let i = 0; i < units; i += 1) {
        await h.pool.query("INSERT INTO sessions (tenant_id, api_key_id, type, node_id, slot_weight, state, started_at, expires_at) SELECT tenant_id, id, 'dedicated', $1, 1, 'running', now(), now() + interval '1 hour' FROM api_keys WHERE key_prefix = 'symb_b_w'", [nodeId]);
      }
    };
    await fill('node-20', 4);
    await fill('node-60', 12);
    const res = await created(h);
    expect(res.status).toBe(201);
    expect(h.launcher.nodes.get(res.body.id)).toBe('node-20');
    const nowhere = await created(h, { region: 'tokyo' });
    expect(nowhere.status).toBe(503);
    expect(nowhere.body.error.code).toBe('no_node');
  });
});

describe('quotas mensuels et durée maximale (04d § 4.2)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ maxConcurrentSessions: 50, maxSessionSeconds: 120 });
  });
  afterAll(async () => h.close());

  const consume = async (seconds: number, bytes: number) => {
    const { rows } = await h.pool.query<{ id: string }>(
      "INSERT INTO sessions (tenant_id, api_key_id, type, node_id, state, end_reason, started_at, ended_at, expires_at) SELECT tenant_id, id, 'dedicated', 'node-a', 'ended', 'released', now() - make_interval(secs => $1), now(), now() FROM api_keys WHERE key_prefix = 'symb_a_w' RETURNING id",
      [seconds],
    );
    await h.pool.query(
      "INSERT INTO usage_records (session_id, tenant_id, api_key_id, node_id, started_at, ended_at, browser_ms, billed_seconds, bytes_in, bytes_out, source) SELECT id, tenant_id, api_key_id, node_id, started_at, ended_at, $2::bigint * 1000, $2, $3, 0, 'node' FROM sessions WHERE id = $1",
      [rows[0]!.id, seconds, bytes],
    );
  };

  test('durée max : timeoutSeconds borné à la valeur du client', async () => {
    const res = await created(h, { timeoutSeconds: 3_600 });
    expect(res.status).toBe(201);
    expect(Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt)).toBeLessThanOrEqual(120_000);
    await h.call({ method: 'DELETE', url: `/v1/sessions/${res.body.id}` });
  });

  test('octets : budget de l’egress borné par le reste du mois ; solde nul → 429 quota_exceeded {quota: bytes}', async () => {
    await h.pool.query('UPDATE tenants SET monthly_bytes = 1000 WHERE id = $1', [h.tenantA]);
    await consume(1, 400);
    const res = await created(h, { egress: { budgetBytes: 5_000 } });
    expect(res.status).toBe(201);
    expect(h.launcher.requests.get(res.body.id)?.options.egress?.budgetBytes).toBe(600);
    const small = await created(h, { egress: { budgetBytes: 100 } });
    expect(h.launcher.requests.get(small.body.id)?.options.egress?.budgetBytes).toBe(100);
    await consume(1, 600);
    const refused = await created(h);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'quota_exceeded', details: { quota: 'bytes' } });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await h.pool.query('UPDATE tenants SET monthly_bytes = 10737418240 WHERE id = $1', [h.tenantA]);
  });

  test('minutes : solde nul → 429 quota_exceeded {quota: minutes}, Retry-After jusqu’au mois suivant', async () => {
    await h.pool.query('UPDATE tenants SET monthly_minutes = 1 WHERE id = $1', [h.tenantA]);
    await consume(60, 0);
    const refused = await created(h);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'quota_exceeded', details: { quota: 'minutes' } });
    const now = new Date();
    const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    expect(Math.abs(Number(refused.headers['retry-after']) - Math.ceil((nextMonth - now.getTime()) / 1000))).toBeLessThanOrEqual(5);
    // L'autre client n'est pas touché.
    expect((await h.call({ method: 'POST', url: '/v1/sessions', body: {}, key: 'b' })).status).toBe(201);
  });
});
