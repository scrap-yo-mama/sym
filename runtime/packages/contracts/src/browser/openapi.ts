// SPDX-License-Identifier: MIT
// OpenAPI 3.1 de l'API REST `/v1` de SYM Browser (cdc/sym-browser 04 § 1 à § 9, 04f § 2). Il ne publie que les routes
// servies : cycle de vie des sessions et version (tâche 2.2, validé contre les réponses réelles par Schemathesis). Les
// routes suivantes (egress, événements, fichiers, profils…) y entrent avec leur tâche ; leurs schémas (EgressPolicy,
// EgressState) sont déjà là. Les énumérations viennent des constantes du contrat : schéma et types ne peuvent pas diverger.
import { EGRESS_BLOCK_REASONS, ON_BUDGET_EXCEEDED, UPSTREAM_PROXY_KINDS, UPSTREAM_PROXY_TYPES } from './egress.js';
import { ERROR_CODES } from './errors.js';
import {
  COLOR_SCHEMES,
  DEFAULT_SESSION_TYPE,
  END_REASONS,
  LAUNCH_ARGS,
  METADATA_LIMITS,
  PROFILE_MODES,
  RESERVED_EXTRA_HEADER_PREFIXES,
  RESERVED_EXTRA_HEADERS,
  SESSION_STATES,
  SESSION_TYPES,
} from './session.js';
import { BROWSER_PRODUCT, BROWSER_PROTOCOL_VERSION } from './version.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` }) as const;
const json = (schema: object) => ({ 'application/json': { schema } }) as const;
const error = (description: string) => ({ description, content: json(ref('Error')) }) as const;
/** Erreurs d'une opération authentifiée : 401 et 403 toujours, plus celles de l'opération (04 § 6). */
const secured = <R extends Record<string, unknown>>(responses: R) =>
  ({ ...responses, '401': error('`unauthorized` : clé absente, inconnue ou expirée'), '403': error('`forbidden` : scope manquant') }) as const;
const sessionId = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } } as const;
const idempotencyKey = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 128 } } as const;
const nonNegative = { type: 'integer', minimum: 0 } as const;
/** Durées en secondes, bornées à un an (la durée maximale du client plafonne de toute façon). */
const seconds = { type: 'integer', minimum: 1, maximum: 31_536_000 } as const;
/** URL WebSocket à jeton (`wss://` derrière TLS ; `ws://` en boucle locale de développement). */
const wsUrl = { type: 'string', pattern: '^wss?://' } as const;
// Caractères de contrôle interdits (C0 et DEL ; tabulation admise dans une valeur d'en-tête) : mêmes règles que le nœud (1.3).
const NO_CONTROL = '^[^\\u0000-\\u001f\\u007f]*$';
const NO_CONTROL_EXCEPT_TAB = '^[^\\u0000-\\u0008\\u000a-\\u001f\\u007f]*$';
/** `metadata` (04 § 3) : 16 clés de 1 à 64 caractères `[A-Za-z0-9_.-]` (filtre `metadata.{clé}` de la liste), valeurs ≤ 512. */
const metadata = {
  type: 'object',
  maxProperties: METADATA_LIMITS.maxKeys,
  propertyNames: { pattern: `^[A-Za-z0-9_.-]{1,${METADATA_LIMITS.maxKeyLength}}$` },
  additionalProperties: { type: 'string', maxLength: METADATA_LIMITS.maxValueLength },
} as const;
/** Motif insensible à la casse sans drapeau (JSON Schema n'en a pas) : `te` → `[tT][eE]` ; les noms réservés sont des lettres et des tirets. */
const caseless = (name: string) => [...name].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('');
/** Noms d'en-têtes : jeton RFC 9110 § 5.6.2, hors en-têtes réservés au navigateur et à l'egress (RESERVED_EXTRA_HEADERS). */
const extraHeaders = {
  type: 'object',
  maxProperties: 64,
  propertyNames: {
    pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
    not: { pattern: `^(?:${[...RESERVED_EXTRA_HEADERS.map(caseless), ...RESERVED_EXTRA_HEADER_PREFIXES.map((prefix) => `${caseless(prefix)}.*`)].join('|')})$` },
  },
  additionalProperties: { type: 'string', maxLength: 8192, pattern: NO_CONTROL_EXCEPT_TAB },
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
        description: 'Crée une session (type par défaut `dedicated`) et attend qu’elle soit `running` ; `wait=false` rend la main en `pending`.',
        parameters: [{ name: 'wait', in: 'query', required: false, schema: { type: 'boolean', default: true } }, idempotencyKey],
        requestBody: { required: false, content: json(ref('CreateSessionRequest')) },
        responses: secured({
          '201': { description: 'Session `running`', content: json(ref('Session')) },
          '202': { description: 'Session `pending` (`wait=false`)', content: json(ref('Session')) },
          '409': error('`session_id_taken` ou `idempotency_conflict`'),
          '422': error('`invalid_option`, avec `details[]` (`field`, `reason`)'),
          '429': error('`quota_exceeded` ou `capacity_exceeded`, avec `Retry-After`'),
          '502': error('`proxy_unreachable`'),
          '503': error('`no_node`, avec `Retry-After`'),
        }),
      },
      get: {
        operationId: 'listSessions',
        description: 'Liste paginée par curseur, tri par `createdAt` décroissant. Filtre par métadonnée : `metadata.{clé}={valeur}`.',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { enum: [...SESSION_STATES] } },
          { name: 'type', in: 'query', required: false, schema: { enum: [...SESSION_TYPES] } },
          { name: 'createdAfter', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'createdBefore', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: secured({ '200': { description: 'Page de sessions', content: json(ref('SessionPage')) }, '422': error('`invalid_option` (limite, curseur, filtre)') }),
      },
    },
    '/sessions/{id}': {
      get: {
        operationId: 'getSession',
        description: 'Lit une session ; une session `running` reçoit des `connectUrls` à jeton neuf.',
        parameters: [sessionId],
        responses: secured({ '200': { description: 'Session', content: json(ref('Session')) }, '404': error('`session_not_found`') }),
      },
      delete: {
        operationId: 'releaseSession',
        description: 'Libère la session (raison `released`) ; rejouable sans effet.',
        parameters: [sessionId],
        responses: secured({ '200': { description: 'Session libérée', content: json(ref('Session')) }, '404': error('`session_not_found`') }),
      },
    },
    '/sessions/{id}/extend': {
      post: {
        operationId: 'extendSession',
        description: 'Ajoute du temps, plafonné par la durée maximale du client.',
        parameters: [sessionId, idempotencyKey],
        requestBody: { required: true, content: json(ref('ExtendSessionRequest')) },
        responses: secured({
          '200': { description: 'Session prolongée', content: json(ref('Session')) },
          '404': error('`session_not_found`'),
          '409': error('`idempotency_conflict`'),
          '422': error('`invalid_option` (durée, session terminée)'),
        }),
      },
    },
    '/sessions/{id}/egress': {
      get: {
        operationId: 'getSessionEgress',
        description: 'Compteurs de l’époque courante de l’egress de la session (demandes, refus, octets, budget, IP de sortie).',
        parameters: [sessionId],
        responses: secured({
          '200': { description: 'Etat de l’egress', content: json(ref('EgressState')) },
          '404': error('`session_not_found`'),
          '422': error('`invalid_option` (session terminée ou pas encore démarrée)'),
        }),
      },
      put: {
        operationId: 'replaceSessionEgress',
        description:
          'Remplace la politique d’egress à chaud : ouvre une nouvelle époque aux compteurs remis à zéro. Les identifiants d’un proxy amont ne sont ni stockés ni journalisés.',
        parameters: [sessionId],
        requestBody: { required: true, content: json(ref('EgressPolicy')) },
        responses: secured({
          '200': { description: 'Etat de la nouvelle époque', content: json(ref('EgressState')) },
          '404': error('`session_not_found`'),
          '422': error('`invalid_option` (politique refusée, session terminée ou pas encore démarrée)'),
          '502': error('`proxy_unreachable` (nouvel amont injoignable ; politique courante inchangée)'),
        }),
      },
    },
    '/version': {
      get: {
        operationId: 'getVersion',
        security: [],
        responses: { '200': { description: 'Versions servies', content: json(ref('VersionInfo')) } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        security: [],
        responses: { '200': { description: 'Ce document (OpenAPI 3.1)', content: json({ type: 'object' }) } },
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
          type: { enum: [...SESSION_TYPES], default: DEFAULT_SESSION_TYPE },
          id: { type: 'string', format: 'uuid' },
          region: { type: 'string', minLength: 1, maxLength: 64 },
          timeoutSeconds: seconds,
          idleTimeoutSeconds: seconds,
          viewport: {
            type: 'object',
            required: ['width', 'height'],
            properties: { width: { type: 'integer', minimum: 1, maximum: 7680 }, height: { type: 'integer', minimum: 1, maximum: 4320 } },
            additionalProperties: false,
          },
          locale: { type: 'string', minLength: 1, maxLength: 35 },
          timezoneId: { type: 'string', minLength: 1, maxLength: 64 },
          userAgent: { type: 'string', minLength: 1, maxLength: 512, pattern: NO_CONTROL },
          extraHTTPHeaders: extraHeaders,
          geolocation: {
            type: 'object',
            required: ['latitude', 'longitude'],
            properties: {
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              accuracy: { type: 'number', minimum: 0, maximum: 10_000_000 },
            },
            additionalProperties: false,
          },
          colorScheme: { enum: [...COLOR_SCHEMES] },
          acceptDownloads: { type: 'boolean' },
          launchArgs: { type: 'array', items: { enum: [...LAUNCH_ARGS] }, uniqueItems: true },
          egress: ref('EgressPolicy'),
          profile: {
            type: 'object',
            required: ['id', 'mode'],
            properties: { id: { type: 'string' }, mode: { enum: [...PROFILE_MODES] } },
            additionalProperties: false,
          },
          storageState: {
            type: 'object',
            required: ['cookies', 'origins'],
            properties: { cookies: { type: 'array', items: { type: 'object' } }, origins: { type: 'array', items: { type: 'object' } } },
          },
          recordings: {
            type: 'object',
            properties: {
              trace: { type: 'boolean' },
              har: { type: 'boolean' },
              video: { type: 'boolean' },
              console: { type: 'boolean' },
              network: { type: 'boolean' },
            },
            additionalProperties: false,
          },
          liveView: { type: 'object', properties: { interactive: { type: 'boolean' } }, additionalProperties: false },
          metadata,
        },
        additionalProperties: false,
      },
      ExtendSessionRequest: {
        type: 'object',
        required: ['timeoutSeconds'],
        properties: { timeoutSeconds: seconds },
        additionalProperties: false,
      },
      ConnectUrls: {
        type: 'object',
        required: ['cdp', 'playwright', 'bidi'],
        properties: { cdp: { type: ['string', 'null'], pattern: '^wss?://' }, playwright: wsUrl, bidi: { type: 'null' } },
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
          connectUrls: ref('ConnectUrls'),
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
          metadata,
        },
        additionalProperties: false,
      },
      SessionPage: {
        type: 'object',
        required: ['data', 'nextCursor'],
        properties: { data: { type: 'array', items: ref('Session') }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
      VersionInfo: {
        type: 'object',
        required: ['product', 'api', 'contract', 'playwright', 'chromium', 'platform', 'minSdk'],
        properties: {
          product: { const: BROWSER_PRODUCT },
          api: { type: 'string' },
          contract: { type: 'string' },
          playwright: { type: 'string' },
          chromium: { type: 'string' },
          platform: { type: 'string' },
          minSdk: { type: 'string' },
        },
        additionalProperties: false,
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
