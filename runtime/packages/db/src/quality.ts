// SPDX-License-Identifier: AGPL-3.0-only
// Profils des runs et avis du juge (tâche 2.12, 19 §3, migration 0020) : écrits et lus comme le propriétaire (RLS, INV12).
// Le profil appartient au RUN (revue 2.12, comme la quarantaine D-49) : `owner_id` = `runs.owner_id`. Quand B exécute
// une API de A partagée avec l'instance, le profil (et son top-k, tiré des données de B) est à B : A ne le lit pas, et la
// mémoire du catalogue de A ne voit que les profils de ses propres runs. La baseline est validée par le propriétaire de
// l'API SEUL, sur l'un de ses propres runs (r4 R3 : `promote_api`, ou confirmation après `test_api`, tâche 3.14) ; un
// retour « ce champ est faux » sort le run de la baseline. Les runs de B n'ont donc pas de baseline : seuls les contrôles
// absolus (constante, sentinelles, doublons) s'y appliquent. L'avis du juge ne touche que `runs.judge` (et le coût du
// run, INV4) : jamais le statut, la version courante, le schéma ni une règle.
import { createHash } from 'node:crypto';
import type { JobQueue, QueueDefinition, RunJudge, RunProfile } from '@runtime/core';
import type pg from 'pg';
import { withActor } from './rls.js';

/** File du jugement sur anomalie d'un rejeu (19 §3) : un job par run, après sa clôture. */
export const JUDGE_QUEUE = 'quality-judge';
export type RunJudgeJob = { readonly run_id: string; readonly owner_id: string };

export function judgeQueueDefinition(): QueueDefinition {
  // `short` : un seul job en attente par clé (le run) ; quelques reprises si le run n'est pas encore clos.
  return { name: JUDGE_QUEUE, expireInSeconds: 300, heartbeatSeconds: 30, retryLimit: 3, policy: 'short', deleteAfterSeconds: 7 * 86_400 };
}

/** Planifie le jugement sur anomalie d'un run ; `null` : un job attend déjà pour ce run (doublon écarté). */
export async function scheduleRunJudge(queue: JobQueue, args: { runId: string; ownerId: string }): Promise<string | null> {
  return queue.enqueueOnce<RunJudgeJob>(JUDGE_QUEUE, { run_id: args.runId, owner_id: args.ownerId }, { singletonKey: `judge:${args.runId}`, startAfterSeconds: 1 });
}

/** Empreinte stable de l'entrée d'un run (clés triées) : la baseline compare des runs à même `input_hash`. */
export function inputHash(input: unknown): string {
  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (typeof v === 'object' && v !== null) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
  };
  return createHash('sha256').update(canon(input)).digest('hex');
}

export async function saveRunProfile(pool: pg.Pool, args: { runId: string; apiId: string; ownerId: string; strategyVersion: number | null; inputHash: string; profile: RunProfile }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    await tx.query(
      `INSERT INTO run_profiles (run_id, api_id, owner_id, strategy_version, input_hash, profile) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (run_id) DO UPDATE SET profile = EXCLUDED.profile`,
      [args.runId, args.apiId, args.ownerId, args.strategyVersion, args.inputHash, JSON.stringify(args.profile)],
    );
    await tx.query('UPDATE runs SET quality = $2::jsonb WHERE id = $1', [args.runId, JSON.stringify(args.profile)]);
  });
}

/**
 * Item de la baseline validée à même entrée, pour l'échantillon du juge (19 §3) : le premier item du run validé, lu comme
 * le propriétaire ; `null` si aucune baseline ou si son run a été purgé.
 */
export async function readBaselineItem(pool: pg.Pool, args: { apiId: string; ownerId: string; inputHash: string }): Promise<unknown> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ item: unknown }>(
      `SELECT i.item FROM run_profiles p JOIN runs r ON r.id = p.run_id AND r.owner_id = $2
         JOIN dataset_items i ON i.dataset_id = r.dataset_id AND i.owner_id = $2
       WHERE p.api_id = $1 AND p.owner_id = $2 AND p.input_hash = $3 AND p.baseline
       ORDER BY p.validated_at DESC, i.seq LIMIT 1`,
      [args.apiId, args.ownerId, args.inputHash],
    );
    return rows[0]?.item ?? null;
  });
}

/** Dernière baseline validée à même entrée ; `null` : aucune (les motifs comparatifs restent inactifs). */
export async function readValidatedBaseline(pool: pg.Pool, args: { apiId: string; ownerId: string; inputHash: string }): Promise<RunProfile | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ profile: RunProfile }>(
      'SELECT profile FROM run_profiles WHERE api_id = $1 AND owner_id = $2 AND input_hash = $3 AND baseline ORDER BY validated_at DESC LIMIT 1',
      [args.apiId, args.ownerId, args.inputHash],
    );
    return rows[0]?.profile ?? null;
  });
}

/** Acte humain : le profil d'un run devient baseline (le propriétaire de l'API seulement, sur l'un de ses runs). */
export async function validateBaseline(pool: pg.Pool, args: { runId: string; ownerId: string; userId: string }): Promise<void> {
  await withActor(pool, { userId: args.userId, role: 'member' }, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE run_profiles p SET baseline = true, validated_by = $3, validated_at = now()
       WHERE p.run_id = $1 AND p.owner_id = $2 AND p.owner_id = $3
         AND EXISTS (SELECT 1 FROM apis a WHERE a.id = p.api_id AND a.owner_id = $2)`,
      [args.runId, args.ownerId, args.userId],
    );
    if (rowCount !== 1) throw new Error('profil introuvable pour ce propriétaire');
  });
}

/** Retour « ce champ est faux » : le run sort de la baseline. */
export async function excludeFromBaseline(pool: pg.Pool, args: { runId: string; ownerId: string }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, (tx) => tx.query('UPDATE run_profiles SET baseline = false, validated_by = NULL, validated_at = NULL WHERE run_id = $1 AND owner_id = $2', [args.runId, args.ownerId]));
}

/** Avis consultatif sur la fiche du run ; coût du jugement imputé au run (INV4). Rien d'autre ne change. */
export async function saveRunJudge(pool: pg.Pool, args: { runId: string; ownerId: string; judge: RunJudge; costUsd: number | null; tokens?: { in: number; cached: number; out: number; reasoning: number } }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, (tx) =>
    tx.query(
      `UPDATE runs SET judge = $2::jsonb, cost_llm_usd = cost_llm_usd + coalesce($3::numeric, 0),
         tokens_in = tokens_in + $4, tokens_cached = tokens_cached + $5, tokens_out = tokens_out + $6, tokens_reasoning = tokens_reasoning + $7,
         usage_estimated = usage_estimated OR $3::numeric IS NULL
       WHERE id = $1 AND owner_id = $8`,
      [args.runId, JSON.stringify({ ...args.judge, at: new Date().toISOString() }), args.costUsd, args.tokens?.in ?? 0, args.tokens?.cached ?? 0, args.tokens?.out ?? 0, args.tokens?.reasoning ?? 0, args.ownerId],
    ),
  );
}

/** Date du dernier jugement sur anomalie de l'API (au plus un par API et par jour). */
export async function lastAnomalyJudgedAt(pool: pg.Pool, args: { apiId: string; ownerId: string }): Promise<Date | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ at: string | null }>(
      `SELECT max(judge ->> 'at') AS at FROM runs WHERE api_id = $1 AND owner_id = $2 AND judge ->> 'trigger' = 'anomaly'`,
      [args.apiId, args.ownerId],
    );
    return rows[0]?.at === null || rows[0]?.at === undefined ? null : new Date(rows[0].at);
  });
}

/** Run, items et schéma pour un jugement (job séparé, après le run) : lus comme le propriétaire. */
export async function readRunForJudge(pool: pg.Pool, args: { runId: string; ownerId: string }): Promise<{ apiId: string; outputSchema: unknown; items: unknown[]; profile: RunProfile | null; state: string; input: unknown } | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ api_id: string; output_schema: unknown; dataset_id: string | null; quality: RunProfile | null; state: string; input: unknown }>(
      'SELECT r.api_id, a.output_schema, r.dataset_id, r.quality, r.state, r.input FROM runs r JOIN apis a ON a.id = r.api_id WHERE r.id = $1 AND r.owner_id = $2',
      [args.runId, args.ownerId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const items = r.dataset_id === null ? [] : (await tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1 ORDER BY seq LIMIT 100', [r.dataset_id])).rows.map((x) => x.item);
    return { apiId: r.api_id, outputSchema: r.output_schema, items, profile: r.quality, state: r.state, input: r.input };
  });
}
