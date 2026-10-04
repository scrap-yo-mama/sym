// SPDX-License-Identifier: AGPL-3.0-only
// Point de départ (tâche 2.14, 19c § 3, r7 R5) : un indice confirmé PAR LE CODE (sonde, ou gabarit retrouvé dans le trafic
// et le DOM de la page déjà chargée) place les couples de sa source en tête, À L'INTÉRIEUR de l'ensemble autorisé ; le plan
// n'est jamais élargi (aucun couple ajouté) et le rattrapage du moins cher (`runTrials`, `catchUp`) reste : la stratégie
// retenue est la moins chère conforme, comme sans dossier (INV2). Puis les états finaux de chaque indice (`used`,
// `verified_unused`, `probe_failed`, `ignored`, `unverified`), la source de la version (`source.brief`) et les faits du code.
import type { Element } from 'domhandler';
import { elementText, parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS } from '../dsl/limits.js';
import type { TrialPair } from '../investigation/plan.js';
import type { BriefHintKind, BriefHintState, BriefReason } from './schema.js';
import type { BriefDigest, DigestHint, ParsedHint } from './digest.js';
import type { ProbeFacts, ProbeRun } from './probe.js';
import { matchTemplate, templatePath } from './url.js';

/** Gisement vu par la reconnaissance (forme minimale de `DataCandidate`). */
export type BriefCandidateView = {
  readonly id: string;
  readonly from: 'response' | 'embedded' | 'dom';
  readonly method: string;
  readonly url: string;
  readonly locator: string | null;
  /** Gisement `dom` : sélecteur CSS de ses blocs (un indice `selector` qui y tombe le désigne). */
  readonly records?: string;
};

/** L'élément `inner` est `outer` ou l'un de ses descendants. */
function within(inner: Element, outer: Element): boolean {
  for (let n: Element | null = inner; n !== null; n = n.parent !== null && n.parent.type === 'tag' ? (n.parent as Element) : null) if (n === outer) return true;
  return false;
}

/** Motif de pagination (`/liste/page/{page}/`, `/liste/?page={page}`) en expression : `{page}` = un entier. */
function patternRegex(pattern: string): RegExp {
  const [head, tail] = pattern.split('{page}');
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return new RegExp(`^${esc(head ?? '')}[0-9]{1,6}${esc(tail ?? '')}$`);
}

/** Contrôles qui chargent la suite d'une liste (bouton, lien, rôle bouton). */
const LOAD_MORE_CONTROLS = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
const foldText = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const LOAD_MORE_TEXT = /\b(?:load more|show more|see more|more results|charger plus|voir plus|afficher plus|plus de resultats|suivant(?:e|es|s)?|next)\b/;

/** Texte d'un contrôle : contient le libellé déclaré (sans casse ni accents) ; sans libellé, un libellé usuel de « charger plus ». */
function loadMoreText(text: string, label: string | undefined): boolean {
  const t = foldText(text);
  if (t === '' || t.length > 120) return false;
  return label === undefined ? LOAD_MORE_TEXT.test(t) : t.includes(foldText(label));
}

/** Réponse de données d'un gisement désignée par un indice `xhr` : même hôte et requête nommée, ou paramètre nommé. */
function xhrMatches(p: Extract<ParsedHint, { kind: 'pagination' }>, candidateUrl: string): boolean {
  let c: URL;
  try {
    c = new URL(candidateUrl);
  } catch {
    return false;
  }
  if (p.param !== null) return c.searchParams.has(p.param.replace(/^url\.query\./, ''));
  if (p.host !== undefined && c.hostname.toLowerCase() !== p.host) return false;
  if (p.pattern !== undefined) {
    const [path, query] = p.pattern.split('?');
    const pathOk = path!.includes('{page}') ? patternRegex(path!).test(c.pathname) : pathMatches(templatePath(path!), templatePath(c.pathname)) || path!.toLowerCase() === c.pathname.toLowerCase();
    const names = [...new URLSearchParams(query ?? '').keys()];
    return pathOk && names.every((n) => c.searchParams.has(n));
  }
  if (p.endpoint !== undefined) return pathMatches(p.endpoint, templatePath(c.pathname)) || pathMatches(p.endpoint, c.pathname);
  return true;
}

export type HintProvenance = 'probe' | 'traffic' | 'dom';

export type BriefMatch = {
  /** Indices confirmés par le code : provenance et gisements (identifiants `c1`…) qu'ils désignent. */
  readonly confirmed: ReadonlyMap<string, { readonly provenance: HintProvenance; readonly candidates: readonly string[] }>;
};

/** Le chemin `path` répond-il au gabarit `template` (`{x}` = un segment quelconque) ? */
function pathMatches(template: string, path: string): boolean {
  const a = template.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => /^\{[A-Za-z0-9_]{1,32}\}$/.test(seg) || seg.toLowerCase() === (b[i] ?? '').toLowerCase());
}

function urlMatches(hintUrl: URL, candidateUrl: string): boolean {
  let c: URL;
  try {
    c = new URL(candidateUrl);
  } catch {
    return false;
  }
  if (c.hostname.toLowerCase() !== hintUrl.hostname.toLowerCase()) return false;
  if (matchTemplate(c) === matchTemplate(hintUrl)) return true;
  let hintPath = hintUrl.pathname;
  try {
    hintPath = decodeURI(hintPath);
  } catch {
    // chemin non décodable : comparaison brute
  }
  return pathMatches(templatePath(hintPath), templatePath(c.pathname)) || pathMatches(hintPath, c.pathname);
}

/**
 * Rapprochement des indices avec ce que la reconnaissance a déjà vu (sans requête de plus) et avec les sondes réussies :
 * - `endpoint` / `example_url` sondés avec succès : provenance « sonde » ; non sondés (session, tunnel, gabarit, non GET) :
 *   retenus seulement si leur gabarit est retrouvé dans le trafic de la page déjà chargée (provenance « trafic »), un
 *   `endpoint` non GET seulement avec la même méthode observée ;
 * - `embedded_data` : blob du même type trouvé dans le document ; `selector` : au moins un élément dans le document (il
 *   désigne le gisement `dom` dont un bloc est, contient ou est contenu par cet élément) ;
 * - `pagination` : paramètre déclaré présent dans la requête d'un gisement ; motif d'URL retrouvé dans un lien de la page
 *   (même hôte) ou sélecteur du lien suivant présent dans le document (il désigne les gisements `dom`).
 */
export function matchBriefHints(
  digest: BriefDigest,
  probes: ProbeRun | null,
  recon: { readonly candidates: readonly BriefCandidateView[]; readonly exchanges: readonly { readonly url: string; readonly method: string }[]; readonly html: string | null; readonly pageUrl?: string },
): BriefMatch {
  const confirmed = new Map<string, { provenance: HintProvenance; candidates: string[] }>();
  const verified = new Set((probes?.results ?? []).filter((r) => r.outcome === 'verified').map((r) => r.id));
  let doc: ReturnType<typeof parseHtml> | null = null;
  const document = () => {
    if (doc === null && recon.html !== null) {
      try {
        doc = parseHtml(recon.html, DEFAULT_DSL_LIMITS);
      } catch {
        doc = null;
      }
    }
    return doc;
  };
  /** Éléments d'un sélecteur dans le document de la reconnaissance (plusieurs : le cas courant d'une liste). */
  const select = (selector: string): Element[] => {
    const d = document();
    if (d === null) return [];
    try {
      return selectElements(selector, d, 10_000);
    } catch {
      return [];
    }
  };
  /** Gisements `dom` qui contiennent (ou sont contenus par) un élément trouvé ; sans élément : tous les gisements `dom`. */
  const domCandidatesOf = (found: readonly Element[]): string[] =>
    recon.candidates
      .filter((c) => c.from === 'dom' && c.records !== undefined)
      .filter((c) => {
        if (found.length === 0) return true;
        const blocks = select(c.records!);
        return found.some((el) => blocks.some((b) => within(el, b) || within(b, el)));
      })
      .map((c) => c.id);
  for (const hint of digest.hints) {
    const p = hint.parsed;
    if (p === null || hint.decision === 'ignored' || hint.decision === 'unverifiable') continue;
    if (p.kind === 'endpoint' || p.kind === 'example_url') {
      const method = p.kind === 'endpoint' ? p.method : 'GET';
      const candidates = recon.candidates.filter((c) => c.from === 'response' && c.method.toUpperCase() === method && urlMatches(p.url, c.url)).map((c) => c.id);
      if (hint.decision === 'probe') {
        if (verified.has(hint.id)) confirmed.set(hint.id, { provenance: 'probe', candidates });
        continue;
      }
      const seen = recon.exchanges.some((e) => e.method.toUpperCase() === method && urlMatches(p.url, e.url));
      if (seen) confirmed.set(hint.id, { provenance: 'traffic', candidates });
      continue;
    }
    if (p.kind === 'embedded_data') {
      const candidates = recon.candidates.filter((c) => c.from === 'embedded' && c.locator === p.blob).map((c) => c.id);
      if (candidates.length > 0) confirmed.set(hint.id, { provenance: 'dom', candidates });
      continue;
    }
    if (p.kind === 'selector') {
      // Plusieurs éléments (les cartes d'une liste) : c'était un refus silencieux (borne de 1 résultat), constat Janssens.
      const found = select(p.selector);
      if (found.length > 0) confirmed.set(hint.id, { provenance: 'dom', candidates: domCandidatesOf(found) });
      continue;
    }
    if (p.kind === 'pagination' && p.family === 'xhr') {
      // Liste chargée par XHR / fetch : les réponses de données vues par la reconnaissance (celles de la requête nommée, ou
      // portant le paramètre nommé). Rien de vu : l'indice reste non vérifié, transmis tel quel au prompt.
      const candidates = recon.candidates.filter((c) => c.from === 'response' && xhrMatches(p, c.url)).map((c) => c.id);
      if (candidates.length > 0) confirmed.set(hint.id, { provenance: 'traffic', candidates });
      continue;
    }
    if (p.kind === 'pagination' && p.family === 'load_more') {
      // Bouton « charger plus » présent dans la page déjà chargée (sélecteur, ou libellé dans un bouton ou un lien) : il
      // désigne les listes du DOM. Aucun clic ici : la reconnaissance ne fait que le retrouver.
      const found = p.selector !== undefined ? select(p.selector) : select(LOAD_MORE_CONTROLS).filter((el) => loadMoreText(elementText(el, 200), p.label));
      if (found.length > 0) confirmed.set(hint.id, { provenance: 'dom', candidates: domCandidatesOf([]) });
      continue;
    }
    if (p.kind === 'pagination' && p.selector !== undefined) {
      if (select(p.selector).length > 0) confirmed.set(hint.id, { provenance: 'dom', candidates: domCandidatesOf([]) });
      continue;
    }
    if (p.kind === 'pagination' && p.pattern !== undefined) {
      const re = patternRegex(p.pattern);
      let page: URL | null = null;
      try {
        page = new URL(recon.pageUrl ?? '');
      } catch {
        page = null;
      }
      const seen = select('a[href], link[href]').some((el) => {
        try {
          const u = new URL(el.attribs['href'] ?? '', page ?? 'https://brief.invalid/');
          return (page === null || u.hostname === page.hostname) && re.test(`${u.pathname}${u.search}`);
        } catch {
          return false;
        }
      });
      if (seen) confirmed.set(hint.id, { provenance: 'dom', candidates: domCandidatesOf([]) });
      continue;
    }
    if (p.kind === 'pagination' && p.param !== null) {
      const name = p.param.replace(/^url\.query\./, '');
      const candidates = recon.candidates.filter((c) => {
        try {
          return new URL(c.url).searchParams.has(name);
        } catch {
          return false;
        }
      });
      if (candidates.length > 0) confirmed.set(hint.id, { provenance: 'traffic', candidates: candidates.map((c) => c.id) });
    }
  }
  return { confirmed };
}

/** Sources (gisements) désignées par des indices confirmés ; jamais un gisement que la reconnaissance n'a pas. */
export function briefPreferredSources(match: BriefMatch): Set<string> {
  const out = new Set<string>();
  for (const { candidates } of match.confirmed.values()) for (const c of candidates) out.add(c);
  return out;
}

/**
 * Ordre des essais avec dossier : partition STABLE du plan déjà ordonné (coût croissant, règles) — les couples dont la
 * source est désignée par un indice confirmé d'abord. Aucun couple ajouté ni retiré : `ordered` est une permutation de
 * `plan` (assert_brief_cannot_widen) ; le rattrapage du moins cher garde la stratégie retenue (INV2).
 */
export function orderWithBrief<T extends Pick<TrialPair, 'source'>>(plan: readonly T[], preferred: ReadonlySet<string>): T[] {
  if (preferred.size === 0) return [...plan];
  const first = plan.filter((p) => preferred.has(p.source));
  const rest = plan.filter((p) => !preferred.has(p.source));
  return [...first, ...rest];
}

export type FinalHint = {
  readonly id: string;
  readonly kind: BriefHintKind;
  readonly identity_key: string;
  readonly state: BriefHintState;
  readonly reason: BriefReason | null;
  readonly provenance: HintProvenance | null;
  readonly stale: boolean;
  readonly probe: ProbeFacts | null;
  /** URL d'un indice URL (pour le gabarit affiché, reconstruit par le code). */
  readonly url: string | null;
};

/**
 * États finaux : `used` (confirmé, et la stratégie retenue sert sa source), `verified_unused` (confirmé, une stratégie
 * moins chère ou une autre source a été retenue), `probe_failed`, `ignored` (raison du digest ou de la sonde), `unverified`
 * (non confirmé : `brief_stale`, `brief_breaker_open` ou `brief_unverifiable`). `retainedSource` : gisement de la
 * stratégie retenue (`null` sans stratégie retenue).
 */
export function finalizeBriefHints(digest: BriefDigest, probes: ProbeRun | null, match: BriefMatch, retainedSource: string | null): FinalHint[] {
  const byId = new Map((probes?.results ?? []).map((r) => [r.id, r]));
  return digest.hints.map((hint): FinalHint => {
    const probe = byId.get(hint.id) ?? null;
    const url = hint.parsed !== null && (hint.parsed.kind === 'endpoint' || hint.parsed.kind === 'example_url') ? hint.parsed.url.href : null;
    const base = { id: hint.id, kind: hint.kind, identity_key: hint.identity_key, stale: hint.stale, probe: probe?.probe ?? null, url };
    if (hint.decision === 'ignored') return { ...base, state: 'ignored', reason: hint.reason, provenance: null };
    const confirmed = match.confirmed.get(hint.id);
    if (confirmed !== undefined) {
      const used = retainedSource !== null && confirmed.candidates.includes(retainedSource);
      return { ...base, state: used ? 'used' : 'verified_unused', reason: used ? 'brief_used' : 'brief_verified_unused', provenance: confirmed.provenance };
    }
    if (probe !== null && probe.outcome === 'probe_failed') return { ...base, state: 'probe_failed', reason: 'brief_probe_failed', provenance: null };
    if (probe !== null && probe.outcome === 'skipped') return { ...base, state: 'ignored', reason: probe.reason, provenance: null };
    if (hint.decision === 'probe' && probes !== null && probes.breakerOpen) return { ...base, state: 'unverified', reason: 'brief_breaker_open', provenance: null };
    if (hint.decision === 'unverifiable') return { ...base, state: 'unverified', reason: hint.reason ?? 'brief_unverifiable', provenance: null };
    return { ...base, state: 'unverified', reason: hint.stale ? 'brief_stale' : 'brief_unverifiable', provenance: null };
  });
}

/** `StrategyVersion.source.brief` (19c § 4, § 9.2) : version consultée, indices qui ont pesé, indices écartés et pourquoi. */
export type StrategySourceBrief = {
  readonly ref: { readonly version: number; readonly sha256: string } | null;
  readonly used: readonly string[];
  readonly ignored: readonly { readonly id: string; readonly reason: string }[];
  /** Clone ou transfert (19c § 4) : le dossier ne suit pas l'API. */
  readonly not_transferred?: 'brief_not_transferred';
};

export function sourceBriefOf(ref: { version: number; sha256: string }, hints: readonly FinalHint[]): StrategySourceBrief {
  return {
    ref,
    used: hints.filter((h) => h.state === 'used').map((h) => h.identity_key),
    ignored: hints.filter((h) => h.state === 'ignored' || h.state === 'probe_failed').map((h) => ({ id: h.id, reason: h.reason ?? 'brief_unverifiable' })),
  };
}

/** Indices éligibles à l'événement de preuve `brief_hint_verified` (19c § 6) : utilisés, sondés avec succès, type éligible. */
export function verifiedForPromotion(hints: readonly FinalHint[]): FinalHint[] {
  return hints.filter((h) => h.state === 'used' && (h.provenance === 'probe' || h.provenance === 'traffic' || h.provenance === 'dom') && (h.kind === 'endpoint' || h.kind === 'embedded_data' || h.kind === 'pagination'));
}

export type { DigestHint };
