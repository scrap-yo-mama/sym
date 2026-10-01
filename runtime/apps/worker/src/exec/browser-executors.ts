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
// Garde de classification (1.7, 04 §5, INV6) : elle tourne d'abord, sur la réponse SERVIE (statut, en-têtes, corps brut
// lu au niveau réseau ; compressé, lu seulement si sa taille décodée, vue par CDP, est bornée), avant toute attente du
// rendu ; le DOM rendu n'est classé qu'ensuite. Seule la navigation du cadre principal demandée par l'exécuteur part :
// une navigation lancée par la page (défi qui se résout seul en JavaScript puis recharge, défi muet sans aucun signal
// dans son contenu, redirection en JavaScript, meta refresh), vers un domaine de l'API comme vers un hôte hors API
// (éditeur de défi), est coupée sans connexion et arrête l'essai en `blocked_by_protection` (`self_navigation`).
// Attendre ne franchit donc jamais un défi. Limite assumée (INV6) : une redirection JS ou un meta refresh d'un site SAIN
// (langue, URL canonique) arrête aussi l'essai, sans réparation ; le détail `self_navigation` le dit, et la stratégie
// doit viser l'URL finale.
import {
  boundedEvidence,
  classifyExchange,
  classifyTransportError,
  encodeRequestBody,
  TransportRefusal,
  runDeclarative,
  type DeclarativeRunOptions,
  type DeclarativeRunResult,
  type ExecFailure,
  type HttpExchange,
  type Transport,
} from '@runtime/core/exec';
import { DslError } from '@runtime/core';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type SsrfGuard } from '@runtime/core/net';
import type { Page, Request, Response } from 'playwright-core';
import { boundedContent, boundedDocumentBody, boundedRawBody, TOO_LARGE, trackDecodedSizes, type DecodedSizes } from '../browser/bounded.js';
import type { BrowserPool } from '../browser/pool.js';
import { hostAllowed, isMainNavigation, openRunContext, trackStrategyRequests, type BrowserRequestCheck, type RunContext, type StrategyRequests } from '../browser/run-context.js';

const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
/** Attente du rendu d'une page (sélecteur des enregistrements) avant lecture du DOM. */
const BROWSER_RENDER_WAIT_MS = 10_000;

export type BrowserExecutorOptions = Omit<DeclarativeRunOptions, 'transport'> & {
  readonly pool: BrowserPool;
  readonly egress: BrowserEgress;
  readonly guard: SsrfGuard;
  readonly navigationTimeoutMs?: number;
  readonly renderWaitMs?: number;
  /** User-Agent du robot (1.11, `buildUserAgent`) : la chaîne du moteur, suivie du jeton si `identify_instance` est activé. */
  readonly userAgent?: string;
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

/**
 * Navigations du cadre principal (1.7) : seule celle que l'exécuteur demande part. Toute autre, lancée par la page
 * elle-même, est coupée avant connexion et arrête l'essai (`TransportRefusal`, `blocked_by_protection`).
 */
type NavigationGuard = {
  /** La prochaine navigation du cadre principal est celle de l'exécuteur (une seule). */
  expect(): void;
  /** Fin de la navigation demandée : plus aucune n'est attendue. */
  settle(): void;
  /** Vrai si la page a tenté une navigation non demandée. */
  attempted(): boolean;
  /** `fn`, interrompue dès qu'une navigation non demandée est tentée (refus avec la réponse servie, si connue). */
  during<T>(fn: () => Promise<T>, served?: () => HttpExchange | undefined): Promise<T>;
  /** Refus à lever quand une navigation non demandée a été tentée. */
  refusal(served?: HttpExchange): TransportRefusal;
  /** Tailles décodées des documents de la page (suivi CDP) ; absent sans session CDP (corps compressé alors non lu). */
  readonly sizes?: DecodedSizes;
};

function navigationGuard(): NavigationGuard & { bind(page: Page, sizes?: DecodedSizes): void; admit(request: Request): boolean } {
  let page: Page | undefined;
  let sizes: DecodedSizes | undefined;
  let expected = false;
  let attempted = false;
  let notify: () => void = () => undefined;
  const attempt = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const refusal = (served?: HttpExchange): TransportRefusal =>
    new TransportRefusal(
      { failure_class: 'blocked_by_protection', retryable: false, detail: 'self_navigation', ...(served === undefined ? {} : { status: served.status }) },
      served === undefined ? undefined : boundedEvidence(served),
    );
  return {
    bind: (p, s) => {
      page = p;
      sizes = s;
    },
    get sizes() {
      return sizes;
    },
    admit(request) {
      if (page === undefined) return true;
      let main = false;
      try {
        main = isMainNavigation(page)(request);
      } catch {
        // Requête sans cadre : jamais une navigation de la page du run.
      }
      if (!main) return true;
      if (expected) {
        expected = false;
        return true;
      }
      attempted = true;
      notify();
      return false;
    },
    expect: () => {
      expected = true;
    },
    settle: () => {
      expected = false;
    },
    attempted: () => attempted,
    refusal,
    async during(fn, served) {
      const work = fn();
      work.catch(() => undefined);
      return Promise.race([
        work,
        attempt.then((): never => {
          throw refusal(served?.());
        }),
      ]);
    },
  };
}

/** Contexte de run neuf sur un Chromium du pool ; l'interruption du run (annulation, bail perdu) ferme le contexte. */
/** Types CDP d'une requête de données lancée par la page (`fetch`, XHR). */
const FETCH_TYPES = new Set(['Fetch', 'XHR']);

async function withRunContext(
  options: BrowserExecutorOptions,
  fn: (rc: RunContext, strategy: StrategyRequests, nav: NavigationGuard, claimFetch: (url: string) => void) => Promise<DeclarativeRunResult>,
): Promise<DeclarativeRunResult> {
  return options.pool.run(options.signal, async (browser) => {
    const nav = navigationGuard();
    /**
     * Refus de robots.txt (1.11, INV11) d'une navigation du cadre principal (page d'accueil d'E2, page de la stratégie) :
     * coupée sans connexion, elle donne sa classe à l'essai. Une sous-ressource refusée est seulement coupée.
     */
    let robotsRefusal: ExecFailure | undefined;
    const access = options.access;
    /** URL des `fetch` de la stratégie (transport d'E2) : un saut refusé de leur chaîne donne sa classe à l'essai. */
    const strategyFetches = new Set<string>();
    const claimFetch = (url: string) => {
      strategyFetches.add(url);
      try {
        strategyFetches.add(new URL(url).href);
      } catch {
        // URL refusée en amont par l'interpréteur.
      }
    };
    const robotsVerdict = (url: string) =>
      (access as NonNullable<typeof access>)(url).catch((): { allowed: false; failure: ExecFailure } => ({ allowed: false, failure: { failure_class: 'robots_unreachable', retryable: true, detail: 'robots_check_failed' } }));
    const rc = await openRunContext(browser, {
      egressServer: options.egress.server,
      allowedHosts: options.spec.request.allowed_hosts,
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
      // robots.txt à CHAQUE saut que Chromium suit (redirections que `admit` ne voit pas, cadres hors processus) : un saut
      // refusé du cadre principal ou d'un `fetch` de la stratégie arrête l'essai ; une sous-ressource est seulement coupée.
      ...(access === undefined
        ? {}
        : {
            checkRequest: async (hop: BrowserRequestCheck) => {
              const decision = await robotsVerdict(hop.url);
              if (decision.allowed) return true;
              if (hop.mainFrame || (FETCH_TYPES.has(hop.resourceType) && strategyFetches.has(hop.rootUrl))) robotsRefusal ??= decision.failure;
              return false;
            },
          }),
      admit: async (request) => {
        if (access !== undefined) {
          const decision = await robotsVerdict(request.url());
          if (!decision.allowed) {
            let main = false;
            try {
              main = request.isNavigationRequest() && request.frame().parentFrame() === null;
            } catch {
              // Requête sans cadre : jamais la navigation de la page du run.
            }
            if (main) robotsRefusal ??= decision.failure;
            return false;
          }
        }
        return nav.admit(request);
      },
      // Navigation lancée par la page vers un hôte hors API (redirection JS d'un défi vers son éditeur) : coupée par la
      // politique de domaines sans passer par `admit`, elle compte comme toute navigation non demandée.
      onViolation: (_host, request) => {
        if (request !== undefined) nav.admit(request);
      },
    });
    const cdp = await rc.context.newCDPSession(rc.page).catch(() => undefined);
    nav.bind(rc.page, cdp === undefined ? undefined : await trackDecodedSizes(cdp).catch(() => undefined));
    const strategy = trackStrategyRequests(rc.context, options.spec.request.allowed_hosts);
    const onAbort = () => void rc.close();
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      rc.page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS);
      rc.page.setDefaultTimeout(options.navigationTimeoutMs ?? BROWSER_NAVIGATION_TIMEOUT_MS);
      const result = await fn(rc, strategy, nav, claimFetch);
      options.signal.throwIfAborted();
      if (!result.ok && robotsRefusal !== undefined) return { ok: false, failure: robotsRefusal, pages: result.pages, requests: result.requests };
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

type Navigation = Awaited<ReturnType<typeof navigate>>;

/** Navigation DEMANDÉE par l'exécuteur : la seule admise par la garde des navigations ; interrompue si la page en lance une autre. */
async function requestedNavigation(page: Page, url: string, options: BrowserExecutorOptions, strategy: StrategyRequests, nav: NavigationGuard): Promise<Navigation> {
  nav.expect();
  try {
    return await nav.during(() => strategy.during(isMainNavigation(page), () => navigate(page, url, options)));
  } finally {
    nav.settle();
  }
}

/**
 * Réponse SERVIE d'un document HTML (statut, en-têtes, corps brut lu au niveau réseau), à classer avant tout rendu.
 * Corps vide si sa taille est inconnue ; au-delà du plafond, `response_too_large`.
 */
async function servedDocument(nav: Navigation, maxBytes: number, guardNav: NavigationGuard): Promise<HttpExchange> {
  const raw = await guardNav.during(() => boundedDocumentBody(nav.response, maxBytes, undefined, guardNav.sizes));
  return { status: nav.status, headers: nav.headers, body: raw === undefined ? '' : capped(raw), url: nav.response.url() };
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

/** Échec de l'essai sans requête de stratégie (page d'accueil d'E2 refusée), avec la réponse servie en preuve. */
const failed = (failure: ExecFailure, evidence?: HttpExchange): DeclarativeRunResult => ({
  ok: false,
  failure,
  pages: 0,
  requests: 1,
  ...(evidence === undefined ? {} : { evidence: boundedEvidence(evidence) }),
});

/** E2 : `fetch` exécuté dans la page du site (cookies et contexte du site), par Chromium donc par le proxy d'egress. */
export function runFetchInPageExecutor(options: BrowserExecutorOptions): Promise<DeclarativeRunResult> {
  const classify = options.classify ?? classifyExchange;
  const maxBytes = maxBytesOf(options);
  const pageUrl = `${new URL(options.spec.request.url).origin}/`;
  return withRunContext(options, async ({ page }, strategy, nav, claimFetch) => {
    // Ouverture du site : réservée à la cadence, classée avant toute requête de données (un refus arrête l'essai).
    if (options.pacer !== undefined) {
      const slot = await options.pacer.acquire(pageUrl);
      if (!slot.granted) return { ok: false, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` }, pages: 0, requests: 0 };
    }
    let landing: Navigation;
    let landingExchange: HttpExchange;
    let refused: ExecFailure | null;
    try {
      landing = await requestedNavigation(page, pageUrl, options, strategy, nav);
      // Garde de classification (1.7) avant toute requête de données : réponse servie (corps brut) d'abord, puis DOM
      // rendu ; une navigation lancée par la page arrête l'essai.
      const served = landing.html ? await servedDocument(landing, maxBytes, nav) : { status: landing.status, headers: landing.headers, body: '', url: landing.response.url() };
      landingExchange = served;
      refused = classify(served, { requestUrl: pageUrl });
      if (refused === null && landing.html) {
        landingExchange = { ...served, body: capped(await nav.during(() => boundedContent(page, maxBytes), () => served)), url: page.url() };
        refused = classify(landingExchange, { requestUrl: pageUrl });
      }
      if (nav.attempted()) throw nav.refusal(served);
    } catch (error) {
      if (options.signal.aborted) throw error;
      const failure = classifyTransportError(error);
      // Refus du transport (navigation lancée par la page) : rapporté à la cadence comme tout refus (disjoncteur).
      if (error instanceof TransportRefusal) {
        await options.pacer?.report(pageUrl, { status: error.exchange?.status ?? 0, retryAfter: null, failureClass: failure.failure_class });
        return failed(failure, error.exchange);
      }
      return failed(failure);
    }
    // La classe est rapportée à la cadence (disjoncteur).
    await options.pacer?.report(pageUrl, { status: landing.status, retryAfter: landing.headers['retry-after'] ?? null, failureClass: refused?.failure_class ?? null });
    // Une page d'accueil absente (404) n'empêche pas l'appel de l'API de même origine ; tout autre refus arrête.
    if (refused !== null && refused.failure_class !== 'not_found') return failed(refused, landingExchange);

    const transport: Transport = async (request) => {
      const { body, contentType } = encodeRequestBody(request);
      const headers: Record<string, string> = { ...request.headers };
      if (contentType !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = contentType;
      // Délai borné : une page hostile peut remplacer `fetch` par une promesse qui ne se résout jamais.
      // Lecture bornée dans la page (flux coupé au-delà du plafond) ; seules des valeurs primitives bornées sont rendues :
      // une page qui surcharge `ArrayBuffer`, `TextDecoder` ou `JSON` fausse ses données, jamais la borne du transfert.
      const target = sameUrl(request.url);
      claimFetch(request.url);
      const evaluation = nav.during(() => strategy.during((r) => r.resourceType() === 'fetch' && target(r.url()), () => page.evaluate(
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
      )));
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
  const classify = options.classify ?? classifyExchange;
  return withRunContext(options, async ({ page }, strategy, guardNav) => {
    const transport: Transport = async (request) => {
      if (request.method !== 'GET' || request.body !== undefined) throw new DslError('unsupported', 'E3 déclaratif : requêtes GET seulement');
      const nav = await requestedNavigation(page, request.url, options, strategy, guardNav);
      // Document hors HTML (JSON, texte) : aucun script de page, le corps brut est la réponse.
      if (!nav.html) return { status: nav.status, headers: nav.headers, body: capped(await boundedRawBody(page, nav.response, maxBytes)), url: page.url() };
      // Garde de classification AVANT toute attente du rendu (04 §5, INV6) : statut, en-têtes et corps brut servi. Un
      // refus est rendu tel quel à l'interpréteur, qui le classe et ne l'extrait pas.
      const served = await servedDocument(nav, maxBytes, guardNav);
      if (guardNav.attempted()) throw guardNav.refusal(served);
      if (classify(served, { requestUrl: request.url }) !== null) return served;
      // Attente du rendu : toute navigation du cadre principal lancée par la page (défi qui se résout seul) l'interrompt.
      await guardNav.during(async () => {
        if (renderSelector !== undefined) await page.waitForSelector(renderSelector, { state: 'attached', timeout: renderWaitMs }).catch(() => undefined);
        else await page.waitForLoadState('networkidle', { timeout: renderWaitMs }).catch(() => undefined);
      }, () => served);
      const body = capped(await guardNav.during(() => boundedContent(page, maxBytes), () => served));
      if (guardNav.attempted()) throw guardNav.refusal(served);
      return { status: nav.status, headers: nav.headers, body, url: page.url() };
    };
    return runDeclarative({ ...options, transport });
  });
}
