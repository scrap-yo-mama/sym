// SPDX-License-Identifier: AGPL-3.0-only
// Profil des sorties sans LLM (tâche 2.12, 19 §3, r4 R1, R2, [r4 06 §2]) : fonction PURE, calculée après Ajv et après la
// garde de classification (jamais sur une page de défi servie en 200, c'est à l'appelant de ne l'appeler qu'après) :
// remplissage, sentinelles, motifs de format, longueurs, unicité, doublons. Un champ `x-personal` n'a que des formes
// (remplissage, sentinelles, motifs, longueurs), jamais min, max, top-k ni exemple ; un champ non annoté dont au moins
// 20 % des valeurs ressemblent à un e-mail ou un téléphone devient `suspected_personal` (même traitement). Les motifs de
// format sont des formes (`A-9`, `a.a9@a.a`) : lettres et chiffres réduits à leur classe, répétitions fusionnées.

/** Liste fermée des sentinelles (r4 R5). */
export const SENTINEL_VALUES: readonly string[] = Object.freeze(['N/A', 'n/a', '-', '—', 'null', 'undefined', '']);
/** Part de valeurs d'allure personnelle qui rend un champ non annoté `suspected_personal` (19 §3, à valider). */
export const SUSPECTED_PERSONAL_RATIO = 0.2;
const TOP_K = 10;
const MAX_PATTERNS = 8;

export type FieldProfile = {
  readonly type: string;
  readonly personal: boolean;
  readonly suspected_personal: boolean;
  /** Part des items où la valeur est présente (ni absente, ni null, ni sentinelle). */
  readonly fill_rate: number;
  readonly sentinel_rate: number;
  readonly top_pattern: string | null;
  /** Part de chaque motif parmi les valeurs présentes (les `MAX_PATTERNS` plus fréquents). */
  readonly patterns: Readonly<Record<string, number>>;
  readonly length: { readonly min: number; readonly max: number; readonly mean: number };
  readonly unique_rate: number;
  readonly distinct: number;
  readonly constant: boolean;
  /** Champs non personnels seulement. */
  readonly min?: number;
  readonly max?: number;
  readonly top?: readonly { readonly value: string | number | boolean; readonly count: number }[];
};

export type RunProfile = {
  readonly items: number;
  readonly duplicates: number;
  readonly duplicate_rate: number;
  readonly fields: Readonly<Record<string, FieldProfile>>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (v: number): number => Math.round(v * 1e4) / 1e4;
const EMAILISH = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const PHONEISH = /(?:\+|00)\d{1,3}[\d ().-]{6,16}\d|(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)/;

/** Forme d'une valeur : `9` chiffres, `A` majuscules, `a` minuscules, autres gardés ; répétitions fusionnées ; 24 au plus. */
export function shapeOf(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = /\d/.test(ch) ? '9' : /\p{Lu}/u.test(ch) ? 'A' : /\p{Ll}|\p{Lo}/u.test(ch) ? 'a' : /\s/.test(ch) ? ' ' : ch;
    if (out.at(-1) !== c) out += c;
    if (out.length >= 24) break;
  }
  return out;
}

const isSentinel = (v: unknown): boolean => typeof v === 'string' && SENTINEL_VALUES.includes(v.trim());

function personalFlag(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const f = schema['x-personal'];
  return f === true || (typeof f === 'string' && f !== '' && f !== 'false');
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Valeur canonique pour l'unicité et les doublons (objets triés par clé). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function profileField(name: string, schema: unknown, items: readonly unknown[]): FieldProfile {
  const values = items.map((it) => (isRecord(it) ? it[name] : undefined));
  const declared = isRecord(schema) && typeof schema['type'] === 'string' ? schema['type'] : null;
  const present = values.filter((v) => v !== undefined && v !== null && !isSentinel(v));
  const sentinels = values.filter((v) => isSentinel(v) || v === null).length;
  const texts = present.map((v) => (typeof v === 'string' ? v : canonical(v)));
  const looksPersonal = texts.filter((t) => EMAILISH.test(t) || PHONEISH.test(t)).length;
  const personal = personalFlag(schema);
  const suspected = !personal && texts.length > 0 && looksPersonal / texts.length >= SUSPECTED_PERSONAL_RATIO;
  const counts = new Map<string, number>();
  for (const t of texts) {
    const s = shapeOf(t);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const patterns = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_PATTERNS).map(([k, n]) => [k, round(n / Math.max(1, texts.length))]));
  const lengths = texts.map((t) => [...t].length);
  const distinctValues = new Map<string, { value: unknown; count: number }>();
  for (const v of present) {
    const key = canonical(v);
    const cur = distinctValues.get(key);
    if (cur === undefined) distinctValues.set(key, { value: v, count: 1 });
    else cur.count += 1;
  }
  const n = items.length;
  const base = {
    type: declared ?? (present.length > 0 ? typeOf(present[0]) : 'null'),
    personal,
    suspected_personal: suspected,
    fill_rate: n === 0 ? 0 : round(present.length / n),
    sentinel_rate: n === 0 ? 0 : round(sentinels / n),
    top_pattern: Object.keys(patterns)[0] ?? null,
    patterns,
    length: lengths.length === 0 ? { min: 0, max: 0, mean: 0 } : { min: Math.min(...lengths), max: Math.max(...lengths), mean: round(lengths.reduce((a, b) => a + b, 0) / lengths.length) },
    unique_rate: present.length === 0 ? 0 : round(distinctValues.size / present.length),
    distinct: distinctValues.size,
    constant: present.length >= 2 && distinctValues.size === 1,
  };
  // Valeur personnelle ou soupçonnée : formes seulement, jamais min, max, top-k ni exemple.
  if (personal || suspected) return base;
  const numbers = present.filter((v): v is number => typeof v === 'number');
  const top = [...distinctValues.values()]
    .filter((d) => typeof d.value === 'string' || typeof d.value === 'number' || typeof d.value === 'boolean')
    .sort((a, b) => b.count - a.count || canonical(a.value).localeCompare(canonical(b.value)))
    .slice(0, TOP_K)
    .map((d) => ({ value: typeof d.value === 'string' ? d.value.slice(0, 120) : (d.value as number | boolean), count: d.count }));
  return { ...base, ...(numbers.length > 0 ? { min: Math.min(...numbers), max: Math.max(...numbers) } : {}), top };
}

/** Fiche de qualité d'un run : 0 appel LLM, 0 requête réseau (fonction pure). */
export function profileItems(items: readonly unknown[], schema: unknown): RunProfile {
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
  const names = new Set<string>(Object.keys(props));
  const seen = new Set<string>();
  let duplicates = 0;
  for (const it of items) {
    const key = canonical(it);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  const fields: Record<string, FieldProfile> = {};
  for (const name of names) fields[name] = profileField(name, props[name], items);
  return { items: items.length, duplicates, duplicate_rate: items.length === 0 ? 0 : round(duplicates / items.length), fields };
}
