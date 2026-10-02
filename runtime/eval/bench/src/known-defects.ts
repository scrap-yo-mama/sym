// SPDX-License-Identifier: AGPL-3.0-only
// Défauts du produit constatés par le banc (eval/known-defects.json) : datés, rattachés à la tâche qui les traite. Ils restent
// bloquants dans le rapport et pour le statut « modèle validé » (un défaut du produit n'est pas une qualité du modèle) ; la
// porte CI ne s'arrête que sur un constat bloquant NOUVEAU. La liste ne masque rien : N0 échoue si un défaut connu ne se
// reproduit plus (il faut le retirer) ou si un constat bloquant n'y figure pas.
import { readFileSync } from 'node:fs';
import type { RuleId } from './rules.ts';

export interface KnownDefect {
  task_id: string;
  rule: RuleId;
  since: string;
  owner_task: string;
  detail: string;
}

const KNOWN_DEFECTS_FILE = new URL('../../known-defects.json', import.meta.url);

export function readKnownDefects(file: URL = KNOWN_DEFECTS_FILE): KnownDefect[] {
  const value = JSON.parse(readFileSync(file, 'utf8')) as { defects: KnownDefect[] };
  for (const d of value.defects) {
    if (!/^[TRI]-[a-z0-9_]+$/.test(d.task_id) || !/^\d{4}-\d{2}-\d{2}$/.test(d.since) || !/^\d+\.\d+$/.test(d.owner_task) || d.detail.length < 20) {
      throw new Error(`eval/known-defects.json : entrée invalide (${JSON.stringify(d)}) : cas, date, tâche propriétaire et constat requis`);
    }
  }
  return value.defects;
}
