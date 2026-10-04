// SPDX-License-Identifier: AGPL-3.0-only
// Qualité VISIBLE des données d'une enquête (U1.11 ; constats UX-25 et UX-26), logique pure sans I/O ni LLM :
// - `schemaAnchorChanges` : le schéma de sortie précédent d'une API est l'ancre de la nouvelle proposition ; tout champ perdu,
//   ajouté, retypé ou probablement renommé est signalé (les colonnes CSV, intégrations et planifications en dépendent) ;
// - `requestedPageLimit` : nombre de pages demandé en toutes lettres dans la description (« les 3 premières pages »), lu par
//   le code, jamais par le modèle.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type SchemaAnchorChanges = {
  /** Champs du schéma précédent absents de la proposition. */
  readonly dropped: readonly string[];
  /** Champs de la proposition absents du schéma précédent. */
  readonly added: readonly string[];
  /** Champs gardés dont le type a changé. */
  readonly retyped: readonly string[];
  /** Renommages probables : un champ perdu et un champ ajouté du même type (nom proche, ou seuls de leur type). */
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
};

function fieldTypes(schema: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
  for (const [name, p] of Object.entries(props)) {
    const t = isRecord(p) ? p['type'] : undefined;
    const type = Array.isArray(t) ? (t.find((x) => x !== 'null') as string | undefined) : (t as string | undefined);
    out.set(name, typeof type === 'string' ? type : 'string');
  }
  return out;
}

const tokens = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

/** Écarts entre le schéma précédent d'une API et le schéma proposé ; aucun écart si le précédent n'a aucun champ. */
export function schemaAnchorChanges(previous: unknown, proposed: unknown): SchemaAnchorChanges {
  const before = fieldTypes(previous);
  const after = fieldTypes(proposed);
  if (before.size === 0) return { dropped: [], added: [], retyped: [], renamed: [] };
  const dropped = [...before.keys()].filter((n) => !after.has(n));
  const added = [...after.keys()].filter((n) => !before.has(n));
  const retyped = [...before.keys()].filter((n) => after.has(n) && after.get(n) !== before.get(n));
  const renamed: { from: string; to: string }[] = [];
  const freeFrom = new Set(dropped);
  const freeTo = new Set(added);
  // Nom proche d'abord (jeton commun), puis le seul candidat de son type de chaque côté.
  for (const from of dropped) {
    const a = new Set(tokens(from));
    const near = [...freeTo].filter((to) => after.get(to) === before.get(from) && tokens(to).some((t) => a.has(t)));
    if (near.length === 1) {
      renamed.push({ from, to: near[0]! });
      freeFrom.delete(from);
      freeTo.delete(near[0]!);
    }
  }
  for (const from of [...freeFrom]) {
    const same = [...freeTo].filter((to) => after.get(to) === before.get(from));
    const rivals = [...freeFrom].filter((f) => before.get(f) === before.get(from));
    if (same.length === 1 && rivals.length === 1) {
      renamed.push({ from, to: same[0]! });
      freeTo.delete(same[0]!);
    }
  }
  return { dropped, added, retyped, renamed };
}

const WORDS: Readonly<Record<string, number>> = { un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5, six: 6, sept: 7, seven: 7, huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10 };
const COUNT = '(\\d{1,3}|un|une|one|deux|two|trois|three|quatre|four|cinq|five|six|sept|seven|huit|eight|neuf|nine|dix|ten)';
/** Plafond d'une limite lue : au-delà, la description ne demande plus une limite mais « beaucoup ». */
const MAX_REQUESTED_PAGES = 100;

const count = (raw: string): number | null => {
  const n = /^\d+$/.test(raw) ? Number(raw) : (WORDS[raw.toLowerCase()] ?? null);
  return n !== null && n >= 1 && n <= MAX_REQUESTED_PAGES ? n : null;
};

/**
 * Nombre de pages demandé par la description (« les 3 premières pages », « first two pages », « sur 4 pages », « la première
 * page seulement »), sinon `null` (toutes les pages, ou rien de dit). Un nombre d'éléments (« les 50 premiers livres ») n'en est pas un.
 */
export function requestedPageLimit(description: string): number | null {
  const text = description.normalize('NFC');
  const patterns: RegExp[] = [
    new RegExp(`\\b${COUNT}\\s+(?:premi[èe]res?|first)\\s+pages?\\b`, 'i'),
    new RegExp(`\\bfirst\\s+${COUNT}\\s+pages?\\b`, 'i'),
    new RegExp(`\\bsur\\s+${COUNT}\\s+pages?\\b`, 'i'),
    new RegExp(`\\b(?:over|across)\\s+${COUNT}\\s+pages?\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m !== null) return count(m[1]!);
  }
  if (/\b(?:seulement|uniquement)\s+(?:la\s+)?premi[èe]re\s+page\b|\bpremi[èe]re\s+page\s+(?:seulement|uniquement)\b|\bpage\s+1\s+(?:seulement|uniquement)\b|\bonly\s+(?:the\s+)?first\s+page\b|\bfirst\s+page\s+only\b/i.test(text)) return 1;
  return null;
}
