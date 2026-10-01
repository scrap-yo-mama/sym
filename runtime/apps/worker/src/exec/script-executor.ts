// SPDX-License-Identifier: AGPL-3.0-only
// E3 en script (tâche 1.6, INV7, D-29) : un Chromium du pool, un contexte de run neuf derrière le proxy d'egress de
// l'essai (verrou de domaines compris), la page de départ ouverte et classée par l'hôte, puis le script dans le bac à
// sable de 1.5 (`SandboxEngine`) avec les ponts `ctx.fetch` (session réseau de l'essai, même barreau), `ctx.page.*`,
// `ctx.emit`, `ctx.log`. Le script ne touche jamais la page directement ; ses éléments sont validés contre
// `output_schema` par l'appelant (INV1). Toute violation tue l'enfant (`sandbox_violation`).
// Garde de classification (INV6, X3) : comme pour les exécuteurs déclaratifs, toute réponse est classée AVANT d'être
// rendue au script : réponse finale de chaque `ctx.fetch`, chaque document du cadre principal (page de départ,
// `ctx.page.goto`, navigation d'un clic : statut et en-têtes dès la réponse, contenu rendu avant la prochaine lecture),
// et les XHR / fetch des domaines de l'API émis alors que le code du script est dans la page. Au premier refus
// (`forbidden`, `auth_required`, `rate_limited`, `blocked_by_protection` en 1.7…), rien n'est rendu au script
// (`access_refused`), l'enfant est arrêté (sans violation), aucune requête ne part plus, les éléments émis sont ignorés
// et l'essai échoue avec la classe du refus. Les requêtes du site lui-même émises sans code du script (session anonyme
// sondée en 401 par la page d'accueil, par exemple) ne sont pas classées, comme dans l'E3 déclaratif.
// Chaque document du cadre principal est classé d'abord sur son statut et ses en-têtes DÈS la réponse (un en-tête de
// défi ou un 401 est retenu aussitôt, sans attendre le corps), puis sur son corps BRUT (lu au niveau réseau, avant que
// ses scripts ne le transforment ; corps compressé lu seulement si sa taille décodée, vue par CDP, est bornée), avec
// l'URL demandée (racine de la chaîne de redirections) pour reconnaître une redirection vers la connexion.
// Navigations du cadre principal (même règle qu'en E2/E3 déclaratifs) : seule celle que l'hôte demande part (une par
// page de départ, `ctx.page.goto` ou dispatch d'un clic du script, posée une fois l'élément trouvé et actionnable) ;
// toute autre (défi muet qui pose un cookie puis recharge, redirection JS, meta refresh, vers l'API ou hors API) est
// coupée sans connexion et arrête l'essai en `blocked_by_protection` (`self_navigation`), y compris pendant un
// `ctx.page.evaluate` ou l'attente du sélecteur d'un clic (rien n'y distingue le code du script de celui de la page :
// le script navigue par `ctx.page.goto`). Attendre ne franchit jamais un défi, même indétectable par son contenu. Une navigation demandée fait d'abord classer le document
// courant sur son DOM (il est encore là), puis attend le verdict sur son corps brut.
// Cadence : chaque réponse classée est rapportée AVEC sa classe (`failureClass`) : un défi servi en 200 compte pour
// le disjoncteur du domaine comme un 403, jamais comme un succès (04 §7).
// Cadence par domaine (1.9, 17 §5) : comme les exécuteurs déclaratifs, chaque requête du script réserve un créneau
// avant de partir et rend compte de son statut (429, `Retry-After`, 5xx allongent la cadence) : chaque saut de
// `ctx.fetch`, et chaque requête de document, XHR ou fetch de la page (page de départ, `ctx.page.goto`, navigations d'un
// clic, requêtes lancées par `evaluate` ou par le site), au niveau du contexte de run. Toutes comptent dans
// `domain_pacing.max_requests_per_run` ; au-delà, refus sans violation et sortie tronquée.
// Actions d'écriture (08 §4 mesure 4) : sans `allow_write_actions`, toute soumission (navigation hors GET/HEAD) est
// coupée au niveau du contexte de run et imputée au script ; le clic sur un contrôle d'envoi est refusé par le pont.
// Journal du script (`ctx.log`) et éléments émis : rendus à l'appelant, en mémoire. Les éléments sont inscrits au registre
// de masquage du run, que l'essai réussisse ou non ; le texte du journal n'est jamais écrit (ni `run_logs` ni journal du
// worker : seuls le nombre de lignes et les octets le sont, 17 §6).
import type { FailureClass, SandboxEngine, SandboxLimits, SandboxViolation } from '@runtime/core';
import {
  classifyExchange,
  classifyTransportError,
  type AccessCheck,
  type AccessDecision,
  type ClassifyContext,
  type DeclarativeRunResult,
  type ExecFailure,
  type HttpExchange,
  type RequestPacer,
} from '@runtime/core/exec';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type NetworkSession, type SsrfGuard } from '@runtime/core/net';
import type { Logger } from 'pino';
import type { CDPSession, Request, Response } from 'playwright-core';
import { boundedContent, boundedDocumentBody, TOO_LARGE, trackDecodedSizes, type DecodedSizes } from '../browser/bounded.js';
import type { BrowserPool } from '../browser/pool.js';
import { chainRoot, hostAllowed, isMainNavigation, openRunContext, trackStrategyRequests, type BrowserRequestCheck } from '../browser/run-context.js';
import { DEFAULT_SANDBOX_LIMITS } from '../sandbox/engine.js';
import { createSandboxBridges, SandboxBridgeError, type BridgeResponse } from '../sandbox/bridges.js';
import { ACCESS_REFUSED, createPageBridge, hostViolationWatch, issuedForWatch } from './script.js';

const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_ITEMS = 10_000;
/** Plafond de requêtes d'un essai quand l'API n'en fixe pas (`domain_pacing.max_requests_per_run`). */
const DEFAULT_MAX_REQUESTS = 100;
/** Requêtes de la page soumises à la cadence : documents (navigations) et appels de données. */
const PACED_TYPES = new Set(['document', 'xhr', 'fetch', 'eventsource']);
/** Appels de données de la page classés quand le code du script est dans la page. */
const DATA_TYPES = new Set(['xhr', 'fetch', 'eventsource']);
const READ_METHODS = new Set(['GET', 'HEAD']);
/** Durée de vie maximale du verdict de la garde sur un document du cadre principal (sécurité). */
const DOCUMENT_VERDICT_WAIT_MS = 15_000;
/** Attente, par une navigation du cadre principal dont le document courant passe le classement du DOM, du verdict sur son corps brut. */
const PREVIOUS_VERDICT_WAIT_MS = 2_000;
/** Lecture du DOM courant (CDP) avant une navigation du cadre principal. */
const DOM_READ_TIMEOUT_MS = 3_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Corps d'un XHR / fetch de la page lu pour le classement : déclaré, non compressé, au plus 256 Kio. */
const MAX_CLASSIFIED_BODY = 256 * 1024;
/**
 * Classes rendues au script sans arrêter l'essai : contenu absent ou inattendu, indisponibilité passagère, erreur
 * d'infrastructure. Toute autre classe est un refus d'accès (INV6, 04 §7) qui arrête l'essai.
 */
const PASS_THROUGH = new Set<FailureClass>(['not_found', 'extraction', 'transient', 'code_error']);

/** Branchement du bac à sable (1.5) : moteur, lecture du script référencé par la version de stratégie, plafonds. */
export type ScriptPort = {
  readonly engine: SandboxEngine;
  loadScript(scriptRef: string, spec: unknown): Promise<string>;
  readonly limits?: SandboxLimits;
};

/**
 * Source d'un script E3 : en V1, gardée dans la version de stratégie elle-même (`script_ref = "inline"`,
 * `spec.source`), donc versionnée, visible et réversible avec elle (08 §4.6). Toute autre référence est refusée.
 */
const MAX_SCRIPT_BYTES = 256 * 1024;
export async function loadInlineScript(scriptRef: string, spec: unknown): Promise<string> {
  const source = (spec as { source?: unknown } | null)?.source;
  if (scriptRef !== 'inline' || typeof source !== 'string' || source.length === 0 || Buffer.byteLength(source) > MAX_SCRIPT_BYTES) {
    throw new Error('script introuvable');
  }
  return source;
}

export type ScriptExecutorOptions = {
  readonly pool: BrowserPool;
  readonly egress: BrowserEgress;
  readonly guard: SsrfGuard;
  /** Session réseau de l'essai (même barreau que l'egress) : transport de `ctx.fetch`. */
  readonly session: Pick<NetworkSession, 'fetch'>;
  readonly engine: SandboxEngine;
  readonly code: string;
  readonly allowedHosts: readonly string[];
  readonly startUrl: string;
  readonly input: unknown;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly limits?: SandboxLimits;
  readonly pacer?: RequestPacer;
  /** `domain_pacing.max_requests_per_run` (défaut 100). */
  readonly maxRequests?: number;
  /** `apis.allow_write_actions` (défaut : faux). */
  readonly allowWriteActions?: boolean;
  /** Garde de classification (1.7) ; défaut : `classifyExchange` (statut, en-têtes de protection, défi servi en 200, redirection). */
  readonly classify?: (exchange: HttpExchange, context?: ClassifyContext) => ExecFailure | null;
  readonly navigationTimeoutMs?: number;
  /**
   * Module d'accès (1.11, INV11) : robots.txt contrôlé avant chaque requête du contexte (page de départ, `ctx.page.*`,
   * requêtes de la page) et chaque saut de `ctx.fetch`. Un refus imputable à la stratégie (navigation du cadre
   * principal, `ctx.fetch`, requête lancée par le script) arrête l'essai avec sa classe ; une sous-ressource est coupée.
   */
  readonly robots: AccessCheck;
  /** User-Agent du robot, ajouté à celui du navigateur. */
  readonly userAgent?: string;
};

export type ScriptRunOutcome = {
  readonly result: DeclarativeRunResult;
  /** Violations du bac à sable (journalisées `sandbox_violation`), vides si aucune. */
  readonly violations: readonly SandboxViolation[];
  readonly killed: boolean;
  readonly killLatencyMs?: number;
  /**
   * Lignes de `ctx.log` du script (texte libre non fiable, données lues comprises) : en mémoire pour l'essai seulement
   * (réparation), JAMAIS écrites en base ni au journal du worker ; `run_logs` n'en reçoit que le compte et la taille.
   */
  readonly logs: readonly (readonly string[])[];
  /**
   * Tous les éléments émis par le script, y compris quand l'essai échoue (jamais écrits alors) : l'appelant les inscrit
   * au registre de masquage du run (D-28, 17 §6).
   */
  readonly items: readonly unknown[];
};

const fail = (failure: ExecFailure, pages: number, requests: number): DeclarativeRunResult => ({ ok: false, failure, pages, requests });
const codeError = (detail: string): ExecFailure => ({ failure_class: 'code_error', retryable: false, detail });
const DOMAIN_NOT_ALLOWED: ExecFailure = { failure_class: 'code_error', retryable: false, detail: 'domain_not_allowed' };

/** Corps d'un appel de données de la page, seulement s'il est petit, déclaré et non compressé ; sinon vide. */
async function smallBody(response: Response): Promise<string> {
  const headers = response.headers();
  const declared = Number(headers['content-length'] ?? NaN);
  const encoding = (headers['content-encoding'] ?? 'identity').toLowerCase();
  if (!Number.isFinite(declared) || declared > MAX_CLASSIFIED_BODY || encoding !== 'identity') return '';
  const body = await response.text().catch(() => '');
  return Buffer.byteLength(body) <= MAX_CLASSIFIED_BODY ? body : '';
}

export function runScriptExecutor(options: ScriptExecutorOptions): Promise<ScriptRunOutcome> {
  const timeoutMs = options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const allowWriteActions = options.allowWriteActions === true;
  const classify = options.classify ?? classifyExchange;
  const { pacer } = options;
  const logs: string[][] = [];
  let items: readonly unknown[] = [];
  let requests = 0;
  let capReached = false;
  let paceRefusal: string | undefined;
  /** Premier refus d'accès constaté (INV6) : l'essai s'arrête, plus aucune requête ne part. */
  let refusal: ExecFailure | undefined;
  const stopOnRefusal = new AbortController();
  /** Retient un refus (premier seulement : enfant arrêté) ; vrai si l'essai est refusé. */
  const retain = (failure: ExecFailure | null): boolean => {
    if (refusal !== undefined) return true;
    if (failure === null || PASS_THROUGH.has(failure.failure_class)) return false;
    refusal = failure;
    stopOnRefusal.abort();
    return true;
  };
  /** Résolue (`undefined`) au premier refus retenu. */
  const onRefusal = (): Promise<undefined> =>
    new Promise((resolve) => {
      if (stopOnRefusal.signal.aborted) resolve(undefined);
      else stopOnRefusal.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
  /** Classe une réponse (avec l'URL demandée) : la classe, et si l'essai est refusé. */
  const examine = (exchange: HttpExchange, context: ClassifyContext = {}): { refused: boolean; failure: ExecFailure | null } => {
    const failure = classify(exchange, context);
    return { refused: retain(failure), failure };
  };
  /**
   * Compte rendu à la cadence, sérialisé : une réservation attend le compte rendu précédent (un 429 ralentit la
   * suivante), et le verdict de la garde sur les réponses en cours de classement (même sans cadence). La classe est
   * celle de la garde : un refus (403, défi en 200) compte pour le disjoncteur.
   */
  let reporting: Promise<void> = Promise.resolve();
  const report = (url: string, status: number, retryAfter: string | null, failureClass: FailureClass | null | Promise<FailureClass | null> = null): Promise<void> => {
    reporting = reporting
      .then(async () => {
        const cls = await failureClass;
        await pacer?.report(url, { status, retryAfter, failureClass: cls });
      })
      .catch(() => undefined);
    return reporting;
  };
  /** Verdict de la garde attendu par la prochaine réservation, sans compte rendu (requête hors cadence). */
  const awaitVerdict = (verdict: Promise<unknown>): void => {
    reporting = reporting.then(() => verdict).then(
      () => undefined,
      () => undefined,
    );
  };
  /** Réponses finales de `ctx.fetch` en attente de classement (`inspect`) : rapportées alors avec leur classe. */
  const pendingFetchReports = new Map<string, { status: number; retryAfter: string | null }[]>();
  const hrefOf = (url: string): string => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };
  /** Rapporte la réponse finale de `ctx.fetch` en attente pour `url`, avec la classe de la garde. */
  const reportFetch = (url: string, failureClass: FailureClass | null): Promise<void> => {
    const queue = pendingFetchReports.get(hrefOf(url));
    const entry = queue?.shift();
    if (queue !== undefined && queue.length === 0) pendingFetchReports.delete(hrefOf(url));
    return entry === undefined ? Promise.resolve() : report(url, entry.status, entry.retryAfter, failureClass);
  };
  /** Une requête de plus : plafond du run, puis créneau de la cadence. `false` : refusée (sans connexion). */
  const reserve = async (url: string): Promise<'ok' | 'cap' | 'paced' | 'refused'> => {
    if (refusal !== undefined) return 'refused';
    if (paceRefusal !== undefined) return 'paced';
    if (requests >= maxRequests) {
      capReached = true;
      return 'cap';
    }
    requests += 1;
    // Verdicts en cours (document du cadre principal, appel de données) d'abord : un refus constaté coupe la requête.
    await reporting;
    if (refusal !== undefined) return 'refused';
    if (pacer === undefined) return 'ok';
    const slot = await pacer.acquire(url);
    if (slot.granted) return refusal === undefined ? 'ok' : 'refused';
    paceRefusal = slot.reason;
    return 'paced';
  };
  const pacedRequests = new WeakSet<Request>();
  /** Verdict de robots.txt ; une lecture en échec inattendu vaut injoignable (on s'abstient). */
  const robotsDecision = (url: string): Promise<AccessDecision> =>
    options.robots(url).catch((): AccessDecision => ({ allowed: false, failure: { failure_class: 'robots_unreachable', retryable: true, detail: 'robots_check_failed' } }));

  return options.pool.run(options.signal, async (browser) => {
    const host = hostViolationWatch();
    /** État du guet à l'émission de chaque requête Chromium (le code du script pouvait-il l'avoir lancée ?). */
    const issued = new WeakMap<Request, boolean>();
    /** Requêtes initiales qui sont une navigation du cadre principal (relevé à l'émission). */
    const mainNavigations = new WeakSet<Request>();
    /**
     * État du guet à l'émission, par URL de requête initiale (borné) : imputation d'un saut de redirection refusé par
     * robots.txt, que le contrôle CDP voit sans objet `Request` de Playwright.
     */
    const issuedByUrl = new Map<string, boolean>();
    /**
     * État d'émission transmis au guet : jamais appris d'un saut de redirection, d'une requête de la stratégie
     * (`ctx.page.goto`, clic du script) ni d'une navigation du cadre principal (`issuedForWatch`, D-29).
     */
    const issuedState = (request: Request): boolean | undefined => {
      const root = chainRoot(request);
      return issuedForWatch(issued.get(root), { redirectHop: root !== request, strategy: strategy.owns(root), mainNavigation: mainNavigations.has(root) });
    };
    /**
     * Verdict de la garde sur chaque document du cadre principal (requête initiale → fin du classement de sa réponse) ;
     * la navigation suivante attend celui du document précédent (borné : jamais plus de `DOCUMENT_VERDICT_WAIT_MS`).
     */
    const documentVerdicts = new Map<Request, () => void>();
    const previousDocumentVerdict = new WeakMap<Request, Promise<void>>();
    let lastDocumentVerdict: Promise<void> = Promise.resolve();
    /** Dernier document du cadre principal reçu (statut, en-têtes, URL demandée) : classé sur son DOM avant la navigation suivante. */
    let currentDocument: { status: number; headers: Record<string, string>; url: string; requestUrl: string; root: Request } | undefined;
    /** Documents du cadre principal dont le corps brut a été lu et classé (requête initiale). */
    const rawClassified = new WeakSet<Request>();
    const settleDocument = (request: Request): void => {
      const root = chainRoot(request);
      documentVerdicts.get(root)?.();
      documentVerdicts.delete(root);
    };
    /**
     * Session CDP de la page (posée après l'ouverture du contexte) : lecture du DOM pendant une navigation suspendue,
     * tailles décodées des documents (lecture bornée d'un corps compressé).
     */
    const cdpRef: { session?: CDPSession; sizes?: DecodedSizes } = {};
    /** Navigation du cadre principal (requête initiale) de la page du run. */
    const mainRoot = (request: Request): boolean => {
      try {
        return request.redirectedFrom() === null && isMainNavigation(rc.page)(request);
      } catch {
        return false;
      }
    };
    /**
     * Navigation non demandée par l'hôte (ni page de départ, ni `ctx.page.goto`, ni dispatch d'un clic du script) : refus
     * (INV6), même pendant un `evaluate` (la page a pu la lancer pendant que le script attend).
     */
    const selfNavigation = (request: Request): boolean => {
      if (!mainRoot(request) || host.claimNavigation()) return false;
      retain({ failure_class: 'blocked_by_protection', retryable: false, detail: 'self_navigation', ...(currentDocument === undefined ? {} : { status: currentDocument.status }) });
      return true;
    };
    /**
     * HTML sérialisé du document courant, borné DANS la page, lu par CDP : `page.evaluate` attendrait la fin de la
     * navigation suspendue par `admit` (interblocage). `undefined` si illisible.
     */
    const currentDom = async (): Promise<string | undefined> => {
      const session = cdpRef.session;
      if (session === undefined) return undefined;
      const expression = `(() => { try { const d = document; const s = (d.doctype ? new XMLSerializer().serializeToString(d.doctype) : '') + String(d.documentElement ? d.documentElement.outerHTML : ''); return typeof s === 'string' && s.length <= ${MAX_RESPONSE_BYTES} ? s : null; } catch { return null; } })()`;
      let timer: NodeJS.Timeout | undefined;
      const value = await Promise.race([
        session.send('Runtime.evaluate', { expression, returnByValue: true }).then((r) => (r.result as { value?: unknown }).value),
        new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), DOM_READ_TIMEOUT_MS))),
      ])
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
      return typeof value === 'string' && Buffer.byteLength(value) <= MAX_RESPONSE_BYTES ? value : undefined;
    };
    const rc = await openRunContext(browser, {
      egressServer: options.egress.server,
      allowedHosts: options.allowedHosts,
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
      onViolation: (h, request) => {
        const state = request === undefined ? undefined : issuedState(request);
        // Pendant un `evaluate`, une requête vers un hôte que le site n'a jamais contacté peut être une tentative du code
        // du script (exfiltration par `location.href`) : violation journalisée, enfant tué, 0 requête (D-29). Si c'est
        // une navigation du cadre principal non demandée, elle peut aussi venir de la page (défi muet qui part vers
        // l'éditeur pendant que le script attend) : la classe est alors celle du refus (`self_navigation`, INV6), qui
        // n'ouvre jamais la réparation (revue de 1.7) ; la violation, imputée d'abord, reste journalisée.
        if (host.evaluating()) {
          host.report(h, 'domain_not_allowed', state);
          if (request !== undefined && refusal === undefined) selfNavigation(request);
          return;
        }
        // Navigation lancée par la page vers un hôte hors API (éditeur de défi) : coupée ici sans passer par `admit`,
        // c'est un refus comme toute navigation non demandée.
        if (request !== undefined && refusal === undefined) selfNavigation(request);
        host.report(h, 'domain_not_allowed', state);
      },
      // robots.txt à CHAQUE saut que Chromium suit (`ctx.page.goto`, `fetch` lancé dans `evaluate`, sous-ressources,
      // cadres hors processus) : un saut refusé du cadre principal ou d'une chaîne lancée par le code du script arrête
      // l'essai ; une sous-ressource du site est seulement coupée.
      checkRequest: async (hop: BrowserRequestCheck) => {
        const decision = await robotsDecision(hop.url);
        if (decision.allowed) return true;
        const issuedState = hop.redirect ? issuedByUrl.get(hop.rootUrl) : host.armed();
        if (hop.mainFrame || issuedState === true) retain(decision.failure);
        return false;
      },
      admit: async (request) => {
        if (refusal !== undefined) return false;
        // robots.txt (1.11) : chemin interdit ou robots.txt injoignable → coupée sans connexion ; l'essai s'arrête si la
        // requête est celle de la stratégie (navigation du cadre principal, requête lancée par le script).
        const decision = await robotsDecision(request.url());
        if (!decision.allowed) {
          if (mainRoot(request) || issued.get(chainRoot(request)) === true) retain(decision.failure);
          return false;
        }
        // Soumission (navigation hors GET/HEAD) sans `allow_write_actions` : coupée, imputée au script.
        if (!allowWriteActions && request.isNavigationRequest() && !READ_METHODS.has(request.method())) {
          host.report(new URL(request.url()).hostname, 'write_action_blocked', issued.get(chainRoot(request)));
          return false;
        }
        // Navigation du cadre principal ni demandée ni lancée par le code du script : refusée (décidé à l'émission,
        // avant toute attente).
        if (selfNavigation(request)) return false;
        // Nouvelle navigation DEMANDÉE du cadre principal : le document courant est classé d'abord, sur son DOM tant qu'il est
        // encore là (le corps brut d'un document que cette navigation interrompt n'est plus lisible), puis sur son corps
        // brut (verdict de l'écouteur, attente bornée) : un défi qui se recharge lui-même est refusé avant que le
        // rechargement ne parte.
        const previous = previousDocumentVerdict.get(request);
        if (previous !== undefined) {
          const doc = currentDocument;
          let classified = doc === undefined;
          if (doc !== undefined && refusal === undefined) {
            const html = await currentDom();
            if (html !== undefined) {
              examine({ status: doc.status, headers: doc.headers, body: html, url: doc.url }, { requestUrl: doc.requestUrl });
              classified = true;
            }
          }
          if (refusal === undefined) await Promise.race([previous, sleep(PREVIOUS_VERDICT_WAIT_MS)]);
          // Document qui s'en va avant d'avoir pu être classé (ni DOM lisible ni corps brut lu) : la page s'est rechargée
          // ou redirigée d'elle-même en cours de chargement, sans verdict possible ; refus prudent (INV6).
          if (refusal === undefined && !classified && doc !== undefined && !rawClassified.has(doc.root)) {
            retain({ failure_class: 'blocked_by_protection', retryable: false, detail: 'self_navigation', status: doc.status });
          }
        }
        if (refusal !== undefined) return false;
        if (!PACED_TYPES.has(request.resourceType())) return true;
        if ((await reserve(request.url())) !== 'ok') return false;
        pacedRequests.add(request);
        return true;
      },
    });
    const strategy = trackStrategyRequests(rc.context, options.allowedHosts);
    rc.context.on('request', (request) => {
      const root = chainRoot(request);
      if (root === request) {
        issued.set(request, host.armed());
        if (issuedByUrl.size >= 2000) issuedByUrl.delete(issuedByUrl.keys().next().value as string);
        issuedByUrl.set(request.url(), host.armed());
        try {
          if (isMainNavigation(rc.page)(request)) {
            mainNavigations.add(request);
            let resolve: () => void = () => undefined;
            const verdict = new Promise<void>((r) => {
              resolve = r;
            });
            const timer = setTimeout(resolve, DOCUMENT_VERDICT_WAIT_MS);
            previousDocumentVerdict.set(request, lastDocumentVerdict);
            lastDocumentVerdict = verdict;
            documentVerdicts.set(request, () => {
              clearTimeout(timer);
              resolve();
            });
          }
        } catch {
          // Requête sans cadre : jamais une navigation de la page du run.
        }
      }
      // Saut de redirection hors des domaines de l'API (que `context.route` ne voit pas) : imputé selon l'état de la
      // requête initiale, jamais appris dans la ligne de base ; le proxy d'egress le refuse de toute façon.
      else if (!hostAllowed(request.url(), options.allowedHosts)) {
        let target = '?';
        try {
          target = new URL(request.url()).hostname;
        } catch {
          // URL illisible : « ? ».
        }
        host.report(target, 'domain_not_allowed', issuedState(request));
      }
    });
    rc.context.on('requestfailed', settleDocument);
    // Garde de classification des réponses de la page (INV6) : tâches en cours, document à classer sur son contenu.
    const pending = new Set<Promise<void>>();
    let documentToCheck: { status: number; headers: Record<string, string>; requestUrl: string } | undefined;
    rc.context.on('response', (response) => {
      const request = response.request();
      const paced = pacedRequests.has(request);
      const status = response.status();
      const headers = response.headers();
      const retryAfter = headers['retry-after'] ?? null;
      let mainDocument = false;
      try {
        mainDocument = isMainNavigation(rc.page)(request);
      } catch {
        // Requête sans cadre : jamais un document de la page du run.
      }
      const classified =
        refusal === undefined &&
        hostAllowed(response.url(), options.allowedHosts) &&
        (mainDocument || (DATA_TYPES.has(request.resourceType()) && issued.get(chainRoot(request)) === true)) &&
        // Saut de redirection : la réponse suivante sera classée.
        !(status >= 300 && status < 400 && headers['location'] !== undefined);
      const hop = status >= 300 && status < 400 && headers['location'] !== undefined;
      // Document courant soumis à la garde (hors domaines de l'API ou après un refus : aucun classement, comme avant).
      if (mainDocument && !hop) currentDocument = classified ? { status, headers, url: response.url(), requestUrl: chainRoot(request).url(), root: chainRoot(request) } : undefined;
      if (!classified) {
        if (paced) void report(response.url(), status, retryAfter);
        if (mainDocument && !hop) settleDocument(request);
        return;
      }
      // URL demandée : racine de la chaîne de redirections (redirection vers la connexion, 04 §7).
      const requestUrl = chainRoot(request).url();
      // Statut et en-têtes seuls, DÈS la réponse : un en-tête de défi ou un 401 ne dépend pas du corps (qui peut tarder,
      // pendant que le script du défi réécrit le document et relance la page) ; retenu aussitôt.
      const early = classify({ status, headers, body: '', url: response.url() }, { requestUrl });
      if (early !== null && (early.failure_class === 'blocked_by_protection' || early.failure_class === 'auth_required')) retain(early);
      const task = (async (): Promise<FailureClass | null> => {
        // Document : corps BRUT servi, avant que ses scripts ne le transforment ; appel de données : petit corps.
        let body: string;
        if (mainDocument) {
          // Lecture abandonnée dès qu'un refus est constaté (document interrompu par un rechargement refusé).
          const raw = await Promise.race([boundedDocumentBody(response, MAX_RESPONSE_BYTES, undefined, cdpRef.sizes), onRefusal()]);
          body = typeof raw === 'string' ? raw : '';
          if (typeof raw === 'string') rawClassified.add(chainRoot(request));
        } else body = await smallBody(response);
        const { refused, failure } = examine({ status, headers, body, url: response.url() }, { requestUrl });
        if (!refused && mainDocument) documentToCheck = { status, headers, requestUrl };
        return failure?.failure_class ?? null;
      })().catch(() => null);
      // Compte rendu (avec la classe) chaîné dès maintenant : la requête suivante de la page attend ce verdict.
      if (paced) void report(response.url(), status, retryAfter, task);
      else awaitVerdict(task);
      const done = task.then(() => undefined);
      if (mainDocument) void done.finally(() => settleDocument(request));
      pending.add(done);
      void done.finally(() => pending.delete(done));
    });
    /** Avant et après chaque opération de page : classements en cours terminés, document courant classé sur son contenu. */
    const accessGuard = async (): Promise<void> => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
      const doc = documentToCheck;
      if (refusal === undefined && doc !== undefined) {
        documentToCheck = undefined;
        const html = await boundedContent(rc.page, MAX_RESPONSE_BYTES).catch((): typeof TOO_LARGE => TOO_LARGE);
        examine({ status: doc.status, headers: doc.headers, body: html === TOO_LARGE ? '' : html, url: rc.page.url() }, { requestUrl: doc.requestUrl });
      }
      if (refusal !== undefined) throw new SandboxBridgeError(ACCESS_REFUSED, false);
    };
    // Nouveau document validé dans le cadre principal (ni navigation dans le document, ni restauration du cache de
    // retour) : le code injecté a disparu avec l'ancien, le guet est désarmé. Sans session CDP, le guet ne se désarme
    // jamais (plus prudent, jamais moins).
    const cdp = await rc.context.newCDPSession(rc.page).catch(() => undefined);
    if (cdp !== undefined) cdpRef.session = cdp;
    if (cdp !== undefined) {
      const sizes = await trackDecodedSizes(cdp).catch(() => undefined);
      if (sizes !== undefined) cdpRef.sizes = sizes;
      cdp.on('Page.frameNavigated', (event) => {
        if (event.frame.parentId === undefined && event.type === 'Navigation') host.documentCommitted();
      });
      await cdp.send('Page.enable').catch(() => undefined);
    }
    // Refus du verrou au niveau du proxy d'egress (sauts de redirection, TURN/TCP de WebRTC…) : même guet.
    const unsubscribe = options.egress.onDomainBlocked((target) => host.report(target.host));
    const onAbort = () => void rc.close();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (result: DeclarativeRunResult, rest: Omit<ScriptRunOutcome, 'result' | 'logs' | 'items'> = { violations: [], killed: false }): ScriptRunOutcome => {
      // Réponses de `ctx.fetch` jamais classées (corps illisible) : rapportées sur leur seul statut.
      for (const [url, queue] of pendingFetchReports) for (const entry of queue) void report(url, entry.status, entry.retryAfter);
      pendingFetchReports.clear();
      let out = result;
      if (!out.ok && refusal === undefined && paceRefusal !== undefined) {
        out = { ...out, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${paceRefusal}` } };
      }
      // Requête de la stratégie (page de départ, `ctx.page.goto`) redirigée hors des domaines de l'API : faute de
      // stratégie. Jamais déduite des sous-ressources tierces du site coupées (04 §7).
      const cls = out.ok ? undefined : out.failure.failure_class;
      if (!out.ok && out.failure.detail !== 'sandbox_violation' && refusal === undefined && strategy.cut() && (cls === 'network' || cls === 'transient' || cls === 'code_error')) {
        out = { ...out, failure: DOMAIN_NOT_ALLOWED };
      }
      return { ...rest, result: out, logs, items };
    };
    try {
      rc.page.setDefaultNavigationTimeout(timeoutMs);
      rc.page.setDefaultTimeout(timeoutMs);
      // Page de départ : réservée à la cadence (au niveau du contexte), ouverte par l'hôte, classée avant tout code.
      let exchange: HttpExchange;
      try {
        host.beginHostOp();
        host.expectNavigation();
        const landing = await strategy
          .during(isMainNavigation(rc.page), () => guardedGoto(rc.page, options.startUrl, options.guard, { waitUntil: 'load' as const, timeout: timeoutMs }))
          .finally(() => {
            host.settleNavigation();
            host.endHostOp();
          });
        // Redirection hors des domaines de l'API : refusée par le proxy d'egress ; faute de stratégie, jamais un réseau.
        if (landing !== null && !hostAllowed(landing.url(), options.allowedHosts)) throw new DomainNotAllowedError(new URL(landing.url()).hostname);
        const html = await boundedContent(rc.page, MAX_RESPONSE_BYTES);
        if (html === TOO_LARGE) return finish(fail({ failure_class: 'extraction', retryable: false, detail: 'response_too_large' }, 1, requests));
        exchange = { status: landing?.status() ?? 0, headers: landing?.headers() ?? {}, body: html, url: rc.page.url() };
      } catch (error) {
        if (options.signal.aborted) throw error;
        // Un refus constaté sur la réponse servie (défi qui recharge la page, coupé) prime sur l'erreur de navigation.
        while (pending.size > 0) await Promise.allSettled([...pending]);
        return finish(fail(refusal ?? classifyTransportError(error), 1, requests));
      }
      // Réponse servie (corps brut, classée par l'écouteur) d'abord, puis DOM rendu.
      while (pending.size > 0) await Promise.allSettled([...pending]);
      if (refusal !== undefined) return finish(fail(refusal, 1, requests));
      const refused = classify(exchange, { requestUrl: options.startUrl });
      if (refused !== null) return finish(fail(refused, 1, requests));
      // Page de départ classée ici sur son contenu : la garde des opérations de page n'a pas à la relire.
      while (pending.size > 0) await Promise.allSettled([...pending]);
      documentToCheck = undefined;
      if (refusal !== undefined) return finish(fail(refusal, 1, requests));

      const handle = createSandboxBridges({
        allowedDomains: options.allowedHosts,
        guard: options.guard,
        logger: options.logger,
        maxItems: MAX_ITEMS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        // Le plafond du run est tenu par le transport ci-dessous (refus sans violation), pas par le quota du pont.
        maxRequests: Number.MAX_SAFE_INTEGER,
        onLog: (args) => void logs.push([...args]),
        // `ctx.fetch` : un saut à la fois (le pont contrôle le domaine de chaque redirection), par la session de l'essai,
        // chaque saut réservé à la cadence et compté dans le plafond du run.
        fetch: async (request, signal) => {
          // robots.txt avant tout (chaque saut) : un chemin interdit ne reçoit aucune requête, l'essai s'arrête.
          const decision = await robotsDecision(request.url);
          if (!decision.allowed) {
            retain(decision.failure);
            throw new SandboxBridgeError(ACCESS_REFUSED, false);
          }
          const slot = await reserve(request.url);
          if (slot === 'refused') throw new SandboxBridgeError(ACCESS_REFUSED, false);
          if (slot === 'cap') throw new SandboxBridgeError('request_cap', false);
          if (slot === 'paced') throw new SandboxBridgeError('rate_limited', false);
          const response = (await options.session.fetch(
            request.url,
            { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), signal },
            { followRedirects: false },
          )) as unknown as BridgeResponse;
          const retryAfter = response.headers.get('retry-after');
          if (response.status >= 300 && response.status < 400 && response.headers.get('location') !== null) {
            // Saut de redirection : classé sur son statut et ses en-têtes (en-tête de défi), rapporté aussitôt.
            const hop: Record<string, string> = {};
            response.headers.forEach((value, name) => {
              hop[name.toLowerCase()] = value;
            });
            await report(request.url, response.status, retryAfter, classify({ status: response.status, headers: hop, body: '', url: request.url })?.failure_class ?? null);
          } else {
            // Réponse finale : rapportée par `inspect`, une fois classée sur son corps.
            const key = hrefOf(request.url);
            pendingFetchReports.set(key, [...(pendingFetchReports.get(key) ?? []), { status: response.status, retryAfter }]);
          }
          return response;
        },
        // Réponse finale de `ctx.fetch` classée AVANT sa remise au script (avec l'URL demandée) : un refus n'est jamais
        // rendu ; la classe est rapportée à la cadence (disjoncteur).
        inspect: async (response, { requestUrl }) => {
          const { refused, failure } = examine({ status: response.status, headers: { ...response.headers }, body: response.body, url: response.url }, { requestUrl });
          await reportFetch(response.url, failure?.failure_class ?? null);
          if (refused) throw new SandboxBridgeError(ACCESS_REFUSED, false);
        },
      });
      items = handle.items;
      handle.bridges.page = createPageBridge({
        page: rc.page,
        guard: options.guard,
        allowedHosts: options.allowedHosts,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxItems: MAX_ITEMS,
        timeoutMs,
        watch: host,
        allowWriteActions,
        accessGuard,
        strategy,
      });
      // Un refus arrête l'enfant aussitôt (même mise à mort que l'annulation du run), sans verdict de violation.
      const sandbox = await options.engine.run(options.code, handle.bridges, options.limits ?? DEFAULT_SANDBOX_LIMITS, {
        input: options.input,
        signal: AbortSignal.any([options.signal, stopOnRefusal.signal]),
        watch: host.watch,
      });
      options.signal.throwIfAborted();
      const base = { violations: sandbox.violations, killed: sandbox.killed, ...(sandbox.killLatencyMs === undefined ? {} : { killLatencyMs: sandbox.killLatencyMs }) };
      // Violation : `code_error` (réparation), sauf si un refus est retenu (navigation non demandée du cadre principal
      // pendant un `evaluate`, qui peut être un défi de la page) : la classe du refus, la violation reste journalisée.
      if (sandbox.outcome === 'violation') return finish(fail(refusal ?? codeError('sandbox_violation'), 1, requests), base);
      // Refus d'accès en cours de script : la classe du refus, les éléments émis sont ignorés.
      if (refusal !== undefined) return finish(fail(refusal, 1, requests), base);
      if (sandbox.outcome !== 'ok') return finish(fail(codeError(capReached ? 'max_requests_per_run' : `sandbox_${sandbox.outcome}`), 1, requests), base);
      if (paceRefusal !== undefined) return finish(fail({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${paceRefusal}` }, 1, requests), base);
      const records = handle.items.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null && !Array.isArray(i));
      if (records.length !== handle.items.length) return finish(fail({ failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' }, 1, requests), base);
      return finish(
        { ok: true, records, pages: 1, requests, escalated: false, stop: capReached ? 'max_requests_per_run' : 'no_pagination', truncated: capReached },
        base,
      );
    } finally {
      unsubscribe();
      options.signal.removeEventListener('abort', onAbort);
      await cdp?.detach().catch(() => undefined);
      await rc.close();
    }
  });
}
