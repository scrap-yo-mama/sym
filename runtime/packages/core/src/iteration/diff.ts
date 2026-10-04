// SPDX-License-Identifier: AGPL-3.0-only
// Diff de sorties (tâche 3.14, 19 §6, r3 R10) : le brouillon contre la version en service, par clé d'identité (`x-key`),
// à trois niveaux (items, champs, valeurs), déterministe (mêmes entrées, même diff, même `diff_hash`). Aucune valeur
// `x-personal` ne sort : l'échantillon la masque. La référence de bruit (champs qui varient d'un run sain à l'autre) est
// calculée par l'appelant sur les deux derniers runs sains de `current` et retirée des comptes de changements.
import { createHash } from 'node:crypto';

type Item = Record<string, unknown>;
type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export const DIFF_SAMPLE_MAX = 5;
export const DIFF_PERSONAL_MASK = '[masked]';

const sortKeys = (v: unknown, depth = 0): unknown =>
  depth > 32 ? null : Array.isArray(v) ? v.map((x) => sortKeys(x, depth + 1)) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k], depth + 1)])) : v;
export const canonicalOf = (v: unknown): string => JSON.stringify(sortKeys(v)) ?? 'null';
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Champs-clés d'identité d'un schéma de sortie : ceux marqués `x-key: true` (niveau racine). */
export function identityKeyFields(outputSchema: unknown): string[] {
  const props = isRecord(outputSchema) && isRecord(outputSchema['properties']) ? outputSchema['properties'] : {};
  return Object.keys(props).filter((name) => isRecord(props[name]) && props[name]['x-key'] === true).sort();
}

/** Champs `x-personal` de premier niveau : leurs valeurs ne sortent jamais dans un diff. */
export function personalTopFields(outputSchema: unknown): string[] {
  const props = isRecord(outputSchema) && isRecord(outputSchema['properties']) ? outputSchema['properties'] : {};
  return Object.keys(props).filter((name) => isRecord(props[name]) && props[name]['x-personal'] !== undefined && props[name]['x-personal'] !== false).sort();
}

export type FieldDiff = {
  readonly field: string;
  /** Items dont la valeur a changé (champ présent des deux côtés). */
  readonly changed: number;
  /** Champ présent avant, absent du brouillon. */
  readonly dropped: number;
  /** Champ absent avant, présent dans le brouillon. */
  readonly filled: number;
  readonly noise: boolean;
};

export type DiffSample = { readonly key: string; readonly field: string; readonly before: unknown; readonly after: unknown };

export type ItemsDiff = {
  /** `key` : appariés par `x-key` ; `content` : sans clé d'identité, comparés par contenu (ajoutés et retirés seulement). */
  readonly identity: 'key' | 'content';
  readonly key_fields: readonly string[];
  readonly current_total: number;
  readonly draft_total: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly fields: readonly FieldDiff[];
  readonly noise_fields: readonly string[];
  readonly sample: readonly DiffSample[];
};

export type DiffOptions = {
  readonly keyFields: readonly string[];
  /** Champs de premier niveau qui varient d'un run sain à l'autre : retirés des comptes de changements. */
  readonly noiseFields?: readonly string[];
  readonly personalFields?: readonly string[];
};

const keyOf = (item: Item, fields: readonly string[]): string => canonicalOf(fields.map((f) => item[f] ?? null));

/** Champs de premier niveau qui varient entre deux listes d'items d'une même entrée (référence de bruit, r3 R10). */
export function noiseFieldsOf(a: readonly Item[], b: readonly Item[], keyFields: readonly string[]): string[] {
  if (keyFields.length === 0) return [];
  const byKey = new Map(a.map((i) => [keyOf(i, keyFields), i]));
  const noisy = new Set<string>();
  for (const item of b) {
    const other = byKey.get(keyOf(item, keyFields));
    if (other === undefined) continue;
    for (const field of new Set([...Object.keys(item), ...Object.keys(other)])) if (canonicalOf(item[field]) !== canonicalOf(other[field])) noisy.add(field);
  }
  return [...noisy].sort();
}

export function diffItems(current: readonly Item[], draft: readonly Item[], options: DiffOptions): ItemsDiff {
  const keyFields = [...options.keyFields].sort();
  const noise = new Set(options.noiseFields ?? []);
  const personal = new Set(options.personalFields ?? []);
  const fields = new Map<string, { changed: number; dropped: number; filled: number }>();
  const bump = (field: string, what: 'changed' | 'dropped' | 'filled') => {
    const f = fields.get(field) ?? { changed: 0, dropped: 0, filled: 0 };
    f[what] += 1;
    fields.set(field, f);
  };
  const samples: DiffSample[] = [];
  const mask = (field: string, value: unknown): unknown => (personal.has(field) ? DIFF_PERSONAL_MASK : value);

  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  if (keyFields.length === 0) {
    // Sans clé d'identité : multiensemble de contenus ; aucune comparaison champ à champ (pas d'appariement fiable).
    const count = new Map<string, number>();
    for (const item of current) count.set(canonicalOf(item), (count.get(canonicalOf(item)) ?? 0) + 1);
    for (const item of draft) {
      const k = canonicalOf(item);
      const n = count.get(k) ?? 0;
      if (n > 0) {
        count.set(k, n - 1);
        unchanged += 1;
      } else added += 1;
    }
    for (const n of count.values()) removed += n;
    return {
      identity: 'content', key_fields: [], current_total: current.length, draft_total: draft.length, added, removed, changed: 0, unchanged,
      fields: [], noise_fields: [...noise].sort(), sample: [],
    };
  }

  const before = new Map<string, Item>();
  for (const item of current) before.set(keyOf(item, keyFields), item);
  const seen = new Set<string>();
  for (const item of draft) {
    const k = keyOf(item, keyFields);
    const old = before.get(k);
    if (old === undefined || seen.has(k)) {
      added += old === undefined ? 1 : 0;
      continue;
    }
    seen.add(k);
    let itemChanged = false;
    for (const field of [...new Set([...Object.keys(old), ...Object.keys(item)])].sort()) {
      if (noise.has(field)) continue;
      const a = old[field];
      const b = item[field];
      if (canonicalOf(a) === canonicalOf(b)) continue;
      itemChanged = true;
      if (a === undefined) bump(field, 'filled');
      else if (b === undefined) bump(field, 'dropped');
      else bump(field, 'changed');
      if (samples.length < DIFF_SAMPLE_MAX) samples.push({ key: keyFields.map((f) => String(personal.has(f) ? DIFF_PERSONAL_MASK : (item[f] ?? ''))).join('|').slice(0, 120), field, before: mask(field, a), after: mask(field, b) });
    }
    if (itemChanged) changed += 1;
    else unchanged += 1;
  }
  for (const k of before.keys()) if (!seen.has(k)) removed += 1;
  const fieldDiffs: FieldDiff[] = [...fields.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([field, c]) => ({ field, ...c, noise: false }));
  return {
    identity: 'key', key_fields: keyFields, current_total: current.length, draft_total: draft.length, added, removed, changed, unchanged,
    fields: fieldDiffs, noise_fields: [...noise].sort(), sample: samples,
  };
}

/** Empreinte du diff et de ce qu'il engage (brouillon, base, schéma) : une promotion qui l'ignore ou le périme est refusée. */
export function diffHash(diff: ItemsDiff, bound: { readonly draftVersion: number; readonly baseVersion: number; readonly schemaVersion: string; readonly specSha256: string }): string {
  return sha256(canonicalOf({ diff, bound }));
}

/** Phrase du diff par gabarit déterministe : un code et des nombres ; le texte localisé est rendu par la couche de présentation. */
export type DiffSummaryParts = { readonly code: 'diff_none' | 'diff_changes' | 'diff_content'; readonly params: Readonly<Record<string, number>> };

export function diffSummaryParts(diff: ItemsDiff): DiffSummaryParts {
  if (diff.identity === 'content') return { code: 'diff_content', params: { total: diff.draft_total, added: diff.added, removed: diff.removed } };
  if (diff.added === 0 && diff.removed === 0 && diff.changed === 0) return { code: 'diff_none', params: { total: diff.draft_total } };
  const filled = diff.fields.reduce((n, f) => n + f.filled, 0);
  const dropped = diff.fields.reduce((n, f) => n + f.dropped, 0);
  return { code: 'diff_changes', params: { total: diff.draft_total, added: diff.added, removed: diff.removed, changed: diff.changed, filled, dropped } };
}
