// SPDX-License-Identifier: AGPL-3.0-only
// Instantané des métriques de la passerelle (cdc/sym-browser 04d § 3.1, tâche 3.7), lu à chaque collecte de `/metrics` :
// sessions par état et type, longueur de la file (sessions `pending` sans nœud, 04b § 7), nœuds vivants (battement de
// moins de 15 s et non `down`, 04b § 6). Aucun identifiant de session ni de client ne sort d'ici.
import type pg from 'pg';
import { NODE_LOST_AFTER_MS } from './sessions.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type GatewaySnapshot = {
  sessions: { state: string; type: string; count: number }[];
  queueLength: number;
  nodes: { id: string; up: boolean }[];
};

export async function gatewaySnapshot(db: Queryable): Promise<GatewaySnapshot> {
  const [sessions, queue, nodes] = await Promise.all([
    db.query<{ state: string; type: string; count: number }>('SELECT state, type, count(*)::int AS count FROM sessions GROUP BY state, type'),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM sessions WHERE state = 'pending' AND node_id IS NULL"),
    db.query<{ id: string; up: boolean }>(
      "SELECT id, (state <> 'down' AND last_beat_at > now() - make_interval(secs => $1::float8 / 1000)) AS up FROM nodes ORDER BY id",
      [NODE_LOST_AFTER_MS],
    ),
  ]);
  return { sessions: sessions.rows, queueLength: queue.rows[0]?.n ?? 0, nodes: nodes.rows };
}
