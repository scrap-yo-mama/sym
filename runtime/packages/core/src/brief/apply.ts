// SPDX-License-Identifier: AGPL-3.0-only
// Point de départ (tâche 2.14, 19c § 3, r7 R5) : un indice confirmé PAR LE CODE (sonde, ou gabarit retrouvé dans le trafic
// et le DOM de la page déjà chargée) place les couples de sa source en tête, À L'INTÉRIEUR de l'ensemble autorisé ; le plan
// n'est jamais élargi (aucun couple ajouté) et le rattrapage du moins cher (`runTrials`, `catchUp`) reste : la stratégie
// retenue est la moins chère conforme, comme sans dossier (INV2). Puis les états finaux de chaque indice (`used`,
// `verified_unused`, `probe_failed`, `ignored`, `unverified`), la source de la version (`source.brief`) et les faits du code.
import { parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS } from '../dsl/limits.js';
import type { TrialPair } from '../investigation/plan.js';
import type { BriefHintKind, BriefHintState, BriefReason } from './schema.js';
import type { BriefDigest, DigestHint } from './digest.js';
import type { ProbeFacts, ProbeRun } from './probe.js';
import { matchTemplate, templatePath } from './url.js';

/** Gisement vu par la reconnaissance (forme minimale de `DataCandidate`). */
export type BriefCandidateView = { readonly id: string; readonly from: 'response' | 'embedded'; readonly method: string; readonly url: string; readonly locator: string | null };

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
 * - `embedded_data` : blob du même type trouvé dans le document ; `selector` : au moins un élément dans le document ;
 * - `pagination` : paramètre déclaré présent dans la requête d'un gisement.
 */
export function matchBriefHints(
  digest: BriefDigest,
  probes: ProbeRun | null,
  recon: { readonly candidates: readonly BriefCandidateView[]; readonly exchanges: readonly { readonly url: string; readonly method: string }[]; readonly html: string | null },
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
      const d = document();
      const found = ((): number => {
        try {
          return d === null ? 0 : selectElements(p.selector, d, 1).length;
        } catch {
          return 0;
        }
      })();
      if (found > 0) confirmed.set(hint.id, { provenance: 'dom', candidates: [] });
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
