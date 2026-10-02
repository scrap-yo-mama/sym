// SPDX-License-Identifier: MIT
// Conformité du contrat `browser` : OpenAPI 3.1 bien formé, références résolues, énumérations identiques aux constantes, et
// fixtures valides et invalides tirées du CDC (cdc/sym-browser 04 § 11, 04c § 6.1) rejouées contre les schémas.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import {
  BROWSER_PRODUCT,
  BROWSER_PROTOCOL_VERSION,
  browserOpenApi,
  DEFAULT_SESSION_TYPE,
  END_REASONS,
  ERROR_CODES,
  ERROR_STATUS,
  SESSION_STATES,
  SESSION_TYPES,
  type ApiError,
  type ConnectUrls,
  type CreateSessionRequest,
  type EgressPolicy,
  type Session,
  type SessionEvent,
  type VersionInfo,
} from './index.js';

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: 'https://sym.invalid/browser/openapi.json', ...browserOpenApi });
const validator = (name: keyof typeof browserOpenApi.components.schemas) =>
  ajv.compile({ $ref: `https://sym.invalid/browser/openapi.json#/components/schemas/${name}` });

const refs = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(refs);
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => (key === '$ref' && typeof value === 'string' ? [value] : refs(value)));
};

describe('OpenAPI de SYM Browser', () => {
  test('OpenAPI 3.1, chemins de base du cycle de vie', () => {
    expect(browserOpenApi.openapi).toBe('3.1.0');
    expect(Object.keys(browserOpenApi.paths).sort()).toEqual(['/openapi.json', '/sessions', '/sessions/{id}', '/sessions/{id}/egress', '/sessions/{id}/extend', '/version']);
    expect(browserOpenApi.paths['/version'].get.security).toEqual([]);
  });

  test('toute référence $ref vise un schéma défini', () => {
    const defined = new Set(Object.keys(browserOpenApi.components.schemas));
    const missing = refs(browserOpenApi).filter((r) => !defined.has(r.replace('#/components/schemas/', '')));
    expect(missing).toEqual([]);
  });

  test('énumérations du schéma = constantes du contrat', () => {
    const session = browserOpenApi.components.schemas.Session.properties;
    expect(session.state.enum).toEqual([...SESSION_STATES]);
    expect(session.type.enum).toEqual([...SESSION_TYPES]);
    expect(session.endReason.enum).toEqual([...END_REASONS]);
    expect(browserOpenApi.components.schemas.Error.properties.error.properties.code.enum).toEqual([...ERROR_CODES]);
  });
});

describe('fixtures du CDC rejouées contre les schémas', () => {
  const createRequest: CreateSessionRequest = { type: 'shared', timeoutSeconds: 120, egress: { allowedHosts: ['example.com'], budgetBytes: 50_000_000 }, metadata: { job: 'demo' } };
  const session: Session = {
    id: '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11',
    state: 'running',
    type: 'shared',
    nodeRegion: 'frankfurt',
    connectUrls: { cdp: null, playwright: 'wss://b.example.com/v1/sessions/6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11/playwright?token=x', bidi: null },
    liveViewUrl: 'https://b.example.com/v1/sessions/6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11/live?t=x',
    expiresAt: '2026-10-02T10:02:00Z',
    createdAt: '2026-10-02T10:00:00Z',
  };
  const apiError: ApiError = {
    error: { code: 'profile_locked', message: 'Le profil p1 est ouvert en écriture.', retryable: true, what_to_do: "Attends la fin de l'autre session ou ouvre le profil en lecture.", requestId: 'req_9a', details: { lockedBySession: 'x' } },
  };
  const policy: EgressPolicy = { allowedHosts: ['*.example.com'], ports: [443], upstream: { type: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u', password: 'p', kind: 'isp' }, onBudgetExceeded: 'end' };

  test('valides', () => {
    expect(validator('CreateSessionRequest')(createRequest)).toBe(true);
    expect(validator('Session')(session)).toBe(true);
    expect(validator('Error')(apiError)).toBe(true);
    expect(validator('EgressPolicy')(policy)).toBe(true);
    expect(validator('EgressPolicy')({ upstream: { profileId: 'pp_1' } })).toBe(true);
    const version: VersionInfo = { product: 'sym-browser', api: '1', contract: BROWSER_PROTOCOL_VERSION, playwright: '1.63.0', chromium: '153.0.8010.12', platform: 'linux', minSdk: '1.0.0' };
    expect(validator('VersionInfo')(version)).toBe(true);
  });

  test('invalides', () => {
    expect(validator('CreateSessionRequest')({ launchArgs: ['--no-sandbox'] })).toBe(false);
    expect(validator('CreateSessionRequest')({ type: 'remote' })).toBe(false);
    expect(validator('CreateSessionRequest')({ unknownField: true })).toBe(false);
    expect(validator('Session')({ ...session, state: 'paused' })).toBe(false);
    expect(validator('EgressPolicy')({ onBudgetExceeded: 'throttle' })).toBe(false);
    expect(validator('EgressPolicy')({ upstream: { type: 'ftp', host: 'h', port: 21 } })).toBe(false);
    expect(validator('Error')({ error: { ...apiError.error, code: 'teapot' } })).toBe(false);
  });

  // Revue browser-0.1 : en-têtes posés par la passerelle ou l'egress (Host, saut à saut, Proxy-*), jamais par le client ;
  // l'hôte du proxy amont est un nom ou une adresse nus (la garde SSRF de 04c § 1 s'y applique à l'exécution, tâches 1.5 et 2.x).
  test.each(['Host', 'host', 'Proxy-Authorization', 'proxy-connection', 'Proxy-Foo', 'Connection', 'Keep-Alive', 'Transfer-Encoding', 'TE', 'Trailer', 'Upgrade', 'bad name', 'X-A:b', ''])(
    'extraHTTPHeaders invalide : %j',
    (name) => {
      expect(validator('CreateSessionRequest')({ extraHTTPHeaders: { [name]: 'x' } })).toBe(false);
    },
  );

  test('extraHTTPHeaders valides : en-têtes applicatifs', () => {
    expect(validator('CreateSessionRequest')({ extraHTTPHeaders: { 'X-Trace': '1', 'Accept-Language': 'fr-FR', 'x-hostname': 'a', Teapot: 'b' } })).toBe(true);
  });

  test.each(['http://proxy.example.com', 'proxy.example.com/path', 'user@proxy.example.com', 'proxy example.com', 'proxy.example.com:8080', ''])(
    'hôte de proxy amont invalide : %j',
    (host) => {
      expect(validator('EgressPolicy')({ upstream: { type: 'http', host, port: 8080 } })).toBe(false);
    },
  );

  test.each(['proxy.example.com', 'proxy-1.example.com', '203.0.113.7', '2001:db8::1'])('hôte de proxy amont valide : %s', (host) => {
    expect(validator('EgressPolicy')({ upstream: { type: 'http', host, port: 8080 } })).toBe(true);
  });

  test('événement discriminé par type (contrôle de types à la compilation)', () => {
    const event: SessionEvent = { type: 'egress.blocked', sessionId: session.id, at: session.createdAt, data: { host: 'evil.example', reason: 'domain_not_allowed', count: 1 } };
    expect(event.type).toBe('egress.blocked');
    // @ts-expect-error : un motif hors liste est refusé par le type.
    const wrong: SessionEvent = { type: 'egress.blocked', sessionId: session.id, at: session.createdAt, data: { host: 'h', reason: 'nope', count: 1 } };
    expect(wrong.type).toBe('egress.blocked');
  });
});

describe('session_default_dedicated (F1, F9) : contrat v1.2 de 04 et 04f', () => {
  const id = '6f1c0a52-3d1e-4c0b-9a52-2f0d9d7c1b11';
  const base: Session = { id, state: 'running', type: 'dedicated', expiresAt: '2026-10-02T10:05:00Z', createdAt: '2026-10-02T10:00:00Z' };
  const dedicatedUrls: ConnectUrls = { cdp: `wss://b.example.com/v1/sessions/${id}/cdp?token=t`, playwright: `wss://b.example.com/v1/sessions/${id}/playwright?token=t`, bidi: null };

  test('type par défaut : dedicated (constante et défaut du schéma de création)', () => {
    expect(DEFAULT_SESSION_TYPE).toBe('dedicated');
    expect(browserOpenApi.components.schemas.CreateSessionRequest.properties.type.default).toBe('dedicated');
  });

  test('connectUrls : trois clés, cdp chaîne ou null, bidi null', () => {
    expect(validator('Session')({ ...base, connectUrls: dedicatedUrls })).toBe(true);
    expect(validator('Session')({ ...base, type: 'shared', connectUrls: { ...dedicatedUrls, cdp: null } })).toBe(true);
    // Ancienne forme (v0.1 : cdp facultatif, pas de bidi) refusée.
    expect(validator('Session')({ ...base, connectUrls: { playwright: dedicatedUrls.playwright } })).toBe(false);
    expect(validator('Session')({ ...base, connectUrls: { ...dedicatedUrls, bidi: 'wss://b.example.com/bidi' } })).toBe(false);
    expect(validator('Session')({ ...base, connectUrls: { ...dedicatedUrls, cdp: 'https://b.example.com/cdp' } })).toBe(false);
    expect(validator('Session')({ ...base, connectUrls: { ...dedicatedUrls, extra: 'x' } })).toBe(false);
  });

  test('GET /v1/version : product sym-browser et contract = version du contrat publié', () => {
    expect(BROWSER_PRODUCT).toBe('sym-browser');
    expect(BROWSER_PROTOCOL_VERSION).toBe('1.0.0');
    const version = { product: 'sym-browser', api: '1', contract: BROWSER_PROTOCOL_VERSION, playwright: '1.63.0', chromium: '153.0.8010.12', platform: 'linux', minSdk: '1.0.0' };
    expect(validator('VersionInfo')(version)).toBe(true);
    expect(validator('VersionInfo')({ ...version, product: 'browserless' })).toBe(false);
    const { product: _product, ...withoutProduct } = version;
    expect(validator('VersionInfo')(withoutProduct)).toBe(false);
    const { contract: _contract, ...withoutContract } = version;
    expect(validator('VersionInfo')(withoutContract)).toBe(false);
  });

  test('erreur protocol_not_served (409) au contrat ; chaque code a son statut HTTP de 04 § 6', () => {
    expect(ERROR_CODES).toContain('protocol_not_served');
    expect(ERROR_STATUS).toEqual({
      unauthorized: 401,
      forbidden: 403,
      session_not_found: 404,
      profile_locked: 409,
      session_id_taken: 409,
      idempotency_conflict: 409,
      protocol_not_served: 409,
      invalid_option: 422,
      playwright_version_mismatch: 428,
      quota_exceeded: 429,
      capacity_exceeded: 429,
      proxy_unreachable: 502,
      no_node: 503,
    });
  });

  test('chaque opération déclare ses réponses d’erreur au schéma Error, avec 401 et 403 sur les routes authentifiées', () => {
    for (const [path, item] of Object.entries(browserOpenApi.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, { security?: unknown[]; responses: Record<string, { content?: unknown }> }>)) {
        const secured = op.security === undefined || op.security.length > 0;
        if (secured) expect(Object.keys(op.responses), `${method} ${path}`).toEqual(expect.arrayContaining(['401', '403']));
        for (const [status, response] of Object.entries(op.responses)) {
          if (Number(status) >= 400) expect(response.content, `${method} ${path} ${status}`).toEqual({ 'application/json': { schema: { $ref: '#/components/schemas/Error' } } });
        }
      }
    }
  });
});
