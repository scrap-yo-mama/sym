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

/** Au-delà de cette attente, un repère est servi même si une transaction plus ancienne reste ouverte (borne documentée). */
const FEED_MAX_HOLD_MS = 120_000;

/** Repère de visibilité : instant (horloge de PostgreSQL) et dernier identifiant de `status_events` alloué avant lui. */
type FeedMark = { t: string; b: string; takenAt: number };

/**
 * Lecteur du flux multiplexé d'un utilisateur, dans l'ORDRE DE VALIDATION. Les dates des sources sont posées au DÉBUT de
 * la transaction qui écrit (`investigation_events.at` et `runs.finished_at` valent `now()`, `status_events.id` vient
 * d'une séquence) : une transaction longue (clôture d'un run sur un gros dataset) peut valider APRÈS une autre, plus
 * récente, avec une date plus ancienne. Le flux sert donc par REPÈRES : à chaque relève, il note l'instant `t`
 * (`clock_timestamp()`, lu après le dernier identifiant `b` de la séquence) ; le repère n'est servi (lignes datées avant
 * `t`, identifiants jusqu'à `b`) qu'une fois TERMINÉES toutes les transactions ouvertes avant `t` (`pg_stat_activity`,
 * connexions clientes de la base). Aucune ligne n'est alors plus validable sous le curseur : la reprise par
 * `Last-Event-ID` est exacte. Bornes : les connexions d'un AUTRE rôle de connexion que celui du serveur ne sont pas
 * visibles (serveur et worker partagent `DATABASE_URL`, 14) ; une transaction encore ouverte `FEED_MAX_HOLD_MS` après le
 * repère ne le retient plus (ses événements restent lisibles par `GET /api/runs/{id}` et la chronologie des statuts).
 */
export class UserFeed {
  #cursor: FeedCursor | null;
  #mark: FeedMark | null = null;
  private readonly ctx: ServerContext;
  private actor: Actor;

  constructor(ctx: ServerContext, actor: Actor, lastEventId: string | undefined) {
    this.ctx = ctx;
    this.actor = actor;
    this.#cursor = decodeFeedCursor(lastEventId);
  }

  /** Identité relue pendant le flux (rôle à jour) : les lectures suivantes la prennent. */
  useActor(actor: Actor): void {
    this.actor = actor;
  }

  /**
   * Relève du repère (lecture système, hors `runtime_app` : `pg_stat_activity` ne montre les transactions des autres
   * connexions qu'au rôle de connexion) et, si un repère est en attente, s'il est désormais sûr.
   */
  async #observe(pending: FeedMark | null): Promise<{ next: FeedMark; safe: boolean }> {
    const b = (
      await this.ctx.pool.query<{ b: string }>("SELECT coalesce(pg_sequence_last_value(pg_get_serial_sequence('status_events', 'id')::regclass), 0)::text AS b")
    ).rows[0]!.b;
    const { rows } = await this.ctx.pool.query<{ t: string; safe: boolean }>(
      `SELECT clock_timestamp()::text AS t,
              NOT EXISTS (SELECT 1 FROM pg_stat_activity
                          WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
                            AND xact_start IS NOT NULL AND xact_start <= $1::timestamptz) AS safe`,
      [pending?.t ?? null],
    );
    const row = rows[0]!;
    const safe = pending !== null && (row.safe || Date.now() - pending.takenAt >= FEED_MAX_HOLD_MS);
    return { next: { t: row.t, b, takenAt: Date.now() }, safe };
  }

  /** Trames nouvelles depuis le curseur (vide si rien), dans l'ordre de chaque source. */
  async poll(): Promise<SseFrame[]> {
    const { next, safe } = await this.#observe(this.#mark);
    if (this.#cursor === null) {
      // Première connexion : on part de maintenant (le journal d'une enquête se rejoue par /api/runs/{id}/events).
      this.#cursor = { i: [next.t, ZERO_UUID, 0], s: next.b, r: [next.t, ZERO_UUID] };
      this.#mark = next;
      return [];
    }
    const mark = this.#mark;
    if (mark === null || !safe) {
      // Premier repère après une reprise, ou transaction plus ancienne encore ouverte : on attend.
      this.#mark ??= next;
      return [];
    }
    const c = this.#cursor;
    const out = await withActor(this.ctx.pool, this.actor, async (db) => {
      const frames: SseFrame[] = [];
      let full = false;
      const inv = await db.query<InvestigationRow>(
        `SELECT e.run_id, e.seq, e.kind, e.payload, e.at::text AS at_text, r.api_id, a.slug AS api_slug
         FROM investigation_events e JOIN runs r ON r.id = e.run_id LEFT JOIN apis a ON a.id = r.api_id
         WHERE e.owner_id = $1 AND (e.at, e.run_id, e.seq) > ($2::timestamptz, $3::uuid, $4::int) AND e.at < $5::timestamptz
         ORDER BY e.at, e.run_id, e.seq LIMIT ${BATCH}`,
        [this.actor.userId, c.i[0], c.i[1], c.i[2], mark.t],
      );
      full ||= inv.rows.length === BATCH;
      for (const e of inv.rows) {
        c.i = [e.at_text, e.run_id, e.seq];
        frames.push({ id: encodeFeedCursor(c), event: e.kind, data: { ...asRecord(e.payload), run_id: e.run_id, api_id: e.api_id, api_slug: e.api_slug } });
      }
      const st = await db.query<StatusRow>(
        `SELECT se.id::text AS id, se.api_id, a.slug AS api_slug, se.from_status, se.to_status, se.reason, se.run_id, se.at
         FROM status_events se LEFT JOIN apis a ON a.id = se.api_id
         WHERE se.owner_id = $1 AND se.id > $2::bigint AND se.id <= $3::bigint ORDER BY se.id LIMIT ${BATCH}`,
        [this.actor.userId, c.s, mark.b],
      );
      full ||= st.rows.length === BATCH;
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
         WHERE r.owner_id = $1 AND r.finished_at IS NOT NULL AND (r.finished_at, r.id) > ($2::timestamptz, $3::uuid) AND r.finished_at < $4::timestamptz
         ORDER BY r.finished_at, r.id LIMIT ${BATCH}`,
        [this.actor.userId, c.r[0], c.r[1], mark.t],
      );
      full ||= fin.rows.length === BATCH;
      for (const r of fin.rows) {
        c.r = [r.finished_text, r.id];
        frames.push({ id: encodeFeedCursor(c), event: 'run.finished', data: runFinishedData(r) });
      }
      return { frames, full };
    });
    // Repère épuisé : le suivant prend la relève ; sinon (lot plein) le même repère, toujours sûr, se vide au tour suivant.
    if (!out.full) this.#mark = next;
    return out.frames;
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
  private actor: Actor;
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

  /** Identité relue pendant le flux (rôle à jour) : les lectures suivantes la prennent. */
  useActor(actor: Actor): void {
    this.actor = actor;
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
/** Attente abandonnable : l'écouteur `abort` est retiré à l'expiration (un flux fait un tour toutes les pollMs, des heures). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Attend `drain` (contre-pression) ou l'abandon du flux, puis retire les deux écouteurs. */
export function waitDrain(out: { once(event: 'drain', fn: () => void): unknown; off(event: 'drain', fn: () => void): unknown }, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      out.off('drain', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    out.once('drain', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

export const sseFrame = (f: SseFrame): string => `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`;
