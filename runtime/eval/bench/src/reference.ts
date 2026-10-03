// SPDX-License-Identifier: AGPL-3.0-only
// Référence des règles de blocage (15 §11) : mise à jour À LA MAIN et datée (eval/reference.json), jamais à chaque merge.
// Le banc la lit, ne l'écrit jamais.
import { readFileSync } from 'node:fs';

interface ModelReference {
  /**
   * Réussite d'enquête N1 de référence : part des tâches réussies au moins `repeatMinPass` fois sur `repeat` (2 sur 3), et par
   * tâche 1 (réussie) ou 0, lue comme le rapport N1 (report.ts, `investigation.tasks`).
   */
  investigation_rate: number;
  per_task: Record<string, number>;
  /** Taux de réparation conforme N2 de référence (casses injectées). */
  repair_rate: number | null;
  cost_median_usd: number | null;
}

export interface Reference {
  date: string;
  updated_by: 'manual';
  note?: string;
  models: Record<string, ModelReference>;
}

const REFERENCE_FILE = new URL('../../reference.json', import.meta.url);

export function readReference(file: URL = REFERENCE_FILE): Reference {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Reference;
  if (value.updated_by !== 'manual' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new Error('eval/reference.json : référence datée et mise à jour à la main attendue');
  return value;
}
