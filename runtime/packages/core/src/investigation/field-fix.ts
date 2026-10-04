// SPDX-License-Identifier: AGPL-3.0-only
// Correction BON MARCHÉ de l'affectation d'un champ refusé par le contrôle de fidélité (banc réel R09, passage 2 : `start_date`
// recevait le nom de l'organisateur, puis SYM escaladait vers les voies à LLM qui épuisaient le budget d'enquête). Le CODE
// relit le différentiel du contrôle (champ, motif) et cherche, dans le squelette du gisement, le chemin qui convient :
// - `not_a_date` : un champ ISO de la réponse (`start_at`, `starts_at`, `start_date`…) dont le nom est celui du champ, jamais une
//   fin, une création ou une mise à jour ; vérifié sur les données déjà capturées (80 % de dates) ;
// - `looks_like_id` : le chemin joint du squelette (`$.teamId~name`) qui porte le libellé de l'identifiant lu.
// Aucun appel au LLM, aucune requête : fonction pure. `null` : rien à corriger de cette façon (la voie suivante décide).
import { extractRecords } from '../dsl/extract.js';
import { validateDeclarativeSpec, type DeclarativeSpec, type FieldSpec } from '../dsl/spec.js';
import { looksLikeDate, type FidelityIssue } from './fidelity.js';
import { virtualField } from './proposal.js';
import type { DataCandidate } from './recon.js';

export type FieldFix = { readonly spec: DeclarativeSpec; readonly changes: readonly { readonly field: string; readonly path: string }[] };

const GENERIC = new Set(['date', 'at', 'time', 'on', 'datetime', 'timestamp']);
const NOT_START = new Set(['end', 'ends', 'created', 'updated', 'modified', 'deleted', 'published', 'registered', 'closed', 'expires', 'expiry']);
const DATE_SHARE = 0.8;

/** Mots d'un nom (`start_date`, `startAt`, `start-at`), en minuscules. */
const tokens = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');

/** Dernier segment d'un chemin du squelette (`$.event.start_at` → `start_at`). */
const leafOf = (path: string): string => path.replace(/\['([^']*)'\]/g, '.$1').split('.').at(-1) ?? '';

/** Affinité d'un chemin de la réponse avec un champ date : le début recherché, jamais une fin ni une création. */
function dateScore(field: string, path: string): number {
  const want = tokens(field).filter((t) => !GENERIC.has(t));
  const leaf = tokens(leafOf(path));
  let score = 0;
  for (const t of leaf) {
    if (want.includes(t)) score += 3;
    else if (NOT_START.has(t) && !want.includes(t)) score -= 5;
  }
  if (leaf.some((t) => GENERIC.has(t))) score += 1;
  // Un champ sans mot propre (« date ») : le début d'un événement est le plus probable.
  if (want.length === 0 && leaf.includes('start')) score += 2;
  return score;
}

const withPath = (spec: DeclarativeSpec, field: string, replacement: Record<string, unknown>, outputSchema: unknown): DeclarativeSpec | null => {
  const previous = spec.fields[field] as FieldSpec | undefined;
  if (previous === undefined) return null;
  const raw = { ...spec, fields: { ...spec.fields, [field]: { type: previous.type, ...(previous.required === true ? { required: true } : {}), ...replacement } } };
  const check = validateDeclarativeSpec(raw, { outputSchema });
  return check.ok ? check.spec : null;
};

/**
 * Nouvelle affectation des champs refusés par `issues`, ou `null`. `body` : corps capturé du gisement (réponse JSON ou page
 * qui porte le blob) : toute correction y est vérifiée avant d'être rendue.
 */
export function fixFieldMapping(input: {
  readonly spec: DeclarativeSpec;
  readonly candidate: DataCandidate | null | undefined;
  readonly issues: readonly FidelityIssue[];
  readonly outputSchema: unknown;
  readonly body: string | undefined;
}): FieldFix | null {
  const { candidate, body, outputSchema } = input;
  if (candidate === null || candidate === undefined || candidate.from === 'dom' || body === undefined || input.spec.sources[0]?.from === 'html') return null;
  let spec = input.spec;
  const changes: { field: string; path: string }[] = [];
  const values = (s: DeclarativeSpec, field: string): unknown[] => {
    try {
      const out = extractRecords(s, { body }, { outputSchema, itemPolicy: 'quarantine' });
      return out.records.map((r) => r[field]);
    } catch {
      return [];
    }
  };
  for (const issue of input.issues) {
    const current = spec.fields[issue.field];
    if (current === undefined || changes.some((c) => c.field === issue.field)) continue;
    if (issue.code === 'not_a_date') {
      const paths = Object.entries(candidate.skeleton)
        .filter(([path, type]) => type === 'string' && !/[~^[]/.test(path) && path !== current.path)
        .map(([path]) => ({ path, score: dateScore(issue.field, path) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      for (const { path } of paths) {
        const variant = withPath(spec, issue.field, { path }, outputSchema);
        if (variant === null) continue;
        const found = values(variant, issue.field).filter((v) => v !== undefined && v !== null && v !== '');
        if (found.length > 0 && found.filter(looksLikeDate).length >= found.length * DATE_SHARE) {
          spec = variant;
          changes.push({ field: issue.field, path });
          break;
        }
      }
    } else if (issue.code === 'looks_like_id' && current.path !== undefined) {
      const wanted = tokens(issue.field);
      const joined = Object.keys(candidate.skeleton)
        .filter((p) => p.startsWith(`${current.path}~`) && !p.includes('~parent~'))
        .map((p) => ({ p, score: tokens(leafOf(p.slice(p.indexOf('~') + 1))).filter((t) => wanted.includes(t) || t === 'name' || t === 'title' || t === 'label').length }))
        .sort((a, b) => b.score - a.score)[0];
      const field = joined === undefined ? undefined : virtualField(joined.p, candidate, current.type, current.required === true);
      if (joined === undefined || field === undefined) continue;
      const variant = withPath(spec, issue.field, field, outputSchema);
      if (variant === null) continue;
      const found = values(variant, issue.field).filter((v) => v !== undefined && v !== null && v !== '');
      if (found.length > 0) {
        spec = variant;
        changes.push({ field: issue.field, path: joined.p });
      }
    }
  }
  return changes.length === 0 ? null : { spec, changes };
}
