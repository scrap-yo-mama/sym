// SPDX-License-Identifier: AGPL-3.0-only
// `BriefDigest` typé (tâche 2.14, 19c § 3, § 5) : ce que le CODE retient d'un dossier normalisé avant toute requête. Chaque
// indice reçoit une décision (sonde GET par le pipeline d'accès, rapprochement avec la reconnaissance, non vérifiable,
// ignoré) et, s'il est écarté, une raison fermée. Le statut « vérifié » n'est jamais lu dans le dossier : il est posé après
// la sonde. Les décisions de garde ne viennent pas d'ici : l'hôte hors portée est écarté AVANT toute requête, mais la sonde
// elle-même repasse par la portée de l'API, la garde SSRF, la cadence et le classifieur de l'API.
import { createHash } from 'node:crypto';
import { compileSelector } from '../dsl/css.js';
import { wideningWarnings, type WideningGuard } from '../rules/widening.js';
import { BRIEF_DEFAULTS, BRIEF_STALE_DAYS, DEFAULT_BRIEF_CONFIG, type BriefConfig, type BriefHint, type BriefHintKind, type BriefHintState, type BriefReason, type InvestigationBrief } from './schema.js';
import { isIpLiteral, matchTemplate, parseHintUrl, templatePath } from './url.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Blobs reconnus par la reconnaissance (04b § 2) et leurs noms usuels. */
const BLOB_ALIASES: Readonly<Record<string, string>> = {
  next_data: 'next_data',
  __next_data__: 'next_data',
  nuxt_data: 'nuxt_data',
  __nuxt_data__: 'nuxt_data',
  __nuxt__: 'nuxt_data',
  apollo_state: 'apollo_state',
  __apollo_state__: 'apollo_state',
  json_ld: 'json_ld',
  'json-ld': 'json_ld',
  'ld+json': 'json_ld',
  jsonld: 'json_ld',
};
/** Familles de pagination de 04 § 4. */
export const BRIEF_PAGINATION_FAMILIES = ['page_param', 'offset', 'cursor', 'next_link', 'infinite_scroll', 'none'] as const;

export type ParsedHint =
  | { readonly kind: 'endpoint'; readonly method: string; readonly url: URL; readonly host: string; readonly templated: boolean }
  | { readonly kind: 'example_url'; readonly url: URL; readonly host: string; readonly templated: boolean }
  | { readonly kind: 'embedded_data'; readonly blob: string; readonly path: string }
  /**
   * `param` : nom ou emplacement du paramètre (`page`, `url.query.page`) ; `pattern` : motif de chemin ou d'URL des pages
   * (`/annonces/page/{page}/`, `?page={page}`) ; `selector` : sélecteur CSS du lien « suivant ». Au plus un des trois.
   */
  | {
      readonly kind: 'pagination';
      readonly family: string;
      readonly param: string | null;
      readonly pattern?: string;
      readonly selector?: string;
      /**
       * Famille `xhr` (liste chargée par XHR / fetch après le rendu, constat Barnes) : requête de la liste désignée par le
       * dossier, en chemin GABARIT (`endpoint`, sans valeur de requête) ou en motif (`pattern`), sa méthode et son hôte (dans
       * la portée de l'API, sinon `brief_host_ignored`, 0 requête). Jamais sondée : rapprochée du trafic de la reconnaissance.
       */
      readonly endpoint?: string;
      readonly method?: string;
      readonly host?: string;
      /** Famille `load_more` (bouton « Annonces suivantes », « Voir plus », « Load more ») : libellé court du bouton. */
      readonly label?: string;
    }
  | { readonly kind: 'selector'; readonly selector: string }
  | { readonly kind: 'pitfall' };

/** Valeur d'un indice au gabarit de son type (19c § 9.1) ; `null` : `brief_invalid_item`. */
export function parseHintValue(hint: Pick<BriefHint, 'kind' | 'value'>, pageUrl: string): ParsedHint | null {
  const value = hint.value.trim();
  switch (hint.kind) {
    case 'endpoint': {
      const m = /^([A-Za-z]{3,7})\s+(\S+)$/.exec(value);
      const method = (m?.[1] ?? 'GET').toUpperCase();
      const rawUrl = m === null ? value : m[2]!;
      if (!HTTP_METHODS.has(method)) return null;
      const parsed = parseHintUrl(rawUrl, pageUrl);
      return parsed === null ? null : { kind: 'endpoint', method, url: parsed.url, host: parsed.host, templated: parsed.templated };
    }
    case 'example_url': {
      const parsed = parseHintUrl(value, pageUrl);
      return parsed === null ? null : { kind: 'example_url', url: parsed.url, host: parsed.host, templated: parsed.templated };
    }
    case 'embedded_data': {
      const m = /^(\S{2,40})(?:\s+(\$[^\s]{0,200}|[A-Za-z_][\w.[\]-]{0,200}))?$/.exec(value);
      const blob = m === null ? undefined : BLOB_ALIASES[m[1]!.toLowerCase()];
      return blob === undefined ? null : { kind: 'embedded_data', blob, path: m![2] ?? '$' };
    }
    case 'pagination':
      return parsePaginationHint(value, pageUrl);
    case 'selector':
      return validSelector(value) ? { kind: 'selector', selector: value } : null;
    case 'pitfall':
      return { kind: 'pitfall' };
  }
}

/** Sélecteur CSS accepté par le MÊME analyseur que l'interpréteur (combinateurs, attributs, `:nth-child`…), borné. */
function validSelector(value: string): boolean {
  if (value === '' || value.length > 300 || value.includes('<')) return false;
  try {
    compileSelector(value);
    return true;
  } catch {
    return false;
  }
}

/** Numéro de page d'un motif : `{page}`, `{n}`, `{N}` ou un `N` seul comme segment ou valeur de paramètre. */
const PAGE_TOKEN = /\{(?:page|n|N|p)\}|(?<=\/|=)N(?=\/|&|$)/;

/**
 * Indice de pagination (19c § 9.1, élargi par le constat Janssens) : famille de 04 § 4 suivie d'un paramètre (`page_param
 * page`), d'un MOTIF d'URL des pages (`page_param /nos-maisons/page/{page}/`, `?page=N`) ou du SÉLECTEUR du lien suivant
 * (`next_link a.next`) ; ou le motif, ou le sélecteur, seul. Le motif est ramené à son chemin et à sa requête (`{page}`) :
 * l'hôte n'en est jamais retenu.
 */
function parsePaginationHint(value: string, pageUrl: string): ParsedHint | null {
  const loader = parseLoaderHint(value, pageUrl);
  if (loader !== undefined) return loader;
  const known = parseFamilyHint(value);
  if (known !== null) return known;
  return parseLoaderPhrase(value);
}

/** Familles de chargement de la liste après le rendu (constat Barnes), en plus de celles de 04 § 4. */
export const BRIEF_PAGINATION_LOADERS = ['xhr', 'load_more'] as const;
const XHR_LEAD = /^(?:xhr|ajax|fetch|xmlhttprequest)(?![\w-])[\s:]*(.*)$/is;
const XHR_WORD = /(?<![\w-])(?:xhr|ajax|xmlhttprequest)(?![\w-])/i;
const LOAD_MORE = String.raw`load[\s_-]?more|charger\s+plus|voir\s+plus|afficher\s+plus|show\s+more|see\s+more`;
const LOAD_MORE_LEAD = new RegExp(String.raw`^(?:${LOAD_MORE})(?![\w-])[\s:]*(.*)$`, 'is');
const LOAD_MORE_WORD = new RegExp(String.raw`(?<![\w-])(?:${LOAD_MORE}|bouton|button)(?![\w-])`, 'i');
const BUTTON_LEAD = /^(?:button|bouton|btn)(?:\s*:\s*|\s+|$)/i;
/** Libellé entre guillemets (droits, typographiques, chevrons). */
const QUOTED = /[«"“‘']\s*([^«»"“”‘’']{1,200}?)\s*[»"”’']/;
/** Libellé de bouton : court, sans balisage, sans URL ni chemin. */
const LABEL_MAX = 80;
/** Schéma d'URL (`javascript:`, `ftp://`, `data:`) : jamais suivi, l'indice est refusé. */
const SCHEME = /(?<![\w-])[a-z][a-z0-9+.-]{1,20}:(?=\S)/i;

const cleanLabel = (raw: string): string | null => {
  const label = raw.trim().replace(/\s+/g, ' ');
  return label === '' || label.length > LABEL_MAX || /[<>/\\{}]/.test(label) || SCHEME.test(label) ? null : label;
};

/**
 * Forme menée par la famille (`xhr …`, `ajax`, `fetch`, `load_more …`, `charger plus`, `voir plus`) : rendue ou refusée
 * (`null`) ; `undefined` : autre forme. `xhr` suivi d'un nom de paramètre, d'une requête (méthode facultative, chemin ou URL
 * http(s), motif `{page}`) ou d'une phrase ; `load_more` suivi du libellé du bouton (entre guillemets ou non) ou de son
 * sélecteur. Balisage, URL non http(s) et libellé trop long : refusés.
 */
function parseLoaderHint(value: string, pageUrl: string): ParsedHint | null | undefined {
  const xhr = XHR_LEAD.exec(value);
  if (xhr !== null) {
    const rest = xhr[1]!.trim();
    if (rest === '') return { kind: 'pagination', family: 'xhr', param: null };
    if (rest.includes('<') || rest.includes('>')) return null;
    if (/^[A-Za-z0-9_.[\]-]{1,64}$/.test(rest) && !/^N$/.test(rest)) return { kind: 'pagination', family: 'xhr', param: rest };
    const request = /^(?:([A-Za-z]{3,7})\s+)?(\S+)$/.exec(rest);
    if (request !== null && (/^(?:\/|\?|https?:\/\/)/i.test(request[2]!) || SCHEME.test(request[2]!))) return xhrRequest(request[1], request[2]!, pageUrl);
    // Phrase (« chargée après le rendu ») : la famille seule ; une URL dans la phrase n'est jamais suivie, elle la refuse.
    return SCHEME.test(rest) ? null : { kind: 'pagination', family: 'xhr', param: null };
  }
  const more = LOAD_MORE_LEAD.exec(value);
  if (more === null) return undefined;
  const rest = more[1]!.trim().replace(BUTTON_LEAD, '');
  if (rest === '') return { kind: 'pagination', family: 'load_more', param: null };
  if (rest.includes('<') || rest.includes('>') || SCHEME.test(rest)) return null;
  const quoted = QUOTED.exec(rest);
  if (quoted !== null) {
    const label = cleanLabel(quoted[1]!);
    return label === null ? null : { kind: 'pagination', family: 'load_more', param: null, label };
  }
  if (/[.#[:]/.test(rest) && validSelector(rest)) return { kind: 'pagination', family: 'load_more', param: null, selector: rest };
  const label = cleanLabel(rest);
  return label === null ? null : { kind: 'pagination', family: 'load_more', param: null, label };
}

/** Requête XHR de la liste : méthode connue, URL http(s) (relative à la page), motif `{page}` ou chemin en gabarit. */
function xhrRequest(rawMethod: string | undefined, rawUrl: string, pageUrl: string): ParsedHint | null {
  const method = (rawMethod ?? 'GET').toUpperCase();
  if (!HTTP_METHODS.has(method)) return null;
  const token = PAGE_TOKEN.test(rawUrl);
  const parsed = parseHintUrl(token ? rawUrl.replace(PAGE_TOKEN, '987654321') : rawUrl.startsWith('?') ? `${new URL(pageUrl).pathname}${rawUrl}` : rawUrl, pageUrl);
  if (parsed === null) return null;
  if (token) {
    const pattern = `${parsed.url.pathname}${parsed.url.search}`.replace('987654321', '{page}');
    if (!pattern.includes('{page}') || pattern.length > 500) return null;
    return { kind: 'pagination', family: 'xhr', param: null, pattern, method, host: parsed.host };
  }
  return { kind: 'pagination', family: 'xhr', param: null, endpoint: templatePath(parsed.url.pathname), method, host: parsed.host };
}

/**
 * Phrase qui nomme le chargement sans le mener (« Liste chargée en XHR après le rendu », « bouton « Annonces suivantes » ») :
 * la famille, et pour un bouton son libellé entre guillemets ; balisage ou URL : refusée.
 */
function parseLoaderPhrase(value: string): ParsedHint | null {
  if (value.includes('<') || value.includes('>') || SCHEME.test(value)) return null;
  if (XHR_WORD.test(value)) return { kind: 'pagination', family: 'xhr', param: null };
  if (!LOAD_MORE_WORD.test(value)) return null;
  const quoted = QUOTED.exec(value);
  const label = quoted === null ? null : cleanLabel(quoted[1]!);
  if (quoted !== null && label === null) return null;
  return label === null ? { kind: 'pagination', family: 'load_more', param: null } : { kind: 'pagination', family: 'load_more', param: null, label };
}

function parseFamilyHint(value: string): ParsedHint | null {
  const m = /^([a-z_]{3,20})(?:\s+(.+))?$/s.exec(value);
  const family = m !== null && (BRIEF_PAGINATION_FAMILIES as readonly string[]).includes(m[1]!) ? m[1]! : null;
  const rest = (family === null ? value : (m![2] ?? '')).trim();
  if (rest === '') return family === null ? null : { kind: 'pagination', family, param: null };
  if (family !== null && family !== 'next_link' && /^[A-Za-z0-9_.[\]-]{1,64}$/.test(rest) && !/^N$/.test(rest)) return { kind: 'pagination', family, param: rest };
  if (PAGE_TOKEN.test(rest) && rest.length <= 500 && !/\s/.test(rest)) {
    let url: URL;
    try {
      url = new URL(rest.replace(PAGE_TOKEN, '987654321'), 'https://brief.invalid/');
    } catch {
      return null;
    }
    const pattern = `${url.pathname}${url.search}`.replace('987654321', '{page}');
    if (!pattern.includes('{page}')) return null;
    return { kind: 'pagination', family: family ?? 'page_param', param: null, pattern };
  }
  // Sélecteur du lien suivant : au moins une classe, un identifiant, un attribut ou une pseudo-classe (une phrase n'en est pas un).
  if (/[.#[:]/.test(rest) && validSelector(rest)) return { kind: 'pagination', family: family ?? 'next_link', param: null, selector: rest };
  return null;
}

/** Valeur canonique d'un indice (identité) : gabarit pour une URL, forme normalisée sinon. */
function canonicalValue(parsed: ParsedHint | null, hint: Pick<BriefHint, 'value'>): string {
  if (parsed === null) return hint.value.trim().toLowerCase();
  switch (parsed.kind) {
    case 'endpoint':
      return `${parsed.method} ${matchTemplate(parsed.url)}`;
    case 'example_url':
      return matchTemplate(parsed.url);
    case 'embedded_data':
      return `${parsed.blob} ${parsed.path}`;
    case 'pagination':
      if (parsed.host !== undefined) return `${parsed.family} ${parsed.method ?? 'GET'} ${parsed.host}${parsed.pattern ?? parsed.endpoint ?? ''}`;
      return `${parsed.family} ${parsed.param ?? parsed.pattern ?? parsed.selector ?? parsed.label?.toLowerCase() ?? ''}`.trim();
    case 'selector':
      return parsed.selector.replace(/\s+/g, ' ');
    case 'pitfall':
      return hint.value.trim().toLowerCase().replace(/\s+/g, ' ');
  }
}

/** Clé d'identité (19c § 9.2) : `sha256` du type et de la valeur canonique ; elle survit au remplacement du dossier. */
export function hintIdentityKey(kind: BriefHintKind, canonical: string): string {
  return createHash('sha256').update(`${kind}\n${canonical}`).digest('hex');
}

/** Faits du code sur un indice (`brief_hint_outcomes`), relus d'une version à l'autre. */
export type HintOutcomeFact = {
  readonly identity_key: string;
  readonly state: 'used' | 'verified_unused' | 'probe_failed' | 'ignored';
  readonly reason: string | null;
  /** Dernière sonde (ISO), réussie ou non. */
  readonly probed_at: string | null;
  /** Dernière sonde réussie (ISO). */
  readonly last_ok_at: string | null;
};

export type DigestDecision = 'probe' | 'match_in_recon' | 'unverifiable' | 'ignored';

export type DigestHint = {
  readonly id: string;
  readonly kind: BriefHintKind;
  readonly identity_key: string;
  readonly parsed: ParsedHint | null;
  readonly confidence: 'high' | 'medium' | 'low' | null;
  readonly seen: string | null;
  readonly seen_at: string | null;
  /** Périmé (19c § 5) : utilisable seulement après une sonde réussie. */
  readonly stale: boolean;
  readonly decision: DigestDecision;
  /** Raison d'un indice écarté ou non vérifiable (codes de 19c § 9.3). */
  readonly reason: BriefReason | null;
  /** Gardes visées par une consigne d'élargissement dans la valeur (sans effet, journalisé). */
  readonly widening: readonly WideningGuard[];
};

export type BriefDigest = {
  readonly hints: readonly DigestHint[];
  readonly tried: number;
  readonly tried_refused: number;
  readonly open_questions: number;
  readonly has_notes: boolean;
  /** Gardes visées par une consigne d'élargissement dans `notes`, `tried.note` ou `open_questions` (sans effet). */
  readonly widening: readonly WideningGuard[];
};

export type DigestContext = {
  readonly pageUrl: string;
  /** Portée de site de l'API (`siteScope`) : un indice hors de cette portée est écarté, 0 requête. */
  readonly scope: string;
  readonly now: Date;
  /** API avec session ou en tunnel : aucune sonde directe, rapprochement avec la page déjà chargée seulement. */
  readonly sessionOrTunnel: boolean;
  /** Faits du code par clé d'identité (mémoire négative, péremption). */
  readonly outcomes?: ReadonlyMap<string, HintOutcomeFact>;
  /** Indices dont une valeur figurait dans `subject_exclusions` (`brief_subject_excluded`). */
  readonly subjectExcluded?: readonly string[];
  readonly config?: BriefConfig;
};

/** Consignes d'élargissement propres au dossier (19c § 9.4), en plus de la liste fermée de 18 § 4.7. */
const BRIEF_WIDENING: readonly { guard: WideningGuard; re: RegExp }[] = [
  { guard: 'isolation', re: /\ballowed[_ ]hosts\b|\bhosts?\s*[:=]\s*\*|\bautres?\s+hotes?\b|\b(?:an)?other\s+hosts?\b|\bthird[- ]party\s+host/ },
  { guard: 'caps', re: /\b(?:budget|cost|cout)\s+(?:illimite|unlimited|infini|infinite)\b|\bunlimited\s+budget\b|\bsans\s+limite\b|\bno\s+limit/ },
  { guard: 'step_checks', re: /\b(?:verified|verifie|deja\s+verifie|already\s+checked)\b/ },
  { guard: 'output_schema', re: /\bput_rule\b|\bcree\s+une\s+regle\b|\bcreate\s+a\s+rule\b/ },
  { guard: 'protection', re: /\bsolveur\b|\bsolver\b|\bstealth\b|\bfurtivit/ },
  { guard: 'session', re: /\b(?:autre|another|other)\s+(?:compte|account|cookie)\b/ },
];

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’`]/g, "'");

/** Gardes visées par un texte (liste fermée de 18 § 4.7 et ajouts du dossier) : informe, n'a aucun effet. */
export function briefWidening(text: string): WideningGuard[] {
  const found = new Set<WideningGuard>(wideningWarnings(text).map((w) => w.guard));
  const folded = fold(text);
  for (const { guard, re } of BRIEF_WIDENING) if (re.test(folded)) found.add(guard);
  return [...found];
}

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;
const DAY = 86_400_000;

function within(host: string, scope: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  return h === scope || h.endsWith(`.${scope}`);
}

/**
 * Digest d'un dossier normalisé : décisions et raisons par indice, AVANT toute requête (19c § 3) :
 * - valeur hors gabarit : `brief_invalid_item` ; même clé d'identité qu'un indice précédent : `brief_duplicate` ;
 * - URL vers un autre hôte que celui de l'API, ou adresse IP : `brief_host_ignored` (0 requête) ;
 * - `endpoint` non GET : jamais sondé, candidat seulement s'il est observé dans le trafic (`match_in_recon`) ;
 * - API avec session ou en tunnel : aucune sonde directe (`match_in_recon`) ;
 * - URL en gabarit `{param}` : rapprochée du trafic, jamais sondée ;
 * - mémoire négative : un indice en échec depuis moins de `BRIEF_NEGATIVE_TTL_DAYS` n'est pas resondé, sauf `seen_at`
 *   plus récent que la dernière sonde (une seule resonde) ;
 * - `embedded_data`, `selector`, `pagination` : vérifiés sur la page de reconnaissance, sans requête de plus ;
 * - `pitfall` et `tried` : non vérifiables (`brief_unverifiable`), sans effet sur l'ordre ;
 * - au-delà de `BRIEF_PROBE_MAX` sondes : `brief_over_budget`.
 */
export function buildBriefDigest(brief: InvestigationBrief, ctx: DigestContext): BriefDigest {
  const config = ctx.config ?? DEFAULT_BRIEF_CONFIG;
  const excluded = new Set(ctx.subjectExcluded ?? []);
  const seenKeys = new Set<string>();
  const hints: DigestHint[] = [];
  for (const h of brief.hints ?? []) {
    const parsed = parseHintValue(h, ctx.pageUrl);
    const identity = hintIdentityKey(h.kind, canonicalValue(parsed, h));
    const fact = ctx.outcomes?.get(identity);
    const seenAt = h.seen_at ?? null;
    const freshest = Math.max(seenAt === null ? 0 : Date.parse(seenAt), fact?.last_ok_at ? Date.parse(fact.last_ok_at) : 0);
    const stale = freshest === 0 ? false : ctx.now.getTime() - freshest > BRIEF_STALE_DAYS[h.kind] * DAY;
    const widening = briefWidening(h.value);
    const base = { id: h.id, kind: h.kind, identity_key: identity, parsed, confidence: h.confidence ?? null, seen: h.seen ?? null, seen_at: seenAt, stale, widening };
    const push = (decision: DigestDecision, reason: BriefReason | null) => hints.push({ ...base, decision, reason });
    if (parsed === null) {
      push('ignored', 'brief_invalid_item');
      continue;
    }
    if (seenKeys.has(identity)) {
      push('ignored', 'brief_duplicate');
      continue;
    }
    seenKeys.add(identity);
    if (excluded.has(h.id)) {
      push('ignored', 'brief_subject_excluded');
      continue;
    }
    if (parsed.kind === 'pitfall') {
      push('unverifiable', widening.length > 0 ? 'brief_widening_ignored' : 'brief_unverifiable');
      continue;
    }
    if (parsed.kind === 'endpoint' || parsed.kind === 'example_url') {
      if (isIpLiteral(parsed.host) || !within(parsed.host, ctx.scope)) {
        push('ignored', 'brief_host_ignored');
        continue;
      }
      // Mémoire négative (19c § 5) : pas de resonde avant le délai, sauf un `seen_at` plus récent que la dernière sonde.
      if (fact?.state === 'probe_failed' && fact.probed_at !== null) {
        const probedAt = Date.parse(fact.probed_at);
        const recent = ctx.now.getTime() - probedAt < config.negativeTtlDays * DAY;
        const newer = seenAt !== null && Date.parse(seenAt) > probedAt;
        if (recent && !newer) {
          push('ignored', 'brief_probe_failed');
          continue;
        }
      }
      const getOnly = parsed.kind === 'example_url' || parsed.method === 'GET';
      if (ctx.sessionOrTunnel || !getOnly || parsed.templated) {
        push('match_in_recon', null);
        continue;
      }
      push('probe', null);
      continue;
    }
    // Pagination `xhr` qui nomme une requête : hôte dans la portée de l'API, jamais une adresse IP (0 requête sinon).
    if (parsed.kind === 'pagination' && parsed.host !== undefined && (isIpLiteral(parsed.host) || !within(parsed.host, ctx.scope))) {
      push('ignored', 'brief_host_ignored');
      continue;
    }
    push('match_in_recon', null);
  }
  // Plafond de sondes : les plus sûres d'abord (confiance déclarée, puis date), les autres restent non vérifiées.
  const probes = hints
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.decision === 'probe')
    .sort((a, b) => CONFIDENCE_RANK[a.h.confidence ?? 'low'] - CONFIDENCE_RANK[b.h.confidence ?? 'low'] || (b.h.seen_at ?? '').localeCompare(a.h.seen_at ?? '') || a.i - b.i);
  for (const { i } of probes.slice(config.probeMax)) hints[i] = { ...hints[i]!, decision: 'ignored', reason: 'brief_over_budget' };
  const freeText = [brief.notes ?? '', ...(brief.tried ?? []).map((t) => t.note ?? ''), ...(brief.open_questions ?? [])].join('\n');
  return {
    hints,
    tried: (brief.tried ?? []).length,
    tried_refused: (brief.tried ?? []).filter((t) => t.outcome === 'refused').length,
    open_questions: (brief.open_questions ?? []).length,
    has_notes: (brief.notes ?? '').trim() !== '',
    widening: briefWidening(freeText),
  };
}

/** Indices à sonder, dans l'ordre de la sonde (confiance déclarée, puis date). */
export function probeOrder(digest: BriefDigest): DigestHint[] {
  return digest.hints
    .filter((h) => h.decision === 'probe')
    .sort((a, b) => CONFIDENCE_RANK[a.confidence ?? 'low'] - CONFIDENCE_RANK[b.confidence ?? 'low'] || (b.seen_at ?? '').localeCompare(a.seen_at ?? ''));
}

/** Gabarit de chemin d'un indice URL (pour le rapprochement et la promotion) ; `null` sinon. */
export function hintPathTemplate(hint: DigestHint): string | null {
  const p = hint.parsed;
  if (p === null || (p.kind !== 'endpoint' && p.kind !== 'example_url')) return null;
  return templatePath(p.url.pathname);
}

/** État initial d'un indice (avant sonde et essais), pour le rapport. */
export function initialState(hint: DigestHint): BriefHintState {
  return hint.decision === 'ignored' ? 'ignored' : 'unverified';
}

export { BRIEF_DEFAULTS };
