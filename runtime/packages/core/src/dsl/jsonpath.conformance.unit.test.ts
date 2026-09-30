// SPDX-License-Identifier: AGPL-3.0-only
// Suite de conformité officielle RFC 9535 (jsonpath-compliance-test-suite, BSD-2-Clause, voir conformance/SOURCE.md),
// exécutée contre l'interpréteur DURCI (mêmes bornes qu'en production), pas contre la bibliothèque brute.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DslError } from './errors.js';
import { compileJsonPath, queryNodes } from './jsonpath.js';
import { DEFAULT_DSL_LIMITS } from './limits.js';

interface CtsTest {
  name: string;
  selector: string;
  document?: unknown;
  result?: unknown[];
  result_paths?: string[];
  results?: unknown[][];
  results_paths?: string[][];
  invalid_selector?: boolean;
  tags?: string[];
}

const cts = JSON.parse(readFileSync(new URL('./conformance/cts.json', import.meta.url), 'utf8')) as { tests: CtsTest[] };
const limits = { ...DEFAULT_DSL_LIMITS, maxDepth: 64 };

describe('RFC 9535 : suite de conformité officielle', () => {
  it('la suite est présente et complète', () => {
    expect(cts.tests.length).toBeGreaterThan(650);
  });

  for (const t of cts.tests) {
    it(t.name, () => {
      if (t.invalid_selector === true) {
        expect(() => compileJsonPath(t.selector)).toThrow(DslError);
        return;
      }
      const nodes = queryNodes(t.selector, t.document, { limits });
      const values = nodes.map((n) => n.value);
      const paths = nodes.map((n) => n.path);
      if (t.results !== undefined) {
        const i = t.results.findIndex((r) => JSON.stringify(r) === JSON.stringify(values));
        expect(i, 'aucune des réponses valides ne correspond').toBeGreaterThanOrEqual(0);
        if (t.results_paths !== undefined) expect(paths).toEqual(t.results_paths[i]);
      } else {
        expect(values).toEqual(t.result);
        if (t.result_paths !== undefined) expect(paths).toEqual(t.result_paths);
      }
    });
  }
});
