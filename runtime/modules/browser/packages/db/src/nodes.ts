// SPDX-License-Identifier: AGPL-3.0-only
// État d'un nœud écrit par le nœud lui-même (04b § 9) : `draining` à SIGTERM (la passerelle l'écarte du choix), `down` à la
// sortie. Le retour à `ready` passe par le battement (`recordHeartbeat`), jamais par ici.
import type pg from 'pg';

export async function markNodeState(db: Pick<pg.ClientBase, 'query'>, input: { nodeId: string; state: 'draining' | 'down' }): Promise<boolean> {
  const { rowCount } = await db.query(
    input.state === 'down' ? "UPDATE nodes SET state = 'down', slots_free = 0 WHERE id = $1" : "UPDATE nodes SET state = 'draining' WHERE id = $1 AND state <> 'down'",
    [input.nodeId],
  );
  return (rowCount ?? 0) > 0;
}

