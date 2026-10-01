// SPDX-License-Identifier: AGPL-3.0-only
// Écriture du dataset d'un run (tâche 2.5, 08 § 5 : `dedup_key`, `diff`, `new_items`).
// - Un dataset par run, créé au premier appel et complété aux suivants (pagination, lots).
// - `dedup_key` de la planification d'origine : les clés vues pour l'API vivent dans `dedup_keys` (empreinte HMAC sous la
//   clé des sujets, jamais la valeur en clair, 17 § 6). Une clé absente de `dedup_keys` = item nouveau ; une clé déjà
//   écrite par ce même run (dans son dataset, quel que soit l'appel ou la tentative) = doublon, écarté.
// - Les clés ne sont INSCRITES qu'au succès du run (`commitRunDedupKeys`, dans la transaction de `finishRunAndNotify`),
//   à partir de `dataset_items.dedup_key` du dataset du run. Pendant le run, `appendRunItems` ne fait que les consulter
//   (et rafraîchir `last_seen` des clés déjà connues, revues sur le site). Un run qui écrit des pages puis échoue
//   (extraction, budget, worker perdu, annulation) ne marque donc rien comme vu : le run réussi suivant livre et annonce
//   ces nouveautés. `datasets.new_items` est provisoire pendant le run, définitif à la clôture : c'est lui qui alimente
//   `new_items` et `items.new`. Deux runs concurrents qui voient la même nouveauté : le premier qui réussit l'inscrit
//   et la compte ; le second l'a écrite (elle était nouvelle à son passage) mais ne la compte plus.
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
  // Clés déjà écrites par ce run (appels ou tentatives précédents) : doublons.
  const used = dedupKey === null ? new Set<string>() : await writtenKeys(tx, datasetId, input.hashKey);

  for (let start = 0; start < input.items.length; start += CHUNK) {
    const chunk = input.items.slice(start, start + CHUNK);
    const values = chunk.map((item) => (dedupKey === null ? null : dedupValue(item, dedupKey)));
    const hashes = values.map((v) => (v === null ? null : dedupKeyHash(input.hashKey, v)));
    // Clés déjà vues pour l'API (inscrites par un run réussi) : consultées, `last_seen` rafraîchi, jamais inscrites ici.
    const keyed = [...new Set(hashes.filter((h): h is string => h !== null && !used.has(h)))];
    const known = new Set<string>();
    if (keyed.length > 0) {
      const seen = await tx.query<{ key_hash: string }>(
        'UPDATE dedup_keys SET last_seen = now() WHERE api_id = $1 AND key_hash = ANY($2::text[]) RETURNING key_hash',
        [run.api_id, keyed],
      );
      for (const r of seen.rows) known.add(r.key_hash);
    }

    const out: { seq: number; item: string; size: number; key: string | null }[] = [];
    chunk.forEach((item, i) => {
      const hash = hashes[i] ?? null;
      let fresh = true;
      if (hash !== null) {
        if (used.has(hash)) {
          skipped += 1; // doublon de clé dans ce run
          return;
        }
        used.add(hash);
        fresh = !known.has(hash);
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

/** Empreintes des clés de déduplication écrites dans un dataset (`dataset_items.dedup_key`, valeur en clair). */
async function writtenKeys(tx: Queryable, datasetId: string, hashKey: Buffer): Promise<Set<string>> {
  const { rows } = await tx.query<{ dedup_key: string }>('SELECT DISTINCT dedup_key FROM dataset_items WHERE dataset_id = $1 AND dedup_key IS NOT NULL', [
    datasetId,
  ]);
  return new Set(rows.map((r) => dedupKeyHash(hashKey, r.dedup_key)));
}

/**
 * Inscription des clés de déduplication d'un run RÉUSSI (à appeler dans la transaction qui le clôt, après `finishRun`) :
 * chaque `dedup_key` écrite dans le dataset du run entre dans `dedup_keys` (empreinte HMAC). `datasets.new_items`
 * devient définitif : items sans clé + clés que ce run est le premier à inscrire (une clé inscrite entre-temps par un run
 * concurrent réussi n'est plus nouvelle). Sans effet si le run n'a pas réussi, n'a pas de dataset ou pas de `dedup_key`.
 * Identité système (le propriétaire des clés est celui du run, qui est aussi celui de l'API : sinon pas de dédup).
 * `hashKey` : clé des sujets (`loadSubjectKey`), exigée dès qu'il y a des clés à inscrire.
 */
export async function commitRunDedupKeys(tx: Queryable, runId: string, hashKey: Buffer | undefined): Promise<{ inserted: number; newItems: number } | null> {
  const { rows } = await tx.query<RunRow & { state: string; dataset_id: string | null }>(
    `SELECT r.api_id, r.owner_id, r.project_id, r.api_owner_id, r.state, d.id AS dataset_id, s.rules
     FROM runs r LEFT JOIN schedules s ON s.id = r.schedule_id LEFT JOIN datasets d ON d.id = r.dataset_id AND d.run_id = r.id
     WHERE r.id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run || run.state !== 'succeeded' || run.dataset_id === null || run.rules === null || run.rules === undefined) return null;
  const parsed = parseScheduleRules(run.rules);
  if (!parsed.ok || parsed.rules.dedup_key === null || run.owner_id !== run.api_owner_id) return null;

  const items = await tx.query<{ dedup_key: string | null; n: number }>(
    'SELECT dedup_key, count(*)::int AS n FROM dataset_items WHERE dataset_id = $1 GROUP BY dedup_key',
    [run.dataset_id],
  );
  const unkeyed = items.rows.find((r) => r.dedup_key === null)?.n ?? 0;
  const values = items.rows.flatMap((r) => (r.dedup_key === null ? [] : [r.dedup_key]));
  let inserted = 0;
  if (values.length > 0) {
    if (hashKey === undefined) throw new Error(`run ${runId} : clé des sujets requise pour inscrire ses clés de déduplication`);
    const hashes = [...new Set(values.map((v) => dedupKeyHash(hashKey, v)))];
    for (let start = 0; start < hashes.length; start += CHUNK) {
      const up = await tx.query<{ inserted: boolean }>(
        `INSERT INTO dedup_keys (api_id, key_hash, owner_id, project_id, last_seen, last_run_id)
         SELECT $1, k, $2, $3, now(), $4 FROM unnest($5::text[]) AS k
         ON CONFLICT (api_id, key_hash) DO UPDATE SET last_seen = EXCLUDED.last_seen, last_run_id = EXCLUDED.last_run_id
         RETURNING (xmax = 0) AS inserted`,
        [run.api_id, run.owner_id, run.project_id, runId, hashes.slice(start, start + CHUNK)],
      );
      inserted += up.rows.filter((r) => r.inserted).length;
    }
  }
  const newItems = unkeyed + inserted;
  await tx.query('UPDATE datasets SET new_items = $2 WHERE id = $1', [run.dataset_id, newItems]);
  return { inserted, newItems };
}
