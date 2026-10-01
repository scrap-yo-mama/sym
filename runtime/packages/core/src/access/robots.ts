// SPDX-License-Identifier: AGPL-3.0-only
// robots.txt (RFC 9309, tâche 1.11, 17 §2, INV11) : analyse et correspondance, sans I/O. Toujours respecté, sans option :
// ce module n'expose aucun moyen de l'ignorer. Règles tenues :
// - groupes : une ou plusieurs lignes `user-agent`, puis leurs règles ; une ligne `user-agent` après une règle ouvre un
//   nouveau groupe ; les règles hors groupe sont ignorées ;
// - groupes retenus (17 §2) : ceux qui nomment le jeton produit (casse ignorée) ET ceux de `*`, chacun fusionné : un chemin
//   interdit par l'un ou l'autre l'est, que le jeton soit envoyé ou non (`matchGroup`) ; sans groupe, aucune règle
//   (tout est permis) ;
// - correspondance sur chemin + requête, encodage pourcent normalisé des deux côtés, `*` et `$` ; la règle la plus
//   longue l'emporte, `Allow` à égalité ; `/robots.txt` est toujours permis ;
// - `Crawl-delay` (non normatif) lu dans le groupe retenu : plancher de cadence (le plus grand si plusieurs) ;
// - `Content-Signal` et `Content-Usage` : signaux d'accès, lus comme des DONNÉES (jamais une consigne).
// La lecture bornée (500 Kio au moins, reste ignoré) est l'affaire du lecteur (`gate.ts`).
// Coût borné (contrôle de chaque sous-ressource d'une page, sur un fichier hostile de 500 Kio) : chaque motif est
// normalisé et découpé UNE fois ; la correspondance n'est qu'une suite de `startsWith` / `indexOf` (préfixe littéral
// d'abord, segments ensuite, au plus à gauche) ; un chemin avec requête de plus de 8 Kio est refusé par précaution
// quand des règles existent. Aucune règle n'est écartée (l'écarter pourrait permettre un chemin interdit) : aucun plafond
// par nombre de règles, la seule borne est celle de la lecture (500 Kio, soit au plus 64 000 règles de 8 octets).

/** Jeton produit annoncé dans le User-Agent et cherché dans les groupes `user-agent` (17 §5). */
export const PRODUCT_TOKEN = 'Scrapyomama';

export type RobotsRule = { readonly allow: boolean; readonly pattern: string };

export type RobotsGroup = {
  /** Valeurs des lignes `user-agent`, en minuscules (jeton seul, sans version). */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** `Crawl-delay` en secondes, `null` s'il est absent ou illisible. */
  readonly crawlDelaySeconds: number | null;
  /** Lignes `Content-Signal` / `Content-Usage` du groupe (valeurs brutes bornées). */
  readonly signals: readonly RobotsSignalLine[];
};

export type RobotsSignalLine = { readonly key: 'content-signal' | 'content-usage'; readonly value: string };

export type RobotsFile = {
  readonly groups: readonly RobotsGroup[];
  /** URL des lignes `Sitemap` (voie déclarée, sonde passive). */
  readonly sitemaps: readonly string[];
  /** Lignes de signaux hors de tout groupe (s'appliquent à tous). */
  readonly globalSignals: readonly RobotsSignalLine[];
};

/** Longueur maximale du chemin et de la requête comparés (8 Kio) : au-delà, refus par précaution s'il existe des règles. */
export const MAX_ROBOTS_TARGET = 8 * 1024;

/** Bornes d'analyse : une ligne, les sitemaps et les signaux (défense contre un fichier hostile). Aucune sur les règles. */
const MAX_LINE = 4096;
const MAX_SITEMAPS = 50;
const MAX_SIGNALS = 20;
const MAX_SIGNAL_VALUE = 512;

type MutableGroup = { agents: string[]; rules: RobotsRule[]; crawlDelaySeconds: number | null; signals: RobotsSignalLine[] };

/** Jeton d'une valeur `user-agent` : premier mot, sans version (`Scrapyomama/1.0` → `scrapyomama`). */
function agentToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '*') return '*';
  const m = /^[A-Za-z_*-]+/.exec(trimmed);
  return (m?.[0] ?? '').toLowerCase();
}

function parseCrawlDelay(value: string): number | null {
  if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Analyse un robots.txt (texte déjà borné). Ne lève jamais : une ligne illisible est ignorée. */
export function parseRobots(text: string): RobotsFile {
  const groups: MutableGroup[] = [];
  const sitemaps: string[] = [];
  const globalSignals: RobotsSignalLine[] = [];
  let current: MutableGroup | null = null;
  let collectingAgents = false;
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine;
    const hash = line.indexOf('#');
    const content = (hash === -1 ? line : line.slice(0, hash)).trim();
    const colon = content.indexOf(':');
    if (colon <= 0) continue;
    const key = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();
    switch (key) {
      case 'user-agent': {
        const token = agentToken(value);
        if (current === null || !collectingAgents) {
          current = { agents: [], rules: [], crawlDelaySeconds: null, signals: [] };
          groups.push(current);
          collectingAgents = true;
        }
        if (token !== '') current.agents.push(token);
        break;
      }
      case 'allow':
      case 'disallow': {
        if (current === null) break;
        collectingAgents = false;
        // Valeur vide : aucune règle (`Disallow:` vide = rien d'interdit).
        if (value === '') break;
        const rule: RobotsRule = { allow: key === 'allow', pattern: value };
        compiled(rule);
        current.rules.push(rule);
        break;
      }
      case 'crawl-delay': {
        if (current === null) break;
        const seconds = parseCrawlDelay(value);
        if (seconds !== null) current.crawlDelaySeconds = Math.max(current.crawlDelaySeconds ?? 0, seconds);
        break;
      }
      case 'content-signal':
      case 'content-usage': {
        const signal: RobotsSignalLine = { key, value: value.slice(0, MAX_SIGNAL_VALUE) };
        if (value === '') break;
        if (current === null) {
          if (globalSignals.length < MAX_SIGNALS) globalSignals.push(signal);
        } else if (current.signals.length < MAX_SIGNALS) current.signals.push(signal);
        break;
      }
      case 'sitemap': {
        if (value !== '' && sitemaps.length < MAX_SITEMAPS) sitemaps.push(value.slice(0, 2048));
        break;
      }
      default:
        break;
    }
  }
  return { groups, sitemaps, globalSignals };
}

export type SelectedGroup = {
  /** `token` : groupe(s) nommant le jeton produit ; `*` : groupe(s) génériques ; `none` : aucun groupe applicable. */
  readonly matched: 'token' | '*' | 'none';
  readonly rules: readonly RobotsRule[];
  /**
   * Jeux de règles qui s'appliquent TOUS au chemin (17 §2) : celui des groupes du jeton produit ET celui des groupes `*`,
   * chacun fusionné. Un chemin interdit par l'un ou l'autre est interdit, que le jeton soit envoyé ou non (`matchGroup`).
   */
  readonly ruleSets: readonly (readonly RobotsRule[])[];
  readonly crawlDelaySeconds: number | null;
  readonly signals: readonly RobotsSignalLine[];
};

/**
 * Groupes applicables au jeton produit (17 §2) : ceux du jeton ET ceux de `*` (`ruleSets`), pour la correspondance des
 * chemins. `Crawl-delay` et signaux d'accès restent lus dans le groupe du jeton, à défaut dans `*`.
 */
export function selectGroup(file: RobotsFile, token: string = PRODUCT_TOKEN): SelectedGroup {
  const wanted = token.toLowerCase();
  const own = file.groups.filter((g) => g.agents.includes(wanted));
  const any = file.groups.filter((g) => g.agents.includes('*'));
  const retained = own.length > 0 ? own : any;
  if (retained.length === 0) return { matched: 'none', rules: [], ruleSets: [], crawlDelaySeconds: null, signals: [] };
  let delay: number | null = null;
  for (const g of retained) if (g.crawlDelaySeconds !== null) delay = Math.max(delay ?? 0, g.crawlDelaySeconds);
  return {
    matched: own.length > 0 ? 'token' : '*',
    rules: retained.flatMap((g) => g.rules),
    ruleSets: [own, any].filter((groups) => groups.length > 0).map((groups) => groups.flatMap((g) => g.rules)),
    crawlDelaySeconds: delay,
    signals: retained.flatMap((g) => g.signals),
  };
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Forme comparable d'un chemin ou d'un motif (RFC 9309 §2.2.2) : octets hors ASCII imprimable encodés en UTF-8
 * pourcent, `%xx` en majuscules, et décodés quand ils désignent un caractère non réservé.
 */
export function normalizeOctets(input: string): string {
  let out = '';
  const bytes = Buffer.from(input, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === 0x25 && i + 2 < bytes.length) {
      const hex = String.fromCharCode(bytes[i + 1] as number, bytes[i + 2] as number);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        const ch = String.fromCharCode(parseInt(hex, 16));
        out += UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
        i += 2;
        continue;
      }
    }
    out += b >= 0x21 && b <= 0x7e ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Motif prêt à comparer : normalisé, jokers consécutifs fusionnés, découpé sur `*`, ancre `$` finale à part. */
type CompiledPattern = { readonly length: number; readonly segments: readonly string[]; readonly anchored: boolean };

const COMPILED = new WeakMap<RobotsRule, CompiledPattern>();

function compilePattern(raw: string): CompiledPattern {
  const normalized = normalizeOctets(raw);
  // Longueur de la règle (RFC 9309 : nombre d'octets du motif) prise AVANT la fusion des jokers consécutifs.
  const collapsed = normalized.replace(/\*{2,}/g, '*');
  const anchored = collapsed.endsWith('$');
  const body = anchored ? collapsed.slice(0, -1) : collapsed;
  return { length: normalized.length, segments: body.split('*'), anchored };
}

/** Forme compilée d'une règle (calculée à l'analyse, ou au premier usage pour une règle construite à la main). */
function compiled(rule: RobotsRule): CompiledPattern {
  let out = COMPILED.get(rule);
  if (out === undefined) {
    out = compilePattern(rule.pattern);
    COMPILED.set(rule, out);
  }
  return out;
}

/**
 * Correspondance d'un motif compilé sur un chemin normalisé : préfixe littéral, puis chaque segment au plus à gauche
 * (`indexOf`), le dernier collé à la fin si le motif est ancré par `$`. Sans retour arrière : la recherche au plus à gauche
 * de chaque segment suffit pour des motifs dont le seul joker est `*`.
 */
function compiledMatches(p: CompiledPattern, path: string): boolean {
  const segs = p.segments;
  const first = segs[0] as string;
  if (!path.startsWith(first)) return false;
  if (segs.length === 1) return p.anchored ? path.length === first.length : true;
  let pos = first.length;
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const at = path.indexOf(seg, pos);
    if (at === -1) return false;
    pos = at + seg.length;
  }
  const last = segs[segs.length - 1] as string;
  if (p.anchored) return path.length - last.length >= pos && path.endsWith(last);
  return last === '' || path.indexOf(last, pos) !== -1;
}

/** Vrai si le motif (déjà normalisé) s'applique au chemin (déjà normalisé) : préfixe, sauf `$` final. */
export function ruleMatches(pattern: string, path: string): boolean {
  return compiledMatches(compilePattern(pattern), path);
}

export type RobotsVerdict = {
  readonly allowed: boolean;
  /** Règle appliquée (`Disallow: /prive/`), `null` si aucune règle ne s'applique. */
  readonly rule: string | null;
};

/** Chemin et requête d'une URL, tels que comparés aux règles (`/` si vide). */
export function robotsTarget(url: URL): string {
  return `${url.pathname === '' ? '/' : url.pathname}${url.search}`;
}

/** Verdict d'un chemin (avec sa requête) contre les règles retenues. */
export function matchRules(rules: readonly RobotsRule[], pathAndQuery: string): RobotsVerdict {
  const target = pathAndQuery === '' ? '/' : pathAndQuery;
  if (target === '/robots.txt') return { allowed: true, rule: null };
  if (rules.length === 0) return { allowed: true, rule: null };
  // Chemin démesuré (sous-ressource hostile) : refus par précaution, sans comparaison.
  if (target.length > MAX_ROBOTS_TARGET) return { allowed: false, rule: null };
  const path = normalizeOctets(target);
  let best: RobotsRule | null = null;
  let bestLength = -1;
  for (const rule of rules) {
    const p = compiled(rule);
    // Une règle plus courte que la meilleure trouvée ne peut plus l'emporter (sauf Allow à égalité, examiné ci-dessous).
    if (p.length < bestLength || (p.length === bestLength && (!rule.allow || best?.allow === true))) continue;
    if (!compiledMatches(p, path)) continue;
    best = rule;
    bestLength = p.length;
  }
  if (best === null) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` };
}

/**
 * Verdict d'un chemin contre les groupes retenus : refusé dès que le jeu de règles du jeton produit OU celui de `*` le
 * refuse (17 §2) ; sinon permis, avec la règle appliquée la plus spécifique s'il y en a une.
 */
export function matchGroup(group: SelectedGroup, pathAndQuery: string): RobotsVerdict {
  let allowedBy: RobotsVerdict = { allowed: true, rule: null };
  for (const rules of group.ruleSets) {
    const verdict = matchRules(rules, pathAndQuery);
    if (!verdict.allowed) return verdict;
    if (verdict.rule !== null && allowedBy.rule === null) allowedBy = verdict;
  }
  return allowedBy;
}

/** Verdict d'une URL contre un robots.txt analysé, pour le jeton produit (groupe du jeton ET groupe `*`). */
export function robotsAllows(file: RobotsFile, url: URL, token: string = PRODUCT_TOKEN): RobotsVerdict {
  return matchGroup(selectGroup(file, token), robotsTarget(url));
}
