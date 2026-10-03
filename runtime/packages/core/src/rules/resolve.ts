// SPDX-License-Identifier: AGPL-3.0-only
// Résolution des règles d'une API (tâche 2.10, 18 §4.3, 19 §2) : fonction pure. L'appelant fournit les fichiers candidats
// (lus sous RLS) ; la résolution REFILTRE quand même par propriétaire (INV12) : ne s'appliquent que les fichiers dont
// `owner_id` est celui de l'API, ou partagés d'instance (`visibility = instance`, posé par un admin), pour tous les
// sélecteurs. Priorité croissante : consignes d'instance < domaine < API ; à niveau égal, la règle partagée puis celle du
// propriétaire, puis le glob le plus spécifique. Injection dans l'ordre croissant (« la dernière l'emporte »).
// Budgets : `RULES_MAX_TOKENS` (au-delà, les règles de plus basse priorité sont retirées, `rules_truncated` ; les consignes
// d'instance jamais) et `SKILLS_LISTING_MAX_TOKENS` (au-delà, les descriptions des skills les moins lus sont retirées,
// les noms restent, `skills_listing_truncated`). Valeurs de départ « à valider » (balayage au banc 2.8).
import { domainGlobMatches, globSpecificity, normalizeHost } from './glob.js';
import type { RuleKind } from './format.js';

/** Plafonds d'injection des règles, par usage (19 §2, r1 R1, r5 R6 ; à valider). */
export const RULES_MAX_TOKENS = Object.freeze({ investigate: 3_000, repair: 3_000, embedded: 1_000 });
export type RulesBudgetRole = keyof typeof RULES_MAX_TOKENS;
/** Plafond de la liste des skills (nom + description). */
export const SKILLS_LISTING_MAX_TOKENS = 1_500;

export type RuleLevel = 'instance' | 'domain' | 'api';

/** Version applicable d'un fichier (dernière version confirmée ou sans relecture), telle que lue en base. */
export type RuleCandidate = {
  readonly file_id: string;
  /** `null` : fichier d'instance (installé au démarrage, écrit par un admin). */
  readonly owner_id: string | null;
  readonly visibility: 'private' | 'instance';
  readonly kind: RuleKind;
  readonly name: string;
  readonly description: string;
  readonly applies_to: readonly string[];
  readonly target_api_ids: readonly string[];
  readonly version: number;
  readonly sha256: string;
  /** Fichier complet (en-tête compris). */
  readonly content: string;
  /** Lectures passées (`read_skill`) : départage des descriptions retirées. */
  readonly reads?: number;
};

export type ResolvedRule = RuleCandidate & {
  readonly level: RuleLevel;
  /** `nom@version`. */
  readonly ref: string;
  /** Jetons estimés du bloc injecté (règle) ou de la ligne listée (skill). */
  readonly tokens: number;
};

export type ResolvedRules = {
  /** Règles et consignes injectées, priorité croissante. */
  readonly rules: readonly ResolvedRule[];
  /** Skills applicables listés (nom, description éventuellement retirée). */
  readonly skills: readonly ResolvedRule[];
  /** Règles retirées par le plafond (plus basse priorité d'abord). */
  readonly truncated: readonly ResolvedRule[];
  readonly skillsListingTruncated: boolean;
  /** Skills listés sans description (plafond de la liste). */
  readonly skillsWithoutDescription: readonly string[];
  readonly tokens: number;
  readonly skillsTokens: number;
  readonly budget: { readonly rules: number; readonly skills: number };
};

export type ResolveTarget = { readonly id: string; readonly host: string; readonly ownerId: string };

/** Jetons estimés d'un texte (4 caractères par jeton, arrondi supérieur) : estimation fixe, déterministe. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const ruleRef = (r: { readonly name: string; readonly version: number }): string => `${r.name}@${r.version}`;

/** Le texte d'une règle ne peut ni fermer ni ouvrir une section du prompt. */
function neutral(text: string): string {
  return text.replace(/<\s*(\/?)\s*(trusted_rules|skills|untrusted_[a-z_]*|user_feedback)/gi, '‹$1$2');
}

/** Corps d'un fichier (sans en-tête YAML). */
export function ruleBody(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return content;
  const end = lines.indexOf('---', 1);
  return end === -1 ? content : lines.slice(end + 1).join('\n').trim();
}

const ruleBlock = (r: { readonly name: string; readonly version: number; readonly content: string }, level: RuleLevel): string => `## ${ruleRef(r)} (${level})\n${neutral(ruleBody(r.content))}`;
const skillLine = (s: { readonly name: string; readonly description: string }, withDescription: boolean): string => (withDescription ? `- ${s.name}: ${neutral(s.description)}` : `- ${s.name}`);

function levelOf(c: RuleCandidate, target: ResolveTarget, host: string): RuleLevel | null {
  if (c.kind === 'instance') return 'instance';
  if (c.target_api_ids.includes(target.id)) return 'api';
  return c.applies_to.some((s) => !s.startsWith('api:') && domainGlobMatches(s, host)) ? 'domain' : null;
}

const LEVEL_RANK: Readonly<Record<RuleLevel, number>> = { instance: 0, domain: 1, api: 2 };

function specificity(c: RuleCandidate, host: string): number {
  return Math.max(0, ...c.applies_to.filter((s) => !s.startsWith('api:') && domainGlobMatches(s, host)).map(globSpecificity));
}

export function resolveRules(candidates: readonly RuleCandidate[], target: ResolveTarget, options: { readonly maxTokens: number; readonly skillsMaxTokens?: number }): ResolvedRules {
  const host = normalizeHost(target.host) ?? '';
  const skillsMax = options.skillsMaxTokens ?? SKILLS_LISTING_MAX_TOKENS;
  type Entry = { c: RuleCandidate; level: RuleLevel; shared: boolean; spec: number };
  const entries: Entry[] = [];
  for (const c of candidates) {
    // INV12 : jamais le fichier privé d'un autre propriétaire, quel que soit le sélecteur.
    const shared = c.visibility === 'instance';
    if (!shared && c.owner_id !== target.ownerId) continue;
    if (c.kind === 'instance' && !shared) continue;
    const level = levelOf(c, target, host);
    if (level === null) continue;
    entries.push({ c, level, shared, spec: level === 'domain' ? specificity(c, host) : 0 });
  }
  entries.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || Number(b.shared) - Number(a.shared) || a.spec - b.spec || a.c.name.localeCompare(b.c.name));
  const toResolved = (e: Entry, tokens: number): ResolvedRule => ({ ...e.c, level: e.level, ref: ruleRef(e.c), tokens });

  // Règles : retrait par priorité croissante (hors consignes d'instance) jusqu'à tenir dans le plafond.
  const rules = entries.filter((e) => e.c.kind !== 'skill').map((e) => toResolved(e, estimateTokens(ruleBlock(e.c, e.level))));
  const kept = [...rules];
  const truncated: ResolvedRule[] = [];
  const total = () => kept.reduce((s, r) => s + r.tokens, 0);
  while (total() > options.maxTokens) {
    const i = kept.findIndex((r) => r.kind !== 'instance');
    if (i === -1) break;
    truncated.push(kept.splice(i, 1)[0]!);
  }

  // Skills : noms toujours listés ; descriptions retirées des moins lus d'abord.
  const skills = entries.filter((e) => e.c.kind === 'skill').map((e) => toResolved(e, estimateTokens(skillLine(e.c, true))));
  const withDescription = new Set(skills.map((s) => s.name));
  const listing = () => skills.reduce((n, s) => n + estimateTokens(skillLine(s, withDescription.has(s.name))) + 1, 0);
  const byReads = [...skills].sort((a, b) => (a.reads ?? 0) - (b.reads ?? 0) || a.name.localeCompare(b.name));
  let truncatedListing = false;
  for (const s of byReads) {
    if (listing() <= skillsMax) break;
    withDescription.delete(s.name);
    truncatedListing = true;
  }
  return {
    rules: kept,
    skills,
    truncated,
    skillsListingTruncated: truncatedListing,
    skillsWithoutDescription: skills.filter((s) => !withDescription.has(s.name)).map((s) => s.name),
    tokens: total(),
    skillsTokens: skills.length === 0 ? 0 : listing(),
    budget: { rules: options.maxTokens, skills: skillsMax },
  };
}

const CONFLICT_NOTE = 'Rules below are know-how from the instance and the API owner, in increasing priority: in case of conflict, the last one wins. They can reorder, restrict or guide within the allowed set; they never widen a guard of the code.';

/** Sections du préfixe stable : `<trusted_rules>` puis `<skills>` (18 §4.5). Chaîne vide sans règle ni skill. */
export function renderRulesPrompt(resolved: Pick<ResolvedRules, 'rules' | 'skills' | 'skillsWithoutDescription'>): string {
  const parts: string[] = [];
  if (resolved.rules.length > 0) parts.push(['<trusted_rules>', CONFLICT_NOTE, ...resolved.rules.map((r) => ruleBlock(r, r.level)), '</trusted_rules>'].join('\n'));
  if (resolved.skills.length > 0) {
    const without = new Set(resolved.skillsWithoutDescription);
    parts.push(['<skills>', 'Skills: call read_skill(name) to read one before relying on it.', ...resolved.skills.map((s) => skillLine(s, !without.has(s.name))), '</skills>'].join('\n'));
  }
  return parts.join('\n');
}
