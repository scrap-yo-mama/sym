// SPDX-License-Identifier: AGPL-3.0-only
// E3 en script (`script_ref`, tâche 1.6 ; 08 §3 ; D-29) : le code généré ne s'exécute QUE dans le bac à sable de 1.5
// (`SandboxEngine`, processus enfant à environnement vide, isolated-vm) et ne voit que des ponts : `ctx.fetch`,
// `ctx.emit`, `ctx.log` (1.5) et `ctx.page.*` (ici), sous-ensemble de Playwright relayé, en liste fermée.
// - Chaque opération de page est une demande JSON validée ici (forme, tailles, domaine de l'API) ; la page Playwright
//   reste dans le worker, jamais exposée à l'isolat. Toute valeur rendue au script est bornée DANS la page avant
//   transfert (HTML, textes, résultat d'`evaluate`) : une page hostile ne fait pas charger des centaines de Mo au worker.
// - `ctx.page.evaluate` exécute le texte d'une fonction DANS LA PAGE (Chromium) : son trafic passe par le proxy
//   d'egress de l'essai (garde SSRF, verrou de domaines) et par `context.route('**')`. Imputation des requêtes coupées
//   par la politique de domaines (`hostViolationWatch`) : une fois le code du script entré dans le document (premier
//   `evaluate`), une requête coupée vers un hôte que le site n'a pas lui-même contacté (ligne de base : hôtes coupés
//   avant `evaluate`, ou pendant une navigation ou un clic menés par l'hôte) est une `sandbox_violation` : l'enfant est
//   tué aussitôt (`watch` du moteur), même si la page avale l'erreur ou n'attend pas la réponse. Les sous-ressources
//   tierces du site (mesure d'audience, CDN) restent coupées (0 requête) sans verdict contre le script ; un nouveau
//   document chargé désarme le guet jusqu'au prochain `evaluate`.
// - Actions d'écriture (08 §4 mesure 4, 07 §5) : sans `allow_write_actions`, un clic sur un contrôle d'envoi de
//   formulaire est refusé (`write_action_blocked`, violation) ; les soumissions de formulaire (navigations hors GET)
//   sont coupées au niveau du contexte de run (script-executor.ts).
import type { SandboxBridges, SandboxViolation, SandboxViolationReason } from '@runtime/core';
import { guardedGoto, type SsrfGuard } from '@runtime/core/net';
import type { Page } from 'playwright-core';
import { boundedContent, parseBounded, TOO_LARGE } from '../browser/bounded.js';
import { domainAllowed, normalizeDomain, SandboxBridgeError } from '../sandbox/bridges.js';

/** Opérations `ctx.page.*` (liste fermée, figée par la tâche 1.6). */
export const PAGE_OPERATIONS = Object.freeze(['goto', 'url', 'waitForSelector', 'content', 'textAll', 'attrAll', 'click', 'evaluate'] as const);
type PageOperation = (typeof PAGE_OPERATIONS)[number];

const MAX_SELECTOR = 500;
const MAX_URL = 8192;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 10_000;

/** Raisons imputables au script par le guet de l'hôte. */
type HostViolationReason = Extract<SandboxViolationReason, 'domain_not_allowed' | 'write_action_blocked'>;

/**
 * Guet des requêtes coupées, branché sur le moteur (`SandboxRunOptions.watch`) : tue l'enfant à la première requête
 * imputable au script. Alimenté par `context.route` (politique de domaines, soumissions coupées) ET par le proxy
 * d'egress de l'essai (sauts de redirection, TURN/TCP de WebRTC, tout ce que `context.route` ne voit pas).
 */
export type HostViolationWatch = {
  readonly watch: (violate: (violation: SandboxViolation) => void) => void;
  /** Début et fin d'un `ctx.page.evaluate` : le code du script entre dans le document courant. */
  beginEvaluate(): void;
  endEvaluate(): void;
  /** Navigation ou clic menés par l'hôte : les requêtes coupées pendant eux viennent du site (ligne de base). */
  beginHostOp(): void;
  endHostOp(): void;
  /** Nouveau document dans la page du run : le code injecté a disparu avec l'ancien. */
  documentLoaded(): void;
  report(host: string, reason?: HostViolationReason): void;
  /** Requêtes imputées au script (compte, jamais plafonné). */
  imputed(): number;
  /** Dernière requête imputée (raison, hôte). */
  lastImputed(): SandboxViolation | undefined;
};

export function hostViolationWatch(): HostViolationWatch {
  let sink: ((violation: SandboxViolation) => void) | undefined;
  let armed = false;
  let evaluating = 0;
  let hostOps = 0;
  let imputed = 0;
  let last: SandboxViolation | undefined;
  const baseline = new Set<string>();
  const impute = (host: string, reason: HostViolationReason) => {
    imputed += 1;
    last = { reason, detail: host.slice(0, 253) };
    sink?.(last);
  };
  return {
    watch: (violate) => {
      sink = violate;
    },
    beginEvaluate: () => {
      armed = true;
      evaluating += 1;
    },
    endEvaluate: () => {
      evaluating = Math.max(0, evaluating - 1);
    },
    beginHostOp: () => {
      hostOps += 1;
    },
    endHostOp: () => {
      hostOps = Math.max(0, hostOps - 1);
    },
    documentLoaded: () => {
      if (evaluating === 0) armed = false;
    },
    report: (raw, reason = 'domain_not_allowed') => {
      const host = raw.toLowerCase().replace(/\.$/, '');
      const fromSite = evaluating === 0 && (!armed || hostOps > 0);
      if (reason === 'write_action_blocked') {
        // Une soumission coupée pendant un clic de l'hôte vient du clic demandé par le script.
        if (armed || hostOps > 0) impute(host, reason);
        return;
      }
      if (fromSite) {
        baseline.add(host);
        return;
      }
      if (!baseline.has(host)) impute(host, reason);
    },
    imputed: () => imputed,
    lastImputed: () => last,
  };
}

export type PageBridgeOptions = {
  readonly page: Page;
  readonly guard: SsrfGuard;
  /** Domaines de l'API (noms exacts) : `ctx.page.goto` est refusé ailleurs, avant toute connexion. */
  readonly allowedHosts: readonly string[];
  /** Plafond d'une valeur rendue au script (HTML, textes, résultat d'`evaluate`), en octets, tenu dans la page. */
  readonly maxResponseBytes: number;
  /** Plafond d'éléments d'une liste rendue (`textAll`, `attrAll`). */
  readonly maxItems: number;
  /** Délai d'une opération de page (navigation, `evaluate`), en ms. */
  readonly timeoutMs: number;
  /** Guet de l'essai : imputation des requêtes coupées, autour d'`evaluate` et des opérations de l'hôte. */
  readonly watch: HostViolationWatch;
  /** `apis.allow_write_actions` : sans lui, clic sur un contrôle d'envoi de formulaire refusé. */
  readonly allowWriteActions: boolean;
};

function bad(detail: string): never {
  throw new SandboxBridgeError('invalid_bridge_call', true, detail);
}

function parseRequest(raw: unknown): { op: PageOperation; args: Record<string, unknown> } {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_SOURCE_BYTES + MAX_ARG_BYTES + 1024) bad('page : demande');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return bad('page : JSON invalide');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad('page : objet attendu');
  const { op, args } = value as { op?: unknown; args?: unknown };
  if (typeof op !== 'string' || !(PAGE_OPERATIONS as readonly string[]).includes(op)) bad('page : opération');
  if (typeof args !== 'object' || args === null || Array.isArray(args)) bad('page : arguments');
  return { op: op as PageOperation, args: args as Record<string, unknown> };
}

const text = (v: unknown, name: string, max: number): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) bad(`page : ${name}`);
  return v;
};

const waitMs = (v: unknown): number => {
  if (v === undefined || v === null) return DEFAULT_WAIT_MS;
  if (typeof v !== 'number' || !Number.isFinite(v)) bad('page : délai');
  return Math.min(Math.max(Math.floor(v), 0), MAX_WAIT_MS);
};

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SandboxBridgeError('page_failed', false, 'timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const tooLarge = (): never => {
  throw new SandboxBridgeError('output_limit', true, 'page');
};

/**
 * Pont `ctx.page.*` d'un essai E3. Chaque refus de domaine est une violation (l'enfant est tué). Une erreur de
 * Playwright (sélecteur absent, délai) est rendue au script sous un code stable (`page_failed`), sans message.
 */
export function createPageBridge(options: PageBridgeOptions): NonNullable<SandboxBridges['page']> {
  const allowed = options.allowedHosts.map(normalizeDomain);
  const { page, watch, maxResponseBytes: max } = options;
  const checkUrl = (raw: string): string => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return bad('page : url invalide');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('page : schéma');
    if (url.username !== '' || url.password !== '') bad('page : identifiants dans l’url');
    if (!domainAllowed(url.hostname, allowed)) throw new SandboxBridgeError('domain_not_allowed', true, url.hostname.toLowerCase().slice(0, 253));
    return url.href;
  };
  /** Une requête imputée au script pendant `evaluate` est une violation, même si la page a avalé l'erreur. */
  const settled = <T>(before: number, value: T): T => {
    if (watch.imputed() > before) {
      const v = watch.lastImputed();
      throw new SandboxBridgeError(v?.reason ?? 'domain_not_allowed', true, v?.detail);
    }
    return value;
  };
  /** Liste rendue par la page sous forme de texte JSON borné (chaînes ou `null`). */
  const boundedList = async (selector: string, attribute: string | null): Promise<(string | null)[]> => {
    const raw = await page.locator(selector).evaluateAll(
      (nodes, a: { max: number; maxItems: number; attribute: string | null }) => {
        const out: (string | null)[] = [];
        const n = Math.min(nodes.length, a.maxItems);
        for (let i = 0; i < n; i++) {
          const node = nodes[i] as unknown as { textContent: string | null; getAttribute(name: string): string | null };
          out.push(a.attribute === null ? (node.textContent ?? '') : node.getAttribute(a.attribute));
        }
        let s: unknown;
        try {
          s = JSON.stringify(out);
        } catch {
          return null;
        }
        return typeof s === 'string' && s.length <= a.max ? s : null;
      },
      { max, maxItems: options.maxItems, attribute },
    );
    const value = parseBounded(raw, max);
    if (value === TOO_LARGE || !Array.isArray(value) || !value.every((v) => v === null || typeof v === 'string')) return tooLarge();
    return value as (string | null)[];
  };
  /** Vrai si le clic viserait un contrôle d'envoi d'un formulaire (bouton d'envoi, `input` submit ou image). */
  const isSubmitControl = (selector: string, timeout: number): Promise<boolean> =>
    page
      .locator(selector)
      .first()
      .evaluate(
        (el) => {
          type Control = { tagName: string; type: string; form: unknown };
          const c = (el as unknown as { closest(selector: string): Control | null }).closest('button, input[type="submit" i], input[type="image" i]');
          if (c === null || c.form === null || c.form === undefined) return false;
          return c.tagName !== 'BUTTON' || c.type === 'submit';
        },
        undefined,
        { timeout },
      );

  return async (raw) => {
    const { op, args } = parseRequest(raw);
    const before = watch.imputed();
    const isEvaluate = op === 'evaluate';
    const hostOp = op === 'goto' || op === 'click';
    if (isEvaluate) watch.beginEvaluate();
    if (hostOp) watch.beginHostOp();
    // Hors `evaluate`, les requêtes coupées relèvent du guet (`watch`), pas du verdict de l'opération.
    const check = <T>(value: T): T => (isEvaluate ? settled(before, value) : value);
    try {
      switch (op) {
        case 'goto': {
          const url = checkUrl(text(args['url'], 'url', MAX_URL));
          const response = await guardedGoto(page, url, options.guard, { waitUntil: 'load' as const, timeout: options.timeoutMs });
          return check({ status: response?.status() ?? 0, url: page.url() });
        }
        case 'url':
          return check({ url: page.url() });
        case 'waitForSelector': {
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          const timeout = waitMs(args['timeoutMs']);
          await page.waitForSelector(selector, { state: 'attached', timeout });
          return check({});
        }
        case 'content': {
          const html = await within(boundedContent(page, max), options.timeoutMs);
          return check({ html: html === TOO_LARGE ? tooLarge() : html });
        }
        case 'textAll': {
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          return check({ texts: (await within(boundedList(selector, null), options.timeoutMs)).map((t) => t ?? '') });
        }
        case 'attrAll': {
          const name = text(args['name'], 'attribut', 100);
          if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name)) bad('page : attribut');
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          return check({ values: await within(boundedList(selector, name), options.timeoutMs) });
        }
        case 'click': {
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          const timeout = waitMs(args['timeoutMs']);
          if (!options.allowWriteActions && (await isSubmitControl(selector, timeout))) {
            throw new SandboxBridgeError('write_action_blocked', true, 'submit');
          }
          await page.click(selector, { timeout });
          return check({ url: page.url() });
        }
        case 'evaluate': {
          const source = text(args['source'], 'source', MAX_SOURCE_BYTES);
          const argJson = JSON.stringify(args['arg'] ?? null);
          if (Buffer.byteLength(argJson) > MAX_ARG_BYTES) bad('page : argument');
          // Une fonction est appelée avec son argument (JSON) ; sinon le texte est une expression évaluée dans la page.
          const expression = args['isFunction'] === true ? `(${source})(${argJson})` : source;
          // La valeur reste dans la page (handle) ; seul un texte JSON borné dans la page est transféré au worker.
          const json = await within(
            (async () => {
              const handle = await page.evaluateHandle(expression);
              try {
                return await handle.evaluate((v: unknown, m: number) => {
                  let s: unknown;
                  try {
                    s = JSON.stringify(v === undefined ? null : v);
                  } catch {
                    return null;
                  }
                  if (s === undefined) return 'null';
                  return typeof s === 'string' && s.length <= m ? s : null;
                }, max);
              } finally {
                void handle.dispose().catch(() => undefined);
              }
            })(),
            options.timeoutMs,
          );
          const value = parseBounded(json, max);
          return check({ value: value === TOO_LARGE ? tooLarge() : value });
        }
      }
    } catch (error) {
      if (error instanceof SandboxBridgeError) {
        // Un `evaluate` en échec après une requête imputée : la violation prime sur l'erreur de l'opération.
        if (isEvaluate && !error.violation) check(undefined);
        throw error;
      }
      // Un `evaluate` qui échoue parce que la page a été coupée par la politique de domaines reste une violation.
      check(undefined);
      throw new SandboxBridgeError('page_failed', false, op);
    } finally {
      if (isEvaluate) watch.endEvaluate();
      if (hostOp) watch.endHostOp();
    }
  };
}
