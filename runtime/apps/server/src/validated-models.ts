// SPDX-License-Identifier: AGPL-3.0-only
// Statut « modèle validé » (15 § 11, tâche 2.8), en lecture seule dans Réglages LLM : copie de eval/validated-models.json,
// produit par `pnpm eval --level N2` et embarqué dans l'image (/app/eval/validated-models.json). Relu à chaque lecture des
// réglages (fichier de quelques Kio). Seule la DERNIÈRE mesure de chaque modèle est servie. Un fichier absent, illisible
// ou hors forme donne une liste vide : aucun modèle n'est alors « validé » (jamais une erreur du service).
import { readFileSync } from 'node:fs';

export interface ValidatedModel {
  model_id: string;
  date: string;
  status: 'validated' | 'not_validated';
  level: 'N2';
  blocking_rules: string[];
}

/** Même profondeur depuis src/ (dépôt) et dist/ (image) : <racine>/eval/validated-models.json. */
export const DEFAULT_VALIDATED_MODELS_FILE = new URL('../../../eval/validated-models.json', import.meta.url);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function entry(value: unknown): ValidatedModel | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const rules = v['blocking_rules'] ?? [];
  if (typeof v['model_id'] !== 'string' || v['model_id'] === '' || v['model_id'].length > 200) return null;
  if (typeof v['date'] !== 'string' || !DATE.test(v['date'])) return null;
  if (v['status'] !== 'validated' && v['status'] !== 'not_validated') return null;
  if (v['level'] !== 'N2') return null;
  if (!Array.isArray(rules) || !rules.every((r) => typeof r === 'string')) return null;
  return { model_id: v['model_id'], date: v['date'], status: v['status'], level: 'N2', blocking_rules: [...(rules as string[])] };
}

export function readValidatedModels(file: URL | string = DEFAULT_VALIDATED_MODELS_FILE): ValidatedModel[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const models = (raw as { version?: unknown; models?: unknown } | null)?.models;
  if ((raw as { version?: unknown } | null)?.version !== 1 || !Array.isArray(models)) return [];
  const parsed = models.map(entry);
  if (parsed.some((m) => m === null)) return [];
  const latest = new Map<string, ValidatedModel>();
  for (const m of parsed as ValidatedModel[]) {
    const seen = latest.get(m.model_id);
    if (seen === undefined || m.date > seen.date) latest.set(m.model_id, m);
  }
  return [...latest.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
}
