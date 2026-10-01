// SPDX-License-Identifier: AGPL-3.0-only
// Données et aides de test de la console (tâche 3.4) : objets conformes à l'OpenAPI, serveur factice sur `fetch`, rendu
// côté serveur d'un composant avec i18n et routeur. Aucun navigateur : le parcours en navigateur réel est celui de 3.6.
import type { components } from '@runtime/client';
import { createSSRApp, h, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory } from 'vue-router';
import { createAppI18n, setLocale, type Locale } from '@/i18n/index';
import { buildApi, setApi } from '@/lib/api';
import { createAppRouter } from '@/router/index';

type Schemas = components['schemas'];

export const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function apiSummary(overrides: Partial<Schemas['ApiSummary']> = {}): Schemas['ApiSummary'] {
  return {
    id: UUID(1),
    slug: 'zz-books',
    description: 'Livres de la page d’accueil',
    status: 'sain',
    status_reason: null,
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
  };
}

export function apiDetail(overrides: Partial<Schemas['ApiDetail']> = {}): Schemas['ApiDetail'] {
  return {
    ...apiSummary(),
    metadata_only: false,
    investigation_phase: 'done',
    current_strategy_version: 3,
    input_schema: { type: 'object', required: ['max_pages'], properties: { max_pages: { type: 'integer', description: 'Pages à lire' }, category: { type: 'string', enum: ['all', 'fiction'] } } },
    output_schema: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } },
    views: { columns: ['title', 'price'] },
    cost_estimate: { median_usd: 0.002, sample_size: 10 },
    retention_days: 30,
    ...overrides,
  };
}

/** Une API par statut, chacune avec une raison en code stable : les 7 lignes du critère « raison lisible sans survol ». */
export function oneApiPerStatus(): Schemas['ApiSummary'][] {
  const reasons: Record<Schemas['ApiStatus'], Schemas['ReasonMessage']> = {
    enquete: { code: 'investigating', params: { n: 3, m: 6, execution: 'fetch_in_page' } },
    sain: { code: 'healthy', params: { n: 3, date: '2026-10-01T08:00:00.000Z' } },
    warning: { code: 'escalated', params: {} },
    reparation: { code: 'repairing', params: { n: 1, m: 3 } },
    erreur: { code: 'repair_exhausted', params: { a: 4 } },
    action_requise: { code: 'cookie_expired', params: { domain: 'monsite.example' } },
    bloquee: { code: 'blocked_by_protection', params: {} },
  };
  return (Object.keys(reasons) as Schemas['ApiStatus'][]).map((status, index) => apiSummary({ id: UUID(index + 1), slug: `zz-${status.replace('_', '-')}`, status, status_reason: reasons[status] }));
}

export const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type Handler = (request: Request) => Response | Promise<Response>;

/** Serveur factice : `routes` associe « MÉTHODE /chemin » à une réponse ; renvoie la liste des requêtes vues (« MÉTHODE /chemin?requête »). */
export function installApi(routes: Record<string, Handler>): string[] {
  const seen: string[] = [];
  setApi(
    buildApi({
      baseUrl: 'http://x.test',
      fetch: async (request) => {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}${url.search}`);
        const handler = routes[`${request.method} ${url.pathname}`];
        if (!handler) throw new TypeError(`réseau coupé : ${request.method} ${url.pathname}`);
        return handler(request);
      },
    }),
  );
  return seen;
}

/** Rend un composant en HTML (côté serveur) avec i18n chargée dans la langue demandée et le routeur de la console. */
export async function renderHtml(component: Component, props: Record<string, unknown> = {}, locale: Locale = 'fr'): Promise<string> {
  const i18n = createAppI18n();
  await setLocale(i18n.global, locale, { lang: '' } as HTMLElement);
  const router = createAppRouter(createMemoryHistory());
  const app = createSSRApp({ render: () => h(component, props) });
  app.use(i18n).use(router);
  return renderToString(app);
}

/** Texte brut d'un fragment HTML (balises retirées, entités courantes décodées, espaces réduits). */
export function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
