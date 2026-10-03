// SPDX-License-Identifier: AGPL-3.0-only
// assert_stagehand_selfheal_off (tâche 2.13, 19 §4 « Compilation, règles, moteur ») : Stagehand sert à E6 avec
// `selfHeal: false` EXPLICITE (défaut de 3.7.3 : vrai, constaté dans dist/esm/lib/v3/v3.js, `this.opts.selfHeal ?? true`)
// et sans `cacheDir` (aucun cache d'actions rejouées hors de notre compilation E6 → E5, aucune reprise silencieuse).
import { describe, expect, test } from 'vitest';
import { assertStagehandLocalOnly } from './stagehand-guards.js';
import { STAGEHAND_VERSION, stagehandConstructorOptions } from './stagehand-engine.js';

describe('assert_stagehand_selfheal_off', () => {
  const options = stagehandConstructorOptions({ modelId: 'zz-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'zz_test_key', cdpUrl: 'ws://127.0.0.1:2/devtools', middleware: {} as never });
  test('selfHeal vaut false, explicitement', () => {
    expect(Object.prototype.hasOwnProperty.call(options, 'selfHeal')).toBe(true);
    expect((options as { selfHeal?: unknown }).selfHeal).toBe(false);
  });
  test('cacheDir absent', () => {
    expect('cacheDir' in options).toBe(false);
  });
  test('mode local seulement, version épinglée', () => {
    expect(() => assertStagehandLocalOnly(options as unknown as Record<string, unknown>, {})).not.toThrow();
    expect(options.env).toBe('LOCAL');
    expect(STAGEHAND_VERSION).toBe('3.7.3');
  });
});
