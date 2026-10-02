// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.5 (03 § 5, 04 § 2, 03 « webhookUrl … signé selon Standard Webhooks ») : publication des événements de session et
// file des webhooks, côté base. Chaque insertion dans `session_events` (transition d'état de la 1.2, egress de la 1.5,
// enregistrements…) est notifiée sur `symb_session_events` à la validation, dans l'ordre des validations ; une fin de session
// ou un `recording.ready` d'un client qui a un `webhook_url` met une livraison en file dans la même transaction. Lecture par
// client (BINV7) et reprise après un identifiant (Last-Event-ID).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/helpers/pg.js';
import {
  SESSION_EVENTS_CHANNEL,
  WEBHOOKS_CHANNEL,
  appendSessionEvent,
  claimWebhookDeliveries,
  completeWebhookDelivery,
  createPgSessionEventSink,
  getTenantWebhook,
  listSessionEvents,
  listWebhookDeliveries,
  migrateUp,
  parseSessionEventNotification,
  setTenantWebhook,
  transitionSession,
} from './index.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let listener: pg.Client;
const notes: { channel: string; payload: string }[] = [];

const one = async (sql: string, params: unknown[] = []): Promise<string> => (await pool.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';
const tenant = (name: string) => one('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name]);
const apiKey = (tenantId: string, prefix: string) =>
  one("INSERT INTO api_keys (tenant_id, key_prefix, key_hash, scopes) VALUES ($1, $2, '$argon2id$v=19$m=19456,t=2,p=1$x$y', ARRAY['sessions:read']) RETURNING id", [tenantId, prefix]);
const session = (tenantId: string, keyId: string) =>
  one("INSERT INTO sessions (tenant_id, api_key_id, type, expires_at) VALUES ($1, $2, 'dedicated', now() + interval '5 minutes') RETURNING id", [tenantId, keyId]);

let tenantA: string;
let tenantB: string;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  tdb = await createTestDatabase('events');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  listener = new pg.Client({ connectionString: tdb.url });
  await listener.connect();
  listener.on('notification', (n) => notes.push({ channel: n.channel, payload: n.payload ?? '' }));
  await listener.query(`LISTEN ${SESSION_EVENTS_CHANNEL}`);
  await listener.query(`LISTEN ${WEBHOOKS_CHANNEL}`);
  tenantA = await tenant('a');
  tenantB = await tenant('b');
  keyA = await apiKey(tenantA, 'symb_a');
  keyB = await apiKey(tenantB, 'symb_b');
});
afterAll(async () => {
  await listener.end();
  await pool.end();
  await tdb.drop();
});

const settle = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe(`événements de session et webhooks sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('chaque événement est notifié à la validation (client, session, type, données), y compris les transitions d’état', async () => {
    const s = await session(tenantA, keyA);
    notes.length = 0;
    await transitionSession(pool, { sessionId: s, to: 'running', reason: null });
    const { id } = await appendSessionEvent(pool, { sessionId: s, type: 'egress.blocked', data: { host: 'site-b.test', reason: 'domain_not_allowed', port: 443, count: 1 } });
    await settle(() => notes.filter((n) => n.channel === SESSION_EVENTS_CHANNEL).length >= 2);
    const events = notes.filter((n) => n.channel === SESSION_EVENTS_CHANNEL).map((n) => parseSessionEventNotification(n.payload));
    expect(events.map((e) => [e.sessionId, e.tenantId, e.type])).toEqual([
      [s, tenantA, 'state'],
      [s, tenantA, 'egress.blocked'],
    ]);
    expect(events[0]).toMatchObject({ data: { state: 'running' } });
    expect(events[1]).toMatchObject({ id, data: { host: 'site-b.test', reason: 'domain_not_allowed', port: 443, count: 1 } });
    expect(events[1]?.at).toBeInstanceOf(Date);
    expect(BigInt(events[1]?.id ?? '0')).toBeGreaterThan(BigInt(events[0]?.id ?? '0'));
  });

  test('transaction annulée : aucune notification, aucun événement', async () => {
    const s = await session(tenantA, keyA);
    notes.length = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendSessionEvent(client, { sessionId: s, type: 'download', data: { id: 'f1', name: 'a.bin', state: 'started', bytes: 0 } });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(notes.filter((n) => n.channel === SESSION_EVENTS_CHANNEL)).toEqual([]);
    expect(await listSessionEvents(pool, { tenantId: tenantA, sessionId: s })).toEqual([]);
  });

  test('données trop grosses pour une notification (8 000 octets) : notification sans données, marquée `truncated`, relue en base', async () => {
    const s = await session(tenantA, keyA);
    notes.length = 0;
    const big = { detail: 'x'.repeat(9_000) };
    const { id } = await appendSessionEvent(pool, { sessionId: s, type: 'recording.truncated', data: big });
    await settle(() => notes.some((n) => n.channel === SESSION_EVENTS_CHANNEL));
    const note = parseSessionEventNotification(notes.find((n) => n.channel === SESSION_EVENTS_CHANNEL)?.payload ?? '{}');
    expect(note).toMatchObject({ id, sessionId: s, tenantId: tenantA, type: 'recording.truncated', truncated: true });
    expect(note.data).toBeUndefined();
    const [stored] = await listSessionEvents(pool, { tenantId: tenantA, sessionId: s });
    expect(stored?.data).toEqual(big);
  });

  test('lecture par client : la session d’un autre client ne rend rien ; reprise strictement après un identifiant ; limite', async () => {
    const s = await session(tenantA, keyA);
    const other = await session(tenantB, keyB);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await appendSessionEvent(pool, { sessionId: s, type: 'live.input', data: { n: i } })).id);
    await appendSessionEvent(pool, { sessionId: other, type: 'live.input', data: { n: 99 } });
    expect(await listSessionEvents(pool, { tenantId: tenantB, sessionId: s })).toEqual([]);
    const after = await listSessionEvents(pool, { tenantId: tenantA, sessionId: s, afterId: ids[1] });
    expect(after.map((e) => e.id)).toEqual(ids.slice(2));
    expect((await listSessionEvents(pool, { tenantId: tenantA, sessionId: s, limit: 2 })).map((e) => e.id)).toEqual(ids.slice(0, 2));
    // Flux du client : toutes ses sessions, jamais celles d'un autre client.
    const all = await listSessionEvents(pool, { tenantId: tenantA, afterId: ids[0] });
    expect(all.every((e) => e.tenantId === tenantA)).toBe(true);
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining(ids.slice(1)));
  });

  test('puits d’événements du nœud (SessionEventSink) : écriture ordonnée, horodatage fourni conservé', async () => {
    const s = await session(tenantA, keyA);
    const sink = createPgSessionEventSink(pool);
    const at = new Date('2026-10-02T12:00:00.123Z');
    await sink.append({ sessionId: s, type: 'egress.budget_exceeded', data: { budgetBytes: 1, bytesIn: 2, bytesOut: 0, action: 'cut' }, at });
    const [event] = await listSessionEvents(pool, { tenantId: tenantA, sessionId: s });
    expect(event).toMatchObject({ type: 'egress.budget_exceeded', at, data: { action: 'cut' } });
  });

  test('webhook : URL et secret scellé par client ; fin de session et recording.ready mis en file dans la même transaction, rien sans URL', async () => {
    await setTenantWebhook(pool, { tenantId: tenantA, url: 'https://hooks.example.com/symb', secretEncrypted: '{"v":1,"scellé":true}' });
    expect(await getTenantWebhook(pool, tenantA)).toEqual({ url: 'https://hooks.example.com/symb', secretEncrypted: '{"v":1,"scellé":true}' });
    expect(await getTenantWebhook(pool, tenantB)).toEqual({ url: null, secretEncrypted: null });
    const s = await session(tenantA, keyA);
    const quiet = await session(tenantB, keyB);
    notes.length = 0;
    await transitionSession(pool, { sessionId: s, to: 'running', reason: null });
    await appendSessionEvent(pool, { sessionId: s, type: 'recording.ready', data: { recordingId: 'r1', type: 'har', size: 10, expiresAt: '2026-10-09T00:00:00Z' } });
    await transitionSession(pool, { sessionId: s, to: 'ended', reason: 'released' });
    await transitionSession(pool, { sessionId: quiet, to: 'running', reason: null });
    await transitionSession(pool, { sessionId: quiet, to: 'ended', reason: 'released' });
    const deliveries = await listWebhookDeliveries(pool, { tenantId: tenantA, sessionId: s });
    expect(deliveries.map((d) => [d.type, d.url, d.status, d.attempts])).toEqual([
      ['recording.ready', 'https://hooks.example.com/symb', 'pending', 0],
      ['session.ended', 'https://hooks.example.com/symb', 'pending', 0],
    ]);
    expect(deliveries.every((d) => /^msg_[0-9a-f]{32}$/.test(d.id))).toBe(true);
    expect(await listWebhookDeliveries(pool, { tenantId: tenantB, sessionId: quiet })).toEqual([]);
    await settle(() => notes.some((n) => n.channel === WEBHOOKS_CHANNEL));
    expect(notes.some((n) => n.channel === WEBHOOKS_CHANNEL)).toBe(true);
  });

  test('livraisons : réservées une seule fois sous concurrence (SKIP LOCKED), relance planifiée, état final', async () => {
    await setTenantWebhook(pool, { tenantId: tenantA, url: 'https://hooks.example.com/claim', secretEncrypted: 'x' });
    const s = await session(tenantA, keyA);
    await transitionSession(pool, { sessionId: s, to: 'running', reason: null });
    await transitionSession(pool, { sessionId: s, to: 'failed', reason: 'crash' });
    const [first, second] = await Promise.all([claimWebhookDeliveries(pool, { limit: 50, lockMs: 30_000 }), claimWebhookDeliveries(pool, { limit: 50, lockMs: 30_000 })]);
    const claimed = [...(first ?? []), ...(second ?? [])].filter((d) => d.sessionId === s);
    expect(claimed).toHaveLength(1);
    const delivery = claimed[0];
    if (delivery === undefined) throw new Error('livraison absente');
    expect(delivery).toMatchObject({ type: 'session.ended', tenantId: tenantA, attempts: 1, event: { type: 'state', data: { state: 'failed', endReason: 'crash' } } });
    // Réservée : invisible aux autres jusqu'à la fin du bail.
    expect((await claimWebhookDeliveries(pool, { limit: 50, lockMs: 30_000 })).filter((d) => d.sessionId === s)).toEqual([]);
    await completeWebhookDelivery(pool, { id: delivery.id, outcome: { kind: 'retry', at: new Date(Date.now() - 1), httpStatus: 500, error: 'http_500' } });
    const again = (await claimWebhookDeliveries(pool, { limit: 50, lockMs: 30_000 })).filter((d) => d.sessionId === s);
    expect(again.map((d) => d.attempts)).toEqual([2]);
    await completeWebhookDelivery(pool, { id: delivery.id, outcome: { kind: 'delivered', httpStatus: 204 } });
    const [done] = await listWebhookDeliveries(pool, { tenantId: tenantA, sessionId: s });
    expect(done).toMatchObject({ status: 'delivered', attempts: 2, lastStatus: 204, lastError: null });
    expect(done?.deliveredAt).toBeInstanceOf(Date);
    await completeWebhookDelivery(pool, { id: delivery.id, outcome: { kind: 'failed', httpStatus: null, error: 'timeout' } });
    expect((await listWebhookDeliveries(pool, { tenantId: tenantA, sessionId: s }))[0]).toMatchObject({ status: 'delivered' });
  });

  test('URL de webhook : http ou https seulement, effacée avec son secret', async () => {
    await expect(pool.query("UPDATE tenants SET webhook_url = 'ftp://x' WHERE id = $1", [tenantB])).rejects.toMatchObject({ code: '23514' });
    await setTenantWebhook(pool, { tenantId: tenantB, url: 'https://b.example.com/h', secretEncrypted: 's' });
    await setTenantWebhook(pool, { tenantId: tenantB, url: null, secretEncrypted: null });
    expect(await getTenantWebhook(pool, tenantB)).toEqual({ url: null, secretEncrypted: null });
  });
});
