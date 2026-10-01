// SPDX-License-Identifier: AGPL-3.0-only
// Écriture de `run_logs` (INV4, INV8, RGPD) : les filtres de masquage (secrets, puis données personnelles : e-mails,
// téléphones, valeurs `x-personal` connues du processus) s'appliquent avant l'insertion, jamais après.
import {
  maskPersonal,
  maskPersonalText,
  personalValues,
  secretValues,
  type PersonalValueRegistry,
  type SecretValueRegistry,
} from '@runtime/core';
import type pg from 'pg';

export type RunLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type RunLogEntry = { runId: string; seq: number; ownerId: string; level: RunLogLevel; event: string; data?: unknown };

export async function appendRunLog(
  db: Pick<pg.ClientBase, 'query'>,
  entry: RunLogEntry,
  registry: SecretValueRegistry = secretValues,
  personal: PersonalValueRegistry = personalValues,
): Promise<void> {
  const data = entry.data === undefined ? null : JSON.stringify(maskPersonal(entry.data, personal, registry));
  await db.query('INSERT INTO run_logs (run_id, seq, owner_id, level, event, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [
    entry.runId,
    entry.seq,
    entry.ownerId,
    entry.level,
    maskPersonalText(registry.redactText(entry.event), personal),
    data,
  ]);
}
