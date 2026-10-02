// SPDX-License-Identifier: AGPL-3.0-only
// Banc N1 et N2 (15 §11) avec le fournisseur BYO : `pnpm eval --level N1|N2` (EVAL_LLM_CONFIG, fichier hors du dépôt ;
// « demander d'abord » avant toute clé réelle, 10-taches). Ignoré sans EVAL_LEVEL = N1 ou N2 : la CI de PR ne joue que N0.
// promptfoo (image épinglée, réseau Docker interne) répète chaque cas ; le harnais joue le produit sur le miroir local. Seule
// destination hors de l'instance : l'hôte du fournisseur. N2 met à jour eval/validated-models.json.
import { lookup } from 'node:dns/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BENCH_TASKS, LEVELS } from './catalog.ts';
import { observeEgress } from './egress.ts';
import { createBenchHarness } from './harness.ts';
import { readKnownDefects } from './known-defects.ts';
import { modelsUnderTest, readEvalLlmFile } from './llm-config.ts';
import { runPromptfooJob } from './promptfoo-run.ts';
import type { BenchRecord } from './records.ts';
import { readReference } from './reference.ts';
import { casesFor, finishRun, runCase } from './run.ts';
import { nextValidatedModels, VALIDATED_MODELS_FILE, type ValidatedModels } from './validated-models.ts';

const LEVEL = process.env['EVAL_LEVEL'];

describe.skipIf(LEVEL !== 'N1' && LEVEL !== 'N2')(`banc ${LEVEL ?? ''} (fournisseur BYO)`, () => {
  test('rapport par modèle, règles de blocage contre la référence datée, seule sortie : le fournisseur', async () => {
    const level = LEVEL as 'N1' | 'N2';
    const all = modelsUnderTest(readEvalLlmFile(process.env['EVAL_LLM_CONFIG']), process.env);
    // N1 : modèle par défaut (le premier) ; N2 : tous les modèles déclarés.
    const models = level === 'N1' ? all.slice(0, 1) : all;
    const allowed = new Set<string>();
    for (const m of models) for (const a of await lookup(m.providerHost, { all: true })) allowed.add(a.address);
    const egress = observeEgress();
    const records: BenchRecord[] = [];
    const descriptions = Object.fromEntries(BENCH_TASKS.map((t) => [t.id, t.description]));
    try {
      for (const model of models) {
        const harness = await createBenchHarness({ llm: { kind: 'real', config: model.config, modelId: model.modelId } });
        try {
          const job = await runPromptfooJob({ level, models: [model.modelId], cases: casesFor(level), descriptions, repeat: LEVELS[level].repeat, runCase: (id) => runCase(harness, id, level, 0) });
          expect(job.network.internal).toBe(true);
          records.push(...job.records);
        } finally {
          await harness.close();
        }
      }
    } finally {
      egress.stop();
    }
    expect(egress.nonLocal().filter((c) => !allowed.has(c.address))).toEqual([]);
    const date = new Date().toISOString().slice(0, 10);
    const run = finishRun(records, { outDir: new URL(`../../results/${level.toLowerCase()}/`, import.meta.url), date, reference: readReference(), known: readKnownDefects() });
    if (level === 'N2') {
      const previous = JSON.parse(readFileSync(VALIDATED_MODELS_FILE, 'utf8')) as ValidatedModels;
      writeFileSync(VALIDATED_MODELS_FILE, `${JSON.stringify(nextValidatedModels(previous, run.report, run.verdict), null, 2)}\n`);
    }
    expect(run.verdict.blocked_new, readFileSync(new URL(`../../results/${level.toLowerCase()}/report.md`, import.meta.url), 'utf8')).toBe(false);
  }, 6 * 3_600_000);
});
