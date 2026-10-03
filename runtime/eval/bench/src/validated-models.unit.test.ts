// SPDX-License-Identifier: AGPL-3.0-only
// Statut « modèle validé » (15 §11) : un couple (model_id, date) est validé quand N2 ne déclenche aucune règle de blocage,
// sinon « non validé ». Fichier versionné eval/validated-models.json, lu par Réglages LLM ; un modèle jamais mesuré est
// « non validé ».
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import { type BenchRecord } from './records.ts';
import { buildReport } from './report.ts';
import { verdict } from './rules.ts';
import { modelValidation, nextValidatedModels, VALIDATED_MODELS_SCHEMA, type ValidatedModels } from './validated-models.ts';

const record = (model: string, success: boolean, repetition: number, extra: Partial<BenchRecord> = {}): BenchRecord => ({
  level: 'N2',
  model_id: model,
  task_id: 'T-api_json',
  kind: 'investigation',
  repetition,
  success,
  false_success: false,
  level_retained: success ? 'E1' : null,
  level_e_min: 'E1',
  cost_usd: 0.01,
  inv_violations: [],
  ...extra,
});

const EMPTY: ValidatedModels = { version: 1, generated_by: 'pnpm eval --level N2', models: [] };

describe('eval/validated-models.json', () => {
  test('le fichier versionné est conforme à son schéma', () => {
    const file = JSON.parse(readFileSync(new URL('../../validated-models.json', import.meta.url), 'utf8')) as unknown;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    expect(ajv.validate(VALIDATED_MODELS_SCHEMA, file), JSON.stringify(ajv.errors)).toBe(true);
  });

  test('N2 sans règle de blocage → validé ; avec un faux succès → non validé, règle citée', () => {
    const records = [
      ...Array.from({ length: 10 }, (_, i) => record('zz-model-ok', true, i)),
      ...Array.from({ length: 10 }, (_, i) => record('zz-model-ko', true, i, i === 0 ? { false_success: true } : {})),
    ];
    const report = buildReport(records, { date: '2026-10-02' });
    const next = nextValidatedModels(EMPTY, report, verdict(report, undefined));
    expect(next.models).toEqual([
      { model_id: 'zz-model-ko', date: '2026-10-02', status: 'not_validated', level: 'N2', blocking_rules: ['false_success'] },
      { model_id: 'zz-model-ok', date: '2026-10-02', status: 'validated', level: 'N2', blocking_rules: [] },
    ]);
    expect(modelValidation(next, 'zz-model-ok')).toEqual({ status: 'validated', date: '2026-10-02' });
    expect(modelValidation(next, 'zz-model-ko')).toEqual({ status: 'not_validated', date: '2026-10-02' });
  });

  test('contrat IA 2.8 — un modèle jamais mesuré est « non validé »', () => {
    expect(modelValidation(EMPTY, 'zz-jamais-mesure')).toEqual({ status: 'not_validated', date: null });
  });

  test('seul un rapport N2 produit le statut ; la dernière mesure d’un modèle remplace la précédente', () => {
    const n1 = buildReport([record('zz-model-ok', true, 0, { level: 'N1' })], { date: '2026-10-02' });
    expect(() => nextValidatedModels(EMPTY, n1, verdict(n1, undefined))).toThrow(/N2/);
    const before: ValidatedModels = { ...EMPTY, models: [{ model_id: 'zz-model-ok', date: '2026-09-01', status: 'not_validated', level: 'N2', blocking_rules: ['false_success'] }] };
    const report = buildReport(Array.from({ length: 10 }, (_, i) => record('zz-model-ok', true, i)), { date: '2026-10-02' });
    const next = nextValidatedModels(before, report, verdict(report, undefined));
    expect(next.models).toHaveLength(1);
    expect(modelValidation(next, 'zz-model-ok')).toEqual({ status: 'validated', date: '2026-10-02' });
  });
});
