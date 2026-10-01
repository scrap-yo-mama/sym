// SPDX-License-Identifier: AGPL-3.0-only
// E3 en script (`script_ref`, tâche 1.6 ; 08 §3 ; D-29) : le code généré ne s'exécute QUE dans le bac à sable de 1.5
// (`SandboxEngine`, processus enfant à environnement vide, isolated-vm) et ne voit que des ponts : `ctx.fetch`,
// `ctx.emit`, `ctx.log` (1.5) et `ctx.page.*` (ici), sous-ensemble de Playwright relayé, en liste fermée.
// - Chaque opération de page est une demande JSON validée ici (forme, tailles, domaine de l'API) ; la page Playwright
//   reste dans le worker, jamais exposée à l'isolat.
// - `ctx.page.evaluate` exécute le texte d'une fonction DANS LA PAGE (Chromium) : son trafic passe par le proxy
//   d'egress de l'essai (garde SSRF, verrou de domaines) et par `context.route('**')`. Dès le premier `evaluate`, toute
//   requête de la page coupée par la politique de domaines est une `sandbox_violation` : l'enfant est tué aussitôt
//   (`watch` du moteur), même si la page avale l'erreur ou n'attend pas la réponse. Avant lui, le code du script n'a pas
//   pu entrer dans la page : les requêtes tierces du site lui-même (mesure d'audience, CDN) sont coupées et notées, sans
//   verdict contre le script.
import type { SandboxBridges, SandboxViolation } from '@runtime/core';
import { guardedGoto, type SsrfGuard } from '@runtime/core/net';
import type { Page } from 'playwright-core';
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

export type PageBridgeOptions = {
  readonly page: Page;
  readonly guard: SsrfGuard;
  /** Domaines de l'API (noms exacts) : `ctx.page.goto` est refusé ailleurs, avant toute connexion. */
  readonly allowedHosts: readonly string[];
  /** Plafond d'une valeur rendue au script (HTML, textes, résultat d'`evaluate`), en octets. */
  readonly maxResponseBytes: number;
  /** Plafond d'éléments d'une liste rendue (`textAll`, `attrAll`). */
  readonly maxItems: number;
  /** Délai d'une opération de page (navigation, `evaluate`), en ms. */
  readonly timeoutMs: number;
  /** Requêtes déjà coupées par la politique de domaines (contexte de run et proxy d'egress), lues autour d'`evaluate`. */
  readonly blockedHosts: () => readonly string[];
  /** Appelé avant le premier `evaluate` : à partir de là, toute requête coupée est imputée au script. */
  readonly onEvaluate?: () => void;
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

function capped(value: string, max: number): string {
  if (Buffer.byteLength(value) > max) throw new SandboxBridgeError('output_limit', true, 'page');
  return value;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SandboxBridgeError('page_failed', false, 'timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Pont `ctx.page.*` d'un essai E3. Chaque refus de domaine est une violation (l'enfant est tué). Une erreur de
 * Playwright (sélecteur absent, délai) est rendue au script sous un code stable (`page_failed`), sans message.
 */
export function createPageBridge(options: PageBridgeOptions): NonNullable<SandboxBridges['page']> {
  const allowed = options.allowedHosts.map(normalizeDomain);
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
  /** Une requête de la page coupée pendant `evaluate` est une violation, même si la page a avalé l'erreur. */
  const settled = <T>(before: number, value: T): T => {
    const blocked = options.blockedHosts();
    if (blocked.length > before) throw new SandboxBridgeError('domain_not_allowed', true, blocked[before]?.slice(0, 253));
    return value;
  };
  const passthrough = <T>(_before: number, value: T): T => value;
  const { page } = options;

  return async (raw) => {
    const { op, args } = parseRequest(raw);
    if (op === 'evaluate') options.onEvaluate?.();
    const before = options.blockedHosts().length;
    // Hors `evaluate`, les requêtes coupées pendant une navigation peuvent venir du site : elles relèvent de `watch`.
    const check = op === 'evaluate' ? settled : passthrough;
    try {
      switch (op) {
        case 'goto': {
          const url = checkUrl(text(args['url'], 'url', MAX_URL));
          const response = await guardedGoto(page, url, options.guard, { waitUntil: 'load' as const, timeout: options.timeoutMs });
          return check(before, { status: response?.status() ?? 0, url: page.url() });
        }
        case 'url':
          return check(before, { url: page.url() });
        case 'waitForSelector': {
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          const timeout = waitMs(args['timeoutMs']);
          await page.waitForSelector(selector, { state: 'attached', timeout });
          return check(before, {});
        }
        case 'content':
          return check(before, { html: capped(await page.content(), options.maxResponseBytes) });
        case 'textAll': {
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          const texts = await page.locator(selector).allTextContents();
          return check(before, { texts: JSON.parse(capped(JSON.stringify(texts.slice(0, options.maxItems)), options.maxResponseBytes)) as string[] });
        }
        case 'attrAll': {
          const name = text(args['name'], 'attribut', 100);
          if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name)) bad('page : attribut');
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          const values = await page
            .locator(selector)
            .evaluateAll((nodes, n) => nodes.map((node) => node.getAttribute(n)), name);
          return check(before, { values: JSON.parse(capped(JSON.stringify(values.slice(0, options.maxItems)), options.maxResponseBytes)) as (string | null)[] });
        }
        case 'click': {
          const selector = text(args['selector'], 'sélecteur', MAX_SELECTOR);
          const timeout = waitMs(args['timeoutMs']);
          await page.click(selector, { timeout });
          return check(before, { url: page.url() });
        }
        case 'evaluate': {
          const source = text(args['source'], 'source', MAX_SOURCE_BYTES);
          const argJson = JSON.stringify(args['arg'] ?? null);
          if (Buffer.byteLength(argJson) > MAX_ARG_BYTES) bad('page : argument');
          // Une fonction est appelée avec son argument (JSON) ; sinon le texte est une expression évaluée dans la page.
          const expression = args['isFunction'] === true ? `(${source})(${argJson})` : source;
          const value: unknown = await within(page.evaluate(expression), options.timeoutMs);
          const json = JSON.stringify(value === undefined ? null : value) ?? 'null';
          return check(before, { value: JSON.parse(capped(json, options.maxResponseBytes)) as unknown });
        }
      }
    } catch (error) {
      if (error instanceof SandboxBridgeError) throw error;
      // Un `evaluate` qui échoue parce que la page a été coupée par la politique de domaines reste une violation.
      check(before, undefined);
      throw new SandboxBridgeError('page_failed', false, op);
    }
  };
}

/**
 * Puits de violations de l'hôte branché sur le moteur (`SandboxRunOptions.watch`) : tue l'enfant à la première requête
 * coupée APRÈS `arm()` (premier `ctx.page.evaluate`). Avant, les requêtes coupées viennent du site et sont ignorées ici.
 */
export type HostViolationWatch = {
  readonly watch: (violate: (violation: SandboxViolation) => void) => void;
  arm(): void;
  report(host: string): void;
};

export function hostViolationWatch(): HostViolationWatch {
  let sink: ((violation: SandboxViolation) => void) | undefined;
  let armed = false;
  return {
    watch: (violate) => {
      sink = violate;
    },
    arm: () => {
      armed = true;
    },
    report: (host) => {
      if (armed) sink?.({ reason: 'domain_not_allowed', detail: host.slice(0, 253) });
    },
  };
}
