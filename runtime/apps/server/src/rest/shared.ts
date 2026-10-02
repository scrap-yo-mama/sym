// SPDX-License-Identifier: AGPL-3.0-only
// Briques communes de l'API REST (tâche 3.1, 05 § 2 et § 4.3), réutilisables par le serveur MCP (3.2) : montants,
// codes de raison, file pleine, attente synchrone bornée, déclencheur, case « j'ai lu » (17 § 11).
import { ACTIVE_RUN_STATES, schemaHasPersonalFields, type RunTrigger } from '@runtime/core';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';
import { sendError } from '../routes/guard.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Un montant `numeric(12,6)` en nombre, arrondi au micro-dollar. */
export const usd = (v: string | number | null | undefined): number => Math.round(Number(v ?? 0) * 1e6) / 1e6;
/** Montant qui peut être inconnu (prix LLM absent, 08 § 1) : null reste null, jamais 0. */
export const usdOrNull = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : usd(v));

const REASON_CODE = /^[a-z][a-z0-9_]*$/;

/** Code de raison stable (06 § 4.2) au format `ReasonMessage` ; jamais une phrase, jamais un texte du site. */
export function reasonMessage(code: string | null | undefined): { code: string; params: Record<string, string | number> } | null {
  return typeof code === 'string' && REASON_CODE.test(code) && code.length <= 64 ? { code, params: {} } : null;
}

export const iso = (d: Date | string | null | undefined): string | null => (d === null || d === undefined ? null : new Date(d).toISOString());

/** Déclencheur d'un run créé par l'API : `ui` pour la console (session), `rest` pour une clé d'API. */
export const triggerOf = (actor: Actor): RunTrigger => (actor.via === 'ui' ? 'ui' : 'rest');

/** Fenêtre de la limite par clé d'API (08b § 3). */
const KEY_WINDOW_SECONDS = 60;

/**
 * Limite par clé d'API (08b § 3) : au-delà de `MAX_RUNS_PER_KEY_PER_MINUTE` créations sur une fenêtre d'une minute ouverte
 * par la première, 429 `key_rate_limited` avec `Retry-After` (fin de la fenêtre). Compteur PARTAGÉ en PostgreSQL
 * (`run_creation_counters`, une ligne par clé, mise à jour atomique) : plusieurs instances du serveur et un redémarrage
 * voient le même. Toute demande compte, refusée ou non. Sans clé (session de la console) : rien. Renvoie true si la
 * réponse est partie.
 */
export async function rejectIfKeyRateLimited(ctx: ServerContext, reply: FastifyReply, actor: Actor): Promise<boolean> {
  if (!actor.apiKey) return false;
  const bucket = `key:${actor.apiKey.id}`;
  const { rows } = await ctx.pool.query<{ hits: number; retry: number }>(
    `INSERT INTO run_creation_counters AS c (bucket, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN c.window_start <= now() - make_interval(secs => $2) THEN 1 ELSE c.hits + 1 END,
       window_start = CASE WHEN c.window_start <= now() - make_interval(secs => $2) THEN now() ELSE c.window_start END
     RETURNING hits, greatest(1, ceil(extract(epoch FROM window_start + make_interval(secs => $2) - now())))::int AS retry`,
    [bucket, KEY_WINDOW_SECONDS],
  );
  // Fenêtres échues des autres clés : purgées au passage (table bornée par le nombre de clés actives).
  await ctx.pool.query('DELETE FROM run_creation_counters WHERE window_start < now() - interval \'1 hour\' AND bucket <> $1', [bucket]);
  const row = rows[0]!;
  if (row.hits <= ctx.rest.maxRunsPerKeyPerMinute) return false;
  reply.header('retry-after', String(row.retry));
  await sendError(reply, 429, 'key_rate_limited', 'trop de runs lancés par cette clé dans la minute : réessayez après le délai indiqué (Retry-After)');
  return true;
}

/** Plafond atteint à la création d'un run (`reserveRunSlot`) : 429 avec `Retry-After`, aucun run créé. */
export class RunSlotError extends Error {
  override name = 'RunSlotError';
  readonly code: 'user_queue_full' | 'queue_full';

  constructor(code: 'user_queue_full' | 'queue_full') {
    super(code);
    this.code = code;
  }
}

/**
 * Plafonds par utilisateur et par instance (05 § 4.3, 08b § 3), vérifiés ATOMIQUEMENT avec l'insertion : à appeler en
 * PREMIER dans la transaction (sous l'acteur, `withActor`) qui crée ou reprend le run. La fonction `reserve_run_slot`
 * prend un verrou consultatif de transaction : deux créations simultanées ne voient jamais la même place libre.
 * 1. par utilisateur : `MAX_ACTIVE_RUNS_PER_USER` runs actifs (hors pause) lancés par l'acteur → `user_queue_full` (un
 *    membre ne remplit pas la file des autres) ;
 * 2. par instance : `MAX_CONCURRENT_RUNS` runs actifs (hors pause) → `queue_full`.
 * Lève `RunSlotError` (la transaction est annulée).
 */
export async function reserveRunSlot(tx: Queryable, ctx: ServerContext): Promise<void> {
  const { rows } = await tx.query<{ verdict: string }>('SELECT reserve_run_slot($1::text[], $2, $3) AS verdict', [ACTIVE_RUN_STATES, ctx.rest.maxActiveRunsPerUser, ctx.rest.maxConcurrentRuns]);
  const verdict = rows[0]?.verdict;
  if (verdict === 'user_queue_full' || verdict === 'queue_full') throw new RunSlotError(verdict);
}

/** Réponse 429 d'un plafond atteint (`RunSlotError`). */
export async function sendRunSlotError(reply: FastifyReply, error: RunSlotError): Promise<FastifyReply> {
  reply.header('retry-after', '30');
  return error.code === 'user_queue_full'
    ? sendError(reply, 429, 'user_queue_full', 'trop de runs en cours pour ce compte : réessayez après le délai indiqué (Retry-After)')
    : sendError(reply, 429, 'queue_full', 'file pleine : réessayez après le délai indiqué (Retry-After)');
}

/** Attente demandée (`?wait=` ou `wait_seconds`), bornée par `MAX_WAIT_SECONDS` ; 0 par défaut en REST. */
export function waitSecondsOf(ctx: ServerContext, ...candidates: (number | undefined)[]): number {
  const wanted = candidates.find((c) => typeof c === 'number' && Number.isFinite(c)) ?? 0;
  return Math.max(0, Math.min(ctx.rest.maxWaitSeconds, Math.floor(wanted)));
}

/** Version de la page « Usage responsable » dont la lecture est enregistrée (`responsible_use_acks`, 17 § 11). */
export const RESPONSIBLE_USE_VERSION = '2026-10-01';

/** L'utilisateur a coché « j'ai lu » pour la version courante de la page « Usage responsable ». */
async function responsibleUseAcked(ctx: ServerContext, userId: string): Promise<boolean> {
  const { rowCount } = await ctx.pool.query('SELECT 1 FROM responsible_use_acks WHERE user_id = $1 AND version = $2', [userId, RESPONSIBLE_USE_VERSION]);
  return (rowCount ?? 0) > 0;
}

/**
 * 17 § 11 (critère 2 de 4.8) : sans la case « j'ai lu », une API à champ `x-personal` est refusée (403
 * `responsible_use_ack_required`). `schema` : schéma retenu ; `true` : le schéma n'est pas encore connu (validation
 * automatique d'une enquête), refusé de même. Renvoie true si la réponse est partie.
 */
export async function rejectWithoutAck(ctx: ServerContext, reply: FastifyReply, actor: Actor, schema: unknown | true): Promise<boolean> {
  if (schema !== true && !schemaHasPersonalFields(schema)) return false;
  if (await responsibleUseAcked(ctx, actor.userId)) return false;
  await sendError(reply, 403, 'responsible_use_ack_required', 'lisez la page « Usage responsable » et cochez « j’ai lu » avant une API à données personnelles');
  return true;
}

/** Statut de l'API qui interdit un run (05 § 4.3). `enquete` : la stratégie n'est pas encore là. */
export const BLOCKING_STATUS: Record<string, { code: string; message: string }> = {
  erreur: { code: 'api_error', message: 'API en erreur : relancez une enquête (investigate) avant de l’appeler' },
  action_requise: { code: 'action_required', message: 'action requise : connectez le site, configurez le proxy ou réglez l’accès payant, puis relancez' },
  bloquee: { code: 'blocked', message: 'API bloquée par le site : informez l’utilisateur et ne réessayez pas' },
  enquete: { code: 'investigation_in_progress', message: 'enquête en cours : aucune stratégie validée pour l’instant' },
};
