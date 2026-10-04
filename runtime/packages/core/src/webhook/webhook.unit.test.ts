// SPDX-License-Identifier: AGPL-3.0-only
// Standard Webhooks (08 § 5) : signature, vérification, rotation, tolérance, charges minces, barème. Étage U1.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Webhook } from 'standardwebhooks';
import { describe, expect, test } from 'vitest';
import {
  classifyDelivery,
  generateWebhookSecret,
  itemsNewPayload,
  runFailedPayload,
  runSucceededPayload,
  signWebhook,
  statusChangedPayload,
  verifyWebhook,
  webhookDelaySeconds,
  webhookHeaders,
  WEBHOOK_FORBIDDEN_FIELDS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAYLOAD_SCHEMA,
  assertNoSentenceFields,
  WebhookSecretError,
  WebhookVerificationError,
} from './index.js';

// Vecteur officiel de la spécification Standard Webhooks.
const OFFICIAL = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const NOW = new Date('2026-10-01T10:00:00Z');
const BODY = '{"type":"items.new","timestamp":"2026-10-01T10:00:00.000Z","data":{"new_items":2}}';

function failure(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('assert_webhook_signature (unité)', () => {
  test('vecteur officiel Standard Webhooks', () => {
    expect(signWebhook({ id: OFFICIAL.id, timestamp: OFFICIAL.timestamp, body: OFFICIAL.body }, [OFFICIAL.secret])).toBe(OFFICIAL.signature);
    expect(() =>
      verifyWebhook({
        headers: { 'webhook-id': OFFICIAL.id, 'webhook-timestamp': String(OFFICIAL.timestamp), 'webhook-signature': OFFICIAL.signature },
        body: OFFICIAL.body,
        secrets: [OFFICIAL.secret],
        now: new Date(OFFICIAL.timestamp * 1000 + 1000),
      }),
    ).not.toThrow();
  });

  test('bibliothèque de référence (standardwebhooks) : nos en-têtes se vérifient, avec un ou deux secrets (rotation)', () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const now = new Date();
    const headers = webhookHeaders({ id: 'evt_ref', dispatchId: 'd', body: BODY, secrets: [current, previous], now });
    const plain = { 'webhook-id': headers['webhook-id'], 'webhook-timestamp': headers['webhook-timestamp'], 'webhook-signature': headers['webhook-signature'] };
    // La bibliothèque rend la charge décodée et lève si la signature ne correspond pas.
    expect(new Webhook(current).verify(BODY, plain)).toEqual(JSON.parse(BODY));
    expect(new Webhook(previous).verify(BODY, plain)).toEqual(JSON.parse(BODY));
    expect(() => new Webhook(generateWebhookSecret()).verify(BODY, plain)).toThrow();
    expect(() => new Webhook(current).verify(BODY.replace('2', '3'), plain)).toThrow();
  });

  test('inversement : la bibliothèque signe, notre vérification accepte', () => {
    const secret = generateWebhookSecret();
    const lib = new Webhook(secret);
    const now = new Date();
    const signature = lib.sign('evt_lib', now, BODY);
    expect(() => verifyWebhook({ headers: { 'webhook-id': 'evt_lib', 'webhook-timestamp': String(Math.floor(now.getTime() / 1000)), 'webhook-signature': signature }, body: BODY, secrets: [secret], now })).not.toThrow();
  });

  test('secret généré : préfixe whsec_, 32 octets, jamais deux fois le même', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(a.slice(6), 'base64')).toHaveLength(32);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  test('en-têtes : webhook-id stable, horodatage et signature frais, dispatch-id présent', () => {
    const secret = generateWebhookSecret();
    const first = webhookHeaders({ id: 'evt_1', dispatchId: 'd-1', body: BODY, secrets: [secret], now: NOW });
    const later = webhookHeaders({ id: 'evt_1', dispatchId: 'd-1', body: BODY, secrets: [secret], now: new Date(NOW.getTime() + 5000) });
    expect(first['webhook-id']).toBe(later['webhook-id']);
    expect(first['dispatch-id']).toBe('d-1');
    expect(first['webhook-timestamp']).toBe(String(NOW.getTime() / 1000));
    expect(later['webhook-timestamp']).not.toBe(first['webhook-timestamp']);
    expect(later['webhook-signature']).not.toBe(first['webhook-signature']);
    expect(() => verifyWebhook({ headers: first, body: BODY, secrets: [secret], now: NOW })).not.toThrow();
  });

  test('corps modifié, mauvais secret, identifiant modifié : refus', () => {
    const secret = generateWebhookSecret();
    const headers = webhookHeaders({ id: 'evt_1', dispatchId: 'd', body: BODY, secrets: [secret], now: NOW });
    expect(failure(() => verifyWebhook({ headers, body: BODY.replace('2', '3'), secrets: [secret], now: NOW }))).toBe('no_valid_signature');
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [generateWebhookSecret()], now: NOW }))).toBe('no_valid_signature');
    expect(failure(() => verifyWebhook({ headers: { ...headers, 'webhook-id': 'evt_2' }, body: BODY, secrets: [secret], now: NOW }))).toBe('no_valid_signature');
    expect(failure(() => verifyWebhook({ headers: { ...headers, 'webhook-timestamp': String(Number(headers['webhook-timestamp']) + 1) }, body: BODY, secrets: [secret], now: NOW }))).toBe('no_valid_signature');
  });

  test('tolérance de 5 minutes : rejeu refusé, limite acceptée', () => {
    const secret = generateWebhookSecret();
    const headers = webhookHeaders({ id: 'evt_1', dispatchId: 'd', body: BODY, secrets: [secret], now: NOW });
    const at = (s: number) => new Date(NOW.getTime() + s * 1000);
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [secret], now: at(300) }))).toBe('accepted');
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [secret], now: at(301) }))).toBe('timestamp_out_of_tolerance');
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [secret], now: at(-301) }))).toBe('timestamp_out_of_tolerance');
  });

  test('rotation : deux secrets en parallèle, l\'un ou l\'autre suffit', () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const headers = webhookHeaders({ id: 'evt_1', dispatchId: 'd', body: BODY, secrets: [current, previous], now: NOW });
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [current], now: NOW }))).toBe('accepted');
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [previous], now: NOW }))).toBe('accepted');
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [generateWebhookSecret()], now: NOW }))).toBe('no_valid_signature');
  });

  test('schémas autres que v1 ignorés (anti-repli) ; en-têtes manquants ou mal formés', () => {
    const secret = generateWebhookSecret();
    const headers = webhookHeaders({ id: 'evt_1', dispatchId: 'd', body: BODY, secrets: [secret], now: NOW });
    const v1 = headers['webhook-signature'].slice(3);
    expect(failure(() => verifyWebhook({ headers: { ...headers, 'webhook-signature': `v2,${v1}` }, body: BODY, secrets: [secret], now: NOW }))).toBe('no_valid_signature');
    expect(failure(() => verifyWebhook({ headers: { ...headers, 'webhook-signature': `v1a,${v1} v1,AAAA` }, body: BODY, secrets: [secret], now: NOW }))).toBe('no_valid_signature');
    expect(failure(() => verifyWebhook({ headers: { 'webhook-id': 'x' }, body: BODY, secrets: [secret], now: NOW }))).toBe('missing_headers');
    expect(failure(() => verifyWebhook({ headers: { ...headers, 'webhook-timestamp': 'hier' }, body: BODY, secrets: [secret], now: NOW }))).toBe('invalid_timestamp');
    expect(failure(() => verifyWebhook({ headers, body: BODY, secrets: [], now: NOW }))).toBe('no_secret');
  });

  test('secret mal formé refusé : préfixe et longueur de clé', () => {
    const message = { id: 'a', timestamp: 1, body: '{}' };
    expect(() => signWebhook(message, ['pas_un_secret'])).toThrow(WebhookSecretError);
    expect(() => signWebhook(message, ['whsec_AAAA'])).toThrow(WebhookSecretError);
    expect(() => signWebhook(message, [])).toThrow(WebhookSecretError);
  });
});

describe('charges utiles (INV5 : minces, jamais d\'item)', () => {
  const api = { api: 'zz_test_annonces', api_id: '00000000-0000-0000-0000-0000000000a1' };

  test('run.succeeded : compteurs et URL du dataset, aucun item', () => {
    const p = runSucceededPayload(NOW, { ...api, run_id: 'r1', status: 'sain', outcome: 'clean', items: 48, items_rejected: 1, new_items: 5, dataset_id: 'ds1', base_url: 'https://runtime.example/' });
    expect(p).toEqual({
      type: 'run.succeeded',
      timestamp: '2026-10-01T10:00:00.000Z',
      data: { ...api, run_id: 'r1', status: 'sain', outcome: 'clean', items: 48, items_rejected: 1, new_items: 5, dataset_url: 'https://runtime.example/api/datasets/ds1/items' },
    });
    expect(Object.keys(p.data)).not.toContain('item');
  });

  test('run.succeeded : compteur items_rejected (D-49), 0 par défaut, jamais un item écarté', () => {
    const p = runSucceededPayload(NOW, { ...api, run_id: 'r1', status: 'warning', outcome: 'degraded', items: 47 });
    expect(p.data['items_rejected']).toBe(0);
  });

  test('run.failed : classe et retryable, jamais le détail d\'erreur', () => {
    const p = runFailedPayload(NOW, { ...api, run_id: 'r2', status: 'warning', failure_class: 'unavailable' as never, retryable: true });
    expect(p.data).toEqual({ ...api, run_id: 'r2', status: 'warning', failure_class: 'unavailable', retryable: true });
  });

  test('run.failed d\'une classe bloquante : retryable false quoi que rapporte l\'exécuteur (X3, X4)', () => {
    for (const cls of ['blocked_by_protection', 'forbidden'] as const) {
      expect(runFailedPayload(NOW, { ...api, run_id: 'r5', status: 'bloquee', failure_class: cls, retryable: true }).data['retryable'], cls).toBe(false);
      expect(runFailedPayload(NOW, { ...api, run_id: 'r5', status: 'bloquee', failure_class: cls, retryable: null }).data['retryable'], cls).toBe(false);
    }
    expect(runFailedPayload(NOW, { ...api, run_id: 'r6', status: 'sain', failure_class: 'transient', retryable: true }).data['retryable']).toBe(true);
  });

  test('api.status_changed vers bloquee : retryable false ; ailleurs true', () => {
    const blocked = statusChangedPayload(NOW, { ...api, from: 'sain', to: 'bloquee', reason: 'blocked_by_protection', run_id: 'r3' });
    expect(blocked.type).toBe('api.status_changed');
    expect(blocked.data).toMatchObject({ from: 'sain', to: 'bloquee', reason: 'blocked_by_protection', retryable: false });
    expect(statusChangedPayload(NOW, { ...api, from: 'sain', to: 'warning', reason: 'escalated' }).data['retryable']).toBe(true);
  });

  test('items.new : compteurs, sans URL quand l\'instance n\'a pas de base publique', () => {
    const p = itemsNewPayload(NOW, { ...api, run_id: 'r4', new_items: 2, items: 2, dataset_id: 'ds4' });
    expect(p.data).toEqual({ ...api, run_id: 'r4', new_items: 2, items: 2 });
  });
});

describe('barème de relance et classement', () => {
  test('immédiat, 5 s, 5 min, 30 min, 2 h ; cinq tentatives', () => {
    expect([1, 2, 3, 4, 5].map(webhookDelaySeconds)).toEqual([0, 5, 300, 1800, 7200]);
    expect(webhookDelaySeconds(6)).toBeNull();
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(5);
  });

  test('2xx livré ; 4xx, 5xx, délai, réseau rejoués au barème ; épuisé : failed', () => {
    expect(classifyDelivery(1, { httpStatus: 204, error: null })).toEqual({ verdict: 'delivered', errorCode: null, delaySeconds: null });
    expect(classifyDelivery(1, { httpStatus: 500, error: null })).toEqual({ verdict: 'retry', errorCode: 'http_500', delaySeconds: 5 });
    expect(classifyDelivery(2, { httpStatus: 404, error: null })).toEqual({ verdict: 'retry', errorCode: 'http_404', delaySeconds: 300 });
    expect(classifyDelivery(3, { httpStatus: null, error: 'timeout' })).toEqual({ verdict: 'retry', errorCode: 'timeout', delaySeconds: 1800 });
    expect(classifyDelivery(4, { httpStatus: null, error: 'network' })).toEqual({ verdict: 'retry', errorCode: 'network', delaySeconds: 7200 });
    expect(classifyDelivery(5, { httpStatus: 503, error: null })).toEqual({ verdict: 'failed', errorCode: 'http_503', delaySeconds: null });
  });

  test('refus SSRF et redirection : jamais rejoués (même résultat à chaque fois)', () => {
    expect(classifyDelivery(1, { httpStatus: null, error: 'ssrf_blocked' })).toEqual({ verdict: 'failed', errorCode: 'ssrf_blocked', delaySeconds: null });
    expect(classifyDelivery(1, { httpStatus: 307, error: null })).toEqual({ verdict: 'failed', errorCode: 'redirect_not_followed', delaySeconds: null });
  });
});

describe('assert_webhook_payload_has_no_sentences (21 § 4.4, 21b M10)', () => {
  const validate = new Ajv2020({ strict: false }).compile(WEBHOOK_PAYLOAD_SCHEMA);
  const at = new Date('2026-10-02T10:00:00Z');
  const api = { api: 'zz_test_api', api_id: 'a1' };
  const payloads = [
    runSucceededPayload(at, { ...api, run_id: 'r1', status: 'sain', items: 10, new_items: 2, outcome: 'clean', dataset_id: 'd1', base_url: 'https://runtime.example' }),
    runFailedPayload(at, { ...api, run_id: 'r2', status: 'bloquee', failure_class: 'blocked_by_protection', retryable: true }),
    statusChangedPayload(at, { ...api, from: 'sain', to: 'bloquee', reason: 'blocked_by_protection', run_id: 'r2' }),
    itemsNewPayload(at, { ...api, run_id: 'r1', new_items: 2, items: 10, dataset_id: 'd1', base_url: 'https://runtime.example' }),
  ];

  test('le schéma de la charge interdit message, text et description à toute profondeur ; les quatre charges le respectent', () => {
    expect(WEBHOOK_FORBIDDEN_FIELDS).toEqual(['message', 'text', 'description']);
    for (const payload of payloads) expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    for (const field of WEBHOOK_FORBIDDEN_FIELDS) {
      expect(validate({ ...payloads[0], data: { ...payloads[0]!.data, [field]: 'Le site refuse l’accès automatisé.' } }), field).toBe(false);
      expect(validate({ ...payloads[0], data: { ...payloads[0]!.data, nested: { deep: [{ [field]: 'x' }] } } }), `${field} imbriqué`).toBe(false);
    }
    expect(validate({ type: 'run.succeeded', timestamp: 'hier', data: {} })).toBe(false);
  });

  test('les constructeurs refusent un champ de phrase ; aucune charge ne porte une phrase, que des codes, paramètres, identifiants et horodatages UTC', () => {
    expect(() => assertNoSentenceFields({ ...payloads[0]!, data: { message: 'x' } })).toThrow(/interdit/);
    expect(() => assertNoSentenceFields({ ...payloads[0]!, data: { a: { b: [{ description: 'x' }] } } })).toThrow(/interdit/);
    for (const payload of payloads) {
      expect(payload.timestamp).toMatch(/Z$/);
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/\.\s+[A-ZÉ]|\b(the|le|la|les)\s/i);
    }
  });
});
