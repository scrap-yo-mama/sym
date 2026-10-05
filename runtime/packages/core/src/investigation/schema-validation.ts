// SPDX-License-Identifier: AGPL-3.0-only
// `validate_schema` avec corrections du client (constat Barnes, 05 § 4.1, 03-specs-mcp § 9 bis) : logique pure. Le schéma
// validé est celui du CLIENT (INV1 : c'est le contrat) ; le code calcule ce qui a changé par rapport à la proposition, pour le
// montrer (réponse de l'outil, chronologie), et ce qui n'est pas applicable, pour le dire (jamais ignoré en silence) :
// - propriétés de premier niveau ajoutées, retirées, renommées (même définition sous un autre nom, appariement unique),
//   type, description, statut requis, autre changement de la définition (enum, format, items…) ;
// - marques `x-personal` : celles du client sont ignorées, celles que l'enquête a détectées sont gardées (17 § 6).
// Consignes libres du client (`instructions`) : texte de l'UTILISATEUR, jamais du site, borné (2 000 caractères), traité
// comme la description de l'API. Source candidate (`source_id`, D-124) : un identifiant de la reconnaissance (`c1`, `c2`…).
// Aucune valeur du site n'entre ici : noms et définitions de champs viennent du schéma (proposé ou client).

/** Plafond des consignes libres du client (caractères), comme la description de l'API. */
export const VALIDATION_INSTRUCTIONS_MAX = 2000;
/** Forme d'un identifiant de source candidate (`c1`, `results-list`…). */
export const VALIDATION_SOURCE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export type SchemaChanges = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly type_changed: readonly string[];
  readonly description_changed: readonly string[];
  readonly required_changed: readonly string[];
  readonly other_changed: readonly string[];
};

/** Partie d'une correction qui n'est pas appliquée telle quelle (code fermé, champ ou identifiant concerné). */
export type NotApplied = { readonly code: 'personal_mark_ignored' | 'personal_mark_kept'; readonly field: string };

export type SchemaValidationReport = { readonly corrected: boolean; readonly changes: SchemaChanges; readonly not_applied: readonly NotApplied[] };

type Rec = Record<string, unknown>;
const PERSONAL = 'x-personal';
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const propertiesOf = (schema: unknown): Rec => rec(rec(schema)['properties']);
const requiredOf = (schema: unknown): Set<string> => new Set((Array.isArray(rec(schema)['required']) ? (rec(schema)['required'] as unknown[]) : []).filter((v): v is string => typeof v === 'string'));

/** Forme canonique (clés triées : jsonb réordonne les clés) d'une valeur JSON, profondeur bornée. */
function canon(value: unknown, depth = 0): string {
  if (depth > 32) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canon(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((value as Rec)[k], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const without = (def: unknown, keys: readonly string[]): Rec => Object.fromEntries(Object.entries(rec(def)).filter(([k]) => !keys.includes(k)));

/**
 * Ce qui a changé entre le schéma PROPOSÉ et le schéma du client, et ce qui n'est pas appliqué. Les marques `x-personal` ne
 * comptent pas comme un changement de définition : elles sont rapportées à part (`not_applied`).
 */
export function schemaValidationReport(proposed: unknown, client: unknown): SchemaValidationReport {
  const p = propertiesOf(proposed);
  const c = propertiesOf(client);
  const pReq = requiredOf(proposed);
  const cReq = requiredOf(client);
  const removed0 = Object.keys(p).filter((k) => !Object.hasOwn(c, k));
  const added0 = Object.keys(c).filter((k) => !Object.hasOwn(p, k));
  const body = (def: unknown) => canon(without(def, [PERSONAL]));
  // Renommage : même définition (marques à part) sous un autre nom, et un seul appariement possible de chaque côté.
  const renamed: { from: string; to: string }[] = [];
  for (const from of removed0) {
    const matches = added0.filter((to) => body(c[to]) === body(p[from]));
    const back = matches.length === 1 ? removed0.filter((r) => body(p[r]) === body(c[matches[0]!])) : [];
    if (matches.length === 1 && back.length === 1 && !renamed.some((r) => r.to === matches[0])) renamed.push({ from, to: matches[0]! });
  }
  const added = added0.filter((k) => !renamed.some((r) => r.to === k));
  const removed = removed0.filter((k) => !renamed.some((r) => r.from === k));
  const typeChanged: string[] = [];
  const descriptionChanged: string[] = [];
  const otherChanged: string[] = [];
  const requiredChanged: string[] = [];
  for (const k of Object.keys(c)) {
    const from = Object.hasOwn(p, k) ? k : renamed.find((r) => r.to === k)?.from;
    if (from === undefined) {
      if (cReq.has(k)) requiredChanged.push(k);
      continue;
    }
    const before = rec(p[from]);
    const after = rec(c[k]);
    const typeDiff = canon(before['type']) !== canon(after['type']);
    if (typeDiff) typeChanged.push(k);
    if (canon(before['description']) !== canon(after['description'])) descriptionChanged.push(k);
    if (!typeDiff && canon(without(before, [PERSONAL, 'type', 'description'])) !== canon(without(after, [PERSONAL, 'type', 'description']))) otherChanged.push(k);
    if (pReq.has(from) !== cReq.has(k)) requiredChanged.push(k);
  }
  // Marques personnelles (17 § 6, `correctedSchemaWithDetectedMarks`) : celles du client ne comptent pas, celles détectées restent.
  const notApplied: NotApplied[] = [];
  for (const k of Object.keys(c)) {
    const from = Object.hasOwn(p, k) ? k : renamed.find((r) => r.to === k)?.from;
    const detected = Object.hasOwn(p, k) && rec(p[k])[PERSONAL] !== undefined;
    const marked = rec(c[k])[PERSONAL] !== undefined;
    if (marked && !detected) notApplied.push({ code: 'personal_mark_ignored', field: k });
    else if (!marked && detected && from === k) notApplied.push({ code: 'personal_mark_kept', field: k });
  }
  notApplied.sort((a, b) => (a.code === b.code ? 0 : a.code === 'personal_mark_ignored' ? -1 : 1));
  const changes: SchemaChanges = { added, removed, renamed, type_changed: typeChanged, description_changed: descriptionChanged, required_changed: requiredChanged, other_changed: otherChanged };
  const corrected = canon(client) !== canon(proposed);
  return { corrected, changes, not_applied: notApplied };
}

/** Consignes libres du client : caractères de contrôle retirés, espaces resserrées ; vides → `null` ; au-delà du plafond → erreur. */
export function normalizeValidationInstructions(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  if (raw.length > VALIDATION_INSTRUCTIONS_MAX) throw new Error(`instructions : ${VALIDATION_INSTRUCTIONS_MAX} caractères au plus`);
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return text === '' ? null : text;
}

/** Source candidate choisie par le client : un gisement de la reconnaissance, utilisable ; sinon la liste des identifiants valides. */
export function checkValidationSource(
  id: string,
  candidates: readonly { readonly id: string; readonly unsupported?: unknown }[] | undefined,
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly valid: readonly string[] } {
  const valid = (candidates ?? []).filter((c) => c.unsupported === undefined).map((c) => c.id);
  return valid.includes(id) ? { ok: true, id } : { ok: false, valid };
}
