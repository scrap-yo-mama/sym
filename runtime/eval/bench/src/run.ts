// SPDX-License-Identifier: AGPL-3.0-only
// Exécution d'un niveau du banc : tâches d'enquête, mutations de réparation et corpus d'injection, répétés selon le niveau,
// puis rapport par modèle, règles de blocage contre la référence datée, et fichiers du job CI (records.jsonl, report.json,
// report.md). Le coureur intégré joue N0 ; N1 et N2 passent par promptfoo (promptfoo-run.ts), qui appelle les mêmes cas.
import { mkdirSync, writeFileSync } from 'node:fs';
import { BENCH_TASKS, LEVELS, REPAIR_MUTATIONS, injectionCases, taskById } from './catalog.ts';
import type { BenchHarness } from './harness.ts';
import type { BenchLevel, BenchRecord } from './records.ts';
import type { Reference } from './reference.ts';
import { buildReport, renderMarkdown, type BenchReport } from './report.ts';
import { verdict, type Verdict } from './rules.ts';

export interface BenchRun {
  records: BenchRecord[];
  report: BenchReport;
  verdict: Verdict;
}

/** Identifiants de tous les cas d'un niveau : T-* (enquête), R-* (réparation), I-* (injection). */
function caseIds(): string[] {
  return [...BENCH_TASKS.map((t) => t.id), ...REPAIR_MUTATIONS.map((m) => `R-${m.id}`), ...injectionCases().map((c) => `I-${c.technique}`)];
}

/** Suffixe des cas du corpus d'injection joués avec un modèle obéissant (N0). */
const OBEDIENT = '_obedient';

/** Cas d'un niveau : N1 sur fixtures figées (enquête, injection) ; N0 et N2 avec les mutations de réparation. N0 joue en plus le
 * corpus d'injection avec un modèle OBÉISSANT (`I-<technique>_obedient`, faux fournisseur seulement). */
export function casesFor(level: BenchLevel): string[] {
  if (level === 'N0') return [...caseIds(), ...injectionCases().map((c) => `I-${c.technique}${OBEDIENT}`)];
  return LEVELS[level].sites === 'fixtures' ? caseIds().filter((id) => !id.startsWith('R-')) : caseIds();
}

/** Un cas, une répétition : c'est aussi ce que sert le point d'accès appelé par promptfoo. */
export async function runCase(harness: BenchHarness, id: string, level: BenchLevel, repetition: number): Promise<BenchRecord> {
  if (id.startsWith('T-')) return harness.runInvestigation(taskById(id), level, repetition);
  if (id.startsWith('R-')) {
    const mutation = REPAIR_MUTATIONS.find((m) => `R-${m.id}` === id);
    if (mutation === undefined) throw new Error(`mutation inconnue : ${id}`);
    return harness.runRepair(mutation, level, repetition);
  }
  const obedient = id.endsWith(OBEDIENT);
  const entry = injectionCases().find((c) => `I-${c.technique}` === (obedient ? id.slice(0, -OBEDIENT.length) : id));
  if (entry === undefined) throw new Error(`cas du banc inconnu : ${id}`);
  return harness.runInjection(entry, level, repetition, { obedient });
}

export function finishRun(records: BenchRecord[], options: { outDir: URL; date: string; reference?: Reference}): BenchRun {
  const report = buildReport(records, { date: options.date });
  const result = verdict(report, options.reference);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(new URL('records.jsonl', options.outDir), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(new URL('report.json', options.outDir), `${JSON.stringify({ ...report, verdict: result }, null, 2)}\n`);
  writeFileSync(new URL('report.md', options.outDir), renderMarkdown(report, result));
  return { records, report, verdict: result };
}

/** Coureur intégré (N0) : chaque cas, `LEVELS[level].repeat` fois, l'un après l'autre (fixtures remises à zéro par cas). */
export async function runBench(harness: BenchHarness, options: { level: BenchLevel; outDir: URL; date: string; reference?: Reference}): Promise<BenchRun> {
  const records: BenchRecord[] = [];
  for (let repetition = 0; repetition < LEVELS[options.level].repeat; repetition++) {
    for (const id of casesFor(options.level)) records.push(await runCase(harness, id, options.level, repetition));
  }
  return finishRun(records, options);
}
