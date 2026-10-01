// SPDX-License-Identifier: AGPL-3.0-only
// Données de la gate d'accessibilité (tâche 3.9) : objets conformes à l'OpenAPI (types du client généré), servis par le faux
// serveur de harness.ts. Tout y est fictif (`zz-`, domaines `.example`) ; aucune donnée réelle.
import { readFileSync } from 'node:fs';
import type { components } from '@runtime/client';
import type { ApiRoutes } from './harness.ts';

type Schemas = components['schemas'];

export const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ME = (locale: 'en' | 'fr', theme: 'light' | 'dark'): Schemas['Me'] => ({
  id: UUID(900),
  email: 'ada@zz-test.example',
  displayName: 'Ada',
  role: 'owner',
  locale,
  theme,
  via: 'ui',
  scopes: null,
});

const STATUSES: Schemas['ApiStatus'][] = ['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'];

const REASONS: Record<Schemas['ApiStatus'], Schemas['ReasonMessage']> = {
  enquete: { code: 'investigating', params: { n: 3, m: 6, execution: 'fetch_in_page' } },
  sain: { code: 'healthy', params: { n: 3, date: '2026-10-01T08:00:00.000Z' } },
  warning: { code: 'escalated', params: {} },
  reparation: { code: 'repairing', params: { n: 1, m: 3 } },
  erreur: { code: 'repair_exhausted', params: { a: 4 } },
  action_requise: { code: 'cookie_expired', params: { domain: 'monsite.example' } },
  bloquee: { code: 'blocked_by_protection', params: {} },
};

const summary = (overrides: Partial<Schemas['ApiSummary']> = {}): Schemas['ApiSummary'] => ({
  id: UUID(1),
  slug: 'zz-books',
  description: 'Livres de la page d’accueil',
  status: 'sain',
  status_reason: REASONS.sain,
  stale: false,
  execution: 'fetch',
  network: 'direct',
  requires: { session_domain: null, tunnel: false },
  avg_cost_usd: 0.002,
  avg_cost_estimated: true,
  last_run_at: '2026-10-01T08:00:00.000Z',
  success_rate_30d: 0.97,
  access_signal: 'allowed',
  visibility: 'private',
  ...overrides,
});

/** Une API par statut (le catalogue de 06 § 4.3) ; la première `sain` porte aussi le drapeau `stale`. */
export const catalog = (): Schemas['ApiSummary'][] =>
  STATUSES.map((status, index) =>
    summary({
      id: UUID(index + 1),
      slug: `zz-${status.replace('_', '-')}`,
      status,
      status_reason: REASONS[status],
      stale: status === 'sain',
      execution: (['fetch', 'fetch_in_page', 'playwright', 'agent_fetch', 'hybrid', 'agent', 'fetch'] as const)[index] ?? 'fetch',
      network: (['direct', 'dc_proxy', 'res_proxy', 'tunnel', 'direct', 'direct', 'direct'] as const)[index] ?? 'direct',
      requires: { session_domain: status === 'action_requise' ? 'monsite.example' : null, tunnel: false },
      access_signal: status === 'bloquee' ? 'disallowed' : status === 'warning' ? 'review' : 'allowed',
    }),
  );

const run = (n: number, overrides: Partial<Schemas['RunSummary']> = {}): Schemas['RunSummary'] => ({
  id: UUID(200 + n),
  api_id: UUID(1),
  api_slug: 'zz-books',
  owner_id: UUID(900),
  strategy_version: 3,
  trigger: 'ui',
  state: 'succeeded',
  outcome: 'clean',
  degraded_reasons: [],
  failure_class: null,
  created_at: '2026-09-30T09:00:00.000Z',
  started_at: '2026-09-30T09:00:01.000Z',
  finished_at: '2026-09-30T09:00:03.000Z',
  duration_ms: 2000,
  cost: { llm_usd: 0, proxy_usd: 0, total_usd: 0.002, estimated: false },
  items: 20,
  dataset_id: UUID(300 + n),
  retention_until: '2026-10-30T09:00:00.000Z',
  ...overrides,
});

export const runsOf = (slug: string): Schemas['RunSummary'][] => [
  run(1, { api_slug: slug }),
  run(2, { api_slug: slug, state: 'failed', outcome: 'failed', failure_class: 'blocked_by_protection', items: 0, dataset_id: null, trigger: 'schedule' }),
  run(3, { api_slug: slug, outcome: 'degraded', degraded_reasons: ['retried'], trigger: 'mcp' }),
];

const version = (n: number, overrides: Partial<Schemas['StrategyVersionSummary']> = {}): Schemas['StrategyVersionSummary'] => ({
  version: n,
  execution: 'fetch',
  network: 'direct',
  est_cost_usd: 0.001,
  created_by: n === 1 ? 'investigation' : 'repair',
  parent_version: n > 1 ? n - 1 : null,
  created_at: `2026-09-2${n}T10:00:00.000Z`,
  validated_samples: 5,
  run_id: UUID(100 + n),
  ...overrides,
});

const accessReport: Schemas['AccessReport'] = {
  id: UUID(500),
  checked_at: '2026-10-01T08:00:00.000Z',
  signal: 'review',
  robots: { status: 'allowed', fetched_at: '2026-10-01T08:00:00.000Z', rule: null },
  usage_signals: [{ kind: 'ai-preference', value: 'train-ai=n' }],
  llms_txt: true,
  payment_offer: null,
  official_api_url: 'https://api.zz-test.example/docs',
};

export const detail = (status: Schemas['ApiStatus'], slug = `zz-${status.replace('_', '-')}`): Schemas['ApiDetail'] => ({
  ...summary({ id: UUID(1), slug, status, status_reason: REASONS[status], access_signal: status === 'bloquee' ? 'disallowed' : 'allowed' }),
  metadata_only: false,
  investigation_phase: status === 'enquete' ? 'testing' : 'done',
  current_strategy_version: 3,
  current_strategy: version(3),
  input_schema: { type: 'object', required: ['max_pages'], properties: { max_pages: { type: 'integer', description: 'Pages à lire' }, category: { type: 'string', enum: ['all', 'fiction'] } } },
  output_schema: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } },
  views: { columns: ['title', 'price'] },
  clean_streak: 4,
  network_policy: { allow: ['direct', 'dc_proxy'] },
  access_policy: { robots: 'respect', report_id: UUID(500) },
  access_report: accessReport,
  purpose: 'Veille tarifaire',
  legal_basis: null,
  contains_personal_data: false,
  allow_write_actions: false,
  max_cost_usd: 0.5,
  budget_daily_usd: 5,
  cost_estimate: { median_usd: 0.002, sample_size: 10 },
  session_owner: null,
  recent_runs: runsOf(slug),
  retention_days: 30,
  created_at: '2026-09-20T10:00:00.000Z',
});

/** Réponses de l'API commune à tous les écrans d'un utilisateur connecté. */
export function signedInRoutes(locale: 'en' | 'fr', theme: 'light' | 'dark'): ApiRoutes {
  const me = ME(locale, theme);
  return {
    'GET /api/auth/get-session': { body: { session: { id: 's' }, user: { id: me.id, email: me.email } } },
    'GET /api/me': { body: me },
    'GET /api/version': { body: { version: '0.0.0', commit: 'zz', schema_version: 1, build_date: '2026-10-01' } },
  };
}

export const anonymousRoutes: ApiRoutes = {
  'GET /api/auth/get-session': { body: null },
  'POST /api/auth/sign-in/email': { status: 401, body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'zz' } },
};

/** Routes de données : catalogue, fiches, runs, réglages. */
export function dataRoutes(): ApiRoutes {
  const apis = catalog();
  return {
    'GET /api/apis': { body: { apis, next_cursor: 'zz-next' } satisfies Schemas['ApiList'] },
    'GET /api/apis/:slug': (request) => {
      const found = apis.find((api) => api.slug === request.params.slug);
      return found ? { body: detail(found.status, found.slug) } : { status: 404, body: { error: { code: 'not_found', message: 'zz' } } };
    },
    'GET /api/apis/:slug/versions': { body: { versions: [version(3), version(2), version(1)], next_cursor: null } satisfies Schemas['StrategyVersionList'] },
    'GET /api/apis/:slug/versions/:version': (request) => ({
      body: { ...version(Number(request.params.version)), spec: { steps: [{ fetch: 'https://zz-test.example/list' }] }, script_ref: null } satisfies Schemas['StrategyVersion'],
    }),
    'GET /api/apis/:slug/versions/:version/diff': (request) => ({
      body: {
        from: Number(request.query.get('against') ?? 1),
        to: Number(request.params.version),
        summary: { code: 'repaired', params: { a: 2, b: 3 } },
        fields: [{ path: 'steps[0].fetch', change: 'changed', before: 'https://zz-test.example/a', after: 'https://zz-test.example/b' }],
        raw: { before: { steps: [{ fetch: 'https://zz-test.example/a' }] }, after: { steps: [{ fetch: 'https://zz-test.example/b' }] } },
      } satisfies Schemas['StrategyDiff'],
    }),
    'GET /api/apis/:slug/status-events': {
      body: {
        events: [
          { id: UUID(600), at: '2026-09-30T09:00:03.000Z', from_status: 'sain', to_status: 'warning', transition: 12, reason: { code: 'escalated', params: {} }, failure_class: null, run_id: UUID(203) },
          { id: UUID(601), at: '2026-09-21T09:00:03.000Z', from_status: 'enquete', to_status: 'sain', transition: 4, reason: null, failure_class: null, run_id: UUID(201) },
        ],
        next_cursor: null,
      } satisfies Schemas['StatusEventList'],
    },
    'GET /api/apis/:slug/runs': (request) => ({ body: { runs: runsOf(request.params.slug ?? 'zz-books'), next_cursor: null } }),
    'GET /api/apis/:slug/schedules': {
      body: {
        schedules: [
          { id: UUID(400), api_slug: 'zz-sain', cron: '0 8 * * *', timezone: 'Europe/Paris', input: {}, overlap: 'skip', missed: 'once', rules: {}, enabled: true, paused_reason: null, next_runs: ['2026-10-02T06:00:00.000Z'], created_at: '2026-09-01T10:00:00.000Z' },
          { id: UUID(401), api_slug: 'zz-sain', cron: '*/30 * * * *', timezone: 'UTC', input: { max_pages: 2 }, overlap: 'queue', missed: 'skip', rules: {}, enabled: false, paused_reason: 'status_not_healthy', next_runs: [], created_at: '2026-09-02T10:00:00.000Z' },
        ],
      } satisfies Schemas['ScheduleList'],
    },
    'GET /api/runs': (request) => {
      const slug = request.query.get('api');
      return { body: { runs: runsOf(slug ?? 'zz-books'), next_cursor: slug ? null : 'zz-next' } satisfies Schemas['RunList'] };
    },
    'GET /api/runs/:id': (request) => ({
      body: {
        ...run(1, { id: request.params.id ?? UUID(201) }),
        metadata_only: false,
        attempts: [
          { index: 0, execution: 'fetch', network: 'direct', state: 'done', est_cost_usd: 0.0004, result: 'extraction', cost_usd: 0.0004, ms: 240 },
          { index: 1, execution: 'agent', network: 'direct', state: 'pruned', pruned_reason: 'cheaper_succeeded', est_cost_usd: 0.09, result: null, cost_usd: null, ms: null },
        ],
        tokens: { in: 0, cached: 0, out: 0, reasoning: 0, estimated: false },
      } satisfies Schemas['Run'],
    }),
    'GET /api/datasets/:id/items': { body: { items: [{ title: 'Livre A', price: 12.5 }, { title: 'Livre B', price: 9 }], next_cursor: null } satisfies Schemas['DatasetItems'] },
    'GET /api/settings/llm': {
      body: {
        providers: [
          { id: 'zai', preset: 'zai', base_url: 'https://api.zz-test.example/v1', api_key_set: true, headers_set: false },
          { id: 'local', preset: 'ollama', base_url: 'http://localhost:11434/v1', api_key_set: false, headers_set: false },
          { id: 'vieux', preset: 'custom', base_url: 'https://old.zz-test.example/v1', api_key_set: true, headers_set: false, api_key_unreadable: true },
        ],
        roles: { investigate: { provider: 'zai', model: 'glm-5.3' }, extract: { provider: 'local', model: 'qwen' } },
        redact: { enabled: true, patterns: ['\\d{16}'] },
        log_prompts: { enabled: false, retention_days: 7 },
      } satisfies Schemas['LlmSettings'],
    },
    'GET /api/settings/proxies': {
      body: {
        proxies: [
          { id: UUID(700), label: 'Datacenter FR', type: 'dc', url: 'http://proxy.zz-test.example:8080', username_set: true, password_set: true, params: {}, price: { per_gb_usd: 0.5 }, tested_at: '2026-10-01T08:00:00.000Z' },
          { id: UUID(701), label: 'Résidentiel DE', type: 'res', url: 'http://res.zz-test.example:8080', username_set: true, password_set: true, params: { country: 'de' }, username_template: 'user-country-{country}', price: { per_gb_usd: 4 }, tested_at: null },
        ],
      } satisfies Schemas['ProxyList'],
    },
    'GET /api/settings/smtp': { body: { host: 'smtp.zz-test.example', port: 587, security: 'starttls', from: 'alerts@zz-test.example', username_set: true, password_set: true, tested_at: null } satisfies Schemas['SmtpSettings'] },
    'GET /api/webhook-subscriptions': {
      body: {
        subscriptions: [
          {
            id: UUID(800),
            url: 'https://hooks.zz-test.example/in',
            events: ['run.succeeded', 'api.status_changed'],
            api_slug: null,
            status: 'active',
            tested_at: '2026-10-01T08:00:00.000Z',
            created_at: '2026-09-25T08:00:00.000Z',
            deliveries: [{ id: UUID(801), at: '2026-10-01T08:00:00.000Z', event: 'run.succeeded', attempt: 1, status_code: 200, duration_ms: 120, excerpt: 'ok' }],
          },
        ],
      } satisfies Schemas['WebhookSubscriptionList'],
    },
    'GET /api/extension/devices': {
      body: { items: [{ id: UUID(850), deviceLabel: 'Chrome du bureau', createdAt: '2026-09-25T08:00:00.000Z', lastSeenAt: '2026-10-01T07:00:00.000Z', expiresAt: '2026-12-25T08:00:00.000Z', revokedAt: null }] } satisfies Schemas['ExtensionDeviceList'],
    },
    'GET /api/sites': {
      body: { items: [{ id: UUID(860), domain: 'monsite.example', serverUseAllowed: false, hasServerCookies: false, consentedAt: '2026-09-26T08:00:00.000Z', capturedAt: '2026-09-26T08:05:00.000Z', expiresAt: null }] } satisfies Schemas['ConnectedSiteList'],
    },
  };
}

/** Texte traduit d'une clé de la console (fichiers de langue de src/i18n), pour attendre le texte exact affiché. */
export function text(locale: 'en' | 'fr', key: string): string {
  const messages = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
  const found = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), messages);
  if (typeof found !== 'string') throw new Error(`clé absente : ${locale} ${key}`);
  return found;
}
