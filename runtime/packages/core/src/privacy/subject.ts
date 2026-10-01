// Sujet de données : valeurs `x-personal` du schéma de sortie, normalisation et empreinte HMAC (17 § 6).
// L'empreinte est un HMAC-SHA256 dont la clé dérive de MASTER_KEY (HKDF, libellé `subjects`) : sans la clé, un
// dictionnaire d'e-mails ou de téléphones ne permet pas de retrouver qui figure dans `subject_exclusions`.
import { createHmac } from 'node:crypto';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const COMBINATORS = ['allOf', 'anyOf', 'oneOf'] as const;
const MAX_DEPTH = 64;

/** `x-personal` actif : `true`, ou une chaîne non vide (`identifier`, `content`). */
function isPersonal(node: Record<string, unknown>): boolean {
  const flag = node['x-personal'];
  return flag === true || (typeof flag === 'string' && flag !== '' && flag !== 'false');
}

function leaves(value: unknown, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) leaves(v, out, depth + 1);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) leaves(v, out, depth + 1);
  }
}

function walk(schema: unknown, value: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || !isRecord(schema) || value === undefined || value === null) return;
  if (isPersonal(schema)) {
    leaves(value, out);
    return;
  }
  for (const key of COMBINATORS) {
    const subs = schema[key];
    if (Array.isArray(subs)) for (const s of subs) walk(s, value, out, depth + 1);
  }
  if (isRecord(value) && isRecord(schema['properties'])) {
    for (const [name, sub] of Object.entries(schema['properties'])) walk(sub, value[name], out, depth + 1);
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    for (const v of value) walk(schema['items'], v, out, depth + 1);
  }
}

/** Valeurs d'un item situées sous un nœud `x-personal` du schéma de sortie (feuilles textuelles, non vides). */
export function extractPersonalValues(outputSchema: unknown, item: unknown): string[] {
  const out: string[] = [];
  walk(outputSchema, item, out, 0);
  return out;
}

/** Le schéma déclare-t-il au moins un champ `x-personal` ? */
export function schemaHasPersonalFields(schema: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(schema)) return schema.some((s) => schemaHasPersonalFields(s, depth + 1));
  if (!isRecord(schema)) return false;
  if (isPersonal(schema)) return true;
  return Object.values(schema).some((s) => schemaHasPersonalFields(s, depth + 1));
}

const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/;

/**
 * Forme canonique d'une valeur de sujet : NFKC, minuscules, espaces repliés ; un numéro de téléphone est réduit à
 * ses chiffres (et au `+` initial) pour que `06 12 34 56 78` et `06.12.34.56.78` désignent la même personne.
 */
export function normalizeSubjectValue(value: string): string {
  const base = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (PHONE_LIKE.test(base) && base.replace(/\D/g, '').length >= 6) return base.replace(/(?!^\+)\D/g, '');
  return base;
}

/** HMAC-SHA256 (hex) de la forme canonique. `key` : `MasterKey.kek('subjects')`. */
export function subjectHash(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(normalizeSubjectValue(value)).digest('hex');
}

/** Empreintes distinctes d'une liste de valeurs (valeurs vides ignorées). */
export function subjectHashes(key: Buffer, values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => normalizeSubjectValue(v) !== '').map((v) => subjectHash(key, v)))];
}

/** Un item est exclu si l'une de ses valeurs `x-personal` a une empreinte présente dans `excluded`. */
export function isItemExcluded(key: Buffer, excluded: ReadonlySet<string>, outputSchema: unknown, item: unknown): boolean {
  if (excluded.size === 0) return false;
  return extractPersonalValues(outputSchema, item).some((v) => excluded.has(subjectHash(key, v)));
}

/** Retire des `items` ceux qui concernent un sujet exclu (à appeler avant collecte et avant écriture du dataset). */
export function filterExcludedItems<T>(
  key: Buffer,
  excluded: ReadonlySet<string>,
  outputSchema: unknown,
  items: readonly T[],
): { kept: T[]; dropped: number } {
  const kept = items.filter((it) => !isItemExcluded(key, excluded, outputSchema, it));
  return { kept, dropped: items.length - kept.length };
}
