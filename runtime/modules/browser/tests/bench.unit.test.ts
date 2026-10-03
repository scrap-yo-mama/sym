// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 0.6 : outils du banc de mesure (statistiques, arbre de processus /proc) et garde-fou de sécurité du banc.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';
import { CAPACITY, computeSlots } from '../packages/core/src/capacity.ts';
import { parseProcStat, parsePssBytes, parseVmRssBytes, treeOf } from '../bench/procfs.ts';
import { median, percentile, summarize } from '../bench/stats.ts';

describe('bench : statistiques', () => {
  test('médiane : milieu pour un nombre impair, moyenne des deux centraux sinon', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test('p95 au rang le plus proche (nearest-rank) sur 30 valeurs : la 29e', () => {
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(29);
    expect(percentile(values, 100)).toBe(30);
    expect(percentile([7], 95)).toBe(7);
  });

  test('summarize : n, min, médiane, p95, max ; refuse une série vide', () => {
    expect(summarize([5, 1, 3])).toEqual({ n: 3, min: 1, median: 3, p95: 5, max: 5 });
    expect(() => summarize([])).toThrow(/vide/);
  });
});

describe('bench : arbre de processus (/proc)', () => {
  test('parseProcStat : pid et ppid, même quand le nom de commande contient espaces et parenthèses', () => {
    expect(parseProcStat('4242 (chrome (sandbox) x) S 4000 4242 4242 0 -1 4194560')).toEqual({ pid: 4242, ppid: 4000 });
  });

  test('parseVmRssBytes : VmRSS en kio converti en octets ; absent (noyau, zombie) : 0', () => {
    expect(parseVmRssBytes('Name:\tchrome\nVmRSS:\t   2048 kB\nThreads:\t3\n')).toBe(2048 * 1024);
    expect(parseVmRssBytes('Name:\tzombie\nState:\tZ\n')).toBe(0);
  });

  test('parsePssBytes : Pss de smaps_rollup en octets ; absent : 0', () => {
    expect(parsePssBytes('Rss:\t 900 kB\nPss:\t  512 kB\nPss_Anon:\t 8 kB\n')).toBe(512 * 1024);
    expect(parsePssBytes('')).toBe(0);
  });

  test('treeOf : la racine et tous ses descendants, jamais un voisin', () => {
    const table = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 },
    ];
    expect(treeOf(10, table).sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(treeOf(99, table)).toEqual([99]);
  });
});

type Summ = { n: number; min: number; median: number; p95: number; max: number };
type Result = {
  meta: { label: string; variant: string; reps: number; maxContexts: number; pageKind?: string; concurrency: number };
  results: {
    warm_shared?: { perContextAtN: Record<string, { cgroupAnonMib: Summ }>; contextCreateMs: Record<string, Summ> };
    dedicated?: { cgroupAnonPeakMib: Summ; startMs: { ready: Summ } };
    saturate?: { limitMib: number; sessionsUnder90Percent: Summ };
    node_base?: { nodeRssMib: Summ };
  };
};
const resultsDir = join(MODULE_ROOT, 'bench/results');
const measures: Result[] = existsSync(resultsDir)
  ? readdirSync(resultsDir).filter((f) => /^\d{4}-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(resultsDir, f), 'utf8')) as Result)
  : [];
const MIB = 1024 * 1024;

describe('constantes de capacité reliées aux mesures versionnées (tâche 0.6, 04b §3)', () => {
  test('des mesures existent pour les cas warm_shared, dedicated, saturate et node_base, à 30 répétitions au moins', () => {
    for (const key of ['warm_shared', 'dedicated', 'saturate', 'node_base'] as const) expect(measures.filter((m) => m.results[key]).length, key).toBeGreaterThan(0);
    for (const m of measures) expect(m.meta.reps, m.meta.label).toBeGreaterThanOrEqual(30);
  });

  test('BASE_BYTES couvre au moins 2 fois la base mesurée du nœud (Node + playwright-core)', () => {
    const base = Math.max(...measures.flatMap((m) => (m.results.node_base ? [m.results.node_base.nodeRssMib.p95] : [])));
    expect(CAPACITY.BASE_BYTES / MIB).toBeGreaterThanOrEqual(2 * base);
  });

  test('un slot dedicated couvre au moins 2 fois le p95 mesuré de la mémoire anonyme d’un Chromium (page lourde comprise)', () => {
    const worst = Math.max(...measures.flatMap((m) => (m.results.dedicated ? [m.results.dedicated.cgroupAnonPeakMib.p95] : [])));
    expect((CAPACITY.DEDICATED_UNITS / CAPACITY.SLOT_UNITS) * (CAPACITY.SLOT_BYTES / MIB)).toBeGreaterThanOrEqual(2 * worst);
  });

  test('le poids shared couvre au moins 2 fois le p95 mesuré d’un contexte au dernier palier', () => {
    const worst = Math.max(
      ...measures.flatMap((m) => (m.results.warm_shared ? [m.results.warm_shared.perContextAtN[String(m.meta.maxContexts)]?.cgroupAnonMib.p95 ?? 0] : [])),
    );
    expect(worst).toBeGreaterThan(0);
    expect((CAPACITY.SHARED_UNITS / CAPACITY.SLOT_UNITS) * (CAPACITY.SLOT_BYTES / MIB)).toBeGreaterThanOrEqual(2 * worst);
  });

  test('CONTEXTS_PER_BROWSER ne dépasse pas le palier mesuré sur la page lourde', () => {
    const heavy = Math.max(...measures.filter((m) => m.meta.pageKind === 'heavy' && m.results.warm_shared).map((m) => m.meta.maxContexts));
    expect(CAPACITY.CONTEXTS_PER_BROWSER).toBeLessThanOrEqual(heavy);
  });

  test('slots du nœud : au plus la moitié des sessions dedicated lourdes mesurées sous 90 % de la limite', () => {
    const runs = measures.filter((m) => m.meta.pageKind === 'heavy' && m.results.saturate);
    expect(runs.length).toBeGreaterThan(0);
    for (const m of runs) {
      const saturate = m.results.saturate as NonNullable<Result['results']['saturate']>;
      expect(computeSlots(saturate.limitMib * MIB) * 2, m.meta.label).toBeLessThanOrEqual(saturate.sessionsUnder90Percent.median);
    }
  });

  test('K2 : démarrage dedicated du nœud (lancement + connexion + page chargée) sous la cible p50 < 2 s, quelle que soit la variante', () => {
    for (const m of measures.filter((r) => r.results.dedicated)) expect((m.results.dedicated as NonNullable<Result['results']['dedicated']>).startMs.ready.median, m.meta.label).toBeLessThan(2000);
  });
});

describe('bench : garde-fou de sécurité', () => {
  const sources = (dir: string): string[] =>
    readdirSync(join(MODULE_ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      if (e.isDirectory()) return e.name === 'results' ? [] : sources(join(dir, e.name));
      return /\.(ts|mjs|sh)$/.test(e.name) ? [join(dir, e.name)] : [];
    });

  test('aucun script du banc ne contient kill -1, kill 0, pkill, killall ni /bin/kill', () => {
    const forbidden = /\bpkill\b|\bkillall\b|\/bin\/kill|\bkill\s+(-1|0|-9\s+-1)\b|process\.kill\(\s*(-?1|0|-\d+)\s*[,)]/;
    const files = sources('bench');
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((file) => forbidden.test(readFileSync(join(MODULE_ROOT, file), 'utf8')));
    expect(hits).toEqual([]);
  });

  test('process.kill du banc ne vise qu’un pid exact validé (entier > 1) enfant du script', () => {
    const file = join(MODULE_ROOT, 'bench/measure.ts');
    expect(existsSync(file)).toBe(true);
    const measure = readFileSync(file, 'utf8');
    const calls = [...measure.matchAll(/process\.kill\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toBe("pid, 'SIGKILL'");
    expect(measure).toMatch(/function killOwnChild\(pid: number\)/);
    expect(measure).toMatch(/Number\.isInteger\(pid\) && pid > 1/);
  });
});
