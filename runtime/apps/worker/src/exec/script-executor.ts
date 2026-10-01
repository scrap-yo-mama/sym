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
import { classifyExchange, classifyTransportError, type DeclarativeRunResult, type ExecFailure, type HttpExchange, type RequestPacer } from '@runtime/core/exec';
import { DomainNotAllowedError, guardedGoto, type BrowserEgress, type NetworkSession, type SsrfGuard } from '@runtime/core/net';
import type { Logger } from 'pino';
import type { Request, Response } from 'playwright-core';
import { boundedContent, TOO_LARGE } from '../browser/bounded.js';
import type { BrowserPool } from '../browser/pool.js';
import { chainRoot, hostAllowed, isMainNavigation, openRunContext, trackStrategyRequests } from '../browser/run-context.js';
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
  /** Garde de classification (1.7) ; défaut : statut seul (`classifyExchange`). */
  readonly classify?: (exchange: HttpExchange) => ExecFailure | null;
  readonly navigationTimeoutMs?: number;
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
  /** Classe une réponse ; vrai si c'est un refus (retenu, enfant arrêté). */
  const examine = (exchange: HttpExchange): boolean => {
    if (refusal !== undefined) return true;
    const failure = classify(exchange);
    if (failure === null || PASS_THROUGH.has(failure.failure_class)) return false;
    refusal = failure;
    stopOnRefusal.abort();
    return true;
  };
  /** Compte rendu à la cadence, sérialisé : une réservation attend le compte rendu précédent (un 429 ralentit la suivante). */
  let reporting: Promise<void> = Promise.resolve();
  const report = (url: string, status: number, retryAfter: string | null): Promise<void> => {
    if (pacer === undefined) return Promise.resolve();
    reporting = reporting.then(() => pacer.report(url, { status, retryAfter })).catch(() => undefined);
    return reporting;
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
    if (pacer === undefined) return 'ok';
    await reporting;
    const slot = await pacer.acquire(url);
    if (slot.granted) return refusal === undefined ? 'ok' : 'refused';
    paceRefusal = slot.reason;
    return 'paced';
  };
  const pacedRequests = new WeakSet<Request>();

  return options.pool.run(options.signal, async (browser) => {
    const host = hostViolationWatch();
    /** État du guet à l'émission de chaque requête Chromium (le code du script pouvait-il l'avoir lancée ?). */
    const issued = new WeakMap<Request, boolean>();
    /** Requêtes initiales qui sont une navigation du cadre principal (relevé à l'émission). */
    const mainNavigations = new WeakSet<Request>();
    /**
     * État d'émission transmis au guet : jamais appris d'un saut de redirection, d'une requête de la stratégie
     * (`ctx.page.goto`, clic du script) ni d'une navigation du cadre principal (`issuedForWatch`, D-29).
     */
    const issuedState = (request: Request): boolean | undefined => {
      const root = chainRoot(request);
      return issuedForWatch(issued.get(root), { redirectHop: root !== request, strategy: strategy.owns(root), mainNavigation: mainNavigations.has(root) });
    };
    const rc = await openRunContext(browser, {
      egressServer: options.egress.server,
      allowedHosts: options.allowedHosts,
      onViolation: (h, request) => host.report(h, 'domain_not_allowed', request === undefined ? undefined : issuedState(request)),
      admit: async (request) => {
        if (refusal !== undefined) return false;
        // Soumission (navigation hors GET/HEAD) sans `allow_write_actions` : coupée, imputée au script.
        if (!allowWriteActions && request.isNavigationRequest() && !READ_METHODS.has(request.method())) {
          host.report(new URL(request.url()).hostname, 'write_action_blocked', issued.get(chainRoot(request)));
          return false;
        }
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
        try {
          if (isMainNavigation(rc.page)(request)) mainNavigations.add(request);
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
    // Garde de classification des réponses de la page (INV6) : tâches en cours, document à classer sur son contenu.
    const pending = new Set<Promise<void>>();
    let documentToCheck: { status: number; headers: Record<string, string> } | undefined;
    rc.context.on('response', (response) => {
      const request = response.request();
      if (pacedRequests.has(request)) void report(response.url(), response.status(), response.headers()['retry-after'] ?? null);
      if (refusal !== undefined || !hostAllowed(response.url(), options.allowedHosts)) return;
      let mainDocument = false;
      try {
        mainDocument = isMainNavigation(rc.page)(request);
      } catch {
        // Requête sans cadre : jamais un document de la page du run.
      }
      if (!mainDocument && !(DATA_TYPES.has(request.resourceType()) && issued.get(chainRoot(request)) === true)) return;
      const status = response.status();
      // Saut de redirection : la réponse suivante sera classée.
      if (status >= 300 && status < 400 && response.headers()['location'] !== undefined) return;
      const headers = response.headers();
      const task = (async () => {
        const body = mainDocument ? '' : await smallBody(response);
        if (!examine({ status, headers, body, url: response.url() }) && mainDocument) documentToCheck = { status, headers };
      })().catch(() => undefined);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    /** Avant et après chaque opération de page : classements en cours terminés, document courant classé sur son contenu. */
    const accessGuard = async (): Promise<void> => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
      const doc = documentToCheck;
      if (refusal === undefined && doc !== undefined) {
        documentToCheck = undefined;
        const html = await boundedContent(rc.page, MAX_RESPONSE_BYTES).catch((): typeof TOO_LARGE => TOO_LARGE);
        examine({ status: doc.status, headers: doc.headers, body: html === TOO_LARGE ? '' : html, url: rc.page.url() });
      }
      if (refusal !== undefined) throw new SandboxBridgeError(ACCESS_REFUSED, false);
    };
    // Nouveau document validé dans le cadre principal (ni navigation dans le document, ni restauration du cache de
    // retour) : le code injecté a disparu avec l'ancien, le guet est désarmé. Sans session CDP, le guet ne se désarme
    // jamais (plus prudent, jamais moins).
    const cdp = await rc.context.newCDPSession(rc.page).catch(() => undefined);
    if (cdp !== undefined) {
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
        const landing = await strategy
          .during(isMainNavigation(rc.page), () => guardedGoto(rc.page, options.startUrl, options.guard, { waitUntil: 'load' as const, timeout: timeoutMs }))
          .finally(() => host.endHostOp());
        // Redirection hors des domaines de l'API : refusée par le proxy d'egress ; faute de stratégie, jamais un réseau.
        if (landing !== null && !hostAllowed(landing.url(), options.allowedHosts)) throw new DomainNotAllowedError(new URL(landing.url()).hostname);
        const html = await boundedContent(rc.page, MAX_RESPONSE_BYTES);
        if (html === TOO_LARGE) return finish(fail({ failure_class: 'extraction', retryable: false, detail: 'response_too_large' }, 1, requests));
        exchange = { status: landing?.status() ?? 0, headers: landing?.headers() ?? {}, body: html, url: rc.page.url() };
      } catch (error) {
        if (options.signal.aborted) throw error;
        return finish(fail(classifyTransportError(error), 1, requests));
      }
      const refused = classify(exchange);
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
          const slot = await reserve(request.url);
          if (slot === 'refused') throw new SandboxBridgeError(ACCESS_REFUSED, false);
          if (slot === 'cap') throw new SandboxBridgeError('request_cap', false);
          if (slot === 'paced') throw new SandboxBridgeError('rate_limited', false);
          const response = (await options.session.fetch(
            request.url,
            { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), signal },
            { followRedirects: false },
          )) as unknown as BridgeResponse;
          await report(request.url, response.status, response.headers.get('retry-after'));
          return response;
        },
        // Réponse finale de `ctx.fetch` classée AVANT sa remise au script : un refus n'est jamais rendu.
        inspect: (response) => {
          if (examine({ status: response.status, headers: { ...response.headers }, body: response.body, url: response.url })) {
            throw new SandboxBridgeError(ACCESS_REFUSED, false);
          }
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
      if (sandbox.outcome === 'violation') return finish(fail(codeError('sandbox_violation'), 1, requests), base);
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
