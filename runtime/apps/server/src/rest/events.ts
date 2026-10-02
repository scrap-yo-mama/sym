// SPDX-License-Identifier: AGPL-3.0-only
// Flux SSE (tâche 3.1, 06 § 3, 05 § 4.2) : `GET /api/events` multiplexé (enquêtes, statuts, runs de l'utilisateur) et
// `GET /api/runs/{id}/events` (vue filtrée d'un run, rejouée depuis le début).
//
// Les événements viennent de tables PERSISTÉES, jamais d'une mémoire du processus : `investigation_events` (récit de
// l'enquête, source unique, 03), `status_events` (transitions, INV3) et `runs` (fins de run). La reprise par
// `Last-Event-ID` est donc exacte d'une connexion à l'autre et d'une instance à l'autre : l'identifiant de chaque trame
// est le curseur complet des trois sources (opaque). Toutes les lectures passent par `withActor` (RLS) : un utilisateur
// ne reçoit que ses événements (INV12). Les charges ne portent que des codes, des coûts et, pour `schema.proposed`, le
// schéma et l'échantillon de l'utilisateur (déjà les siens).
import { isTerminalRunState, type RunState } from '@runtime/core';
import { withActor } from '@runtime/db';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';
import { reasonMessage } from './shared.js';

export type SseFrame = { id: string; event: string; data: Record<string, unknown> };

/** Curseur du flux multiplexé : position dans chaque source (instants au texte exact de PostgreSQL). */
type FeedCursor = { i: [string, string, number]; s: string; r: [string, string] };

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const BATCH = 200;

function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...c })).toString('base64url');
}

const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Curseur lu dans `Last-Event-ID` ; null si absent ou illisible (le flux repart alors de maintenant). */
export function decodeFeedCursor(raw: string | undefined): FeedCursor | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<FeedCursor> & { v?: number };
    const i = v.i;
    const r = v.r;
    if (v.v !== 1 || !Array.isArray(i) || !Array.isArray(r) || typeof v.s !== 'string' || !/^\d{1,19}$/.test(v.s)) return null;
    if (!TS.test(String(i[0])) || !UUID.test(String(i[1])) || !Number.isInteger(i[2]) || !TS.test(String(r[0])) || !UUID.test(String(r[1]))) return null;
    return { i: [String(i[0]), String(i[1]), Number(i[2])], s: v.s, r: [String(r[0]), String(r[1])] };
  } catch {
    return null;
  }
}

type InvestigationRow = { run_id: string; seq: number; kind: string; payload: Record<string, unknown> | null; at_text: string; api_id: string; api_slug: string | null };
type StatusRow = { id: string; api_id: string; api_slug: string | null; from_status: string | null; to_status: string; reason: string | null; run_id: string | null; at: Date };
type FinishedRow = { id: string; api_id: string; api_slug: string | null; kind: string; state: RunState; outcome: string | null; failure_class: string | null; items: number; finished_text: string };

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Lecteur du flux multiplexé d'un utilisateur. Une source n'émet que ce qui est plus vieux que `lagMs` : une écriture
 * concurrente encore non validée, datée juste avant le curseur, n'est jamais sautée.
 */
export class UserFeed {
  #cursor: FeedCursor | null;
  private readonly ctx: ServerContext;
  private readonly actor: Actor;
  private readonly lagMs: number;

  constructor(ctx: ServerContext, actor: Actor, lastEventId: string | undefined, lagMs: number) {
    this.ctx = ctx;
    this.actor = actor;
    this.lagMs = lagMs;
    this.#cursor = decodeFeedCursor(lastEventId);
  }

  /** Trames nouvelles depuis le curseur (vide si rien), dans l'ordre de chaque source. */
  async poll(): Promise<SseFrame[]> {
    const lag = `${Math.max(0, this.lagMs)} milliseconds`;
    return withActor(this.ctx.pool, this.actor, async (db) => {
      if (this.#cursor === null) {
        // Première connexion : on part de maintenant (le journal d'une enquête se rejoue par /api/runs/{id}/events).
        const { rows } = await db.query<{ now: string; s: string }>(
          'SELECT now()::text AS now, coalesce((SELECT max(id) FROM status_events WHERE owner_id = $1), 0)::text AS s',
          [this.actor.userId],
        );
        const now = rows[0]!.now;
        this.#cursor = { i: [now, ZERO_UUID, 0], s: rows[0]!.s, r: [now, ZERO_UUID] };
        return [];
      }
      const c = this.#cursor;
      const frames: SseFrame[] = [];
      const inv = await db.query<InvestigationRow>(
        `SELECT e.run_id, e.seq, e.kind, e.payload, e.at::text AS at_text, r.api_id, a.slug AS api_slug
         FROM investigation_events e JOIN runs r ON r.id = e.run_id LEFT JOIN apis a ON a.id = r.api_id
         WHERE e.owner_id = $1 AND (e.at, e.run_id, e.seq) > ($2::timestamptz, $3::uuid, $4::int) AND e.at <= now() - $5::interval
         ORDER BY e.at, e.run_id, e.seq LIMIT ${BATCH}`,
        [this.actor.userId, c.i[0], c.i[1], c.i[2], lag],
      );
      for (const e of inv.rows) {
        c.i = [e.at_text, e.run_id, e.seq];
        frames.push({ id: encodeFeedCursor(c), event: e.kind, data: { ...asRecord(e.payload), run_id: e.run_id, api_id: e.api_id, api_slug: e.api_slug } });
      }
      const st = await db.query<StatusRow>(
        `SELECT se.id::text AS id, se.api_id, a.slug AS api_slug, se.from_status, se.to_status, se.reason, se.run_id, se.at
         FROM status_events se LEFT JOIN apis a ON a.id = se.api_id
         WHERE se.owner_id = $1 AND se.id > $2::bigint AND se.at <= now() - $3::interval ORDER BY se.id LIMIT ${BATCH}`,
        [this.actor.userId, c.s, lag],
      );
      for (const s of st.rows) {
        c.s = s.id;
        frames.push({
          id: encodeFeedCursor(c),
          event: 'status.changed',
          data: { api_id: s.api_id, api_slug: s.api_slug, status: s.to_status, from_status: s.from_status, status_reason: reasonMessage(s.reason), run_id: s.run_id, at: s.at.toISOString() },
        });
      }
      const fin = await db.query<FinishedRow>(
        `SELECT r.id, r.api_id, a.slug AS api_slug, r.kind, r.state, r.outcome, r.failure_class, r.items, r.finished_at::text AS finished_text
         FROM runs r LEFT JOIN apis a ON a.id = r.api_id
         WHERE r.owner_id = $1 AND r.finished_at IS NOT NULL AND (r.finished_at, r.id) > ($2::timestamptz, $3::uuid) AND r.finished_at <= now() - $4::interval
         ORDER BY r.finished_at, r.id LIMIT ${BATCH}`,
        [this.actor.userId, c.r[0], c.r[1], lag],
      );
      for (const r of fin.rows) {
        c.r = [r.finished_text, r.id];
        frames.push({ id: encodeFeedCursor(c), event: 'run.finished', data: runFinishedData(r) });
      }
      return frames;
    });
  }
}

const runFinishedData = (r: Pick<FinishedRow, 'id' | 'api_id' | 'api_slug' | 'kind' | 'state' | 'outcome' | 'failure_class' | 'items'>) => ({
  run_id: r.id,
  api_id: r.api_id,
  api_slug: r.api_slug,
  kind: r.kind,
  state: r.state,
  outcome: r.outcome,
  failure_class: r.failure_class,
  items: r.items,
});

/**
 * Lecteur du flux d'un run : son récit (`investigation_events`, identifiant = `seq`) depuis le début ou depuis
 * `Last-Event-ID`, puis une trame `run.finished` (identifiant `end`) quand le run est terminé ; le flux se clôt alors.
 */
export class RunFeed {
  #after: number;
  #done: boolean;
  #idlePolls = 0;

  private readonly ctx: ServerContext;
  private readonly actor: Actor;
  private readonly runId: string;

  constructor(ctx: ServerContext, actor: Actor, runId: string, lastEventId: string | undefined) {
    this.ctx = ctx;
    this.actor = actor;
    this.runId = runId;
    this.#done = lastEventId === 'end';
    this.#after = lastEventId !== undefined && /^\d{1,9}$/.test(lastEventId) ? Number(lastEventId) : -1;
  }

  get done(): boolean {
    return this.#done;
  }

  async poll(): Promise<SseFrame[]> {
    if (this.#done) return [];
    return withActor(this.ctx.pool, this.actor, async (db) => {
      const run = (
        await db.query<FinishedRow>(
          `SELECT r.id, r.api_id, a.slug AS api_slug, r.kind, r.state, r.outcome, r.failure_class, r.items, coalesce(r.finished_at, now())::text AS finished_text
           FROM runs r LEFT JOIN apis a ON a.id = r.api_id WHERE r.id = $1`,
          [this.runId],
        )
      ).rows[0];
      if (!run) {
        this.#done = true;
        return [];
      }
      const { rows } = await db.query<{ seq: number; kind: string; payload: Record<string, unknown> | null }>(
        `SELECT seq, kind, payload FROM investigation_events WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT ${BATCH}`,
        [this.runId, this.#after],
      );
      const frames: SseFrame[] = rows.map((e) => {
        this.#after = e.seq;
        return { id: String(e.seq), event: e.kind, data: { ...asRecord(e.payload), run_id: run.id, api_id: run.api_id, api_slug: run.api_slug } };
      });
      // Run terminé et plus rien à lire (deux relectures vides de suite : un événement écrit juste avant la fin est servi).
      if (rows.length === 0 && isTerminalRunState(run.state)) {
        this.#idlePolls += 1;
        if (this.#idlePolls >= 2) {
          this.#done = true;
          frames.push({ id: 'end', event: 'run.finished', data: runFinishedData(run) });
        }
      } else {
        this.#idlePolls = 0;
      }
      return frames;
    });
  }
}

/** Trame SSE (une seule ligne `data:` : JSON sans saut de ligne). */
export const sseFrame = (f: SseFrame): string => `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`;
