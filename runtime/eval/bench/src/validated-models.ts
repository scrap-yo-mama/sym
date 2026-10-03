// SPDX-License-Identifier: AGPL-3.0-only
// Statut « modèle validé » (15 §11) : le produit est BYO. Un couple (model_id, date) est « validé » quand N2 ne déclenche
// aucune règle de blocage, sinon « non validé ». eval/validated-models.json est versionné, produit par `pnpm eval --level
// N2`, affiché en lecture seule dans Réglages LLM ; un modèle absent du fichier (jamais mesuré) est « non validé ».
import type { BenchReport } from './report.ts';
import type { Verdict } from './rules.ts';

interface ValidatedModel {
  model_id: string;
  date: string;
  status: 'validated' | 'not_validated';
  level: 'N2';
  blocking_rules: string[];
}

export interface ValidatedModels {
  version: 1;
  generated_by: 'pnpm eval --level N2';
  models: ValidatedModel[];
}

export const VALIDATED_MODELS_FILE = new URL('../../validated-models.json', import.meta.url);

export const VALIDATED_MODELS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'generated_by', 'models'],
  properties: {
    version: { const: 1 },
    generated_by: { const: 'pnpm eval --level N2' },
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['model_id', 'date', 'status', 'level', 'blocking_rules'],
        properties: {
          model_id: { type: 'string', minLength: 1, maxLength: 200 },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          status: { enum: ['validated', 'not_validated'] },
          level: { const: 'N2' },
          blocking_rules: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/** Fichier suivant : la mesure N2 de chaque modèle remplace la précédente ; les autres modèles sont conservés. */
export function nextValidatedModels(previous: ValidatedModels, report: BenchReport, result: Verdict): ValidatedModels {
  if (report.level !== 'N2') throw new Error(`le statut « modèle validé » ne vient que d’un rapport N2 (reçu : ${report.level})`);
  const measured = result.models.map(
    (m): ValidatedModel => ({
      model_id: m.model_id,
      date: report.date,
      status: m.blocking.length === 0 ? 'validated' : 'not_validated',
      level: 'N2',
      blocking_rules: [...new Set(m.blocking.map((f) => f.rule))].sort(),
    }),
  );
  const kept = previous.models.filter((m) => !measured.some((x) => x.model_id === m.model_id));
  return { version: 1, generated_by: 'pnpm eval --level N2', models: [...kept, ...measured].sort((a, b) => a.model_id.localeCompare(b.model_id)) };
}

/** Statut d'un modèle configuré : « validé » seulement si sa dernière mesure N2 l'est ; jamais mesuré → « non validé ». */
export function modelValidation(file: ValidatedModels, modelId: string): { status: 'validated' | 'not_validated'; date: string | null } {
  const entry = file.models.filter((m) => m.model_id === modelId).sort((a, b) => b.date.localeCompare(a.date))[0];
  return entry === undefined ? { status: 'not_validated', date: null } : { status: entry.status, date: entry.date };
}
