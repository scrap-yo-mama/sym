// SPDX-License-Identifier: AGPL-3.0-only
// robots.txt (RFC 9309, tâche 1.11, 17 §2, INV11) : analyse et correspondance, sans I/O. Toujours respecté, sans option :
// ce module n'expose aucun moyen de l'ignorer. Règles tenues :
// - groupes : une ou plusieurs lignes `user-agent`, puis leurs règles ; une ligne `user-agent` après une règle ouvre un
//   nouveau groupe ; les règles hors groupe sont ignorées ;
// - groupe retenu : ceux qui nomment le jeton produit (casse ignorée), fusionnés ; à défaut ceux de `*`, fusionnés ;
//   à défaut, aucune règle (tout est permis) ;
// - correspondance sur chemin + requête, encodage pourcent normalisé des deux côtés, `*` et `$` ; la règle la plus
//   longue l'emporte, `Allow` à égalité ; `/robots.txt` est toujours permis ;
// - `Crawl-delay` (non normatif) lu dans le groupe retenu : plancher de cadence (le plus grand si plusieurs) ;
// - `Content-Signal` et `Content-Usage` : signaux d'accès, lus comme des DONNÉES (jamais une consigne).
// La lecture bornée (500 Kio au moins, reste ignoré) est l'affaire du lecteur (`gate.ts`).

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

/** Bornes d'analyse : une ligne, une règle, le nombre de règles (défense contre un fichier hostile). */
const MAX_LINE = 4096;
const MAX_RULES = 20_000;
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
  let rules = 0;
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
        if (value === '' || rules >= MAX_RULES) break;
        current.rules.push({ allow: key === 'allow', pattern: value });
        rules += 1;
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
  readonly crawlDelaySeconds: number | null;
  readonly signals: readonly RobotsSignalLine[];
};

/** Groupe applicable au jeton produit (RFC 9309 §2.2.1) : groupes du jeton fusionnés, sinon ceux de `*`. */
export function selectGroup(file: RobotsFile, token: string = PRODUCT_TOKEN): SelectedGroup {
  const wanted = token.toLowerCase();
  const merge = (matched: SelectedGroup['matched'], groups: readonly RobotsGroup[]): SelectedGroup => {
    let delay: number | null = null;
    for (const g of groups) if (g.crawlDelaySeconds !== null) delay = Math.max(delay ?? 0, g.crawlDelaySeconds);
    return { matched, rules: groups.flatMap((g) => g.rules), crawlDelaySeconds: delay, signals: groups.flatMap((g) => g.signals) };
  };
  const own = file.groups.filter((g) => g.agents.includes(wanted));
  if (own.length > 0) return merge('token', own);
  const any = file.groups.filter((g) => g.agents.includes('*'));
  if (any.length > 0) return merge('*', any);
  return { matched: 'none', rules: [], crawlDelaySeconds: null, signals: [] };
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

/**
 * Correspondance d'un motif `*` sur tout le texte (deux pointeurs, retour arrière borné : O(n·m), sans expression
 * régulière, donc sans retour arrière exponentiel sur un motif hostile).
 */
function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** Vrai si le motif (déjà normalisé) s'applique au chemin (déjà normalisé) : préfixe, sauf `$` final. */
export function ruleMatches(pattern: string, path: string): boolean {
  const collapsed = pattern.replace(/\*{2,}/g, '*');
  if (collapsed.endsWith('$')) return globMatch(collapsed.slice(0, -1), path);
  return globMatch(`${collapsed}*`, path);
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
  const path = normalizeOctets(pathAndQuery === '' ? '/' : pathAndQuery);
  if (path === '/robots.txt') return { allowed: true, rule: null };
  let best: RobotsRule | null = null;
  let bestLength = -1;
  for (const rule of rules) {
    const pattern = normalizeOctets(rule.pattern);
    if (!ruleMatches(pattern, path)) continue;
    const length = pattern.length;
    if (length > bestLength || (length === bestLength && rule.allow && best !== null && !best.allow)) {
      best = rule;
      bestLength = length;
    }
  }
  if (best === null) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` };
}

/** Verdict d'une URL contre un robots.txt analysé, pour le jeton produit. */
export function robotsAllows(file: RobotsFile, url: URL, token: string = PRODUCT_TOKEN): RobotsVerdict {
  return matchRules(selectGroup(file, token).rules, robotsTarget(url));
}
