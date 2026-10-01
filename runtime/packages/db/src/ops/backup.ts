// SPDX-License-Identifier: AGPL-3.0-only
// Date de dernière sauvegarde DÉCLARÉE (14 § 7, `runtime doctor`). Le runtime ne lance pas `pg_dump` : la sauvegarde
// est à la charge de l'utilisateur (14 § 8) ; il note seulement qu'elle a été faite, pour que `doctor` la rappelle.
import type pg from 'pg';

export const LAST_BACKUP_SETTING = 'last_backup_at';

type Queryable = Pick<pg.ClientBase, 'query'>;

export class BackupDeclarationError extends Error {
  override name = 'BackupDeclarationError';
}

/** Enregistre la sauvegarde déclarée. Refuse une date future (déclaration d'avance = fausse assurance). */
export async function declareBackup(db: Queryable, at: Date, now: Date = new Date()): Promise<{ at: Date }> {
  if (Number.isNaN(at.getTime())) throw new BackupDeclarationError('date de sauvegarde illisible (format ISO 8601 attendu, ex. 2026-10-01T08:30:00Z).');
  if (at.getTime() > now.getTime() + 60_000) throw new BackupDeclarationError('date de sauvegarde dans le futur : refusée.');
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [LAST_BACKUP_SETTING, JSON.stringify({ at: at.toISOString() })],
  );
  return { at };
}

export async function readBackupDeclaration(db: Queryable): Promise<Date | null> {
  const { rows } = await db.query<{ value: { at?: unknown } }>('SELECT value FROM settings WHERE key = $1', [LAST_BACKUP_SETTING]);
  const raw = rows[0]?.value?.at;
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}
