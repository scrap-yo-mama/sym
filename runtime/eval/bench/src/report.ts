// SPDX-License-Identifier: AGPL-3.0-only
// Rapport CI du banc, par modèle (critère de fin de 2.8) : réussite d'enquête (IC de Wilson), « moins cher atteint », pass^3,
// fausses réparations, réparations par casse injectée ou subie, corpus d'injection (tentatives, blocages, exfiltrations
// séparés), coût médian. Pas de seuil de PASS sans intervalle : chaque taux est publié avec son IC et ses effectifs bruts.
import { LEVELS, levelRank } from './catalog.ts';
import type { BenchLevel, BenchRecord } from './records.ts';
import type { Verdict } from './rules.ts';
import { median, passHatK, wilson, type Interval } from './stats.ts';

interface RepairStats {
  n: number;
  repaired_conform: number;
  repaired_nonconform: number;
  not_repaired: number;
  /** IC de Wilson du taux de réparation conforme. */
  ci: Interval;
}

interface TaskStats {
  n: number;
  success: number;
  rate: number | null;
  cheapest_n: number;
  cheapest_reached: number;
  false_successes: number;
  /** Règle par tâche du niveau (N1 : au moins `repeatMinPass` réussites sur `repeat`) ; null si le niveau n'en déclare pas. */
  passed: boolean | null;
}

export interface ModelReport {
  model_id: string;
  investigation: {
    n: number;
    success: number;
    rate: number | null;
    ci: Interval;
    /** Tâches d'enquête qui passent la règle par tâche du niveau (N1, 15 §11 : 2 réussites sur 3) ; null hors N1. */
    tasks: { n: number; passed: number; rate: number | null; min_pass: number; repeat: number } | null;
  };
  cheapest: { n: number; reached: number; rate: number | null };
  /** Moyenne de pass^3 sur les tâches d'enquête jouées au moins 3 fois ; null sinon. */
  pass3: number | null;
  false_successes: number;
  false_repairs: number;
  /** Cas avec au moins un faux succès (sortie livrée non conforme à la référence, réparée ou non). */
  false_success_tasks: string[];
  repairs: { injected: RepairStats; suffered: RepairStats };
  injection: { cases: number; attempts: number; blocked: number; exfiltrations: number };
  cost_median_usd: number | null;
  inv_violations: Record<string, string[]>;
  per_task: Record<string, TaskStats>;
}

export interface BenchReport {
  date: string;
  level: BenchLevel;
  models: ModelReport[];
}

function repairStats(records: readonly BenchRecord[]): RepairStats {
  const count = (outcome: BenchRecord['repair']): number => records.filter((r) => r.repair === outcome).length;
  const conform = count('repaired_conform');
  return { n: records.length, repaired_conform: conform, repaired_nonconform: count('repaired_nonconform'), not_repaired: count('not_repaired'), ci: wilson(conform, records.length) };
}

function modelReport(model: string, records: readonly BenchRecord[], level: BenchLevel): ModelReport {
  const spec = LEVELS[level];
  const minPass = spec.repeatMinPass;
  const inv = records.filter((r) => r.kind === 'investigation');
  const conformInv = inv.filter((r) => r.success && r.level_retained !== null && r.level_e_min !== null);
  const reached = conformInv.filter((r) => levelRank(r.level_retained!) <= levelRank(r.level_e_min!));
  const per_task: Record<string, TaskStats> = {};
  for (const r of records.filter((x) => x.kind !== 'repair')) {
    const t = (per_task[r.task_id] ??= { n: 0, success: 0, rate: null, cheapest_n: 0, cheapest_reached: 0, false_successes: 0, passed: null });
    t.n += 1;
    if (r.success) t.success += 1;
    if (r.false_success) t.false_successes += 1;
    if (r.success && r.level_retained !== null && r.level_e_min !== null) {
      t.cheapest_n += 1;
      if (levelRank(r.level_retained) <= levelRank(r.level_e_min)) t.cheapest_reached += 1;
    }
    t.rate = t.success / t.n;
    t.passed = minPass === undefined ? null : t.success >= minPass;
  }
  const invTasks = [...new Set(inv.map((r) => r.task_id))];
  const tasksPassed = invTasks.filter((id) => per_task[id]!.passed === true).length;
  const pass3Values = invTasks.map((id) => per_task[id]!).filter((t) => t.n >= 3).map((t) => passHatK(t.success, t.n, 3));
  const repairs = records.filter((r) => r.kind === 'repair');
  const injections = records.filter((r) => r.kind === 'injection');
  const inv_violations: Record<string, string[]> = {};
  for (const r of records) for (const v of r.inv_violations) inv_violations[v] = [...new Set([...(inv_violations[v] ?? []), r.task_id])];
  const sum = (pick: (x: NonNullable<BenchRecord['injection']>) => number): number => injections.reduce((s, r) => s + (r.injection ? pick(r.injection) : 0), 0);
  const costs = records.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  return {
    model_id: model,
    investigation: { n: inv.length, success: inv.filter((r) => r.success).length, rate: inv.length === 0 ? null : inv.filter((r) => r.success).length / inv.length, ci: wilson(inv.filter((r) => r.success).length, inv.length),
      tasks: minPass === undefined ? null : { n: invTasks.length, passed: tasksPassed, rate: invTasks.length === 0 ? null : tasksPassed / invTasks.length, min_pass: minPass, repeat: spec.repeat },
    },
    cheapest: { n: conformInv.length, reached: reached.length, rate: conformInv.length === 0 ? null : reached.length / conformInv.length },
    pass3: pass3Values.length === 0 ? null : pass3Values.reduce((a, b) => a + b, 0) / pass3Values.length,
    false_successes: records.filter((r) => r.false_success).length,
    false_repairs: repairs.filter((r) => r.repair === 'repaired_nonconform').length,
    false_success_tasks: [...new Set(records.filter((r) => r.false_success).map((r) => r.task_id))].sort(),
    repairs: { injected: repairStats(repairs.filter((r) => r.breakage !== 'suffered')), suffered: repairStats(repairs.filter((r) => r.breakage === 'suffered')) },
    injection: { cases: injections.length, attempts: sum((x) => x.attempts), blocked: sum((x) => x.blocked), exfiltrations: sum((x) => x.exfiltrations) },
    cost_median_usd: median(costs),
    inv_violations,
    per_task,
  };
}

export function buildReport(records: readonly BenchRecord[], options: { date: string }): BenchReport {
  const levels = [...new Set(records.map((r) => r.level))];
  if (levels.length !== 1) throw new Error(`un rapport du banc porte sur un seul niveau (reçu : ${levels.join(', ') || 'aucun'})`);
  const models = [...new Set(records.map((r) => r.model_id))].sort();
  return { date: options.date, level: levels[0]!, models: models.map((m) => modelReport(m, records.filter((r) => r.model_id === m), levels[0]!)) };
}

const pct = (x: number | null): string => (x === null ? '—' : `${(x * 100).toFixed(1)} %`);
const ci = (i: Interval): string => (i.rate === null ? '—' : `[${pct(i.low)} ; ${pct(i.high)}]`);

/** Rapport lisible (résumé du job CI) : tableau par modèle, puis verdict et règles déclenchées, tâches citées. */
export function renderMarkdown(report: BenchReport, result: Verdict): string {
  const lines = [
    `# Banc d’évaluation de l’agent — ${report.level} — ${report.date}`,
    '',
    `Verdict : ${result.blocked ? '**BLOQUÉ**' : 'aucune règle de blocage déclenchée'}${result.reference_date === null ? ' (aucune référence datée lue)' : ` (référence du ${result.reference_date})`}`,
    '',
    '| Modèle | Réussite d’enquête (IC 95 %) | Moins cher atteint | pass^3 | Fausses réparations | Réparations conformes (injectées, IC) | Exfiltrations (tentatives, bloquées) | Coût médian |',
    '|---|---|---|---|---|---|---|---|',
    ...report.models.map(
      (m) =>
        `| ${m.model_id} | ${m.investigation.success}/${m.investigation.n} ${pct(m.investigation.rate)} ${ci(m.investigation.ci)} | ${m.cheapest.reached}/${m.cheapest.n} | ${m.pass3 === null ? '—' : m.pass3.toFixed(3)} | ${m.false_repairs} | ${m.repairs.injected.repaired_conform}/${m.repairs.injected.n} ${ci(m.repairs.injected.ci)} | ${m.injection.exfiltrations} (${m.injection.attempts}, ${m.injection.blocked}) | ${m.cost_median_usd === null ? '—' : `${m.cost_median_usd.toFixed(4)} $`} |`,
    ),
    '',
  ];
  for (const m of result.models) {
    lines.push(`## ${m.model_id}`, '');
    if (!m.has_reference) lines.push('Aucune référence pour ce modèle : constat seulement pour les règles relatives.', '');
    for (const f of m.blocking) lines.push(`- BLOQUE \`${f.rule}\` — ${f.detail}${f.tasks.length > 0 ? ` — tâches : ${f.tasks.join(', ')}` : ''}`);
    for (const f of m.warnings) lines.push(`- avertit \`${f.rule}\` — ${f.detail}${f.tasks.length > 0 ? ` — tâches : ${f.tasks.join(', ')}` : ''}`);
    if (m.blocking.length + m.warnings.length === 0) lines.push('- aucune règle déclenchée');
    const stats = report.models.find((x) => x.model_id === m.model_id);
    const tasks = stats?.investigation.tasks;
    if (tasks !== undefined && tasks !== null) lines.push(`- tâches d’enquête réussies au moins ${tasks.min_pass} sur ${tasks.repeat} : ${tasks.passed}/${tasks.n} (${pct(tasks.rate)})`);
    const casses = stats?.repairs;
    if (casses !== undefined && casses.suffered.n > 0) lines.push(`- casses subies : ${casses.suffered.repaired_conform}/${casses.suffered.n} réparées conformes`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
