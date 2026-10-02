// SPDX-License-Identifier: MIT
// OpenAPI 3.1 minimal de l'API REST `/v1` de SYM Browser (cdc/sym-browser 04 § 1 à § 6). Document de départ : cycle de vie
// des sessions, politique d'egress et version. Il grandit avec les tâches 2.x (2.2 le valide contre les réponses réelles).
// Les énumérations viennent des constantes du contrat : le schéma et les types TypeScript ne peuvent pas diverger.
import { EGRESS_BLOCK_REASONS, ON_BUDGET_EXCEEDED, UPSTREAM_PROXY_KINDS, UPSTREAM_PROXY_TYPES } from './egress.js';
import { ERROR_CODES } from './errors.js';
import { COLOR_SCHEMES, END_REASONS, LAUNCH_ARGS, PROFILE_MODES, RESERVED_EXTRA_HEADER_PREFIXES, RESERVED_EXTRA_HEADERS, SESSION_STATES, SESSION_TYPES } from './session.js';
import { BROWSER_PROTOCOL_VERSION } from './version.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` }) as const;
const json = (schema: object) => ({ 'application/json': { schema } }) as const;
const error = (description: string) => ({ description, content: json(ref('Error')) }) as const;
const sessionId = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } } as const;
const strings = { type: 'object', additionalProperties: { type: 'string' } } as const;
const nonNegative = { type: 'integer', minimum: 0 } as const;
/** Motif insensible à la casse sans drapeau (JSON Schema n'en a pas) : `te` → `[tT][eE]` ; les noms réservés sont des lettres et des tirets. */
const caseless = (name: string) => [...name].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('');
/** Noms d'en-têtes : jeton RFC 9110 § 5.6.2, hors en-têtes réservés au navigateur et à l'egress (RESERVED_EXTRA_HEADERS). */
const extraHeaders = {
  type: 'object',
  propertyNames: {
    pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
    not: { pattern: `^(?:${[...RESERVED_EXTRA_HEADERS.map(caseless), ...RESERVED_EXTRA_HEADER_PREFIXES.map((prefix) => `${caseless(prefix)}.*`)].join('|')})$` },
  },
  additionalProperties: { type: 'string' },
} as const;
/** Hôte nu du proxy amont (nom DNS, IPv4 ou IPv6, sans schéma, port, chemin ni identifiants). La garde SSRF (04c § 1) s'y applique à l'exécution (tâches 1.5 et 2.x). */
const proxyHost = {
  type: 'string',
  anyOf: [
    { pattern: '^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$' },
    { pattern: '^(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}$' },
  ],
} as const;

export const browserOpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'SYM Browser API',
    version: BROWSER_PROTOCOL_VERSION,
    license: { name: 'MIT', identifier: 'MIT' },
  },
  servers: [{ url: '/v1' }],
  security: [{ bearer: [] }],
  paths: {
    '/sessions': {
      post: {
        operationId: 'createSession',
        parameters: [
          { name: 'wait', in: 'query', required: false, schema: { type: 'boolean', default: true } },
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 128 } },
        ],
        requestBody: { required: false, content: json(ref('CreateSessionRequest')) },
        responses: {
          '201': { description: 'Session `running`', content: json(ref('Session')) },
          '202': { description: 'Session `pending` (`wait=false`)', content: json(ref('Session')) },
          '401': error('Clé absente, inconnue ou expirée'),
          '409': error('`session_id_taken` ou `idempotency_conflict`'),
          '422': error('`invalid_option`'),
          '429': error('`quota_exceeded` ou `capacity_exceeded`, avec `Retry-After`'),
          '502': error('`proxy_unreachable`'),
          '503': error('`no_node`, avec `Retry-After`'),
        },
      },
      get: {
        operationId: 'listSessions',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { enum: [...SESSION_STATES] } },
          { name: 'type', in: 'query', required: false, schema: { enum: [...SESSION_TYPES] } },
        ],
        responses: { '200': { description: 'Page de sessions', content: json(ref('SessionPage')) }, '401': error('Non authentifié') },
      },
    },
    '/sessions/{id}': {
      get: {
        operationId: 'getSession',
        parameters: [sessionId],
        responses: { '200': { description: 'Session', content: json(ref('Session')) }, '404': error('`session_not_found`') },
      },
      delete: {
        operationId: 'releaseSession',
        parameters: [sessionId],
        responses: { '200': { description: 'Session libérée (rejouable sans effet)', content: json(ref('Session')) }, '404': error('`session_not_found`') },
      },
    },
    '/sessions/{id}/extend': {
      post: {
        operationId: 'extendSession',
        parameters: [sessionId],
        requestBody: { required: true, content: json(ref('ExtendSessionRequest')) },
        responses: { '200': { description: 'Session prolongée', content: json(ref('Session')) }, '404': error('`session_not_found`') },
      },
    },
    '/sessions/{id}/egress': {
      get: {
        operationId: 'getSessionEgress',
        parameters: [sessionId],
        responses: { '200': { description: "Compteurs de l'époque", content: json(ref('EgressState')) }, '404': error('`session_not_found`') },
      },
      put: {
        operationId: 'replaceSessionEgress',
        parameters: [sessionId],
        requestBody: { required: true, content: json(ref('EgressPolicy')) },
        responses: { '200': { description: 'Nouvelle époque ouverte', content: json(ref('EgressState')) }, '422': error('`invalid_option`') },
      },
    },
    '/version': {
      get: {
        operationId: 'getVersion',
        security: [],
        responses: { '200': { description: 'Versions servies', content: json(ref('VersionInfo')) } },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      UpstreamProxy: {
        type: 'object',
        required: ['type', 'host', 'port'],
        properties: {
          type: { enum: [...UPSTREAM_PROXY_TYPES] },
          host: proxyHost,
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          username: { type: 'string' },
          password: { type: 'string', writeOnly: true },
          kind: { enum: [...UPSTREAM_PROXY_KINDS] },
        },
        additionalProperties: false,
      },
      EgressPolicy: {
        type: 'object',
        properties: {
          allowedHosts: { type: 'array', items: { type: 'string' } },
          ports: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 65535 } },
          upstream: {
            oneOf: [
              ref('UpstreamProxy'),
              { type: 'object', required: ['profileId'], properties: { profileId: { type: 'string' } }, additionalProperties: false },
            ],
          },
          dnsViaProxy: { type: 'boolean' },
          budgetBytes: nonNegative,
          onBudgetExceeded: { enum: [...ON_BUDGET_EXCEEDED] },
        },
        additionalProperties: false,
      },
      EgressState: {
        type: 'object',
        required: ['epoch', 'requests', 'blocked', 'bytesIn', 'bytesOut', 'budgetExceeded'],
        properties: {
          epoch: nonNegative,
          requests: nonNegative,
          blocked: nonNegative,
          bytesIn: nonNegative,
          bytesOut: nonNegative,
          budgetBytes: nonNegative,
          budgetExceeded: { type: 'boolean' },
          exitIp: { type: 'string' },
          latencyMs: nonNegative,
        },
      },
      EgressBlockReason: { enum: [...EGRESS_BLOCK_REASONS] },
      CreateSessionRequest: {
        type: 'object',
        properties: {
          type: { enum: [...SESSION_TYPES] },
          id: { type: 'string', format: 'uuid' },
          region: { type: 'string' },
          timeoutSeconds: { type: 'integer', minimum: 1 },
          idleTimeoutSeconds: { type: 'integer', minimum: 1 },
          viewport: {
            type: 'object',
            required: ['width', 'height'],
            properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } },
          },
          locale: { type: 'string' },
          timezoneId: { type: 'string' },
          userAgent: { type: 'string', maxLength: 512 },
          extraHTTPHeaders: extraHeaders,
          geolocation: {
            type: 'object',
            required: ['latitude', 'longitude'],
            properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' } },
          },
          colorScheme: { enum: [...COLOR_SCHEMES] },
          acceptDownloads: { type: 'boolean' },
          launchArgs: { type: 'array', items: { enum: [...LAUNCH_ARGS] } },
          egress: ref('EgressPolicy'),
          profile: {
            type: 'object',
            required: ['id', 'mode'],
            properties: { id: { type: 'string' }, mode: { enum: [...PROFILE_MODES] } },
          },
          storageState: { type: 'object' },
          recordings: {
            type: 'object',
            properties: {
              trace: { type: 'boolean' },
              har: { type: 'boolean' },
              video: { type: 'boolean' },
              console: { type: 'boolean' },
              network: { type: 'boolean' },
            },
          },
          liveView: { type: 'object', properties: { interactive: { type: 'boolean' } } },
          metadata: { ...strings, maxProperties: 16 },
        },
        additionalProperties: false,
      },
      ExtendSessionRequest: {
        type: 'object',
        required: ['timeoutSeconds'],
        properties: { timeoutSeconds: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
      Session: {
        type: 'object',
        required: ['id', 'state', 'type', 'expiresAt', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          state: { enum: [...SESSION_STATES] },
          type: { enum: [...SESSION_TYPES] },
          nodeRegion: { type: 'string' },
          connectUrls: {
            type: 'object',
            required: ['playwright'],
            properties: { playwright: { type: 'string' }, cdp: { type: 'string' } },
          },
          liveViewUrl: { type: 'string' },
          egress: { type: 'object', properties: { exitIp: { type: 'string' }, latencyMs: nonNegative } },
          expiresAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          endReason: { enum: [...END_REASONS] },
          usage: {
            type: 'object',
            required: ['seconds', 'bytesIn', 'bytesOut'],
            properties: { seconds: nonNegative, bytesIn: nonNegative, bytesOut: nonNegative },
          },
          metadata: strings,
        },
      },
      SessionPage: {
        type: 'object',
        required: ['data', 'nextCursor'],
        properties: { data: { type: 'array', items: ref('Session') }, nextCursor: { type: ['string', 'null'] } },
      },
      VersionInfo: {
        type: 'object',
        required: ['api', 'playwright', 'chromium', 'platform', 'minSdk'],
        properties: {
          api: { type: 'string' },
          playwright: { type: 'string' },
          chromium: { type: 'string' },
          platform: { type: 'string' },
          minSdk: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'retryable', 'what_to_do', 'requestId'],
            properties: {
              code: { enum: [...ERROR_CODES] },
              message: { type: 'string' },
              retryable: { type: 'boolean' },
              what_to_do: { type: 'string' },
              requestId: { type: 'string' },
              details: {},
            },
          },
        },
      },
    },
  },
} as const;
