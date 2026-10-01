// SPDX-License-Identifier: AGPL-3.0-only
// E2 `fetch_in_page` et E3 `playwright` (tâche 1.6 ; 04 §3.1) sur un Chromium du pool, dans un contexte neuf dont tout
// le trafic passe par le proxy d'egress de l'essai (garde SSRF, barreau N1-N3 chaîné au proxy BYO). Même boucle
// déclarative qu'E1 (`runDeclarative`) : seul le transport change.
// - E2 : navigateur ouvert sur le site (origine de la requête), `fetch` injecté dans la page (contexte et cookies du
//   site), corps borné ;
// - E3 : navigation déterministe (GET), attente du rendu (sélecteur des enregistrements), DOM rendu extrait.
// Toute navigation passe par `guardedGoto` ; la cadence (1.9) est réservée avant chaque requête de la stratégie.
import {
  classifyExchange,
  classifyStatus,
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
import { guardedGoto, type BrowserEgress, type SsrfGuard } from '@runtime/core/net';
import type { Page } from 'playwright-core';
import type { BrowserPool } from '../browser/pool.js';
import { openRunContext, type RunContext } from '../browser/run-context.js';

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

function capped(body: string, max: number): string {
  if (Buffer.byteLength(body) > max) throw new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
  return body;
}

/** Affine un échec quand le proxy d'egress ou la politique de domaines ont refusé quelque chose. */
function refine(result: DeclarativeRunResult, egress: BrowserEgress, rc: RunContext | undefined): DeclarativeRunResult {
  if (result.ok) return result;
  const { failure_class: cls } = result.failure;
  // Le proxy d'egress répond 403 `ssrf_blocked` (http) ou refuse le CONNECT (https, ws) : Chromium voit un 403 ou une
  // erreur réseau. Dans les deux cas, la cause journalisée est la garde.
  if (egress.blocked.length > 0 && (cls === 'network' || cls === 'code_error' || cls === 'transient' || cls === 'forbidden')) {
    return { ...result, failure: { failure_class: 'forbidden', retryable: false, detail: 'ssrf_blocked' } };
  }
  if (rc !== undefined && rc.violations.length > 0 && (cls === 'network' || cls === 'code_error')) {
    return { ...result, failure: { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' } };
  }
  return result;
}

/** Contexte de run neuf sur un Chromium du pool ; l'interruption du run (annulation, bail perdu) ferme le contexte. */
async function withRunContext(options: BrowserExecutorOptions, fn: (rc: RunContext) => Promise<DeclarativeRunResult>): Promise<DeclarativeRunResult> {
  return options.pool.run(options.signal, async (browser) => {
    const rc = await openRunContext(browser, { egressServer: options.egress.server, allowedHosts: options.spec.request.allowed_hosts });
    const onAbort = () => void rc.close();
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      rc.page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS);
      rc.page.setDefaultTimeout(options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS);
      const result = await fn(rc);
      options.signal.throwIfAborted();
      return refine(result, options.egress, rc);
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      await rc.close();
    }
  });
}

async function navigate(page: Page, url: string, options: BrowserExecutorOptions): Promise<{ status: number; headers: Record<string, string>; html: boolean; raw: () => Promise<string> }> {
  const response = await guardedGoto(page, url, options.guard, { waitUntil: 'load' as const, timeout: options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS });
  if (response === null) throw new DslError('unsupported', 'navigation sans réponse HTTP');
  const headers = response.headers();
  return { status: response.status(), headers, html: /html/i.test(headers['content-type'] ?? 'text/html'), raw: () => response.text() };
}

/** Échec de l'essai sans requête de stratégie (page d'accueil d'E2 refusée). */
const failed = (failure: ExecFailure): DeclarativeRunResult => ({ ok: false, failure, pages: 0, requests: 1 });

/** E2 : `fetch` exécuté dans la page du site (cookies et contexte du site), par Chromium donc par le proxy d'egress. */
export function runFetchInPageExecutor(options: BrowserExecutorOptions): Promise<DeclarativeRunResult> {
  const classify = options.classify ?? classifyExchange;
  const maxBytes = maxBytesOf(options);
  const pageUrl = `${new URL(options.spec.request.url).origin}/`;
  return withRunContext(options, async ({ page }) => {
    // Ouverture du site : réservée à la cadence, classée avant toute requête de données (un refus arrête l'essai).
    if (options.pacer !== undefined) {
      const slot = await options.pacer.acquire(pageUrl);
      if (!slot.granted) return { ok: false, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }, pages: 0, requests: 0 };
    }
    let landing: Awaited<ReturnType<typeof navigate>>;
    try {
      landing = await navigate(page, pageUrl, options);
    } catch (error) {
      if (options.signal.aborted) throw error;
      return failed(classifyTransportError(error));
    }
    await options.pacer?.report(pageUrl, { status: landing.status, retryAfter: landing.headers['retry-after'] ?? null });
    const landingExchange: HttpExchange = { status: landing.status, headers: landing.headers, body: landing.html ? capped(await page.content(), maxBytes) : '', url: page.url() };
    const refused = classify(landingExchange);
    // Une page d'accueil absente (404) n'empêche pas l'appel de l'API de même origine ; tout autre refus arrête.
    if (refused !== null && refused.failure_class !== 'not_found') return failed(refused);

    const transport: Transport = async (request) => {
      const { body, contentType } = encodeRequestBody(request);
      const headers: Record<string, string> = { ...request.headers };
      if (contentType !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = contentType;
      // Délai borné : une page hostile peut remplacer `fetch` par une promesse qui ne se résout jamais.
      const evaluation = page.evaluate(
        async (a: { url: string; method: string; headers: Record<string, string>; body: string | null; maxBytes: number }) => {
          try {
            const r = await fetch(a.url, { method: a.method, headers: a.headers, body: a.body, credentials: 'include', redirect: 'follow', cache: 'no-store' });
            const buffer = await r.arrayBuffer();
            if (buffer.byteLength > a.maxBytes) return { kind: 'too_large' as const };
            const h: Record<string, string> = {};
            r.headers.forEach((value, name) => {
              h[name.toLowerCase()] = value;
            });
            return { kind: 'ok' as const, status: r.status, headers: h, body: new TextDecoder().decode(buffer), url: r.url };
          } catch {
            return { kind: 'error' as const };
          }
        },
        { url: request.url, method: request.method, headers, body: body ?? null, maxBytes },
      );
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
      return { status: out.status, headers: out.headers, body: out.body, url: out.url === '' ? request.url : out.url };
    };
    return runDeclarative({ ...options, transport });
  });
}

/** E3 : navigation Chromium, attente du rendu, DOM rendu (ou corps brut hors HTML) extrait par l'interpréteur. */
export function runPlaywrightExecutor(options: BrowserExecutorOptions): Promise<DeclarativeRunResult> {
  const maxBytes = maxBytesOf(options);
  const renderSelector = options.spec.sources.find((s) => s.from === 'html')?.records;
  const renderWaitMs = options.renderWaitMs ?? BROWSER_RENDER_WAIT_MS;
  return withRunContext(options, async ({ page }) => {
    const transport: Transport = async (request) => {
      if (request.method !== 'GET' || request.body !== undefined) throw new DslError('unsupported', 'E3 déclaratif : requêtes GET seulement');
      const nav = await navigate(page, request.url, options);
      let body: string;
      if (nav.html && classifyStatus(nav.status) === null) {
        if (renderSelector !== undefined) await page.waitForSelector(renderSelector, { state: 'attached', timeout: renderWaitMs }).catch(() => undefined);
        else await page.waitForLoadState('networkidle', { timeout: renderWaitMs }).catch(() => undefined);
        body = capped(await page.content(), maxBytes);
      } else {
        body = capped(await nav.raw(), maxBytes);
      }
      return { status: nav.status, headers: nav.headers, body, url: page.url() };
    };
    return runDeclarative({ ...options, transport });
  });
}
