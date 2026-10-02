// SPDX-License-Identifier: AGPL-3.0-only
// Export des datasets EN FLUX (tâche 3.1, 05 § 2, T3) : JSON, NDJSON ou CSV, lus par lots sur l'index (dataset_id, seq)
// et écrits au rythme du client (contre-pression du flux Node) ; la mémoire du serveur reste bornée par un lot, quelle
// que soit la taille du dataset (`assert_export_streaming`). Reprise par le curseur `after` (dernier `seq` servi, opaque ou en
// clair) ou, après un export coupé en cours de route, par `offset` (nombre d'items déjà reçus en entier).
// CSV : chaque cellule qui commence par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot est préfixée d'une
// apostrophe (injection de formule, 08b § 2, `assert_csv_formula_neutralized`), de même qu'un déclencheur placé juste après un
// séparateur possible (`;`, `,`, tabulation, fin de ligne, espaces compris) : Excel en locale française ou allemande découpe
// sur `;` et ignore un guillemet au milieu d'un champ, ce déclencheur ouvrirait une cellule autonome. Noms de colonnes compris.
import { withActor } from '@runtime/db';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';

/** Lignes lues par requête : borne la mémoire du flux. */
const EXPORT_BATCH = 1000;

const FORMULA_START = /^[=+\-@\t\r]/;
/** Déclencheur après un séparateur de liste possible (Excel fr/de : `;`), espaces compris. */
const FORMULA_AFTER_SEPARATOR = /([;,\t\r\n]\s*)([=+\-@])/g;

/** Cellule CSV neutralisée (08b § 2) puis échappée (RFC 4180). Les objets et tableaux sont rendus en JSON. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else text = JSON.stringify(value);
  // Un nombre fini n'est jamais une formule ; toute autre cellule qui commence par un déclencheur est préfixée.
  if (!(typeof value === 'number' && Number.isFinite(value))) {
    text = text.replace(FORMULA_AFTER_SEPARATOR, "$1'$2");
    if (FORMULA_START.test(text)) text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`;

export type ExportQuery = {
  datasetId: string;
  /** `seq` après lequel reprendre (exclu) ; -1 depuis le début. */
  afterSeq: number;
  /** Nombre maximal d'items (undefined : tout le reste). */
  limit?: number;
  since?: string;
  fields?: readonly string[];
  omit?: readonly string[];
};

/** Projection d'un item : `fields` garde ces champs de premier niveau, `omit` les retire. */
export function projectItem(item: Record<string, unknown>, fields?: readonly string[], omit?: readonly string[]): Record<string, unknown> {
  let out: Record<string, unknown> = item;
  if (fields && fields.length > 0) out = Object.fromEntries(fields.filter((f) => Object.hasOwn(item, f)).map((f) => [f, item[f]]));
  if (omit && omit.length > 0) out = Object.fromEntries(Object.entries(out).filter(([k]) => !omit.includes(k)));
  return out;
}

/** Items du dataset (de l'acteur : RLS) par lots ordonnés par `seq`, à partir de `afterSeq`. */
export async function* datasetItems(ctx: ServerContext, actor: Actor, q: ExportQuery): AsyncGenerator<{ seq: number; item: Record<string, unknown> }> {
  let after = q.afterSeq;
  let remaining = q.limit ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const batch = Math.min(EXPORT_BATCH, remaining);
    const rows = await withActor(ctx.pool, actor, async (db) =>
      (
        await db.query<{ seq: number; item: Record<string, unknown> }>(
          `SELECT seq, item FROM dataset_items WHERE dataset_id = $1 AND seq > $2 ${q.since ? 'AND created_at >= $4::timestamptz' : ''} ORDER BY seq LIMIT $3`,
          q.since ? [q.datasetId, after, batch, q.since] : [q.datasetId, after, batch],
        )
      ).rows,
    );
    for (const row of rows) yield { seq: row.seq, item: projectItem(row.item, q.fields, q.omit) };
    if (rows.length < batch) return;
    after = rows.at(-1)!.seq;
    remaining -= rows.length;
  }
}

/**
 * Reprise d'un export interrompu par `offset` (05 § 4.2, T3) : `seq` du `offset`-ième item après `afterSeq` (filtre `since`
 * compris), à partir duquel reprendre (exclu) ; un dataset terminé ne change plus, le compte des lignes complètes reçues
 * désigne donc le même item. Au-delà du dernier item : `Number.MAX_SAFE_INTEGER` (rien à servir).
 */
export async function seqAtOffset(ctx: ServerContext, actor: Actor, q: Pick<ExportQuery, 'datasetId' | 'afterSeq' | 'since'>, offset: number): Promise<number> {
  if (offset <= 0) return q.afterSeq;
  return withActor(ctx.pool, actor, async (db) => {
    const { rows } = await db.query<{ seq: number }>(
      `SELECT seq FROM dataset_items WHERE dataset_id = $1 AND seq > $2 ${q.since ? 'AND created_at >= $4::timestamptz' : ''} ORDER BY seq OFFSET $3 LIMIT 1`,
      q.since ? [q.datasetId, q.afterSeq, offset - 1, q.since] : [q.datasetId, q.afterSeq, offset - 1],
    );
    return rows[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  });
}

/** `seq` du dernier item d'une page de `limit` items après `afterSeq`, s'il en reste au-delà (curseur de suite). */
export async function pageEnd(ctx: ServerContext, actor: Actor, q: ExportQuery & { limit: number }): Promise<number | null> {
  return withActor(ctx.pool, actor, async (db) => {
    const { rows } = await db.query<{ seq: number }>(
      `SELECT seq FROM dataset_items WHERE dataset_id = $1 AND seq > $2 ${q.since ? 'AND created_at >= $4::timestamptz' : ''} ORDER BY seq OFFSET $3 LIMIT 2`,
      q.since ? [q.datasetId, q.afterSeq, q.limit - 1, q.since] : [q.datasetId, q.afterSeq, q.limit - 1],
    );
    // Deux lignes : la dernière de la page et au moins une après elle.
    return rows.length === 2 ? rows[0]!.seq : null;
  });
}
