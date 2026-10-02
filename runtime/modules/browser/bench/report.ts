// SPDX-License-Identifier: AGPL-3.0-only
// Tableaux Markdown du rapport de capacité (tâche 0.6), générés depuis bench/results/*.json pour éviter toute
// retranscription à la main.   node bench/report.ts [dossier-de-résultats]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type S = { n: number; median: number; p95: number };
type Report = { meta: Record<string, unknown>; results: Record<string, Record<string, unknown>> };

const dir = process.argv[2] ?? new URL('./results', import.meta.url).pathname;
const reports = readdirSync(dir)
  .filter((f) => /^\d{4}-.*\.json$/.test(f))
  .sort()
  .map((f) => ({ file: f, report: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Report }));

const cell = (s: S | undefined, digits = 0): string => (s ? `${s.median.toFixed(digits)} / ${s.p95.toFixed(digits)}` : '-');
const get = (o: unknown, ...path: string[]): S | undefined => path.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], o) as S | undefined;
const name = (r: Report): string => `${String(r.meta.label)} ${String(r.meta.variant)}`;

const has = (key: string) => reports.filter(({ report }) => report.results[key]);

function table(title: string, header: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  console.log(`\n#### ${title}\n`);
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
}

console.log('Cellules : médiane / p95. Durées en ms, mémoires en Mio (1 Mio = 2^20 octets).');

table(
  'Démarrage (ms)',
  ['Run', 'Répét.', 'Chromium chaud : lancement', 'Chromium chaud : prêt (lancement + connexion)', 'Contexte shared : newContext + newPage (1er)', 'Contexte shared : + chargement page (1er)', 'dedicated : prêt (lancement + connexion + page chargée)', 'dedicated simultanées : prêt'],
  has('warm_shared').map(({ report: r }) => {
    const w = r.results.warm_shared;
    const d = r.results.dedicated;
    const c = r.results.concurrent;
    return [name(r), String(r.meta.reps), cell(get(w, 'launchMs')), cell(get(w, 'readyMs')), cell(get(w, 'contextCreateMs', '1')), cell(get(w, 'contextLoadMs', '1')), cell(get(d, 'startMs', 'ready')), `${cell(get(c, 'readyMs'))} (k=${String(r.meta.concurrency)})`];
  }),
);

table(
  'Chromium chaud sans contexte (Mio)',
  ['Run', 'Processus', 'RSS (somme des processus)', 'PSS (partages répartis)'],
  has('warm_shared').map(({ report: r }) => [name(r), cell(get(r.results.warm_shared, 'idle', 'processes')), cell(get(r.results.warm_shared, 'idle', 'rssMib'), 1), cell(get(r.results.warm_shared, 'idle', 'pssMib'), 1)]),
);

table(
  'Contexte shared : coût par contexte (Mio)',
  ['Run', 'Page', 'Paliers', 'RSS marginal / contexte', 'RSS / contexte au dernier palier', 'PSS / contexte au dernier palier', 'Mémoire anonyme du cgroup / contexte au dernier palier', 'Reliquat après fermeture des contextes'],
  has('warm_shared').map(({ report: r }) => {
    const w = r.results.warm_shared as { perContextAtN: Record<string, { rssMib: S; pssMib: S; cgroupAnonMib: S }> };
    const last = String(r.meta.maxContexts);
    return [name(r), String(r.meta.pageKind ?? 'typical'), last, cell(get(w, 'marginalPerContextMib'), 1), cell(w.perContextAtN[last]?.rssMib, 1), cell(w.perContextAtN[last]?.pssMib, 1), cell(w.perContextAtN[last]?.cgroupAnonMib, 1), cell(get(w, 'afterCloseResidualMib'), 1)];
  }),
);

table(
  'Session dedicated, un Chromium (Mio)',
  ['Run', 'Page', 'RSS au repos', 'RSS pic', 'PSS au repos', 'cgroup `memory.current` au repos', 'cgroup anonyme, pic', 'Arrêt (ms)', 'Orphelins après arrêt (max)'],
  has('dedicated').map(({ report: r }) => {
    const d = r.results.dedicated;
    return [name(r), String(r.meta.pageKind ?? 'typical'), cell(get(d, 'restRssMib'), 1), cell(get(d, 'peakRssMib'), 1), cell(get(d, 'restPssMib'), 1), cell(get(d, 'cgroupCurrentAtRestMib'), 1), cell(get(d, 'cgroupAnonPeakMib'), 1), cell(get(d, 'closeMs')), String((get(d, 'orphansAfterClose') as { max?: number } | undefined)?.max ?? '-')];
  }),
);

table(
  'Sessions dedicated simultanées (par session, Mio)',
  ['Run', 'k', 'RSS', 'PSS', 'cgroup `memory.current`', 'cgroup anonyme, pic', 'Lancements échoués (max)'],
  has('concurrent').map(({ report: r }) => {
    const c = r.results.concurrent;
    return [name(r), String(r.meta.concurrency), cell(get(c, 'perSessionRssMib'), 1), cell(get(c, 'perSessionPssMib'), 1), cell(get(c, 'perSessionCgroupCurrentMib'), 1), cell(get(c, 'perSessionCgroupAnonPeakMib'), 1), String((get(c, 'failedLaunches') as { max?: number } | undefined)?.max ?? '-')];
  }),
);

table(
  'Saturation : sessions dedicated sous 90 % de la limite du cgroup',
  ['Run', 'Limite (Mio)', 'Page', 'Sessions sous 90 %', 'cgroup `memory.current` / session', 'Lancements échoués (max)'],
  has('saturate').map(({ report: r }) => {
    const t = r.results.saturate;
    return [name(r), String(t?.limitMib), String(r.meta.pageKind ?? 'typical'), cell(get(t, 'sessionsUnder90Percent'), 1), cell(get(t, 'perSessionCgroupCurrentMib'), 1), String((get(t, 'failedLaunches') as { max?: number } | undefined)?.max ?? '-')];
  }),
);

table(
  'Dérive d’un Chromium chaud qui enchaîne des sessions shared (Mio pour 50 sessions)',
  ['Run', 'Cycles', 'RSS', 'PSS', 'cgroup anonyme'],
  has('leak').map(({ report: r }) => [name(r), String((r.results.leak as { cycles?: number } | undefined)?.cycles), cell(get(r.results.leak, 'driftRssMibPer50Sessions'), 1), cell(get(r.results.leak, 'driftPssMibPer50Sessions'), 1), cell(get(r.results.leak, 'driftCgroupAnonMibPer50Sessions'), 1)]),
);

table(
  'Base du nœud hors Chromium (processus Node + playwright-core + serveur HTTP, Mio)',
  ['Run', 'RSS Node'],
  has('node_base').map(({ report: r }) => [name(r), cell(get(r.results.node_base, 'nodeRssMib'), 1)]),
);
