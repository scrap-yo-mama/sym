// SPDX-License-Identifier: AGPL-3.0-only
// Validation d'une réparation contre les DERNIÈRES SORTIES SAINES (04 §5 étape 2, S2) : en plus du schéma, la sortie
// réparée doit garder les champs STABLES des derniers runs réussis (présents, non nuls et du même type JSON dans chacun
// des items de référence). Une réparation qui « passe » le schéma en vidant un champ optionnel jusque-là toujours rempli,
// ou en changeant son type, est un faux succès : elle est refusée. Profil = chemins et types seulement, jamais une valeur.
// L'empreinte de forme (`shapeFingerprint`, chemins:types) sert de diff de forme au journal et au prompt de réparation.
// La référence suit le schéma COURANT : items conformes à lui, champs qu'il déclare.
import { shapeFingerprint } from '../dsl/fingerprint.js';
import { compileSchema } from '../schema/validator.js';

/** Seuils (à valider) : taille minimale de la référence, part d'items réparés qui doivent porter chaque champ stable. */
export const HEALTHY_DEFAULTS = { minItems: 5, minPresence: 0.8, maxDepth: 4 } as const;

export type JsonFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** Profil des sorties saines : champ stable (pointeur) → type JSON. Vide : pas de référence suffisante. */
export type HealthyProfile = {
  readonly items: number;
  readonly stable: Readonly<Record<string, JsonFieldType>>;
  /** Empreinte de forme d'un item de référence (chemins:types). */
  readonly fingerprint: string | null;
};

export type HealthyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[]; readonly type_changed: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const escapeSegment = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

function jsonType(v: unknown): JsonFieldType | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : null;
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'object') return typeof v as JsonFieldType;
  return null;
}

/** Feuilles et nœuds (pointeur → type) d'un item, jusqu'à `maxDepth` ; les tableaux ne sont pas parcourus. */
function fieldsOf(item: unknown, maxDepth: number): Map<string, JsonFieldType> {
  const out = new Map<string, JsonFieldType>();
  const walk = (value: unknown, path: string, depth: number): void => {
    if (!isRecord(value) || depth >= maxDepth) return;
    for (const [k, v] of Object.entries(value)) {
      const t = jsonType(v);
      if (t === null) continue;
      const p = `${path}/${escapeSegment(k)}`;
      out.set(p, t);
      if (t === 'object') walk(v, p, depth + 1);
    }
  };
  walk(item, '', 0);
  return out;
}

/** Le pointeur suit-il des propriétés DÉCLARÉES (`properties`, imbriquées) du schéma ? */
function declaredPath(schema: unknown, pointer: string): boolean {
  let node = schema;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const props = isRecord(node) ? node['properties'] : undefined;
    if (!isRecord(props) || !Object.hasOwn(props, key)) return false;
    node = props[key];
  }
  return true;
}

/**
 * Profil des champs stables d'items de référence (sorties livrées des derniers runs réussis). `outputSchema` (le schéma
 * COURANT) : seuls comptent les items qui lui sont conformes et les champs qu'il déclare ; après un changement de schéma
 * (ré-enquête `output_schema_changed`), un champ retiré ou retypé n'est plus exigé d'une réparation.
 */
export function healthyProfile(items: readonly unknown[], options: { minItems?: number; maxDepth?: number; outputSchema?: unknown } = {}): HealthyProfile {
  const minItems = options.minItems ?? HEALTHY_DEFAULTS.minItems;
  const maxDepth = options.maxDepth ?? HEALTHY_DEFAULTS.maxDepth;
  const schema = options.outputSchema;
  if (schema !== undefined) {
    const validate = compileSchema(schema);
    const current = items.filter((item) => validate(item));
    const profile = healthyProfile(current, { minItems, maxDepth });
    return { ...profile, stable: Object.fromEntries(Object.entries(profile.stable).filter(([p]) => declaredPath(schema, p))) };
  }
  if (items.length < minItems) return { items: items.length, stable: {}, fingerprint: items[0] === undefined ? null : shapeFingerprint(items[0]) };
  let stable: Map<string, JsonFieldType> | null = null;
  for (const item of items) {
    const fields = fieldsOf(item, maxDepth);
    if (stable === null) {
      stable = fields;
      continue;
    }
    for (const [p, t] of [...stable]) if (fields.get(p) !== t) stable.delete(p);
    if (stable.size === 0) break;
  }
  return { items: items.length, stable: Object.fromEntries([...(stable ?? new Map())].sort(([a], [b]) => a.localeCompare(b))), fingerprint: shapeFingerprint(items[0]) };
}

/**
 * Sortie réparée contre la référence : chaque champ stable doit être présent, du même type, dans au moins `minPresence`
 * des items réparés (seuil à valider). Sans référence (profil vide), seul le schéma juge.
 */
export function checkAgainstHealthy(profile: HealthyProfile, items: readonly unknown[], minPresence: number = HEALTHY_DEFAULTS.minPresence): HealthyCheck {
  const stable = Object.entries(profile.stable);
  if (stable.length === 0) return { ok: true };
  if (items.length === 0) return { ok: false, missing: stable.map(([p]) => p), type_changed: [] };
  const present = new Map<string, number>();
  const typed = new Map<string, number>();
  for (const item of items) {
    const fields = fieldsOf(item, HEALTHY_DEFAULTS.maxDepth);
    for (const [p, t] of stable) {
      const got = fields.get(p);
      if (got === undefined) continue;
      present.set(p, (present.get(p) ?? 0) + 1);
      if (got === t) typed.set(p, (typed.get(p) ?? 0) + 1);
    }
  }
  const need = minPresence * items.length;
  const missing = stable.filter(([p]) => (present.get(p) ?? 0) < need).map(([p]) => p);
  const typeChanged = stable.filter(([p]) => (present.get(p) ?? 0) >= need && (typed.get(p) ?? 0) < need).map(([p]) => p);
  return missing.length === 0 && typeChanged.length === 0 ? { ok: true } : { ok: false, missing, type_changed: typeChanged };
}
