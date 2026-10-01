// SPDX-License-Identifier: AGPL-3.0-only
// E2 `fetch_in_page` et E3 `playwright` (tâche 1.6 ; 04 §3.1) sur un Chromium du pool, dans un contexte neuf dont tout
// le trafic passe par le proxy d'egress de l'essai (garde SSRF, barreau N1-N3 chaîné au proxy BYO). Même boucle
// déclarative qu'E1 (`runDeclarative`) : seul le transport change.
// - E2 : navigateur ouvert sur le site (origine de la requête), `fetch` injecté dans la page (contexte et cookies du
//   site), corps borné ;
// - E3 : navigation déterministe (GET), attente du rendu (sélecteur des enregistrements), DOM rendu extrait.
// Toute navigation passe par `guardedGoto` ; la cadence (1.9) est réservée avant chaque requête de la stratégie.
// `max_response_bytes` est tenu DANS la page, avant tout transfert au worker (browser/bounded.ts) : une page hostile ne
// fait pas charger des centaines de Mo au processus Node. Une redirection hors des domaines de l'API d'une requête DE LA
// STRATÉGIE (refusée par le proxy d'egress, que `context.route` ne voit pas) est une faute de stratégie
// (`domain_not_allowed`), jamais un réseau ; une sous-ressource tierce du site coupée ne change jamais la classe.
import {
  classifyExchange,
  classifyTransportError,
  encodeRequestBody,
  runDeclarative,
  type DeclarativeRunOptions,
  type DeclarativeRunResult,
  type ExecFailure,
  type HttpExchange,
  type Transport,
} from '@runtime/core/exec';
import { DslError } from '@runtime/core';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type SsrfGuard } from '@runtime/core/net';
import type { Page, Response } from 'playwright-core';
import { boundedContent, boundedRawBody, TOO_LARGE } from '../browser/bounded.js';
import type { BrowserPool } from '../browser/pool.js';
import { hostAllowed, isMainNavigation, openRunContext, trackStrategyRequests, type RunContext, type StrategyRequests } from '../browser/run-context.js';

const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
/** Attente du rendu d'une page (sélecteur des enregistrements) avant lecture du DOM. */
const BROWSER_RENDER_WAIT_MS = 10_000;

export type BrowserExecutorOptions = Omit<DeclarativeRunOptions, 'transport'> & {
  readonly pool: BrowserPool;
  readonly egress: BrowserEgress;
  readonly guard: SsrfGuard;
  readonly navigationTimeoutMs?: number;
  readonly renderWaitMs?: number;
};

const maxBytesOf = (options: BrowserExecutorOptions): number => options.spec.limits?.max_response_bytes ?? 5_000_000;

function capped(body: string | typeof TOO_LARGE): string {
  if (body === TOO_LARGE) throw new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
  return body;
}

/** Affine un échec quand le proxy d'egress ou la politique de domaines ont refusé une requête DE LA STRATÉGIE. */
function refine(result: DeclarativeRunResult, egress: BrowserEgress, strategy: StrategyRequests): DeclarativeRunResult {
  if (result.ok) return result;
  const { failure_class: cls } = result.failure;
  // Le proxy d'egress répond 403 `ssrf_blocked` (http) ou refuse le CONNECT (https, ws) : Chromium voit un 403 ou une
  // erreur réseau. Dans les deux cas, la cause journalisée est la garde.
  if (egress.blocked.length > 0 && (cls === 'network' || cls === 'code_error' || cls === 'transient' || cls === 'forbidden')) {
    return { ...result, failure: { failure_class: 'forbidden', retryable: false, detail: 'ssrf_blocked' } };
  }
  // Verrou de domaines sur la requête de la stratégie elle-même (redirection hors API : CONNECT refusé, Chromium voit
  // ERR_TUNNEL_CONNECTION_FAILED ; en http, 403 du proxy d'egress). Jamais sur les compteurs globaux : les sous-ressources
  // tierces du site coupées (presque tous les sites réels) ne changent pas la classe d'un 451, d'un 503 ou d'un réseau.
  if (strategy.cut() && (cls === 'network' || cls === 'code_error' || cls === 'transient' || cls === 'forbidden')) {
    return { ...result, failure: { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } };
  }
  return result;
}

/** Contexte de run neuf sur un Chromium du pool ; l'interruption du run (annulation, bail perdu) ferme le contexte. */
async function withRunContext(
  options: BrowserExecutorOptions,
  fn: (rc: RunContext, strategy: StrategyRequests) => Promise<DeclarativeRunResult>,
): Promise<DeclarativeRunResult> {
  return options.pool.run(options.signal, async (browser) => {
    const rc = await openRunContext(browser, { egressServer: options.egress.server, allowedHosts: options.spec.request.allowed_hosts });
    const strategy = trackStrategyRequests(rc.context, options.spec.request.allowed_hosts);
    const onAbort = () => void rc.close();
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      rc.page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS);
      rc.page.setDefaultTimeout(options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS);
      const result = await fn(rc, strategy);
      options.signal.throwIfAborted();
      return refine(result, options.egress, strategy);
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      await rc.close();
    }
  });
}

async function navigate(page: Page, url: string, options: BrowserExecutorOptions): Promise<{ status: number; headers: Record<string, string>; html: boolean; response: Response }> {
  const response = await guardedGoto(page, url, options.guard, { waitUntil: 'load' as const, timeout: options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS });
  if (response === null) throw new DslError('unsupported', 'navigation sans réponse HTTP');
  // Dernier saut hors des domaines de l'API : la réponse est le refus du proxy d'egress, pas celle du site.
  if (!hostAllowed(response.url(), options.spec.request.allowed_hosts)) throw new DomainNotAllowedError(new URL(response.url()).hostname);
  const headers = response.headers();
  return { status: response.status(), headers, html: /html/i.test(headers['content-type'] ?? 'text/html'), response };
}

/** Comparaison d'URL après normalisation (Chromium normalise l'URL d'une requête). */
function sameUrl(expected: string): (url: string) => boolean {
  let normalized = expected;
  try {
    normalized = new URL(expected).href;
  } catch {
    // URL déjà refusée en amont (interpréteur) ; comparaison brute.
  }
  return (url) => url === normalized || url === expected;
}

/** Échec de l'essai sans requête de stratégie (page d'accueil d'E2 refusée). */
const failed = (failure: ExecFailure): DeclarativeRunResult => ({ ok: false, failure, pages: 0, requests: 1 });

/** E2 : `fetch` exécuté dans la page du site (cookies et contexte du site), par Chromium donc par le proxy d'egress. */
export function runFetchInPageExecutor(options: BrowserExecutorOptions): Promise<DeclarativeRunResult> {
  const classify = options.classify ?? classifyExchange;
  const maxBytes = maxBytesOf(options);
  const pageUrl = `${new URL(options.spec.request.url).origin}/`;
  return withRunContext(options, async ({ page }, strategy) => {
    // Ouverture du site : réservée à la cadence, classée avant toute requête de données (un refus arrête l'essai).
    if (options.pacer !== undefined) {
      const slot = await options.pacer.acquire(pageUrl);
      if (!slot.granted) return { ok: false, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }, pages: 0, requests: 0 };
    }
    let landing: Awaited<ReturnType<typeof navigate>>;
    try {
      landing = await strategy.during(isMainNavigation(page), () => navigate(page, pageUrl, options));
    } catch (error) {
      if (options.signal.aborted) throw error;
      return failed(classifyTransportError(error));
    }
    const landingExchange: HttpExchange = { status: landing.status, headers: landing.headers, body: landing.html ? capped(await boundedContent(page, maxBytes)) : '', url: page.url() };
    // Garde de classification (1.7) avant toute requête de données ; la classe est rapportée à la cadence (disjoncteur).
    const refused = classify(landingExchange, { requestUrl: pageUrl });
    await options.pacer?.report(pageUrl, { status: landing.status, retryAfter: landing.headers['retry-after'] ?? null, failureClass: refused?.failure_class ?? null });
    // Une page d'accueil absente (404) n'empêche pas l'appel de l'API de même origine ; tout autre refus arrête.
    if (refused !== null && refused.failure_class !== 'not_found') return failed(refused);

    const transport: Transport = async (request) => {
      const { body, contentType } = encodeRequestBody(request);
      const headers: Record<string, string> = { ...request.headers };
      if (contentType !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = contentType;
      // Délai borné : une page hostile peut remplacer `fetch` par une promesse qui ne se résout jamais.
      // Lecture bornée dans la page (flux coupé au-delà du plafond) ; seules des valeurs primitives bornées sont rendues :
      // une page qui surcharge `ArrayBuffer`, `TextDecoder` ou `JSON` fausse ses données, jamais la borne du transfert.
      const target = sameUrl(request.url);
      const evaluation = strategy.during((r) => r.resourceType() === 'fetch' && target(r.url()), () => page.evaluate(
        async (a: { url: string; method: string; headers: Record<string, string>; body: string | null; maxBytes: number; maxMeta: number }) => {
          try {
            const r = await fetch(a.url, { method: a.method, headers: a.headers, body: a.body, credentials: 'include', redirect: 'follow', cache: 'no-store' });
            const parts: Uint8Array[] = [];
            let size = 0;
            const reader = r.body === null ? null : r.body.getReader();
            if (reader !== null) {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > a.maxBytes) {
                  await reader.cancel().catch(() => undefined);
                  return { kind: 'too_large' as const };
                }
                parts.push(chunk.value);
              }
            }
            const buffer = new Uint8Array(size);
            let offset = 0;
            for (const part of parts) {
              buffer.set(part, offset);
              offset += part.byteLength;
            }
            const h: Record<string, string> = {};
            r.headers.forEach((value, name) => {
              h[name.toLowerCase()] = value;
            });
            const text: unknown = new TextDecoder().decode(buffer);
            const meta: unknown = JSON.stringify(h);
            const url: unknown = r.url;
            const status: unknown = r.status;
            if (typeof text !== 'string' || text.length > a.maxBytes) return { kind: 'too_large' as const };
            if (typeof meta !== 'string' || meta.length > a.maxMeta || typeof url !== 'string' || url.length > 8192 || typeof status !== 'number') {
              return { kind: 'error' as const };
            }
            return { kind: 'ok' as const, status, headers: meta, body: text, url };
          } catch {
            return { kind: 'error' as const };
          }
        },
        { url: request.url, method: request.method, headers, body: body ?? null, maxBytes, maxMeta: 64 * 1024 },
      ));
      let timer: NodeJS.Timeout | undefined;
      const timeoutMs = options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS;
      const out = await Promise.race([
        evaluation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('fetch dans la page : délai dépassé'), { name: 'TimeoutError' })), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      if (out.kind === 'too_large') throw new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
      if (out.kind === 'error') throw Object.assign(new Error('fetch dans la page : échec'), { code: 'IN_PAGE_FETCH_FAILED' });
      // Revérifié côté hôte : octets UTF-8 du corps, en-têtes en chaînes.
      if (Buffer.byteLength(out.body) > maxBytes) throw new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.headers);
      } catch {
        parsed = null;
      }
      const responseHeaders: Record<string, string> = {};
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) if (typeof value === 'string') responseHeaders[name] = value;
      }
      return { status: out.status, headers: responseHeaders, body: out.body, url: out.url === '' ? request.url : out.url };
    };
    return runDeclarative({ ...options, transport });
  });
}

/** E3 : navigation Chromium, attente du rendu, DOM rendu (ou corps brut hors HTML) extrait par l'interpréteur. */
export function runPlaywrightExecutor(options: BrowserExecutorOptions): Promise<DeclarativeRunResult> {
  const maxBytes = maxBytesOf(options);
  const renderSelector = options.spec.sources.find((s) => s.from === 'html')?.records;
  const renderWaitMs = options.renderWaitMs ?? BROWSER_RENDER_WAIT_MS;
  return withRunContext(options, async ({ page }, strategy) => {
    const transport: Transport = async (request) => {
      if (request.method !== 'GET' || request.body !== undefined) throw new DslError('unsupported', 'E3 déclaratif : requêtes GET seulement');
      const nav = await strategy.during(isMainNavigation(page), () => navigate(page, request.url, options));
      let body: string;
      // Refus visible dès les en-têtes (statut, en-tête de défi, redirection vers la connexion) : aucune attente du rendu, le corps brut suffit à la garde.
      if (nav.html && classifyExchange({ status: nav.status, headers: nav.headers, body: '', url: page.url() }, { requestUrl: request.url }) === null) {
        if (renderSelector !== undefined) await page.waitForSelector(renderSelector, { state: 'attached', timeout: renderWaitMs }).catch(() => undefined);
        else await page.waitForLoadState('networkidle', { timeout: renderWaitMs }).catch(() => undefined);
        body = capped(await boundedContent(page, maxBytes));
      } else {
        body = capped(await boundedRawBody(page, nav.response, maxBytes));
      }
      return { status: nav.status, headers: nav.headers, body, url: page.url() };
    };
    return runDeclarative({ ...options, transport });
  });
}
