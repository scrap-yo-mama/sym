// SPDX-License-Identifier: AGPL-3.0-only
// Récit d'une enquête (`investigation_events`, 03 : source unique du SSE, de la progression MCP et du replay), écrit
// comme le propriétaire (RLS, INV12). Étape 0 (tâche 1.11, migration 0012) : l'événement `access_report` précède tout
// essai, et un rapport qui arrête l'enquête (robots.txt interdit ou injoignable, 402) interdit tout essai ensuite ;
// la base le refuse (`AccessReportFirstError`), quel que soit l'appelant (`assert_access_report_first`).
import type pg from 'pg';
import { withActor } from './rls.js';

export const ACCESS_REPORT_EVENT = 'access_report';

/** Essai ou reconnaissance refusé : aucun rapport d'accès antérieur, ou un rapport qui arrête l'enquête. */
export class AccessReportFirstError extends Error {
  readonly code = 'access_report_first';
  constructor(message: string) {
    super(message);
    this.name = 'AccessReportFirstError';
  }
}

export type InvestigationEvent = { readonly seq: number; readonly kind: string; readonly payload: unknown; readonly at: Date };

const isAccessReportFirst = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { constraint?: unknown }).constraint === 'investigation_events_access_report_first';

/**
 * Ajoute un événement au récit d'une enquête (numéro suivant, sous verrou du run), comme le propriétaire du run.
 * Lève `AccessReportFirstError` si la base refuse un essai avant le rapport d'accès.
 */
export async function appendInvestigationEvent(
  pool: pg.Pool,
  event: { readonly runId: string; readonly ownerId: string; readonly kind: string; readonly payload?: unknown },
): Promise<{ seq: number }> {
  if (event.kind.length === 0 || event.kind.length > 64) throw new Error('investigation_events.kind : 1 à 64 caractères');
  try {
    return await withActor(pool, { userId: event.ownerId, role: 'member' }, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1101))', [event.runId]);
      const { rows } = await tx.query<{ seq: number }>(
        `INSERT INTO investigation_events (run_id, seq, owner_id, project_id, kind, payload)
         SELECT r.id, COALESCE((SELECT max(e.seq) FROM investigation_events e WHERE e.run_id = r.id), 0) + 1, $2, r.project_id, $3, $4::jsonb
           FROM runs r WHERE r.id = $1 AND r.owner_id = $2
         RETURNING seq`,
        [event.runId, event.ownerId, event.kind, JSON.stringify(event.payload ?? {})],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('run introuvable pour ce propriétaire');
      return { seq: row.seq };
    });
  } catch (error) {
    if (isAccessReportFirst(error)) throw new AccessReportFirstError((error as Error).message);
    throw error;
  }
}

/** Inscrit le rapport d'accès (étape 0) : charge `accessReportEventPayload(report)` (verdict obligatoire). */
export function recordAccessReport(pool: pg.Pool, args: { readonly runId: string; readonly ownerId: string; readonly payload: Record<string, unknown> }): Promise<{ seq: number }> {
  return appendInvestigationEvent(pool, { runId: args.runId, ownerId: args.ownerId, kind: ACCESS_REPORT_EVENT, payload: args.payload });
}

/** Récit d'une enquête dans l'ordre, lu comme le propriétaire. */
export async function listInvestigationEvents(pool: pg.Pool, args: { readonly runId: string; readonly ownerId: string }): Promise<InvestigationEvent[]> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ seq: number; kind: string; payload: unknown; at: Date }>(
      'SELECT seq, kind, payload, at FROM investigation_events WHERE run_id = $1 ORDER BY seq',
      [args.runId],
    );
    return rows;
  });
}
