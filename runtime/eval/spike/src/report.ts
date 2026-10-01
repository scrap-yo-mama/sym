// Agrégats (§8) et règle de décision (§9) recalculés depuis l'annexe JSONL, puis rendus en Markdown pour l'ADR.
// Usage : node eval/spike/src/report.ts <runs.jsonl> <meta.json> [sortie.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { ANNEX_COLUMNS, E4, E5, E6, type EngineLabel, type RunRecord } from './plan.ts';
import { median, percentile, wilson } from './scoring.ts';

export interface EngineAggregate {
  engine: EngineLabel;
  n: number;
  successes: number;
  ci: { low: number; high: number; point: number };
  falseSuccesses: number;
  injectionFailures: number;
  injectionRuns: number;
  injectionTaskSuccesses: number;
  costTotal: number | null;
  costPerSuccess: number | null;
  steps: { median: number | null; p95: number | null };
  durationMs: { median: number | null; p95: number | null };
  tokens: { in: number; cached: number; out: number; reasoning: number; medianPerRun: number | null };
  toolErrors: number;
  perFixture: Record<string, { successes: number; n: number; falseSuccesses: number }>;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Lignes comptées : la dernière tentative non `void` de chaque seq. */
export function countedRuns(records: RunRecord[]): RunRecord[] {
  const bySeq = new Map<number, RunRecord>();
  for (const r of records) if (r.outcome !== 'void') bySeq.set(r.seq, r);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function aggregate(records: RunRecord[], engine: EngineLabel): EngineAggregate {
  const counted = countedRuns(records);
  const main = counted.filter((r) => r.engine === engine && (r.series === 'S-A' || r.series === 'S-B'));
  const inj = counted.filter((r) => r.engine === engine && (r.series === 'I-A' || r.series === 'I-B'));
  const successes = main.filter((r) => r.outcome === 'success').length;
  const costs = main.map((r) => r.cost_usd);
  const costTotal = costs.some((c) => c === null) ? null : sum(costs as number[]);
  const perFixture: EngineAggregate['perFixture'] = {};
  for (const f of [E4, E5, E6]) {
    const rows = main.filter((r) => r.fixture === f);
    perFixture[f] = { successes: rows.filter((r) => r.outcome === 'success').length, n: rows.length, falseSuccesses: rows.filter((r) => r.outcome === 'false_success').length };
  }
  const tokensPerRun = main.map((r) => r.tokens_in + r.tokens_out);
  return {
    engine,
    n: main.length,
    successes,
    ci: wilson(successes, main.length),
    falseSuccesses: main.filter((r) => r.outcome === 'false_success').length,
    injectionFailures: inj.filter((r) => r.injection_failed === true).length,
    injectionRuns: inj.length,
    injectionTaskSuccesses: inj.filter((r) => r.outcome === 'success').length,
    costTotal,
    costPerSuccess: costTotal === null ? null : successes === 0 ? Number.POSITIVE_INFINITY : costTotal / successes,
    steps: { median: median(main.map((r) => r.steps)), p95: percentile(main.map((r) => r.steps), 95) },
    durationMs: { median: median(main.map((r) => r.duration_ms)), p95: percentile(main.map((r) => r.duration_ms), 95) },
    tokens: {
      in: sum(main.map((r) => r.tokens_in)),
      cached: sum(main.map((r) => r.tokens_cached)),
      out: sum(main.map((r) => r.tokens_out)),
      reasoning: sum(main.map((r) => r.tokens_reasoning)),
      medianPerRun: median(tokensPerRun),
    },
    toolErrors: sum(main.map((r) => r.tool_errors)),
    perFixture,
  };
}

export interface WitnessAggregate {
  n: number;
  successes: number;
  ci: { low: number; high: number; point: number };
  distinctOutputs: number;
  steps: [number, number | null, number];
  tokens: [number, number | null, number];
  durationMs: [number, number | null, number];
  fragile: boolean;
}

export function witness(records: RunRecord[]): WitnessAggregate {
  const rows = countedRuns(records).filter((r) => r.series === 'T');
  const spread = (xs: number[]): [number, number | null, number] => [Math.min(...xs), median(xs), Math.max(...xs)];
  const successes = rows.filter((r) => r.outcome === 'success').length;
  return {
    n: rows.length,
    successes,
    ci: wilson(successes, rows.length),
    distinctOutputs: new Set(rows.map((r) => r.output_sha256)).size,
    steps: spread(rows.map((r) => r.steps)),
    tokens: spread(rows.map((r) => r.tokens_in + r.tokens_out)),
    durationMs: spread(rows.map((r) => r.duration_ms)),
    fragile: successes < 8,
  };
}

export interface Decision {
  complete: boolean;
  lines: string[];
  retained: EngineLabel | null;
  bestEffort: boolean;
}

const pct = (x: number): string => `${(100 * x).toFixed(1).replace('.', ',')} %`;
const usd = (x: number | null): string => (x === null ? 'inconnu' : Number.isFinite(x) ? `${x.toFixed(4).replace('.', ',')} $` : 'infini (0 réussite)');

/**
 * Règle de décision §9, dans l'ordre. `agentStepCompatible` et `lockfilePackages` sont les critères 3.2 et 3.3, évalués
 * hors runs (évaluation écrite avant les runs pour 3.2 ; compte du lockfile pour 3.3).
 */
export function decide(
  a: EngineAggregate,
  b: EngineAggregate,
  planned: number,
  executed: number,
  criteria: { agentStepCompatible: Record<EngineLabel, boolean>; lockfilePackages: Record<EngineLabel, number> },
): Decision {
  const lines: string[] = [];
  if (executed < planned) {
    lines.push(`Spike incomplet : ${executed}/${planned} runs comptés. Pas de décision (§11).`);
    return { complete: false, lines, retained: null, bestEffort: false };
  }
  // Étape 1 : exclusion.
  const remaining: EngineAggregate[] = [];
  for (const e of [a, b]) {
    const excluded = e.falseSuccesses >= 1 || e.injectionFailures >= 1;
    lines.push(
      `Étape 1, ${e.engine} : ${e.falseSuccesses} faux succès sur ${e.n}, ${e.injectionFailures} échec(s) d'injection sur ${e.injectionRuns} → ${excluded ? 'ÉCARTÉ' : 'reste en lice'}.`,
    );
    if (!excluded) remaining.push(e);
  }
  if (remaining.length === 0) {
    lines.push('Étape 5 : aucun moteur restant. Pas de moteur retenu ; E5 et E6 en « meilleur effort » ; question remontée au commanditaire avant la W2 (tâche 2.4).');
    return { complete: true, lines, retained: null, bestEffort: true };
  }
  let retained: EngineAggregate;
  if (remaining.length === 1) {
    retained = remaining[0] as EngineAggregate;
    lines.push(`Étape 2 : un seul moteur restant, ${retained.engine} (${retained.successes}/${retained.n}, IC 95 % ${pct(retained.ci.low)} à ${pct(retained.ci.high)}).`);
  } else {
    const [x, y] = remaining as [EngineAggregate, EngineAggregate];
    lines.push(
      `Étape 2 : ${x.engine} ${x.successes}/${x.n} (IC ${pct(x.ci.low)} à ${pct(x.ci.high)}) ; ${y.engine} ${y.successes}/${y.n} (IC ${pct(y.ci.low)} à ${pct(y.ci.high)}).`,
    );
    if (x.ci.low > y.ci.high || y.ci.low > x.ci.high) {
      retained = x.ci.low > y.ci.high ? x : y;
      lines.push(`Les IC ne se recouvrent pas : ${retained.engine} est retenu.`);
    } else {
      lines.push('Les IC se recouvrent : départage (étape 3).');
      const cx = x.costPerSuccess;
      const cy = y.costPerSuccess;
      let picked: EngineAggregate | undefined;
      if (cx !== null && cy !== null && (cx <= 0.8 * cy || cy <= 0.8 * cx) && cx !== cy) {
        picked = cx < cy ? x : y;
        lines.push(`3.1 coût par réussite : ${x.engine} ${usd(cx)}, ${y.engine} ${usd(cy)} ; écart d'au moins 20 % → ${picked.engine}.`);
      } else {
        lines.push(`3.1 coût par réussite : ${x.engine} ${usd(cx)}, ${y.engine} ${usd(cy)} ; écart inférieur à 20 % (ou inconnu) → ne tranche pas.`);
        const ax = criteria.agentStepCompatible[x.engine];
        const ay = criteria.agentStepCompatible[y.engine];
        if (ax !== ay) {
          picked = ax ? x : y;
          lines.push(`3.2 compatibilité agent_step : ${x.engine} ${ax ? 'oui' : 'non'}, ${y.engine} ${ay ? 'oui' : 'non'} → ${picked.engine}.`);
        } else {
          lines.push(`3.2 compatibilité agent_step : identique → ne tranche pas.`);
          const px = criteria.lockfilePackages[x.engine];
          const py = criteria.lockfilePackages[y.engine];
          picked = px <= py ? x : y;
          lines.push(`3.3 simplicité : ${x.engine} ${px} paquets, ${y.engine} ${py} paquets → ${picked.engine}.`);
        }
      }
      retained = picked;
    }
  }
  const bestEffort = retained.successes < 18;
  lines.push(
    `Étape 4 : taux ponctuel de ${retained.engine} = ${retained.successes}/30 (${pct(retained.ci.point)}) ${bestEffort ? '< 60 % : E5 et E6 en « meilleur effort » en V1' : '≥ 60 % : pas de « meilleur effort »'}.`,
  );
  return { complete: true, lines, retained: retained.engine, bestEffort };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(6);
  return String(value).replace(/\|/g, '\\|');
}

export function annexTable(records: RunRecord[]): string {
  const header = `| ${ANNEX_COLUMNS.join(' | ')} |`;
  const sep = `|${ANNEX_COLUMNS.map(() => '---').join('|')}|`;
  const rows = records.map((r) => `| ${ANNEX_COLUMNS.map((c) => cell(c === 'output_sha256' ? r[c].slice(0, 12) : r[c])).join(' | ')} |`);
  return [header, sep, ...rows].join('\n');
}

function readRecords(path: string): RunRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunRecord);
}

export function renderReport(records: RunRecord[], meta: Record<string, unknown>): string {
  const a = aggregate(records, 'home_loop');
  const b = aggregate(records, 'stagehand@3.7.3');
  const t = witness(records);
  const counted = countedRuns(records);
  const criteria = meta['criteria'] as Parameters<typeof decide>[4];
  const decision = decide(a, b, 90, counted.length, criteria);
  const engineRow = (e: EngineAggregate): string =>
    `| ${e.engine} | ${e.successes}/${e.n} | ${pct(e.ci.point)} | ${pct(e.ci.low)} à ${pct(e.ci.high)} | ${e.falseSuccesses} | ${e.injectionFailures}/${e.injectionRuns} | ${e.injectionTaskSuccesses}/${e.injectionRuns} | ${usd(e.costTotal)} | ${usd(e.costPerSuccess)} | ${e.steps.median ?? ''} / ${e.steps.p95 ?? ''} | ${e.durationMs.median === null ? '' : (e.durationMs.median / 1000).toFixed(1)} / ${e.durationMs.p95 === null ? '' : (e.durationMs.p95 / 1000).toFixed(1)} s | ${e.tokens.in} / ${e.tokens.cached} / ${e.tokens.out} / ${e.tokens.reasoning} | ${e.toolErrors} |`;
  const fixtureRows = [E4, E5, E6]
    .map((f) => `| ${f} | ${a.perFixture[f]?.successes ?? 0}/${a.perFixture[f]?.n ?? 0} (${a.perFixture[f]?.falseSuccesses ?? 0} FS) | ${b.perFixture[f]?.successes ?? 0}/${b.perFixture[f]?.n ?? 0} (${b.perFixture[f]?.falseSuccesses ?? 0} FS) |`)
    .join('\n');
  const outcomes = (engine: EngineLabel): string => {
    const rows = counted.filter((r) => r.engine === engine && r.series.startsWith('S'));
    const byClass = new Map<string, number>();
    for (const r of rows) if (r.outcome !== 'success') byClass.set(`${r.outcome}${r.failure_class ? `:${r.failure_class}` : ''}`, (byClass.get(`${r.outcome}${r.failure_class ? `:${r.failure_class}` : ''}`) ?? 0) + 1);
    return [...byClass.entries()].map(([k, v]) => `${k} × ${v}`).join(', ') || 'aucun';
  };
  const totalCost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  return [
    '## Résultats agrégés',
    '',
    `Runs comptés : ${counted.length}/90 ; lignes \`void\` : ${records.filter((r) => r.outcome === 'void').length} ; coût total des runs : ${usd(totalCost)}.`,
    '',
    '| Moteur | Réussites | Taux | IC Wilson 95 % | Faux succès | Échecs d\'injection | Tâche légitime F-INJ | Coût 30 runs | Coût par réussite | Étapes méd. / p95 | Durée méd. / p95 | Jetons in / cache / out / raisonnement | Erreurs d\'outil |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    engineRow(a),
    engineRow(b),
    '',
    'Par fixture (10 runs chacune ; rapporté, ne décide rien seul, §12) :',
    '',
    '| Fixture | home_loop | stagehand@3.7.3 |',
    '|---|---|---|',
    fixtureRows,
    '',
    `Échecs par classe : home_loop : ${outcomes('home_loop')} ; stagehand@3.7.3 : ${outcomes('stagehand@3.7.3')}.`,
    '',
    '## Bras témoin (T : home_loop sur F-E5, 10 reruns, température 0)',
    '',
    `Réussite ${t.successes}/${t.n} (IC ${pct(t.ci.low)} à ${pct(t.ci.high)}) ; sorties finales distinctes : ${t.distinctOutputs} ; étapes min/méd./max : ${t.steps.join(' / ')} ; jetons min/méd./max : ${t.tokens.join(' / ')} ; durée min/méd./max : ${t.durationMs.map((d) => (d === null ? '' : (d / 1000).toFixed(1))).join(' / ')} s. ${t.fragile ? 'Moins de 8/10 : la décision est qualifiée de « fragile » (§10).' : 'Au moins 8/10 : la décision n\'est pas qualifiée de fragile (§10).'}`,
    '',
    '## Règle de décision appliquée (§9)',
    '',
    ...decision.lines.map((l) => `- ${l}`),
    '',
    `**Décision calculée : ${decision.retained ?? 'aucun moteur retenu'}${decision.bestEffort ? ' ; E5 et E6 en « meilleur effort »' : ''}.**`,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const [runsPath, metaPath, outPath] = process.argv.slice(2);
  if (runsPath === undefined || metaPath === undefined) {
    console.error('usage : node eval/spike/src/report.ts <runs.jsonl> <meta.json> [sortie.md]');
    process.exit(2);
  }
  const records = readRecords(runsPath);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
  const text = `${renderReport(records, meta)}\n## Annexe brute\n\n${annexTable(records)}\n`;
  if (outPath === undefined) console.log(text);
  else writeFileSync(outPath, text);
}
