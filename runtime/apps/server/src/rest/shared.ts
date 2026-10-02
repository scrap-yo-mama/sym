// SPDX-License-Identifier: AGPL-3.0-only
// Briques communes de l'API REST (tâche 3.1, 05 § 2 et § 4.3), réutilisables par le serveur MCP (3.2) : montants,
// codes de raison, file pleine, attente synchrone bornée, déclencheur, case « j'ai lu » (17 § 11).
import { ACTIVE_RUN_STATES, schemaHasPersonalFields, type RunTrigger } from '@runtime/core';
import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';
import { sendError } from '../routes/guard.js';

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

/**
 * File pleine (05 § 4.3) : au-delà de `MAX_CONCURRENT_RUNS` runs actifs (hors pause) sur l'instance, 429 `queue_full` et
 * `Retry-After`. Comptage système : il ne lit que des états, jamais du contenu. Renvoie true si la réponse est partie.
 */
export async function rejectIfQueueFull(ctx: ServerContext, reply: FastifyReply): Promise<boolean> {
  const { rows } = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM runs WHERE state = ANY($1::text[]) AND paused_at IS NULL', [ACTIVE_RUN_STATES]);
  if ((rows[0]?.n ?? 0) < ctx.rest.maxConcurrentRuns) return false;
  reply.header('retry-after', '30');
  await sendError(reply, 429, 'queue_full', 'file pleine : réessayez après le délai indiqué (Retry-After)');
  return true;
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
