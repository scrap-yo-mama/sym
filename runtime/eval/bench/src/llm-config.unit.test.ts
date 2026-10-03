// SPDX-License-Identifier: AGPL-3.0-only
// Configuration BYO du banc N1 à N3 : la clé vient d'une variable nommée, n'apparaît dans aucun message d'erreur (INV8).
import { describe, expect, test } from 'vitest';
import { modelsUnderTest, readEvalLlmFile, type EvalLlmFile } from './llm-config.ts';

const FILE: EvalLlmFile = {
  providers: [{ id: 'zz_prov', base_url: 'https://llm.zz-test.example/v1', api_key_env: 'ZZ_TEST_EVAL_KEY', models: [{ id: 'zz-model-a', price: { in: 1, out: 2 } }, { id: 'zz-model-b' }] }],
  models: [
    { provider: 'zz_prov', model: 'zz-model-a' },
    { provider: 'zz_prov', model: 'zz-model-b' },
  ],
};

describe('modelsUnderTest', () => {
  test('un modèle par entrée, rôles investigate, extract et repair sur ce modèle, hôte du fournisseur relevé', () => {
    const models = modelsUnderTest(FILE, { ZZ_TEST_EVAL_KEY: 'zz-test-secret-0001' });
    expect(models.map((m) => [m.modelId, m.providerHost])).toEqual([
      ['zz-model-a', 'llm.zz-test.example'],
      ['zz-model-b', 'llm.zz-test.example'],
    ]);
    expect(models[0]!.config.roles).toEqual({ investigate: { provider: 'zz_prov', model: 'zz-model-a' }, extract: { provider: 'zz_prov', model: 'zz-model-a' }, repair: { provider: 'zz_prov', model: 'zz-model-a' } });
    expect(JSON.stringify(models)).not.toContain('zz-test-secret-0001');
  });

  test('erreurs lisibles, sans la clé', () => {
    expect(() => readEvalLlmFile(undefined)).toThrow(/EVAL_LLM_CONFIG/);
    expect(() => modelsUnderTest(FILE, {})).toThrow(/ZZ_TEST_EVAL_KEY/);
    expect(() => modelsUnderTest({ ...FILE, models: [{ provider: 'autre', model: 'x' }] }, { ZZ_TEST_EVAL_KEY: 'k' })).toThrow(/fournisseur inconnu/);
    expect(() => modelsUnderTest({ ...FILE, models: [] }, {})).toThrow(/au moins un modèle/);
  });
});
