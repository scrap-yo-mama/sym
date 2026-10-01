// SPDX-License-Identifier: AGPL-3.0-only
// Webhooks sortants Standard Webhooks sur base réelle (tâche 2.5, 08 § 5, 08 § 7) : secret chiffré et rendu une fois,
// URL refusée par la garde SSRF, signature vérifiée par la bibliothèque de référence, `webhook-id` stable, barème de
// relance, journal, rotation, désactivation après 5 jours, `retryable: false` vers `bloquee`, isolation par propriétaire.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateMasterKey, MasterKey, secretValues, verifyWebhook, type Keyring, type RunResult } from '@runtime/core';
import { createSsrfPolicy, SsrfBlockedError, SsrfGuard, type Resolver } from '@runtime/core/net';
import pg from 'pg';
import { TestClock } from 'pg-boss';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { appendRunItems } from './datasets.js';
import { migrateUp } from './migrate.js';
import { applyStatusAndNotify, finishRunAndNotify, notifyRunFinished, notifyStatusChange, toStatusTransitions } from './notify.js';
import { PgBossJobQueue } from './queue.js';
import { runQueueDefinition } from './runs.js';
import { withActor } from './rls.js';
import { keyCheck, secretStore } from './secrets.js';
import { applyStatusTransition } from './status.js';
import {
  createWebhookSubscription,
  deliverWebhookAttempt,
  emitWebhookEvent,
  enableWebhookSubscription,
  listDeliveries,
  purgeExpiredWebhookSecrets,
  redeliverWebhook,
  rotateWebhookSecret,
  testWebhookSubscription,
  WEBHOOK_DELIVERY_QUEUE,
  webhookDeliveryQueueDefinition,
  type DeliveryContext,
  type WebhookDeliveryJob,
} from './webhooks.js';

type Received = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
type Behavior = (req: Received, index: number) => { status: number; body?: string; headers?: Record<string, string> };

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let store: ReturnType<typeof secretStore>;
let receiver: Server;
let port: number;
let guard: SsrfGuard;
let received: Received[] = [];
let behavior: Behavior = () => ({ status: 200, body: 'ok' });
const A = randomUUID();
const B = randomUUID();
let apiId: string;
// Heure réelle (à la seconde) : la bibliothèque de référence juge l'horodatage sur l'horloge réelle (tolérance de 5 minutes).
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const permissive = (p: number, resolver?: Resolver) => new SsrfGuard({ policy: createSsrfPolicy({ allowedPrivateHosts: ['127.0.0.0/8'], allowedPorts: [p] }), ...(resolver ? { resolver } : {}) });

beforeAll(async () => {
  tdb = await createTestDatabase('webhooks');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  for (const [id, email] of [[A, 'zz_test_a@example.test'], [B, 'zz_test_b@example.test']] as const) {
    await pool.query("INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')", [id, email]);
  }
  apiId = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, status) VALUES ('zz_test_hooked', $1, 'sain') RETURNING id", [A])).rows[0]!.id;
  const keyring: Keyring = { current: MasterKey.parse(generateMasterKey()) };
  store = secretStore(pool, keyring, await keyCheck(pool, keyring));
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 3, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  await queue.createQueue(webhookDeliveryQueueDefinition());
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      received.push(entry);
      const answer = behavior(entry, received.length - 1);
      res.writeHead(answer.status, { 'content-type': 'text/plain', ...answer.headers }).end(answer.body ?? '');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  port = (receiver.address() as AddressInfo).port;
  guard = permissive(port);
});

beforeEach(async () => {
  await pool.query('DELETE FROM webhook_deliveries');
  await pool.query('DELETE FROM webhook_subscriptions');
});

afterEach(() => {
  received = [];
  behavior = () => ({ status: 200, body: 'ok' });
});

afterAll(async () => {
  secretValues.clear();
  receiver?.closeAllConnections();
  await new Promise<void>((resolve) => (receiver ? receiver.close(() => resolve()) : resolve()));
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

const url = (path = '/hook') => `http://127.0.0.1:${port}${path}`;
const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({ pool, queue, store, guard, ...over });
const subscribe = (events: string[], owner = A, path = '/hook') => createWebhookSubscription(pool, store, guard, { ownerId: owner, url: url(path), events });
const secretsIn = async (id: string): Promise<{ current: string; previous: string | null; previousExpires: Date | null }> => {
  const { rows } = await pool.query<{ secret_id: string; previous_secret_id: string | null; previous_secret_expires_at: Date | null }>(
    'SELECT secret_id, previous_secret_id, previous_secret_expires_at FROM webhook_subscriptions WHERE id = $1',
    [id],
  );
  const row = rows[0]!;
  return {
    current: (await store.get(row.secret_id)).reveal(),
    previous: row.previous_secret_id ? (await store.get(row.previous_secret_id)).reveal() : null,
    previousExpires: row.previous_secret_expires_at,
  };
};
const deliveriesOf = async (subscriptionId: string) =>
  (await pool.query<{ dispatch_id: string; attempt: number; status: string; http_status: number | null; error_code: string | null; next_attempt_at: Date | null; event_id: string; duration_ms: number | null; response_excerpt: string | null }>(
    'SELECT dispatch_id, attempt, status, http_status, error_code, next_attempt_at, event_id, duration_ms, response_excerpt FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY id',
    [subscriptionId],
  )).rows;
/**
 * La bibliothèque de référence signe le même contenu : sa signature pour (id, horodatage de la requête, corps) figure dans
 * l'en-tête reçu. Valable à n'importe quel instant (`verify` de la bibliothèque juge l'heure sur l'horloge réelle).
 */
const referenceSigns = (secret: string, r: Received): boolean => {
  const timestamp = new Date(Number(r.headers['webhook-timestamp']) * 1000);
  return String(r.headers['webhook-signature']).split(' ').includes(new Webhook(secret).sign(String(r.headers['webhook-id']), timestamp, r.body));
};
const headersOf = (r: Received) => ({ 'webhook-id': String(r.headers['webhook-id']), 'webhook-timestamp': String(r.headers['webhook-timestamp']), 'webhook-signature': String(r.headers['webhook-signature']) });

async function emitRunSucceeded(owner = A) {
  return emitWebhookEvent(pool, queue, {
    event: 'run.succeeded',
    payload: { type: 'run.succeeded', timestamp: NOW.toISOString(), data: { api: 'zz_test_hooked', api_id: apiId, run_id: randomUUID(), status: 'sain', outcome: 'clean', items: 48, new_items: 5 } },
    ownerIds: [owner],
    now: NOW,
  });
}

async function newRun(over: { state?: string; scheduleId?: string | null; owner?: string; items?: number; failureClass?: string } = {}): Promise<{ runId: string; jobId: string }> {
  const jobId = randomUUID();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, job_id, schedule_id, items, started_at, failure_class, retryable)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10) RETURNING id`,
    [apiId, over.owner ?? A, A, over.scheduleId ? 'schedule' : 'rest', over.state ?? 'running', jobId, over.scheduleId ?? null, over.items ?? 0, over.failureClass ?? null, over.failureClass ? true : null],
  );
  return { runId: rows[0]!.id, jobId };
}

describe('cibles et secrets', () => {
  test('secret `whsec_` rendu une fois ; chiffré au repos, jamais en clair ailleurs (INV8)', async () => {
    const created = await subscribe(['run.succeeded', 'items.new']);
    expect(created.secret).toMatch(/^whsec_/);
    const stored = await secretsIn(created.id);
    expect(stored.current).toBe(created.secret);
    const hits = await pool.query<{ t: string }>(
      `SELECT 'webhook_subscriptions' AS t FROM webhook_subscriptions WHERE strpos(to_jsonb(webhook_subscriptions)::text, $1) > 0
       UNION ALL SELECT 'secrets' FROM secrets WHERE strpos(to_jsonb(secrets)::text, $1) > 0 OR position(convert_to($1, 'UTF8') in ciphertext) > 0
       UNION ALL SELECT 'webhook_deliveries' FROM webhook_deliveries WHERE strpos(to_jsonb(webhook_deliveries)::text, $1) > 0`,
      [created.secret],
    );
    expect(hits.rows).toEqual([]);
    const row = (await pool.query<{ kind: string; owner_id: string }>('SELECT s.kind, s.owner_id FROM secrets s JOIN webhook_subscriptions w ON w.secret_id = s.id WHERE w.id = $1', [created.id])).rows[0];
    expect(row).toEqual({ kind: 'webhook_secret', owner_id: A });
  });

  test('événements : liste non vide dans le vocabulaire fermé', async () => {
    await expect(subscribe([])).rejects.toThrow('events');
    await expect(subscribe(['run.started'])).rejects.toThrow('events');
  });

  test('assert_webhook_ssrf_blocked (enregistrement) : métadonnées cloud, boucle locale, réseau privé, schéma : refus, rien d\'écrit', async () => {
    const strict = new SsrfGuard();
    const before = {
      subs: (await pool.query('SELECT count(*)::int AS n FROM webhook_subscriptions')).rows[0].n as number,
      secrets: (await pool.query('SELECT count(*)::int AS n FROM secrets')).rows[0].n as number,
    };
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/hook', 'http://10.0.0.5/hook', 'http://[::1]/hook', 'http://localhost/hook', 'http://192.168.1.1/hook', 'file:///etc/passwd', 'http://user:pass@example.com/hook']) {
      const error = await createWebhookSubscription(pool, store, strict, { ownerId: A, url: target, events: ['run.succeeded'] }).catch((e: unknown) => e);
      expect(error, target).toBeInstanceOf(SsrfBlockedError);
      expect((error as SsrfBlockedError).message).toBe('ssrf_blocked');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM webhook_subscriptions')).rows[0].n).toBe(before.subs);
    expect((await pool.query('SELECT count(*)::int AS n FROM secrets')).rows[0].n).toBe(before.secrets);
  });
});

describe('livraison', () => {
  test('assert_webhook_signature : la signature v1 se vérifie avec la bibliothèque de référence, `webhook-id` = evt_<événement>', async () => {
    const sub = await subscribe(['run.succeeded']);
    const { eventId, deliveries } = await emitRunSucceeded();
    expect(deliveries).toHaveLength(1);
    const result = await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 });
    expect(result).toEqual({ outcome: 'delivered', httpStatus: 200 });

    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['webhook-id']).toBe(`evt_${eventId}`);
    expect(req.headers['dispatch-id']).toBe(deliveries[0]);
    expect(req.headers['webhook-timestamp']).toBe(String(NOW.getTime() / 1000));
    expect(req.headers['authorization']).toBeUndefined();
    // Bibliothèque de référence, puis notre vérificateur.
    const payload = new Webhook(sub.secret).verify(req.body, headersOf(req)) as { type: string; data: Record<string, unknown> };
    expect(payload.type).toBe('run.succeeded');
    expect(() => verifyWebhook({ headers: headersOf(req), body: req.body, secrets: [sub.secret], now: NOW })).not.toThrow();
    // Charge mince (INV5) : compteurs et identifiants, jamais d'item.
    expect(Object.keys(payload.data).sort()).toEqual(['api', 'api_id', 'items', 'new_items', 'outcome', 'run_id', 'status']);
    expect(JSON.parse(req.body)).toEqual(payload);

    const [row] = await deliveriesOf(sub.id);
    expect(row).toMatchObject({ attempt: 1, status: 'succeeded', http_status: 200, error_code: null, response_excerpt: 'ok' });
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
    expect((await pool.query('SELECT failing_since, last_success_at FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0].last_success_at).toEqual(NOW);
  });

  test('assert_webhook_retry : 500, 500 puis 200 ; barème, `webhook-id` et `Dispatch-Id` stables, journal complet', async () => {
    const sub = await subscribe(['run.succeeded']);
    behavior = (_req, i) => (i < 2 ? { status: 500, body: 'boom' } : { status: 200, body: 'ok' });
    const { eventId, deliveries } = await emitRunSucceeded();
    const dispatch = deliveries[0]!;

    expect(await deliverWebhookAttempt(ctx({ now: () => at(0) }), { dispatch_id: dispatch, attempt: 1 })).toEqual({ outcome: 'retry', errorCode: 'http_500', delaySeconds: 5 });
    expect(await deliverWebhookAttempt(ctx({ now: () => at(5) }), { dispatch_id: dispatch, attempt: 2 })).toEqual({ outcome: 'retry', errorCode: 'http_500', delaySeconds: 300 });
    expect(await deliverWebhookAttempt(ctx({ now: () => at(305) }), { dispatch_id: dispatch, attempt: 3 })).toEqual({ outcome: 'delivered', httpStatus: 200 });
    // Un job déjà traité ne repart pas (reprise de pg-boss) : une seule exécution côté récepteur par tentative.
    expect(await deliverWebhookAttempt(ctx({ now: () => at(306) }), { dispatch_id: dispatch, attempt: 3 })).toEqual({ outcome: 'skipped', reason: 'already_done' });

    expect(received).toHaveLength(3);
    for (const r of received) {
      expect(r.headers['webhook-id']).toBe(`evt_${eventId}`);
      expect(r.headers['dispatch-id']).toBe(dispatch);
      expect(referenceSigns(sub.secret, r)).toBe(true);
    }
    expect(new Set(received.map((r) => r.headers['webhook-timestamp'])).size).toBe(3);
    expect(new Set(received.map((r) => r.headers['webhook-signature'])).size).toBe(3);

    const rows = await deliveriesOf(sub.id);
    expect(rows.map((r) => [r.attempt, r.status, r.http_status, r.error_code])).toEqual([
      [1, 'failed', 500, 'http_500'],
      [2, 'failed', 500, 'http_500'],
      [3, 'succeeded', 200, null],
    ]);
    expect(rows[0]!.response_excerpt).toBe('boom');
    expect(rows[1]!.next_attempt_at).toEqual(at(5));
    expect(rows[2]!.next_attempt_at).toEqual(at(305));
    // Livré : la série d'échecs est close.
    expect((await pool.query('SELECT failing_since FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0].failing_since).toBeNull();
  });

  test('barème épuisé : cinq tentatives (0, 5 s, 5 min, 30 min, 2 h), puis abandon, aucune sixième', async () => {
    const sub = await subscribe(['run.succeeded']);
    behavior = () => ({ status: 503 });
    const { deliveries } = await emitRunSucceeded();
    const offsets = [0, 5, 305, 2105, 9305];
    const results = [];
    for (const [i, offset] of offsets.entries()) {
      results.push(await deliverWebhookAttempt(ctx({ now: () => at(offset) }), { dispatch_id: deliveries[0]!, attempt: i + 1 }));
    }
    expect(results.map((r) => r.outcome)).toEqual(['retry', 'retry', 'retry', 'retry', 'failed']);
    expect(results.slice(0, 4).map((r) => (r as { delaySeconds: number }).delaySeconds)).toEqual([5, 300, 1800, 7200]);
    const rows = await deliveriesOf(sub.id);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
    expect(received).toHaveLength(5);
  });

  test('pg-boss rejoue au barème (horloge simulée) : 500, 500 puis 200 aux instants +5 s et +305 s', async () => {
    const sub = await subscribe(['run.succeeded']);
    behavior = (_req, i) => (i < 2 ? { status: 500 } : { status: 200 });
    // Départ à l'heure réelle : les écritures faites dans NOTRE transaction (`tx`) lisent l'horloge de Postgres, pas la simulée
    // (l'override de pg-boss est un réglage de session de SES connexions) ; les deux doivent rester du même ordre de grandeur.
    const clock = new TestClock(Date.now());
    const q = new PgBossJobQueue({ connectionString: tdb.url, max: 3, clock, supervise: false, application_name: 'zz_test_webhook_clock' });
    try {
      await q.start();
      await q.createQueue(webhookDeliveryQueueDefinition());
      const context = ctx({ queue: q, now: () => new Date(clock.now()) });
      await q.work<WebhookDeliveryJob>(WEBHOOK_DELIVERY_QUEUE, { concurrency: 2, pollingIntervalSeconds: 0.5 }, async (job) => {
        await deliverWebhookAttempt(context, job.data);
      });
      const { deliveries } = await emitWebhookEvent(pool, q, {
        event: 'run.succeeded',
        payload: { type: 'run.succeeded', timestamp: NOW.toISOString(), data: { api: 'zz_test_hooked', api_id: apiId, run_id: randomUUID(), status: 'sain', outcome: 'clean', items: 1 } },
        ownerIds: [A],
        now: new Date(clock.now()),
      });
      const step = async (ms: number) => {
        for (let t = 0; t < ms; t += 1000) {
          await clock.tick(1000);
          await new Promise((r) => setTimeout(r, 20));
        }
        await new Promise((r) => setTimeout(r, 200));
      };
      await step(3000);
      expect(received).toHaveLength(1); // tentative immédiate seule
      await step(4000); // t = 7 s : la deuxième (échec) est partie à +5 s
      expect(received).toHaveLength(2);
      await step(290_000); // t = 297 s : la troisième n'est due qu'à +305 s
      expect(received).toHaveLength(2);
      await step(20_000); // t = 317 s
      expect(received).toHaveLength(3);
      expect((await deliveriesOf(sub.id)).map((r) => r.status)).toEqual(['failed', 'failed', 'succeeded']);
      expect(deliveries).toHaveLength(1);
    } finally {
      await q.stop({ timeoutMs: 1000 }).catch(() => undefined);
    }
  }, 120_000);

  test('cible désactivée après 5 jours d\'échecs continus ; plus aucune livraison jusqu\'à sa réactivation', async () => {
    const sub = await subscribe(['run.succeeded']);
    behavior = () => ({ status: 500 });
    // Série continue : en échec depuis plus de 5 jours, dernier échec il y a 2 h.
    await pool.query("UPDATE webhook_subscriptions SET failing_since = $2, last_failure_at = $3 WHERE id = $1", [sub.id, new Date(NOW.getTime() - 5 * 86_400_000 - 1000), at(-7200)]);
    const { deliveries } = await emitRunSucceeded();
    const result = await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 });
    expect(result.outcome).toBe('failed');
    const row = (await pool.query('SELECT status, disabled_at FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0];
    expect(row.status).toBe('disabled');
    expect(row.disabled_at).toEqual(NOW);
    expect((await deliveriesOf(sub.id)).map((r) => r.attempt)).toEqual([1]); // pas de relance
    expect((await emitRunSucceeded()).deliveries).toHaveLength(0);
    await enableWebhookSubscription(pool, { subscriptionId: sub.id, ownerId: A });
    expect((await emitRunSucceeded()).deliveries).toHaveLength(1);
  });

  test('moins de 5 jours : la cible reste active, la série d\'échecs est mémorisée', async () => {
    const sub = await subscribe(['run.succeeded']);
    behavior = () => ({ status: 500 });
    await pool.query("UPDATE webhook_subscriptions SET failing_since = $2, last_failure_at = $3 WHERE id = $1", [sub.id, new Date(NOW.getTime() - 4 * 86_400_000), at(-7200)]);
    const { deliveries } = await emitRunSucceeded();
    await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 });
    const row = (await pool.query('SELECT status, failing_since FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0];
    expect(row.status).toBe('active');
    expect(row.failing_since).toEqual(new Date(NOW.getTime() - 4 * 86_400_000));
  });

  test('un échec isolé il y a 6 jours puis un nouvel échec : nouvelle série, la cible reste active (pas « 5 jours d\'échecs continus »)', async () => {
    const sub = await subscribe(['run.succeeded']);
    behavior = () => ({ status: 500 });
    // Un événement en échec il y a 6 jours, barème épuisé 2 h 35 plus tard ; rien depuis.
    await pool.query('UPDATE webhook_subscriptions SET failing_since = $2, last_failure_at = $3 WHERE id = $1', [sub.id, at(-6 * 86_400), at(-6 * 86_400 + 9_305)]);
    const { deliveries } = await emitRunSucceeded();
    expect((await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 })).outcome).toBe('retry');
    const row = (await pool.query('SELECT status, failing_since, last_failure_at FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0];
    expect(row).toEqual({ status: 'active', failing_since: NOW, last_failure_at: NOW });
  });

  test('livraison interrompue (worker arrêté entre l\'envoi et l\'écriture du journal) : pg-boss rejoue une fois, la ligne ne reste pas `pending`', async () => {
    expect(webhookDeliveryQueueDefinition().retryLimit).toBe(1);
    const q = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
    await q.start();
    await q.createQueue(webhookDeliveryQueueDefinition());
    try {
      const sub = await subscribe(['run.succeeded']);
      const { deliveries } = await emitWebhookEvent(pool, q, {
        event: 'run.succeeded',
        payload: { type: 'run.succeeded', timestamp: NOW.toISOString(), data: { api_id: apiId, run_id: randomUUID(), items: 1 } },
        ownerIds: [A],
        now: NOW,
      });
      let calls = 0;
      await q.work<WebhookDeliveryJob>(WEBHOOK_DELIVERY_QUEUE, { concurrency: 1, pollingIntervalSeconds: 0.5 }, async (job) => {
        // Les jobs laissés par les autres tests passent aussi par ce worker : on ne compte que celui de ce test.
        if (job.data.dispatch_id !== deliveries[0]) return;
        calls += 1;
        if (calls === 1) throw new Error('zz_test : arrêt du worker avant la mise à jour du journal');
        await deliverWebhookAttempt(ctx({ queue: q }), job.data);
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (await deliveriesOf(sub.id))[0]?.status === 'pending') await new Promise((r) => setTimeout(r, 200));
      expect(calls).toBe(2);
      expect((await deliveriesOf(sub.id)).map((r) => [r.dispatch_id, r.status])).toEqual([[deliveries[0], 'succeeded']]);
    } finally {
      await q.stop({ timeoutMs: 1000 }).catch(() => undefined);
    }
  }, 30_000);

  test('assert_webhook_ssrf_blocked (livraison) : rebinding après l\'enregistrement → ssrf_blocked, jamais rejoué, 0 requête reçue', async () => {
    let phase: 'validate' | 'connect' = 'validate';
    const resolver: Resolver = async () => (phase === 'validate' ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const rebinding = new SsrfGuard({ policy: createSsrfPolicy({ allowedPorts: [port] }), resolver });
    const created = await createWebhookSubscription(pool, store, rebinding, { ownerId: A, url: `http://rebind.zz-test:${port}/hook`, events: ['run.succeeded'] });
    phase = 'connect';
    const { deliveries } = await emitRunSucceeded();
    const seen: string[] = [];
    const result = await deliverWebhookAttempt(ctx({ guard: rebinding, now: () => NOW, onSsrfBlocked: (d) => seen.push(d.reason) }), { dispatch_id: deliveries[0]!, attempt: 1 });
    expect(result).toEqual({ outcome: 'failed', errorCode: 'ssrf_blocked' });
    expect(seen).toEqual(['loopback']);
    expect(received).toHaveLength(0);
    const rows = await deliveriesOf(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', http_status: null, error_code: 'ssrf_blocked' });
  });

  test('une redirection n\'est jamais suivie ni rejouée : échec `redirect_not_followed`', async () => {
    const sub = await subscribe(['run.succeeded'], A, '/moved');
    behavior = (req) => (req.url === '/moved' ? { status: 307, headers: { location: '/elsewhere' } } : { status: 200 });
    const { deliveries } = await emitRunSucceeded();
    const result = await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 });
    expect(result).toEqual({ outcome: 'failed', errorCode: 'redirect_not_followed' });
    expect(received.map((r) => r.url)).toEqual(['/moved']);
    expect(await deliveriesOf(sub.id)).toHaveLength(1);
  });

  test('délai de 15 s : un récepteur muet est abandonné (timeout) puis rejoué au barème', async () => {
    // Récepteur muet : un serveur à part qui ne répond jamais.
    const mute = createServer(() => undefined);
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve));
    const mutePort = (mute.address() as AddressInfo).port;
    try {
      const g = permissive(mutePort);
      const slow = await createWebhookSubscription(pool, store, g, { ownerId: A, url: `http://127.0.0.1:${mutePort}/hook`, events: ['items.new'] });
      const { deliveries } = await emitWebhookEvent(pool, queue, {
        event: 'items.new',
        payload: { type: 'items.new', timestamp: NOW.toISOString(), data: { api: 'x', api_id: apiId, run_id: randomUUID(), new_items: 1, items: 1 } },
        ownerIds: [A],
        now: NOW,
      });
      const started = Date.now();
      const result = await deliverWebhookAttempt(ctx({ guard: g, now: () => NOW, timeoutMs: 300 }), { dispatch_id: deliveries[0]!, attempt: 1 });
      expect(result).toEqual({ outcome: 'retry', errorCode: 'timeout', delaySeconds: 5 });
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await deliveriesOf(slow.id))[0]).toMatchObject({ status: 'failed', error_code: 'timeout', http_status: null });
    } finally {
      mute.closeAllConnections();
      await new Promise<void>((resolve) => mute.close(() => resolve()));
    }
  });

  test('« renvoyer » : une tentative de plus, même webhook-id, signature et horodatage frais', async () => {
    const sub = await subscribe(['run.succeeded']);
    const { eventId, deliveries } = await emitRunSucceeded();
    await deliverWebhookAttempt(ctx({ now: () => at(0) }), { dispatch_id: deliveries[0]!, attempt: 1 });
    const attempt = await redeliverWebhook(pool, queue, { dispatchId: deliveries[0]!, ownerId: A }, at(60));
    expect(attempt).toBe(2);
    await deliverWebhookAttempt(ctx({ now: () => at(60) }), { dispatch_id: deliveries[0]!, attempt });
    expect(received.map((r) => r.headers['webhook-id'])).toEqual([`evt_${eventId}`, `evt_${eventId}`]);
    expect(received[1]!.headers['webhook-timestamp']).toBe(String(at(60).getTime() / 1000));
    expect(referenceSigns(sub.secret, received[1]!)).toBe(true);
    expect((await listDeliveries(pool, { subscriptionId: sub.id, ownerId: A })).map((r) => r.attempt)).toEqual([2, 1]);
  });

  test('« Tester » : charge signée `webhook.test`, journalisée, `tested_at` renseigné ; en échec, pas de `tested_at`', async () => {
    const sub = await subscribe(['run.succeeded']);
    expect((await pool.query('SELECT tested_at FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0].tested_at).toBeNull();
    expect(await testWebhookSubscription(ctx(), { subscriptionId: sub.id, ownerId: A })).toEqual({ httpStatus: 200, errorCode: null });
    expect(JSON.parse(received[0]!.body).type).toBe('webhook.test');
    expect(() => new Webhook(sub.secret).verify(received[0]!.body, headersOf(received[0]!))).not.toThrow();
    expect((await pool.query('SELECT tested_at FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0].tested_at).not.toBeNull();

    const failing = await subscribe(['run.succeeded']);
    behavior = () => ({ status: 410 });
    expect(await testWebhookSubscription(ctx(), { subscriptionId: failing.id, ownerId: A })).toEqual({ httpStatus: 410, errorCode: 'http_410' });
    expect((await pool.query('SELECT tested_at FROM webhook_subscriptions WHERE id = $1', [failing.id])).rows[0].tested_at).toBeNull();
  });

  test('secret supprimé ou illisible : échec `secret_missing`, aucune requête, aucune relance', async () => {
    const sub = await subscribe(['run.succeeded']);
    await pool.query('UPDATE webhook_subscriptions SET secret_id = NULL WHERE id = $1', [sub.id]);
    const { deliveries } = await emitRunSucceeded();
    expect(await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 })).toEqual({ outcome: 'failed', errorCode: 'secret_missing' });
    expect(received).toHaveLength(0);
    expect(await deliveriesOf(sub.id)).toHaveLength(1);
  });
});

describe('rotation, filtrage, isolation', () => {
  test('rotation : deux secrets valides en parallèle pendant la grâce, puis un seul', async () => {
    const sub = await subscribe(['run.succeeded']);
    const rotated = await rotateWebhookSecret(pool, store, { subscriptionId: sub.id, ownerId: A, graceHours: 24, now: NOW });
    expect(rotated.secret).not.toBe(sub.secret);
    const stored = await secretsIn(sub.id);
    expect(stored.current).toBe(rotated.secret);
    expect(stored.previous).toBe(sub.secret);
    expect(stored.previousExpires).toEqual(at(24 * 3600));

    const first = await emitRunSucceeded();
    await deliverWebhookAttempt(ctx({ now: () => at(3600) }), { dispatch_id: first.deliveries[0]!, attempt: 1 });
    const both = received[0]!;
    expect(String(both.headers['webhook-signature']).split(' ')).toHaveLength(2);
    // Un récepteur qui n'a pas encore basculé (ancien secret) comme un récepteur à jour (nouveau) vérifient.
    expect(referenceSigns(sub.secret, both)).toBe(true);
    expect(referenceSigns(rotated.secret, both)).toBe(true);

    const later = await emitRunSucceeded();
    await deliverWebhookAttempt(ctx({ now: () => at(25 * 3600) }), { dispatch_id: later.deliveries[0]!, attempt: 1 });
    const only = received[1]!;
    expect(String(only.headers['webhook-signature']).split(' ')).toHaveLength(1);
    expect(referenceSigns(rotated.secret, only)).toBe(true);
    expect(referenceSigns(sub.secret, only)).toBe(false);
  });

  test('l\'événement n\'atteint que les cibles abonnées', async () => {
    const onlyFailed = await subscribe(['run.failed']);
    const succeeded = await subscribe(['run.succeeded', 'items.new']);
    const { deliveries } = await emitRunSucceeded();
    expect(deliveries).toHaveLength(1);
    expect(await deliveriesOf(onlyFailed.id)).toHaveLength(0);
    expect(await deliveriesOf(succeeded.id)).toHaveLength(1);
  });

  test('INV12 : les cibles d\'un autre utilisateur ne reçoivent pas les événements des runs d\'un propriétaire', async () => {
    const mine = await subscribe(['run.succeeded'], A);
    const theirs = await subscribe(['run.succeeded'], B);
    await emitRunSucceeded(A);
    expect(await deliveriesOf(mine.id)).toHaveLength(1);
    expect(await deliveriesOf(theirs.id)).toHaveLength(0);
  });

  test('assert_webhook_owner_bound : un membre ne peut lier ni la cible ni le secret d\'un autre (clés étrangères liées au propriétaire)', async () => {
    const theirs = await subscribe(['run.succeeded'], A);
    const mine = await subscribe(['run.succeeded'], B);
    const theirSecret = (await pool.query<{ secret_id: string }>('SELECT secret_id FROM webhook_subscriptions WHERE id = $1', [theirs.id])).rows[0]!.secret_id;
    const asB = <T,>(fn: (tx: pg.PoolClient) => Promise<T>) => withActor(pool, { userId: B, role: 'member' }, fn);
    // Livraison forgée vers la cible d'un autre (contrôle de clé étrangère hors RLS) : refusée par la base.
    await expect(
      asB((tx) =>
        tx.query("INSERT INTO webhook_deliveries (subscription_id, owner_id, event, dispatch_id, attempt, status, event_id, payload) VALUES ($1, $2, 'run.succeeded', $3, 1, 'pending', $4, '{}')", [
          theirs.id,
          B,
          randomUUID(),
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/foreign key/);
    // Secret d'un autre (UUID connu) posé sur sa propre cible, courant ou précédent : refusé.
    await expect(asB((tx) => tx.query('UPDATE webhook_subscriptions SET secret_id = $2 WHERE id = $1', [mine.id, theirSecret]))).rejects.toThrow(/foreign key/);
    await expect(asB((tx) => tx.query('UPDATE webhook_subscriptions SET previous_secret_id = $2 WHERE id = $1', [mine.id, theirSecret]))).rejects.toThrow(/foreign key/);
    // Livraison réorientée vers la cible d'un autre : refusée.
    const { deliveries } = await emitRunSucceeded(B);
    await expect(asB((tx) => tx.query('UPDATE webhook_deliveries SET subscription_id = $2 WHERE dispatch_id = $1', [deliveries[0], theirs.id]))).rejects.toThrow(/foreign key/);
    expect(received).toHaveLength(0);
  });

  test('livraison : un secret d\'une autre nature (pas `webhook_secret`) ne signe jamais, 0 requête', async () => {
    const sub = await subscribe(['run.succeeded']);
    const other = await store.put({ ownerId: A, kind: 'proxy_password', label: 'zz_test proxy', value: 'zz_test_pas_un_secret_webhook' });
    await pool.query('UPDATE webhook_subscriptions SET secret_id = $2 WHERE id = $1', [sub.id, other]);
    const { deliveries } = await emitRunSucceeded();
    expect(await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: deliveries[0]!, attempt: 1 })).toEqual({ outcome: 'failed', errorCode: 'secret_missing' });
    await expect(testWebhookSubscription(ctx(), { subscriptionId: sub.id, ownerId: A })).rejects.toThrow('secret');
    expect(received).toHaveLength(0);
  });

  test('IDOR : tester, faire tourner, réactiver, lire le journal ou renvoyer exigent le propriétaire de la cible', async () => {
    const sub = await subscribe(['run.succeeded'], A);
    const { deliveries } = await emitRunSucceeded(A);
    await expect(testWebhookSubscription(ctx(), { subscriptionId: sub.id, ownerId: B })).rejects.toThrow('introuvable');
    await expect(rotateWebhookSecret(pool, store, { subscriptionId: sub.id, ownerId: B })).rejects.toThrow('introuvable');
    await expect(enableWebhookSubscription(pool, { subscriptionId: sub.id, ownerId: B })).rejects.toThrow('introuvable');
    expect(await listDeliveries(pool, { subscriptionId: sub.id, ownerId: B })).toEqual([]);
    await expect(redeliverWebhook(pool, queue, { dispatchId: deliveries[0]!, ownerId: B })).rejects.toThrow('introuvable');
    expect(received).toHaveLength(0);
    expect(await deliveriesOf(sub.id)).toHaveLength(1);
    expect((await secretsIn(sub.id)).current).toBe(sub.secret);
  });

  test('rotation : l\'ancien « ancien » secret est supprimé au remplacement ; la grâce passée, la maintenance retire le précédent', async () => {
    const sub = await subscribe(['run.succeeded']);
    const idsOf = async () => (await pool.query<{ secret_id: string; previous_secret_id: string | null }>('SELECT secret_id, previous_secret_id FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0]!;
    const exists = async (id: string) => ((await pool.query('SELECT 1 FROM secrets WHERE id = $1', [id])).rowCount ?? 0) > 0;
    const original = (await idsOf()).secret_id;
    await rotateWebhookSecret(pool, store, { subscriptionId: sub.id, ownerId: A, graceHours: 24, now: NOW });
    const second = (await idsOf()).secret_id;
    expect((await idsOf()).previous_secret_id).toBe(original);
    const third = await rotateWebhookSecret(pool, store, { subscriptionId: sub.id, ownerId: A, graceHours: 24, now: at(3600) });
    expect(await idsOf()).toEqual({ secret_id: expect.any(String), previous_secret_id: second });
    expect(await exists(original)).toBe(false);

    expect(await purgeExpiredWebhookSecrets(pool, at(3600))).toBe(0);
    expect(await purgeExpiredWebhookSecrets(pool, at(3600 + 24 * 3600 + 1))).toBe(1);
    const after = await idsOf();
    expect(after.previous_secret_id).toBeNull();
    expect(await exists(second)).toBe(false);
    expect((await secretsIn(sub.id)).current).toBe(third.secret);
    expect((await pool.query('SELECT previous_secret_expires_at FROM webhook_subscriptions WHERE id = $1', [sub.id])).rows[0].previous_secret_expires_at).toBeNull();
  });
});

describe('événements de run et de statut', () => {
  async function api(status: string, owner = A): Promise<string> {
    return (await pool.query<{ id: string }>('INSERT INTO apis (slug, owner_id, status) VALUES ($1, $2, $3) RETURNING id', [`zz_test_${randomBytes(4).toString('hex')}`, owner, status])).rows[0]!.id;
  }

  test('assert_webhook_blocked_not_retryable : api.status_changed vers bloquee porte retryable: false, aucun run ni ré-enquête n\'en découle', async () => {
    const sub = await subscribe(['api.status_changed']);
    const blocked = await api('enquete');
    const runsBefore = (await pool.query('SELECT count(*)::int AS n FROM runs')).rows[0].n as number;
    const result = await applyStatusAndNotify(pool, queue, { apiId: blocked, event: { type: 'run_failed', failureClass: 'blocked_by_protection' }, clock: { now: () => NOW } }, { now: () => NOW });
    expect(result.ok && result.state.status).toBe('bloquee');
    const [row] = await deliveriesOf(sub.id);
    expect(row).toBeDefined();

    await deliverWebhookAttempt(ctx({ now: () => NOW }), { dispatch_id: row!.dispatch_id, attempt: 1 });
    const payload = new Webhook(sub.secret).verify(received[0]!.body, headersOf(received[0]!)) as { type: string; data: Record<string, unknown> };
    expect(payload.type).toBe('api.status_changed');
    expect(payload.data).toMatchObject({ from: 'enquete', to: 'bloquee', reason: 'blocked_by_protection', retryable: false });

    // Aucune conséquence automatique : pas de run créé, statut inchangé, aucune enquête ni réparation lancée.
    expect((await pool.query('SELECT count(*)::int AS n FROM runs')).rows[0].n).toBe(runsBefore);
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [blocked])).rows[0].status).toBe('bloquee');
    expect((await pool.query('SELECT count(*)::int AS n FROM status_events WHERE api_id = $1', [blocked])).rows[0].n).toBe(1);
  });

  test('vers un autre statut (warning) : retryable true ; l\'événement part dans la même transaction que la transition', async () => {
    const sub = await subscribe(['api.status_changed']);
    const healthy = await api('sain');
    await applyStatusTransition(pool, {
      apiId: healthy,
      event: { type: 'run_succeeded', signals: ['escalated'] },
      clock: { now: () => NOW },
      afterTransition: async (client, events) => {
        await notifyStatusChange(client, queue, { apiId: healthy, transitions: toStatusTransitions(events) }, { now: () => NOW });
      },
    });
    const [row] = await deliveriesOf(sub.id);
    expect((row as unknown as { dispatch_id: string }).dispatch_id).toBeTruthy();
    const payload = (await pool.query<{ payload: { data: { to: string; retryable: boolean } } }>('SELECT payload FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY id DESC LIMIT 1', [sub.id])).rows[0]!.payload;
    expect(payload.data).toMatchObject({ to: 'warning', retryable: true });

    // Transaction annulée : ni la transition, ni la livraison.
    const other = await api('sain');
    const before = (await deliveriesOf(sub.id)).length;
    await expect(
      applyStatusTransition(pool, {
        apiId: other,
        event: { type: 'run_succeeded', signals: ['escalated'] },
        clock: { now: () => NOW },
        afterTransition: async (client, events) => {
          await notifyStatusChange(client, queue, { apiId: other, transitions: toStatusTransitions(events) }, { now: () => NOW });
          throw new Error('échec après l\'émission');
        },
      }),
    ).rejects.toThrow('après l\'émission');
    expect((await deliveriesOf(sub.id)).length).toBe(before);
    expect((await pool.query('SELECT status FROM apis WHERE id = $1', [other])).rows[0].status).toBe('sain');
  });

  test('fin de run : run.succeeded et run.failed aux cibles du propriétaire du run, charge mince', async () => {
    const sub = await subscribe(['run.succeeded', 'run.failed']);
    const ok = await newRun({ state: 'running', items: 12 });
    expect(await finishRunAndNotify(pool, queue, { runId: ok.runId, jobId: ok.jobId, result: { state: 'succeeded', outcome: 'clean', items: 12 }, now: () => NOW })).toBe(true);
    const bad = await newRun({ state: 'running' });
    expect(await finishRunAndNotify(pool, queue, { runId: bad.runId, jobId: bad.jobId, result: { state: 'failed', failure_class: 'transient', retryable: true }, now: () => NOW })).toBe(true);

    const rows = (await pool.query<{ event: string; payload: { data: Record<string, unknown> } }>('SELECT event, payload FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY id', [sub.id])).rows;
    expect(rows.map((r) => r.event)).toEqual(['run.succeeded', 'run.failed']);
    expect(rows[0]!.payload.data).toMatchObject({ run_id: ok.runId, items: 12, outcome: 'clean', api_id: apiId });
    expect(rows[1]!.payload.data).toMatchObject({ run_id: bad.runId, failure_class: 'transient', retryable: true });
    for (const r of rows) expect(JSON.stringify(r.payload)).not.toMatch(/"item"|error_detail|cookie|authorization/i);

    // Classe bloquante rapportée « réessayable » par l'exécuteur : le webhook dit retryable: false (X3, X4).
    const refused = await newRun({ state: 'running' });
    await finishRunAndNotify(pool, queue, { runId: refused.runId, jobId: refused.jobId, result: { state: 'failed', failure_class: 'forbidden', retryable: true }, now: () => NOW });
    const last = (await pool.query<{ payload: { data: Record<string, unknown> } }>('SELECT payload FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY id DESC LIMIT 1', [sub.id])).rows[0]!;
    expect(last.payload.data).toMatchObject({ run_id: refused.runId, failure_class: 'forbidden', retryable: false });
  });

  test('bail perdu (job_id changé) : le run n\'est pas clos et rien n\'est annoncé', async () => {
    const sub = await subscribe(['run.succeeded']);
    const run = await newRun({ state: 'running' });
    const before = (await deliveriesOf(sub.id)).length;
    expect(await finishRunAndNotify(pool, queue, { runId: run.runId, jobId: randomUUID(), result: { state: 'succeeded', outcome: 'clean', items: 1 } })).toBe(false);
    expect((await deliveriesOf(sub.id)).length).toBe(before);
    expect((await pool.query('SELECT state FROM runs WHERE id = $1', [run.runId])).rows[0].state).toBe('running');
  });

  /** Planification de surveillance et runs réels : chaque run écrit son dataset par `appendRunItems` (dédup contre l'API). */
  async function watchedSchedule(rules: Record<string, unknown>) {
    const watched = await api('sain');
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO schedules (api_id, owner_id, cron, rules) VALUES ($1, $2, '* * * * *', $3::jsonb) RETURNING id`, [
      watched,
      A,
      JSON.stringify(rules),
    ]);
    const scheduleId = rows[0]!.id;
    const hashKey = randomBytes(32);
    /** Un run planifié qui renvoie `items` : écriture du dataset sous l'identité du propriétaire (RLS), fin et annonce. */
    const start = async () => {
      const jobId = randomUUID();
      const r = await pool.query<{ id: string }>(
        `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, job_id, schedule_id, started_at) VALUES ($1, $2, $2, 'schedule', 'running', $3, $4, now()) RETURNING id`,
        [watched, A, jobId, scheduleId],
      );
      return { runId: r.rows[0]!.id, jobId };
    };
    const write = (runId: string, items: readonly unknown[]) => withActor(pool, { userId: A, role: 'member' }, (tx) => appendRunItems(tx, { runId, items, hashKey }));
    const finish = (runId: string, jobId: string, result: RunResult) => finishRunAndNotify(pool, queue, { runId, jobId, result, now: () => NOW }, { subjectKey: hashKey });
    /** Run ouvert : dataset écrit, clôture (succès) laissée à l'appelant. */
    const runOpen = async (items: readonly unknown[]) => {
      const { runId, jobId } = await start();
      const w = await write(runId, items);
      return { runId, write: w, finish: () => finish(runId, jobId, { state: 'succeeded', outcome: 'clean', items: w.written, dataset_id: w.datasetId }) };
    };
    const runWith = async (items: readonly unknown[]) => {
      const open = await runOpen(items);
      await open.finish();
      return { runId: open.runId, write: open.write };
    };
    /** Run qui écrit plusieurs pages (un appel chacune) puis se clôt sur `result`. */
    const runPartial = async (pages: readonly (readonly unknown[])[], result: RunResult) => {
      const { runId, jobId } = await start();
      const writes = [];
      for (const page of pages) writes.push(await write(runId, page));
      await finish(runId, jobId, result);
      return { runId, writes };
    };
    return { watched, scheduleId, runWith, runOpen, runPartial, hashKey };
  }
  const listing = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ url: `https://zz-test.example/annonce/${from + i}`, title: `annonce ${from + i}` }));
  const urlsOf = async (datasetId: string) =>
    (await pool.query<{ url: string; dedup_key: string | null }>("SELECT item->>'url' AS url, dedup_key FROM dataset_items WHERE dataset_id = $1 ORDER BY seq", [datasetId])).rows;
  const eventsOf = async (subscriptionId: string) =>
    (await pool.query<{ event: string; payload: { data: Record<string, unknown> } }>('SELECT event, payload FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY id', [subscriptionId])).rows;

  test('assert_schedule_diff_new : `dedup_key: url` + `diff: new`, 48 items connus puis 2 nouveaux : le dataset ne contient que ces 2, `new_items` = 2 part au webhook', async () => {
    const sub = await subscribe(['items.new', 'run.succeeded']);
    const { runWith } = await watchedSchedule({ dedup_key: 'url', diff: 'new' });
    const known = listing(48);

    // 1er run : base de référence (48 items écrits, rien à signaler).
    const first = await runWith(known);
    expect(first.write).toMatchObject({ written: 48, newItems: 48 });
    // 2e run, mêmes 48 items : rien de nouveau, dataset vide, pas d'items.new.
    const second = await runWith(known);
    expect(second.write).toMatchObject({ written: 0, newItems: 0, skipped: 48 });
    expect(await urlsOf(second.write.datasetId)).toEqual([]);
    // 3e run, les 48 + 2 nouveautés : le dataset contient exactement ces 2 items.
    const third = await runWith([...known, ...listing(2, 48)]);
    expect(third.write).toMatchObject({ written: 2, newItems: 2, skipped: 48 });
    expect(await urlsOf(third.write.datasetId)).toEqual([
      { url: 'https://zz-test.example/annonce/48', dedup_key: 'https://zz-test.example/annonce/48' },
      { url: 'https://zz-test.example/annonce/49', dedup_key: 'https://zz-test.example/annonce/49' },
    ]);
    const ds = (await pool.query<{ item_count: number; new_items: number; owner_id: string; run_id: string }>('SELECT item_count, new_items, owner_id, run_id FROM datasets WHERE id = $1', [third.write.datasetId])).rows[0];
    expect(ds).toEqual({ item_count: 2, new_items: 2, owner_id: A, run_id: third.runId });

    const events = await eventsOf(sub.id);
    expect(events.map((e) => e.event)).toEqual(['run.succeeded', 'run.succeeded', 'run.succeeded', 'items.new']);
    expect(events[0]!.payload.data['new_items']).toBe(0); // base de référence
    expect(events[1]!.payload.data['new_items']).toBe(0);
    expect(events[2]!.payload.data['new_items']).toBe(2);
    expect(events[3]!.payload.data).toMatchObject({ run_id: third.runId, new_items: 2, items: 2 });
    // Clés gardées en empreinte HMAC seulement (17 § 6) : aucune URL en clair dans dedup_keys.
    expect((await pool.query("SELECT count(*)::int AS n FROM dedup_keys WHERE key_hash LIKE '%zz-test%'")).rows[0].n).toBe(0);
  });

  test('assert_schedule_failed_run_keeps_new_items : un run qui écrit 2 pages puis échoue ne marque aucune clé comme vue ; le run réussi suivant (`diff: new`) livre et annonce ces nouveautés', async () => {
    const sub = await subscribe(['items.new']);
    const { runWith, runPartial } = await watchedSchedule({ dedup_key: 'url', diff: 'new' });
    const known = listing(48);
    await runWith(known); // base de référence

    // Run planifié : page 1 puis page 2 écrites (chacune au COMMIT de son appel), puis échec (extraction, budget, worker perdu).
    const failed = await runPartial([[...known.slice(0, 24), ...listing(1, 48)], [...known.slice(24), ...listing(1, 49)]], {
      state: 'failed',
      failure_class: 'transient',
      retryable: true,
    });
    expect(failed.writes.map((w) => w.newItems)).toEqual([1, 1]);
    expect((await pool.query('SELECT dataset_id FROM runs WHERE id = $1', [failed.runId])).rows[0].dataset_id).toBeNull();

    // Run suivant, même annonce : les 2 nouveautés sont toujours nouvelles, écrites et annoncées.
    const next = await runWith([...known, ...listing(2, 48)]);
    expect(next.write).toMatchObject({ written: 2, newItems: 2, skipped: 48 });
    expect((await urlsOf(next.write.datasetId)).map((r) => r.url)).toEqual(listing(2, 48).map((i) => i.url));
    expect((await pool.query('SELECT new_items FROM datasets WHERE id = $1', [next.write.datasetId])).rows[0].new_items).toBe(2);
    const events = await eventsOf(sub.id);
    expect(events.map((e) => e.event)).toEqual(['items.new']);
    expect(events[0]!.payload.data).toMatchObject({ run_id: next.runId, new_items: 2, items: 2 });

    // Et une fois ce run réussi, elles sont vues : le run d'après n'a plus rien de nouveau.
    const after = await runWith([...known, ...listing(2, 48)]);
    expect(after.write).toMatchObject({ written: 0, newItems: 0, skipped: 50 });
    expect((await eventsOf(sub.id)).map((e) => e.event)).toEqual(['items.new']);
  });

  test('deux runs concurrents voient la même nouveauté : elle n’est comptée et annoncée qu’une fois (par le premier qui réussit)', async () => {
    const sub = await subscribe(['items.new']);
    const { runWith, runOpen } = await watchedSchedule({ dedup_key: 'url', diff: 'all' });
    await runWith(listing(3)); // base de référence
    const a = await runOpen([...listing(3), ...listing(1, 3)]);
    const b = await runOpen([...listing(3), ...listing(1, 3)]);
    expect(a.write.newItems).toBe(1);
    expect(b.write.newItems).toBe(1);
    await a.finish();
    await b.finish();
    expect((await pool.query('SELECT new_items FROM datasets WHERE id = $1', [a.write.datasetId])).rows[0].new_items).toBe(1);
    expect((await pool.query('SELECT new_items FROM datasets WHERE id = $1', [b.write.datasetId])).rows[0].new_items).toBe(0);
    const events = await eventsOf(sub.id);
    expect(events.map((e) => e.event)).toEqual(['items.new']);
    expect(events[0]!.payload.data).toMatchObject({ run_id: a.runId, new_items: 1 });
  });

  test('`diff: all` : tout est écrit, les nouveautés comptées ; doublons de clé dans un même run écrits une fois ; item sans clé gardé', async () => {
    const sub = await subscribe(['items.new']);
    const { runWith } = await watchedSchedule({ dedup_key: 'url', diff: 'all' });
    await runWith(listing(3));
    const again = await runWith([...listing(3), ...listing(1, 3), listing(1, 3)[0], { title: 'sans url' }]);
    expect(again.write).toMatchObject({ written: 5, newItems: 2, skipped: 1 });
    expect((await urlsOf(again.write.datasetId)).map((r) => r.url)).toEqual([...listing(4).map((i) => i.url), null]);
    const events = await eventsOf(sub.id);
    expect(events.map((e) => e.event)).toEqual(['items.new']);
    expect(events[0]!.payload.data).toMatchObject({ new_items: 2, items: 5 });
  });

  test('appels successifs dans un même run : un seul dataset complété, bilan cumulé', async () => {
    const { runWith, hashKey } = await watchedSchedule({ dedup_key: 'url', diff: 'new' });
    const { runId, write } = await runWith(listing(2));
    const more = await withActor(pool, { userId: A, role: 'member' }, (tx) => appendRunItems(tx, { runId, items: [...listing(2), ...listing(3, 2)], hashKey }));
    expect(more.datasetId).toBe(write.datasetId);
    // Bilan de l'appel : les 2 déjà écrits par ce run sont des doublons, les 3 autres sont nouveaux.
    expect(more).toMatchObject({ written: 3, newItems: 3, skipped: 2 });
    expect((await pool.query('SELECT count(*)::int AS n FROM datasets WHERE run_id = $1', [runId])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT item_count, new_items FROM datasets WHERE id = $1', [write.datasetId])).rows[0]).toEqual({ item_count: 5, new_items: 5 });
    expect((await urlsOf(write.datasetId)).map((r) => r.url)).toEqual(listing(5).map((i) => i.url));
  });

  test('notifyRunFinished : sans effet pour un run non terminé', async () => {
    const run = await newRun({ state: 'running' });
    expect(await notifyRunFinished(pool, queue, run.runId)).toEqual({ events: [] });
  });
});
