// SPDX-License-Identifier: AGPL-3.0-only
// `BriefDigest` typé (tâche 2.14, 19c § 3, § 5) : ce que le CODE retient d'un dossier normalisé avant toute requête. Chaque
// indice reçoit une décision (sonde GET par le pipeline d'accès, rapprochement avec la reconnaissance, non vérifiable,
// ignoré) et, s'il est écarté, une raison fermée. Le statut « vérifié » n'est jamais lu dans le dossier : il est posé après
// la sonde. Les décisions de garde ne viennent pas d'ici : l'hôte hors portée est écarté AVANT toute requête, mais la sonde
// elle-même repasse par robots.txt, la garde SSRF, la cadence et le classifieur de l'API.
import { createHash } from 'node:crypto';
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
  | { readonly kind: 'pagination'; readonly family: string; readonly param: string | null }
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
    case 'pagination': {
      const m = /^([a-z_]{3,20})(?:\s+([A-Za-z0-9_.[\]-]{1,64}))?$/.exec(value);
      if (m === null || !(BRIEF_PAGINATION_FAMILIES as readonly string[]).includes(m[1]!)) return null;
      return { kind: 'pagination', family: m[1]!, param: m[2] ?? null };
    }
    case 'selector':
      return value === '' || /[<>{}]/.test(value) || value.length > 300 ? null : { kind: 'selector', selector: value };
    case 'pitfall':
      return { kind: 'pitfall' };
  }
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
      return `${parsed.family} ${parsed.param ?? ''}`.trim();
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
