// SPDX-License-Identifier: AGPL-3.0-only
// Version de schéma d'un brouillon (tâche 3.14, 19 §6, r3 R8) : `MAJOR.MINOR.PATCH` calculée par une fonction pure à partir
// de deux schémas de sortie, pré-version `-draft.N`. Un mot-clé inconnu vaut `major` (jamais un changement silencieux).
// Lecture côté consommateur d'une API : retirer ou retyper un champ casse ceux qui le lisent ; en ajouter un ne casse rien.

export const SCHEMA_CHANGE_LEVELS = ['none', 'patch', 'minor', 'major'] as const;
export type SchemaChangeLevel = (typeof SCHEMA_CHANGE_LEVELS)[number];

export const SCHEMA_CHANGE_KINDS = [
  'field_added',
  'field_removed',
  'type_changed',
  'required_added',
  'required_removed',
  'enum_changed',
  'constraint_changed',
  'annotation_changed',
  'unknown_keyword',
] as const;
export type SchemaChangeKind = (typeof SCHEMA_CHANGE_KINDS)[number];

export type SchemaChange = { readonly kind: SchemaChangeKind; readonly path: string; readonly level: Exclude<SchemaChangeLevel, 'none'> };
export type SchemaClassification = { readonly level: SchemaChangeLevel; readonly changes: readonly SchemaChange[] };

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const RANK: Record<SchemaChangeLevel, number> = { none: 0, patch: 1, minor: 2, major: 3 };

/** Mots-clés de description : leur changement n'altère aucun consommateur (patch). */
/** `x-key` (clé d'identité du diff) décrit comment comparer deux sorties : il ne change rien pour qui lit les items. */
const ANNOTATIONS = new Set(['title', 'description', 'examples', '$comment', 'default', '$schema', '$id', 'deprecated', 'x-key']);
/** Mots-clés de contrainte : tout changement est tenu pour cassant (on ne sait pas dire s'il élargit ou resserre). */
const CONSTRAINTS = new Set([
  'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'additionalProperties', 'const', 'oneOf', 'anyOf', 'allOf',
  'not', '$defs', '$ref', 'x-personal',
]);
const STRUCTURAL = new Set(['type', 'properties', 'required', 'items', 'enum']);

const stable = (v: unknown): string => JSON.stringify(v, (_k, value: unknown) => (isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value));
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);
const typesOf = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []);

function walk(before: unknown, after: unknown, path: string, out: SchemaChange[], depth: number): void {
  if (depth > 32) {
    if (!same(before, after)) out.push({ kind: 'unknown_keyword', path, level: 'major' });
    return;
  }
  if (!isRecord(before) || !isRecord(after)) {
    if (!same(before, after)) out.push({ kind: 'unknown_keyword', path, level: 'major' });
    return;
  }
  const keywords = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keywords].sort()) {
    const a = before[key];
    const b = after[key];
    if (same(a, b)) continue;
    if (key === 'properties') {
      const pa = isRecord(a) ? a : {};
      const pb = isRecord(b) ? b : {};
      for (const name of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        const child = path === '' ? name : `${path}.${name}`;
        if (!(name in pb)) out.push({ kind: 'field_removed', path: child, level: 'major' });
        else if (!(name in pa)) out.push({ kind: 'field_added', path: child, level: 'minor' });
        else walk(pa[name], pb[name], child, out, depth + 1);
      }
    } else if (key === 'items') {
      walk(a, b, `${path}[]`, out, depth + 1);
    } else if (key === 'required') {
      const ra = new Set(Array.isArray(a) ? (a as unknown[]).map(String) : []);
      const rb = new Set(Array.isArray(b) ? (b as unknown[]).map(String) : []);
      for (const name of rb) if (!ra.has(name)) out.push({ kind: 'required_added', path: path === '' ? name : `${path}.${name}`, level: 'minor' });
      // Un champ qui n'est plus garanti présent casse celui qui comptait dessus.
      for (const name of ra) if (!rb.has(name)) out.push({ kind: 'required_removed', path: path === '' ? name : `${path}.${name}`, level: 'major' });
    } else if (key === 'type') {
      const ta = typesOf(a);
      const tb = typesOf(b);
      // Rétrécir (["string","null"] → "string") ne casse personne ; élargir ou changer casse.
      const narrowed = tb.length > 0 && tb.every((t) => ta.includes(t)) && tb.length < ta.length;
      out.push({ kind: 'type_changed', path, level: narrowed ? 'minor' : 'major' });
    } else if (key === 'enum') {
      const ea = Array.isArray(a) ? (a as unknown[]) : null;
      const eb = Array.isArray(b) ? (b as unknown[]) : null;
      const added = ea === null || eb === null || eb.some((v) => !ea.some((w) => same(v, w)));
      out.push({ kind: 'enum_changed', path, level: added ? 'major' : 'minor' });
    } else if (ANNOTATIONS.has(key)) {
      out.push({ kind: 'annotation_changed', path, level: 'patch' });
    } else if (CONSTRAINTS.has(key) || STRUCTURAL.has(key)) {
      out.push({ kind: 'constraint_changed', path, level: 'major' });
    } else {
      // Mot-clé inconnu (extension, futur mot-clé) : major, jamais un silence.
      out.push({ kind: 'unknown_keyword', path, level: 'major' });
    }
  }
}

/** Classe le passage de `before` à `after` : le niveau le plus haut des changements, et la liste des changements (ordre stable). */
export function classifySchemaChange(before: unknown, after: unknown): SchemaClassification {
  const changes: SchemaChange[] = [];
  walk(before, after, '', changes, 0);
  let level: SchemaChangeLevel = 'none';
  for (const c of changes) if (RANK[c.level] > RANK[level]) level = c.level;
  return { level, changes };
}

export type SchemaVersion = { readonly major: number; readonly minor: number; readonly patch: number; readonly draft: number | null };
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-draft\.(\d{1,6}))?$/;

export function parseSchemaVersion(raw: string): SchemaVersion | null {
  const m = VERSION.exec(raw);
  return m === null ? null : { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), draft: m[4] === undefined ? null : Number(m[4]) };
}

export const formatSchemaVersion = (v: SchemaVersion): string => `${v.major}.${v.minor}.${v.patch}${v.draft === null ? '' : `-draft.${v.draft}`}`;

/** Version publiée d'un brouillon : la pré-version perd son `-draft.N`. */
export const releasedSchemaVersion = (raw: string): string => raw.replace(/-draft\.\d+$/, '');

/**
 * Version de schéma d'un brouillon : la base (version en service) montée selon le niveau, avec la pré-version `-draft.N`
 * (N = rang de l'affinage). Aucun changement : la version de la base, sans pré-version.
 */
export function nextSchemaVersion(base: string, level: SchemaChangeLevel, draftN: number): string {
  const v = parseSchemaVersion(releasedSchemaVersion(base)) ?? { major: 1, minor: 0, patch: 0, draft: null };
  if (level === 'none') return formatSchemaVersion(v);
  const bumped: SchemaVersion =
    level === 'major' ? { major: v.major + 1, minor: 0, patch: 0, draft: draftN } : level === 'minor' ? { ...v, minor: v.minor + 1, patch: 0, draft: draftN } : { ...v, patch: v.patch + 1, draft: draftN };
  return formatSchemaVersion(bumped);
}

/** Version de schéma différente (hors pré-version) : un retour vers elle franchit un changement de schéma. */
export const crossesSchemaVersion = (from: string, to: string): boolean => releasedSchemaVersion(from) !== releasedSchemaVersion(to);
