// SPDX-License-Identifier: AGPL-3.0-only
// Reconnaissance (tâche 2.1, 04 §4, S5) : à partir de ce qu'une passe sur la page a capturé (trafic XHR / fetch en E3,
// document servi et rendu), les GISEMENTS de données dans l'ordre de 04b §2 : réponses JSON du site, blobs embarqués
// (`__NEXT_DATA__`, Nuxt, état Apollo, JSON-LD), puis BLOCS RÉPÉTÉS du DOM (liste HTML : cartes de même balise et mêmes
// classes, emplacements vérifiés, pagination détectée, dom.ts), cherchés AVANT de conclure « pas d'API ». Chaque gisement porte des tableaux d'enregistrements
// (chemin JSONPath RFC 9535), leur nombre, leur taille mesurée et un SQUELETTE (chemins et types du premier
// enregistrement, aucune valeur) : c'est tout ce que le LLM d'enquête verra du site (08 §4, 17 §6 ; une valeur de la
// page n'est jamais une consigne). Une requête qui porte un jeton ou une signature calculés côté client rend la voie
// `unsupported`, sans aucune tentative de les reproduire (INV6, 04b §2 principe 6).
// Fonctions pures, sans I/O.
import type { Document } from 'domhandler';
import { decodeEmbedded, type BlobKind, type BlobLocator } from '../dsl/blobs.js';
import { elementAttribute, parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS, type DslLimits } from '../dsl/limits.js';
import { analyzeDomBlocks, DOM_MIN_BLOCKS, slotDescription, type DomBlocks, type DomPagination, type DomSlot } from './dom.js';
import { narrativeUrl } from './events.js';

/** Un échange capturé pendant la reconnaissance (requête de données de la page, ou sonde statique). */
export type CapturedExchange = {
  readonly url: string;
  readonly method: string;
  /** Corps de la requête (POST JSON), borné ; jamais d'en-tête d'authentification ni de cookie. */
  readonly requestBody: string | null;
  readonly requestContentType: string | null;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly bytes: number;
};

/** Ce que la passe de reconnaissance a vu (`tunnel` : page et URL de données lues par l'extension, session requise). */
export type ReconCapture = {
  readonly mode: 'browser' | 'static' | 'tunnel';
  readonly pageUrl: string;
  /** Document de la page : corps servi (blobs) et, en mode navigateur, DOM rendu. */
  readonly document: { readonly url: string; readonly status: number; readonly html: string; readonly renderedHtml: string | null; readonly bytes: number } | null;
  readonly exchanges: readonly CapturedExchange[];
  /** Octets reçus par toute la passe (sous-ressources comprises) : base du coût estimé de E2 et E3. */
  readonly totalBytes: number;
  /** Sous-ressources statiques d'hôtes tiers chargées pour le rendu (mode navigateur) : hôtes et requêtes, sans URL. */
  readonly assets?: { readonly hosts: number; readonly requests: number };
  /** Réponses de données (fetch, XHR) d'un domaine de l'API vues par la passe navigateur, capturées, écartées par raison (codes). */
  readonly data?: { readonly seen: number; readonly captured: number; readonly skipped: Readonly<Record<string, number>> };
  /**
   * Bouton « charger plus » cliqué par la passe navigateur (R13) : sélecteur vérifié ; les réponses XHR qu'il a déclenchées
   * (fragments HTML compris) sont dans `exchanges`.
   */
  readonly loadMore?: { readonly clicked: boolean; readonly selector: string };
};

/** Squelette d'un enregistrement : chemin relatif (`$.a.b`) → type JSON. Aucune valeur. */
export type RecordSkeleton = Readonly<Record<string, string>>;

/** Bloc répété du document (gisement `dom`) : emplacements vérifiés, pagination détectée ; aucune valeur d'un enregistrement. */
export type DomCandidateInfo = {
  readonly slots: readonly DomSlot[];
  readonly pagination: DomPagination | null;
  /** Bloc lu dans le DOM RENDU par Chromium (absent du document servi) : E1 ne le verra pas, E3 si. */
  readonly rendered: boolean;
  /** Rôle du bloc (R13) : carrousel (pénalisé) ou liste de résultats. */
  readonly hints?: DomBlocks['hints'];
};

export type DataCandidate = {
  /** `c1`, `c2`… dans l'ordre des sources de 04b §2 : API JSON, puis blob embarqué, puis blocs répétés du DOM. */
  readonly id: string;
  readonly from: 'response' | 'embedded' | 'dom';
  /** Requête de données (gisement `response`) ou page qui porte le blob (`embedded`). */
  readonly request: { readonly method: 'GET' | 'POST'; readonly url: string; readonly body_json?: unknown };
  readonly locator?: BlobLocator;
  readonly host: string;
  /** JSONPath des enregistrements (RFC 9535) ; sélecteur CSS des blocs pour un gisement `dom`. */
  readonly records: string;
  readonly count: number;
  /** Octets de la réponse (ou du document) qui porte le gisement. */
  readonly bytes: number;
  readonly skeleton: RecordSkeleton;
  /** Voie refusée sans tentative : paramètre calculé côté client (signature, jeton). */
  readonly unsupported?: 'client_signature';
  /** Gisement `dom` : emplacements (clés `$.<nom>` du squelette) et pagination détectés par le code. */
  readonly dom?: DomCandidateInfo;
  /**
   * Compteur de résultats affiché par la page (R13 : « 6197 annonces ») : contrôle de complétude d'un essai et plafond dur de
   * pages à sa mesure. Absent d'un carrousel.
   */
  readonly counter?: number;
};

/** Nombre de gisements gardés au plus (les plus gros tableaux d'abord). */
export const MAX_CANDIDATES = 8;
const MAX_ARRAYS_PER_SOURCE = 3;
const MAX_SKELETON_ENTRIES = 60;
const MAX_WALK_DEPTH = 8;
/** Clé montrable : nom de champ ordinaire (lettre, chiffre, `_`, `$`, `-`), jamais un e-mail, un `Type:id` ni du texte. */
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
/** Clé qui ressemble à une valeur : numéro (5 chiffres de suite ou plus), identifiant hexadécimal long. */
const VALUE_LIKE_KEY = /[0-9]{5,}|[0-9a-f]{12,}/i;
/** Nom de paramètre de requête montrable (comme dans le prompt du rôle `investigate`). */
const SAFE_PARAM = /^[A-Za-z0-9_.-]{1,64}$/;
const DOT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Une clé du site peut-elle être montrée (prompt du rôle `investigate`, état de l'enquête) ? Non si elle ressemble à une
 * valeur : e-mail, identifiant `Type:123` ou argument Apollo, numéro, condensé, texte libre (08 §4, 17 §6).
 */
export function isSafeKey(key: string): boolean {
  return SAFE_KEY.test(key) && !VALUE_LIKE_KEY.test(key);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Segment JSONPath d'une clé (RFC 9535) : notation pointée si possible, sinon crochets et chaîne échappée. */
export function pathSegment(key: string): string {
  if (DOT_KEY.test(key)) return `.${key}`;
  return `['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

/** Squelette d'un enregistrement : chemins et types, clés sûres seulement, profondeur et taille bornées. */
export function recordSkeleton(record: unknown): RecordSkeleton {
  const out: Record<string, string> = {};
  let count = 0;
  const walk = (value: unknown, path: string, depth: number): void => {
    if (count >= MAX_SKELETON_ENTRIES) return;
    if (isRecord(value) && depth < 3) {
      for (const [key, child] of Object.entries(value)) {
        if (count >= MAX_SKELETON_ENTRIES) return;
        // Une clé hors du jeu sûr (texte libre, balises) n'est pas montrée : une clé de la page n'est pas une consigne.
        if (!isSafeKey(key)) continue;
        walk(child, `${path}${pathSegment(key)}`, depth + 1);
      }
      return;
    }
    if (path === '$') return;
    out[path] = jsonType(value);
    count += 1;
  };
  walk(record, '$', 0);
  return out;
}

type FoundArray = { path: string; count: number; first: Record<string, unknown> };

/**
 * Tableaux d'objets d'un document JSON (enregistrements possibles), les plus longs d'abord. Une clé non sûre
 * (`isSafeKey`) n'entre jamais dans le chemin : son segment devient le joker `[*]` (RFC 9535), qui sélectionne toujours
 * le tableau sans porter la clé du site (e-mail, identifiant, argument de requête Apollo).
 */
export function findRecordArrays(root: unknown, max = MAX_ARRAYS_PER_SOURCE): FoundArray[] {
  const found: FoundArray[] = [];
  let visited = 0;
  const walk = (value: unknown, path: string, depth: number): void => {
    visited += 1;
    if (visited > 20_000 || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      const objects = value.filter(isRecord);
      if (objects.length > 0 && objects.length >= value.length / 2) found.push({ path: `${path}[*]`, count: objects.length, first: objects[0]! });
      // Un tableau d'enregistrements n'est pas parcouru plus loin (ses sous-tableaux seraient des champs).
      if (objects.length > 0) return;
      value.slice(0, 50).forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1));
      return;
    }
    if (isRecord(value)) for (const [key, child] of Object.entries(value)) walk(child, `${path}${isSafeKey(key) ? pathSegment(key) : '[*]'}`, depth + 1);
  };
  walk(root, '$', 0);
  return found.sort((a, b) => b.count - a.count).slice(0, max);
}

/**
 * Suffixes publics à deux niveaux (et domaines d'hébergement partagé) les plus courants : `www.<suffixe>` n'y perd
 * jamais son `www.` (la portée deviendrait le suffixe, donc tous les sites qu'il héberge). Liste volontairement courte,
 * complétée par la règle générique `<co|com|gov|…>.<ccTLD>` : sans liste des suffixes publics (dépendance hors de la
 * stack de 03), un hôte douteux garde sa portée exacte.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com',
  'herokuapp.com', 'appspot.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com',
  'wordpress.com', 'myshopify.com', 'wixsite.com', 'squarespace.com', 'onrender.com', 'fly.dev', 'railway.app',
]);
/** Second niveau générique sous un ccTLD (`co.uk`, `gov.uk`, `com.au`, `ac.jp`, `gouv.fr`…). */
const CC_SECOND_LEVEL = /^(?:co|com|gov|gouv|org|net|edu|ac|ltd|plc|nhs|police|mil|nic|sch|ne|or|go|gob|govt|nom|info|biz)\.[a-z]{2}$/;

/** `host` est un suffixe public (ou un domaine d'hébergement partagé) connu à deux niveaux. */
function isTwoLevelSuffix(host: string): boolean {
  return TWO_LEVEL_SUFFIXES.has(host) || CC_SECOND_LEVEL.test(host);
}

/**
 * Portée de site d'une page : son hôte sans `www.`. Les domaines de l'API sont cet hôte et ses sous-domaines
 * (04b §2 : page `www.exemple.test`, données sur `api.exemple.test`). `www.` n'est retiré que s'il reste au moins deux
 * libellés qui ne forment pas un suffixe public connu (`www.gov.uk`, `www.com.au`, `www.github.io` gardent leur hôte
 * exact). On ne remonte jamais plus haut : un voisin (`user2.github.io` pour `user1.github.io`, `api.x.test` pour
 * `shop.x.test`) n'est jamais un domaine de l'API.
 */
export function siteScope(pageHost: string): string {
  const host = pageHost.toLowerCase().replace(/\.+$/, '');
  if (!host.startsWith('www.')) return host;
  const rest = host.slice(4);
  return rest.split('.').length >= 2 && !isTwoLevelSuffix(rest) ? rest : host;
}

/** Mots d'action d'un chemin (`/logout`, `/cart/clear`, `/unsubscribe`) : un GET qui change un état, jamais rejoué. */
const ACTION_WORDS = new Set([
  'logout', 'log-out', 'signout', 'sign-out', 'logoff', 'delete', 'remove', 'destroy', 'unsubscribe', 'optout',
  'opt-out', 'cancel', 'clear', 'confirm', 'revoke', 'deactivate', 'disable', 'reset', 'purge',
  'checkout', 'pay', 'buy', 'purchase', 'subscribe', 'follow', 'unfollow', 'like', 'vote',
  'send', 'submit', 'approve', 'reject', 'archive',
]);

/**
 * L'URL désigne une action (déconnexion, suppression, désabonnement…) plutôt qu'une lecture de données : un mot du
 * chemin (découpé sur `/`, `-`, `_`, `.`, ou le segment entier) est un mot d'action. La reconnaissance en tunnel ne
 * rejoue jamais une telle URL : elle partirait avec les cookies de session de l'utilisateur.
 */
export function isActionUrl(url: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return true;
  }
  for (const segment of path.split('/')) {
    if (segment === '') continue;
    if (ACTION_WORDS.has(segment)) return true;
    for (const word of segment.split(/[-_.]/)) if (ACTION_WORDS.has(word)) return true;
  }
  return false;
}

/** `host` est la portée de site ou l'un de ses sous-domaines. */
export function withinSiteScope(host: string, scope: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return h === scope || h.endsWith(`.${scope}`);
}

/** Noms de paramètre d'une valeur calculée côté client (signature, jeton anti-rejeu, défi). */
const SIGNED_NAME = /(?:^|[-_.])(?:sig|sign|signature|signed|hmac|nonce|xsrf|csrf|captcha|challenge|digest)(?:$|[-_.])/i;
/** Valeur qui ressemble à un condensé : 32+ caractères hexadécimaux, ou 40+ caractères base64 / base64url. */
const DIGEST_VALUE = /^(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})$/;
/** Paramètres de pagination : un curseur opaque n'est pas une signature (il vient d'une réponse précédente). */
const PAGINATION_NAME = /^(?:cursor|after|before|next|continuation|page|page_?token|offset|start)$/i;

const signedParam = (name: string, value: unknown): boolean =>
  SIGNED_NAME.test(name) || (typeof value === 'string' && !PAGINATION_NAME.test(name) && DIGEST_VALUE.test(value));

/** Vrai si la requête porte un paramètre calculé côté client : la voie est `unsupported` (aucune reproduction). */
export function hasClientSignature(request: { readonly url: string; readonly body_json?: unknown }): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  for (const [name, value] of url.searchParams) if (signedParam(name, value)) return true;
  const body = request.body_json;
  if (isRecord(body)) for (const [name, value] of Object.entries(body)) if (signedParam(name, value)) return true;
  return false;
}

const JSON_TYPE = /(?:^|[/+])json(?:$|;|\s)/i;

function parseJson(text: string, limits: DslLimits): unknown {
  if (text.length === 0 || text.length > limits.maxResponseBytes) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const BLOB_ORDER: readonly BlobKind[] = ['next_data', 'nuxt_data', 'apollo_state', 'json_ld'];

/** Blobs embarqués d'un document (sans exécution : lecture de balises JSON ou de littéraux affectés). */
function blobsOf(doc: Document, limits: DslLimits): { locator: BlobLocator; value: unknown }[] {
  const out: { locator: BlobLocator; value: unknown }[] = [];
  for (const kind of BLOB_ORDER) {
    try {
      out.push({ locator: { kind }, value: decodeEmbedded(doc, { kind }, limits) });
    } catch {
      // Blob absent ou illisible : rien à proposer pour ce type.
    }
  }
  return out;
}

/**
 * Gisements d'une capture, dans l'ordre de 04b §2 (API JSON, puis blob embarqué, puis blocs répétés du DOM). `allowedHosts` : seuls les échanges
 * vers un domaine de l'API comptent (une sous-ressource tierce n'est jamais un gisement).
 */
export function analyzeCapture(capture: ReconCapture, allowedHosts: readonly string[], limits: DslLimits = DEFAULT_DSL_LIMITS): DataCandidate[] {
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const candidates: Omit<DataCandidate, 'id'>[] = [];
  const seen = new Set<string>();
  for (const exchange of capture.exchanges) {
    const host = hostOf(exchange.url);
    if (host === null || !hosts.has(host)) continue;
    if (exchange.status < 200 || exchange.status >= 300 || !JSON_TYPE.test(exchange.contentType)) continue;
    const method = exchange.method.toUpperCase() === 'POST' ? 'POST' : exchange.method.toUpperCase() === 'GET' ? 'GET' : null;
    if (method === null) continue;
    const key = `${method} ${exchange.url} ${exchange.requestBody ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const root = parseJson(exchange.body, limits);
    if (root === undefined) continue;
    let bodyJson: unknown;
    if (method === 'POST') {
      if (exchange.requestBody === null || !JSON_TYPE.test(exchange.requestContentType ?? '')) continue; // POST non JSON : hors V1
      bodyJson = parseJson(exchange.requestBody, limits);
      if (bodyJson === undefined) continue;
    }
    const request = { method, url: exchange.url, ...(bodyJson === undefined ? {} : { body_json: bodyJson }) } as const;
    const unsupported = hasClientSignature(request);
    for (const found of findRecordArrays(root)) {
      candidates.push({
        from: 'response',
        request,
        host,
        records: found.path,
        count: found.count,
        bytes: exchange.bytes,
        skeleton: recordSkeleton(found.first),
        ...(unsupported ? { unsupported: 'client_signature' as const } : {}),
      });
    }
  }
  const doc = capture.document;
  const docHost = doc === null ? null : hostOf(doc.url);
  if (doc !== null && docHost !== null && hosts.has(docHost)) {
    // Blobs du document SERVI d'abord (E1 les lit tel quel), puis du DOM rendu s'il en montre d'autres (E3 seulement :
    // hors V1, non proposé).
    let parsed: Document | undefined;
    try {
      parsed = parseHtml(doc.html, limits);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      for (const blob of blobsOf(parsed, limits)) {
        for (const found of findRecordArrays(blob.value)) {
          candidates.push({
            from: 'embedded',
            request: { method: 'GET', url: doc.url },
            locator: blob.locator,
            host: docHost,
            records: found.path,
            count: found.count,
            bytes: doc.bytes,
            skeleton: recordSkeleton(found.first),
          });
        }
      }
    }
    // Blocs répétés du DOM (04b §2, troisième source) : document servi d'abord (E1 le lit tel quel), puis les blocs du DOM
    // RENDU absents du document servi (E2, E3), au plus 3 (R13 : un carrousel « Nouveautés » servi et la liste de résultats
    // rendue après un XHR). Carrousel en dernier (ordre du score sinon) ; compteur de résultats affiché et pagination par bouton
    // « charger plus » (fragment HTML capturé après le clic) portés par chaque bloc qui n'est pas un carrousel.
    const served = analyzeDomBlocks(doc.html, doc.url, limits);
    const rendered = doc.renderedHtml !== null && doc.renderedHtml !== doc.html ? analyzeDomBlocks(doc.renderedHtml, doc.url, limits) : null;
    const counter = served?.counter ?? rendered?.counter ?? null;
    const blocks = [
      ...(served?.blocks ?? []).map((b) => ({ b, rendered: false })),
      ...(rendered?.blocks ?? []).filter((b) => !(served?.blocks ?? []).some((s) => s.records === b.records)).map((b) => ({ b, rendered: true })),
    ]
      .sort((x, y) => Number(x.b.hints?.carousel === true) - Number(y.b.hints?.carousel === true))
      .slice(0, 3);
    for (const { b, rendered: fromRendered } of blocks) {
      const carousel = b.hints?.carousel === true;
      const loadMore = carousel ? null : loadMorePagination(capture, b.records, b.count, docHost, limits);
      const { pagination: own, ...block } = b;
      candidates.push({
        from: 'dom',
        request: { method: 'GET', url: doc.url },
        host: docHost,
        records: block.records,
        count: block.count,
        bytes: doc.bytes,
        skeleton: Object.fromEntries(block.slots.map((slot) => [`$.${slot.name}`, slotDescription(slot, block.count)])),
        dom: { slots: block.slots, pagination: loadMore ?? own, rendered: fromRendered, ...(block.hints === undefined ? {} : { hints: block.hints }) },
        // Compteur porté par la liste de résultats (ou, à défaut, le premier bloc qui n'est pas un carrousel), jamais par un
        // bloc de texte éditorial voisin.
        ...(carousel || counter === null || !(block.hints?.results === true || b === blocks.find((x) => x.b.hints?.carousel !== true)?.b) ? {} : { counter }),
      });
    }
  }
  // Les blocs du DOM gardent leur place même derrière beaucoup de réponses JSON : ils sont la seule voie sans LLM d'une liste HTML.
  const dom = candidates.filter((c) => c.from === 'dom');
  const others = candidates.filter((c) => c.from !== 'dom');
  const kept = [...others.slice(0, Math.max(0, MAX_CANDIDATES - dom.length)), ...dom].slice(0, MAX_CANDIDATES);
  return kept.map((c, i) => ({ id: `c${i + 1}`, ...c }));
}

/** Paramètre entier d'une URL de « charger plus » qui vaut le nombre de cartes de la page 1 (décalage) ou 2 (numéro de page). */
const PAGE_PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Pagination par bouton « charger plus » (R13) : après le clic de la reconnaissance, une réponse XHR GET du même hôte dont le
 * corps est un fragment HTML où le sélecteur des enregistrements trouve des cartes ; son paramètre entier qui vaut le nombre
 * de cartes de la page 1 est un décalage (`begin=24` : départ 0, pas de 24), celui qui vaut 2 un numéro de page. La page 1
 * reste la page, les suivantes cette URL (`next_url`, paramètre remis au départ). `null` sinon.
 */
function loadMorePagination(capture: ReconCapture, records: string, count: number, host: string, limits: DslLimits): DomPagination | null {
  if (capture.loadMore?.clicked !== true) return null;
  for (const exchange of capture.exchanges) {
    if (exchange.method.toUpperCase() !== 'GET' || exchange.status < 200 || exchange.status >= 300 || !/html/i.test(exchange.contentType) || hostOf(exchange.url) !== host) continue;
    let found: number;
    try {
      found = selectElements(records, parseHtml(exchange.body, limits), 10_000).length;
    } catch {
      continue;
    }
    if (found < DOM_MIN_BLOCKS && found < count) continue;
    const url = new URL(exchange.url);
    for (const [name, value] of url.searchParams) {
      if (!PAGE_PARAM_NAME.test(name) || !/^\d{1,7}$/.test(value)) continue;
      const n = Number(value);
      if (n === count) {
        url.searchParams.set(name, '0');
        return { type: 'offset', param: `url.query.${name}`, start: 0, step: count, last: null, next_url: url.href };
      }
      if (n === 2) {
        url.searchParams.set(name, '1');
        return { type: 'page_param', param: `url.query.${name}`, start: 1, last: null, next_url: url.href };
      }
    }
  }
  return null;
}

const SCRIPT_URL_PATTERNS: readonly RegExp[] = [
  /\bfetch\(\s*(["'`])([^"'`\s]{1,300})\1/g,
  /\.open\(\s*["'](?:GET|get)["']\s*,\s*(["'`])([^"'`\s]{1,300})\1/g,
];

/**
 * Mode sans navigateur (`DISABLE_BROWSER`) : URL de données que les scripts EN LIGNE de la page appellent en GET par
 * une chaîne littérale (`fetch("/api/…")`, `xhr.open("GET", …)`), domaines de l'API (`siteScope`), sans gabarit (`${…}`). Aucun
 * script n'est exécuté ; c'est un repli, la passe E3 du navigateur reste la reconnaissance de référence (04 §4).
 */
export function discoverScriptEndpoints(html: string, pageUrl: string, max = 5, limits: DslLimits = DEFAULT_DSL_LIMITS): string[] {
  let doc: Document;
  let page: URL;
  try {
    doc = parseHtml(html, limits);
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const scope = siteScope(page.hostname);
  const out: string[] = [];
  for (const script of selectElements('script:not([src])', doc, 50)) {
    if (elementAttribute(script, 'type') !== undefined && !/javascript|module/i.test(elementAttribute(script, 'type') ?? '')) continue;
    const text = script.children.map((c) => ('data' in c && typeof c.data === 'string' ? c.data : '')).join('').slice(0, 200_000);
    for (const pattern of SCRIPT_URL_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[2] ?? '';
        if (raw.includes('${')) continue;
        let url: URL;
        try {
          url = new URL(raw, page);
        } catch {
          continue;
        }
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !withinSiteScope(url.hostname, scope) || url.username !== '' || url.password !== '') continue;
        url.hash = '';
        if (!out.includes(url.href)) out.push(url.href);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * Gisement tel que l'état de l'enquête le garde (`apis.investigation`, hors rétention) : AUCUNE valeur du site. Requête
 * réduite à l'origine, au chemin et aux NOMS de paramètres (requête et premier niveau du corps JSON) ; le reste (chemin
 * des enregistrements, squelette) est déjà sans valeur. Les valeurs vivent dans la reconnaissance du run (récit couvert
 * par la rétention) et sont relues par la reconnaissance du run suivant (`rematchCandidates`).
 */
export type StoredCandidate = Omit<DataCandidate, 'request'> & {
  readonly request: { readonly method: 'GET' | 'POST'; readonly url: string; readonly query: readonly string[]; readonly body_keys?: readonly string[] };
};

const sortedUnique = (names: Iterable<string>): string[] => [...new Set(names)].sort();

function queryNames(url: string): string[] {
  try {
    return sortedUnique([...new URL(url).searchParams.keys()].filter((k) => SAFE_PARAM.test(k)));
  } catch {
    return [];
  }
}

export function storedCandidate(c: DataCandidate): StoredCandidate {
  const body = c.request.body_json;
  // Gisement `dom` : ni emplacements ni libellés constants dans l'état (sélecteurs et forme relus au run suivant).
  const { dom, ...rest } = c;
  const skeleton = dom === undefined ? c.skeleton : Object.fromEntries(Object.entries(c.skeleton).map(([k, v]) => [k, v.split(';').filter((part) => !/^(prefix|suffix|value)=/.test(part)).join(';')]));
  return {
    ...rest,
    skeleton,
    request: {
      method: c.request.method,
      url: narrativeUrl(c.request.url),
      query: queryNames(c.request.url),
      ...(body === undefined ? {} : { body_keys: isRecord(body) ? sortedUnique(Object.keys(body).filter(isSafeKey)) : [] }),
    },
  };
}

/** Clé sans valeur d'un gisement : nature, méthode, origine + chemin, noms de paramètres, blob, chemin des enregistrements. */
export function candidateKey(c: DataCandidate | StoredCandidate): string {
  const stored = 'query' in c.request ? (c as StoredCandidate) : storedCandidate(c as DataCandidate);
  return JSON.stringify([stored.from, stored.request.method, stored.request.url, stored.request.query, stored.request.body_keys ?? null, stored.locator?.kind ?? null, stored.records]);
}

/**
 * Gisements frais (reconnaissance du run en cours) retrouvés sous les identifiants stockés, dans l'ordre stocké ; un
 * gisement stocké absent de la reconnaissance manque (la proposition qui le cite l'écarte : `unknown_candidate`).
 */
export function rematchCandidates(stored: readonly StoredCandidate[], fresh: readonly DataCandidate[]): DataCandidate[] {
  const byKey = new Map<string, DataCandidate>();
  for (const c of fresh) if (!byKey.has(candidateKey(c))) byKey.set(candidateKey(c), c);
  const out: DataCandidate[] = [];
  for (const s of stored) {
    const match = byKey.get(candidateKey(s));
    if (match !== undefined) out.push({ ...match, id: s.id });
  }
  return out;
}
