// SPDX-License-Identifier: AGPL-3.0-only
// Écriture du dataset d'un run (tâche 2.5, 08 § 5 : `dedup_key`, `diff`, `new_items`).
// - Un dataset par run, créé au premier appel et complété aux suivants (pagination, lots).
// - `dedup_key` de la planification d'origine : chaque clé est inscrite dans `dedup_keys` (empreinte HMAC sous la clé des
//   sujets, jamais la valeur en clair, 17 § 6), par API. Une clé jamais vue = item nouveau ; une clé déjà vue par ce même
//   run = doublon, écarté. `datasets.new_items` cumule les nouveautés : c'est lui qui alimente `new_items` et `items.new`.
// - `diff: new` : seuls les items nouveaux sont écrits ; `diff: all` (ou absent) : tout est écrit, nouveautés comptées.
//   Un item sans valeur de clé (champ absent, vide ou non scalaire) est écrit et compté nouveau : il ne peut pas être jugé.
// - Run d'un membre sur l'API d'instance d'un autre : les clés de l'API appartiennent à son propriétaire (RLS) ; pas de
//   dédup (aucune fuite de ce que l'autre a vu), tout est écrit, `new_items` inconnu.
// Identité : celle de l'appelant (le worker écrit sous `withActor` avec le propriétaire du run).
import { dedupKeyHash, parseScheduleRules } from '@runtime/core';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Lignes par requête (tableaux `unnest`) : borne la taille d'une requête. */
const CHUNK = 500;

export type AppendRunItemsInput = {
  runId: string;
  items: readonly unknown[];
  /** Clé des sujets de l'instance (`loadSubjectKey`) : l'empreinte des clés de déduplication. */
  hashKey: Buffer;
};

/** Bilan de CET appel (le dataset, lui, cumule : `item_count`, `new_items`). */
export type AppendRunItemsResult = {
  datasetId: string;
  written: number;
  /** Items dont la clé n'avait jamais été vue pour l'API ; `null` sans `dedup_key` (rien n'est jugé). */
  newItems: number | null;
  /** Items écartés : déjà vus (`diff: new`) ou doublons de clé dans le même run. */
  skipped: number;
};

/** Valeur de la clé de déduplication d'un item (`url`, `item.url`) : chaîne non vide ou nombre fini, sinon `null`. */
export function dedupValue(item: unknown, path: string): string | null {
  let current: unknown = item;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === 'string') return current.trim() === '' ? null : current;
  if (typeof current === 'number' && Number.isFinite(current)) return String(current);
  return null;
}

type RunRow = { api_id: string; owner_id: string; project_id: string; api_owner_id: string; rules: unknown };

export async function appendRunItems(tx: Queryable, input: AppendRunItemsInput): Promise<AppendRunItemsResult> {
  const { rows } = await tx.query<RunRow>(
    `SELECT r.api_id, r.owner_id, r.project_id, r.api_owner_id, s.rules
     FROM runs r LEFT JOIN schedules s ON s.id = r.schedule_id WHERE r.id = $1`,
    [input.runId],
  );
  const run = rows[0];
  if (!run) throw new Error(`run ${input.runId} introuvable`);
  const parsed = run.rules === null || run.rules === undefined ? null : parseScheduleRules(run.rules);
  const rules = parsed?.ok ? parsed.rules : null;
  const dedupKey = rules !== null && run.owner_id === run.api_owner_id ? rules.dedup_key : null;
  const onlyNew = dedupKey !== null && rules?.diff === 'new';

  const datasetId = await runDataset(tx, input.runId, run);
  const last = await tx.query<{ seq: number | null }>('SELECT max(seq) AS seq FROM dataset_items WHERE dataset_id = $1', [datasetId]);
  let seq = last.rows[0]?.seq ?? 0;
  let written = 0;
  let newItems = 0;
  let skipped = 0;
  let bytes = 0;

  for (let start = 0; start < input.items.length; start += CHUNK) {
    const chunk = input.items.slice(start, start + CHUNK);
    const values = chunk.map((item) => (dedupKey === null ? null : dedupValue(item, dedupKey)));
    const hashes = values.map((v) => (v === null ? null : dedupKeyHash(input.hashKey, v)));
    // Clé → nouvelle (jamais vue pour l'API) ou déjà vue ; absente du résultat = déjà inscrite par ce même run.
    const status = new Map<string, boolean>();
    const keyed = [...new Set(hashes.filter((h): h is string => h !== null))];
    if (keyed.length > 0) {
      const up = await tx.query<{ key_hash: string; inserted: boolean }>(
        `INSERT INTO dedup_keys (api_id, key_hash, owner_id, project_id, last_seen, last_run_id)
         SELECT $1, k, $2, $3, now(), $4 FROM unnest($5::text[]) AS k
         ON CONFLICT (api_id, key_hash) DO UPDATE SET last_seen = EXCLUDED.last_seen, last_run_id = EXCLUDED.last_run_id
           WHERE dedup_keys.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id
         RETURNING key_hash, (xmax = 0) AS inserted`,
        [run.api_id, run.owner_id, run.project_id, input.runId, keyed],
      );
      for (const r of up.rows) status.set(r.key_hash, r.inserted);
    }

    const out: { seq: number; item: string; size: number; key: string | null }[] = [];
    const used = new Set<string>();
    chunk.forEach((item, i) => {
      const hash = hashes[i] ?? null;
      let fresh = true;
      if (hash !== null) {
        const known = status.get(hash);
        if (known === undefined || used.has(hash)) {
          skipped += 1; // doublon de clé dans ce run
          return;
        }
        used.add(hash);
        fresh = known;
      }
      if (fresh) newItems += 1;
      if (onlyNew && !fresh) {
        skipped += 1;
        return;
      }
      const json = JSON.stringify(item ?? null);
      seq += 1;
      out.push({ seq, item: json, size: Buffer.byteLength(json), key: values[i] ?? null });
    });
    if (out.length > 0) {
      await tx.query(
        `INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, project_id, item, size_bytes, dedup_key)
         SELECT $1, s, $2, $3, $4, i::jsonb, b, k FROM unnest($5::int[], $6::text[], $7::int[], $8::text[]) AS t(s, i, b, k)`,
        [datasetId, input.runId, run.owner_id, run.project_id, out.map((o) => o.seq), out.map((o) => o.item), out.map((o) => o.size), out.map((o) => o.key)],
      );
      written += out.length;
      bytes += out.reduce((sum, o) => sum + o.size, 0);
    }
  }

  await tx.query('UPDATE datasets SET item_count = item_count + $2, bytes = bytes + $3, new_items = new_items + $4 WHERE id = $1', [
    datasetId,
    written,
    bytes,
    dedupKey === null ? 0 : newItems,
  ]);
  return { datasetId, written, newItems: dedupKey === null ? null : newItems, skipped };
}

/** Le dataset du run (verrouillé : deux appels concurrents du même run n'en créent pas deux). */
async function runDataset(tx: Queryable, runId: string, run: RunRow): Promise<string> {
  await tx.query('SELECT 1 FROM runs WHERE id = $1 FOR UPDATE', [runId]);
  const found = await tx.query<{ id: string }>('SELECT id FROM datasets WHERE run_id = $1 ORDER BY created_at LIMIT 1', [runId]);
  if (found.rows[0]) return found.rows[0].id;
  const created = await tx.query<{ id: string }>('INSERT INTO datasets (api_id, run_id, owner_id, project_id) VALUES ($1, $2, $3, $4) RETURNING id', [
    run.api_id,
    runId,
    run.owner_id,
    run.project_id,
  ]);
  return created.rows[0]!.id;
}
