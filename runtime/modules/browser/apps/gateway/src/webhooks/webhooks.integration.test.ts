// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.5 (03 § 6 « webhookUrl … signé selon Standard Webhooks », 06 ligne 2.5 « webhook vérifiable par signature ») :
// webhook de fin de session et `recording.ready`, URL réglée par client (`PATCH /v1/admin/tenants/{id}`, scope `admin`),
// secret `whsec_` affiché une seule fois et scellé au repos (BINV6), garde SSRF de l'egress à l'enregistrement et à chaque
// envoi (résolution unique, adresse épinglée, aucune redirection suivie), signature v1 vérifiée par la bibliothèque de
// référence `standardwebhooks`, relances au même `webhook-id`, livraison unique même avec plusieurs passerelles.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendSessionEvent, transitionSession } from '@sym-browser/db';
import { MasterKey, createEgressGuard, kekFor, type ResolvedAddress } from '@sym-browser/core';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';
import { createWebhookDispatcher } from './index.js';

type Received = { headers: IncomingHttpHeaders; body: string; at: number };
type Receiver = { url: string; port: number; received: Received[]; reply: (status: number, headers?: Record<string, string>) => void; close(): Promise<void> };

async function startReceiver(): Promise<Receiver> {
  const received: Received[] = [];
  const replies: { status: number; headers: Record<string, string> }[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (p: Buffer) => parts.push(p));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(parts).toString('utf8'), at: Date.now() });
      const next = replies.shift() ?? { status: 204, headers: {} };
      res.writeHead(next.status, next.headers).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    received,
    reply: (status, headers = {}) => void replies.push({ status, headers }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Résolution maîtrisée de hook.test (rebinding simulé entre l'enregistrement et l'envoi). */
const dns: Record<string, string> = { 'hook.test': '127.0.0.1' };
const resolver = async (host: string): Promise<ResolvedAddress[]> => (dns[host] === undefined ? Promise.reject(new Error('ENOTFOUND')) : [{ address: dns[host] ?? '', family: 4 }]);
const guard = createEgressGuard({ privateHosts: ['127.0.0.1', 'hook.test'], resolver });
const keys = { current: kekFor(MasterKey.generate(), 1) };

let h: Harness;
let receiver: Receiver;
const dispatchOptions = { pollMs: 25, retryDelaysMs: [0, 50, 50], timeoutMs: 2_000 } as const;

beforeAll(async () => {
  h = await createHarness({ webhooks: { guard, keys, dispatcher: dispatchOptions } });
  receiver = await startReceiver();
});
afterEach(() => {
  dns['hook.test'] = '127.0.0.1';
});
afterAll(async () => {
  await receiver.close();
  await h.close();
});

const patchTenant = (tenantId: string, body: unknown, key: keyof Harness['keys'] = 'aAdmin') =>
  h.app.inject({ method: 'PATCH', url: `/v1/admin/tenants/${tenantId}`, headers: { authorization: `Bearer ${h.keys[key]}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

async function configure(url: string): Promise<string> {
  const res = await patchTenant(h.tenantA, { webhookUrl: url, rotateWebhookSecret: true });
  expect(res.statusCode).toBe(200);
  return res.json().webhookSecret as string;
}

async function endedSession(reason: 'released' | 'crash' = 'released'): Promise<string> {
  const created = await h.call({ method: 'POST', url: '/v1/sessions', key: 'a', body: {} });
  const id = created.body.id as string;
  if (reason === 'released') await h.call({ method: 'DELETE', url: `/v1/sessions/${id}` });
  else await transitionSession(h.pool, { sessionId: id, to: 'failed', reason: 'crash' });
  return id;
}

const waitFor = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe('réglage du webhook d’un client', () => {
  test('URL posée par l’admin du client ; secret whsec_ affiché une seule fois, scellé en base, jamais relu', async () => {
    const res = await patchTenant(h.tenantA, { webhookUrl: receiver.url });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: h.tenantA, webhookUrl: receiver.url, webhookSecretSet: true });
    expect(body.webhookSecret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const again = await h.app.inject({ method: 'GET', url: `/v1/admin/tenants/${h.tenantA}`, headers: { authorization: `Bearer ${h.keys.aAdmin}` } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: h.tenantA, name: 'a', webhookUrl: receiver.url, webhookSecretSet: true });
    // Changer l'URL garde le secret ; seul `rotateWebhookSecret` en tire un nouveau.
    const moved = (await patchTenant(h.tenantA, { webhookUrl: `${receiver.url}?v=2` })).json();
    expect(moved.webhookSecret).toBeUndefined();
    const { rows } = await h.pool.query<{ webhook_secret_encrypted: string }>('SELECT webhook_secret_encrypted FROM tenants WHERE id = $1', [h.tenantA]);
    expect(rows[0]?.webhook_secret_encrypted).not.toContain(body.webhookSecret);
    expect(rows[0]?.webhook_secret_encrypted).not.toContain(body.webhookSecret.slice(6));
    expect(JSON.stringify(rows)).not.toContain('whsec_');
  });

  test.each([
    ['http://169.254.169.254/latest', 'address_not_public'],
    ['http://10.0.0.5/hook', 'address_not_public'],
    ['http://localhost:9/hook', 'address_not_public'],
    ['http://absent.invalid/hook', 'unresolvable'],
    ['ftp://hook.test/x', 'scheme'],
    ['http://user:pw@hook.test/x', 'credentials'],
    ['pas une url', 'scheme'],
  ])('URL refusée %s → 422 invalid_option (%s), rien d’enregistré', async (url, reason) => {
    const before = (await h.app.inject({ method: 'GET', url: `/v1/admin/tenants/${h.tenantB}`, headers: { authorization: `Bearer ${h.keys.bAdmin}` } })).json();
    const res = await patchTenant(h.tenantB, { webhookUrl: url }, 'bAdmin');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_option', details: [{ field: 'webhookUrl', reason }] } });
    const after = (await h.app.inject({ method: 'GET', url: `/v1/admin/tenants/${h.tenantB}`, headers: { authorization: `Bearer ${h.keys.bAdmin}` } })).json();
    expect(after).toEqual(before);
  });

  test('accès : scope admin requis, réglages d’un autre client invisibles (404), corps invalide 422', async () => {
    expect((await patchTenant(h.tenantA, { webhookUrl: receiver.url }, 'a')).statusCode).toBe(403);
    expect((await patchTenant(h.tenantA, { webhookUrl: receiver.url }, 'bAdmin')).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/v1/admin/tenants/${h.tenantA}`, headers: { authorization: `Bearer ${h.keys.bAdmin}` } })).statusCode).toBe(404);
    expect((await patchTenant(h.tenantA, { webhookUrl: 42 })).statusCode).toBe(422);
    expect((await patchTenant(h.tenantA, { inconnu: true })).statusCode).toBe(422);
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/admin/tenants/${h.tenantA}`, payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
  });

  test('webhookUrl: null : webhook désactivé, plus aucune livraison mise en file', async () => {
    await configure(receiver.url);
    expect((await patchTenant(h.tenantA, { webhookUrl: null })).json()).toEqual({ id: h.tenantA, name: 'a', webhookUrl: null, webhookSecretSet: false });
    const id = await endedSession();
    const { rows } = await h.pool.query('SELECT 1 FROM webhook_deliveries WHERE session_id = $1', [id]);
    expect(rows).toEqual([]);
  });
});

describe('livraison des webhooks', () => {
  test('fin de session : POST JSON signé v1, vérifié par la bibliothèque de référence Standard Webhooks', async () => {
    const secret = await configure(receiver.url);
    const before = receiver.received.length;
    const id = await endedSession();
    await waitFor(() => receiver.received.length > before);
    const got = receiver.received.at(-1);
    if (got === undefined) throw new Error('aucun webhook reçu');
    expect(got.headers['content-type']).toBe('application/json');
    expect(got.headers['webhook-id']).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(got.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    const verified = new Webhook(secret).verify(got.body, { 'webhook-id': String(got.headers['webhook-id']), 'webhook-timestamp': String(got.headers['webhook-timestamp']), 'webhook-signature': String(got.headers['webhook-signature']) });
    expect(verified).toMatchObject({ type: 'session.ended', data: { session: { id, state: 'ended', endReason: 'released' } } });
    expect(Number.isNaN(Date.parse((verified as { timestamp: string }).timestamp))).toBe(false);
    // Corps altéré ou autre secret : refusé par la bibliothèque de référence.
    expect(() => new Webhook(secret).verify(got.body.replace('released', 'timeout'), got.headers as Record<string, string>)).toThrow();
    expect(() => new Webhook(`whsec_${Buffer.alloc(32, 7).toString('base64')}`).verify(got.body, got.headers as Record<string, string>)).toThrow();
  });

  test('recording.ready : livré avec ses données', async () => {
    const secret = await configure(receiver.url);
    const created = await h.call({ method: 'POST', url: '/v1/sessions', key: 'a', body: {} });
    const before = receiver.received.length;
    await appendSessionEvent(h.pool, { sessionId: created.body.id, type: 'recording.ready', data: { recordingId: 'rec_1', type: 'har', size: 1234, expiresAt: '2026-10-09T00:00:00.000Z' } });
    await waitFor(() => receiver.received.length > before);
    const got = receiver.received.at(-1);
    const payload = new Webhook(secret).verify(got?.body ?? '', got?.headers as Record<string, string>);
    expect(payload).toMatchObject({ type: 'recording.ready', data: { sessionId: created.body.id, recordingId: 'rec_1', type: 'har', size: 1234 } });
  });

  test('échec (500) puis succès : relance au même webhook-id, signature fraîche ; livraison close', async () => {
    const secret = await configure(receiver.url);
    receiver.reply(500);
    const before = receiver.received.length;
    const id = await endedSession('crash');
    await waitFor(() => receiver.received.length >= before + 2);
    const [first, second] = receiver.received.slice(before);
    expect(first?.headers['webhook-id']).toBe(second?.headers['webhook-id']);
    for (const r of [first, second]) expect(() => new Webhook(secret).verify(r?.body ?? '', r?.headers as Record<string, string>)).not.toThrow();
    await waitFor(() => false, 200);
    const { rows } = await h.pool.query('SELECT status, attempts, last_status FROM webhook_deliveries WHERE session_id = $1', [id]);
    expect(rows).toEqual([{ status: 'delivered', attempts: 2, last_status: 204 }]);
    expect(receiver.received.slice(before)).toHaveLength(2);
  });

  test('barème épuisé : livraison `failed` après le dernier essai, plus de relance', async () => {
    await configure(receiver.url);
    for (let i = 0; i < 3; i++) receiver.reply(503);
    const before = receiver.received.length;
    const id = await endedSession();
    await waitFor(() => receiver.received.length >= before + 3);
    await waitFor(() => false, 300);
    const { rows } = await h.pool.query('SELECT status, attempts, last_status, last_error FROM webhook_deliveries WHERE session_id = $1', [id]);
    expect(rows).toEqual([{ status: 'failed', attempts: 3, last_status: 503, last_error: 'http_503' }]);
    expect(receiver.received.length).toBe(before + 3);
  });

  test('redirection : jamais suivie (échec de livraison), la cible de la redirection ne reçoit rien', async () => {
    const other = await startReceiver();
    try {
      await configure(receiver.url);
      for (let i = 0; i < 3; i++) receiver.reply(302, { location: other.url });
      const id = await endedSession();
      await waitFor(() => false, 600);
      expect(other.received).toEqual([]);
      const { rows } = await h.pool.query('SELECT status, last_status FROM webhook_deliveries WHERE session_id = $1', [id]);
      expect(rows[0]).toMatchObject({ last_status: 302 });
    } finally {
      await other.close();
    }
  });

  test('rebinding : le nom résout vers une adresse interdite au moment de l’envoi → rien n’est envoyé (address_not_public)', async () => {
    await configure(`http://hook.test:${receiver.port}/hook`);
    const before = receiver.received.length;
    dns['hook.test'] = '169.254.169.254';
    const id = await endedSession();
    await waitFor(() => false, 500);
    expect(receiver.received.length).toBe(before);
    const { rows } = await h.pool.query('SELECT last_error FROM webhook_deliveries WHERE session_id = $1', [id]);
    expect(rows[0]).toMatchObject({ last_error: 'address_not_public' });
  });

  test('plusieurs passerelles : chaque livraison part une seule fois', async () => {
    await configure(receiver.url);
    const second = createWebhookDispatcher({ db: h.pool, guard, keys, ...dispatchOptions });
    second.start();
    try {
      const before = receiver.received.length;
      const ids = await Promise.all([endedSession(), endedSession(), endedSession(), endedSession()]);
      await waitFor(() => receiver.received.length >= before + 4);
      await waitFor(() => false, 300);
      const delivered = receiver.received.slice(before).map((r) => r.headers['webhook-id']);
      expect(delivered).toHaveLength(4);
      expect(new Set(delivered).size).toBe(4);
      expect(ids).toHaveLength(4);
    } finally {
      await second.stop();
    }
  });

  test('secret absent des livraisons en base, des en-têtes et des corps reçus', async () => {
    const secret = await configure(receiver.url);
    const before = receiver.received.length;
    await endedSession();
    await waitFor(() => receiver.received.length > before);
    const { rows } = await h.pool.query('SELECT * FROM webhook_deliveries');
    const seen = JSON.stringify({ rows, received: receiver.received });
    expect(seen).not.toContain(secret);
    expect(seen).not.toContain(secret.slice(6));
  });
});
