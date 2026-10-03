// SPDX-License-Identifier: AGPL-3.0-only
// assert_policy_module_no_brief_import (tâche 2.14, 19c § 3, deuxième couche de la garantie) : les modules qui calculent la
// politique effective d'une API et les décisions de ses gardes (robots.txt et rapport d'accès, réseau et garde SSRF, verrou
// de domaines, cadence, classifieur, plan d'essais et règles) n'importent JAMAIS le module du dossier d'enquête, ni
// directement ni par un import transitif. Le graphe est relu depuis les sources (imports relatifs et `@runtime/core/*`).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const src = new URL('..', import.meta.url).pathname;

/** Modules de politique et de garde (racines du parcours). */
const POLICY_DIRS = ['access', 'net', 'pacing'];
const POLICY_FILES = ['exec/classify.ts', 'exec/guard.ts', 'exec/pacer.ts', 'exec/protection.ts', 'exec/fetch.ts', 'investigation/plan.ts', 'investigation/trials.ts', 'investigation/recon.ts', 'rules/plan.ts', 'rules/widening.ts', 'rules/resolve.ts'];

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.includes('.testkit.')) out.push(full);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith('@runtime/core/')) {
    const sub = spec.slice('@runtime/core/'.length);
    return join(src, sub, 'index.ts');
  }
  if (spec === '@runtime/core') return join(src, 'index.ts');
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate;
  return null;
}

/** Fichiers atteints depuis les racines (imports statiques, transitifs). */
function reachable(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const next = resolveImport(file, m[1]!);
      if (next !== null && existsSync(next)) stack.push(next);
    }
  }
  return seen;
}

describe('assert_policy_module_no_brief_import', () => {
  test('assert_policy_module_no_brief_import — aucun module de politique ou de garde n’atteint src/brief/ (graphe transitif)', () => {
    const roots = [...POLICY_DIRS.flatMap((d) => tsFiles(join(src, d))), ...POLICY_FILES.map((f) => join(src, f))];
    for (const r of roots) expect(existsSync(r), relative(src, r)).toBe(true);
    const graph = reachable(roots);
    expect(graph.size).toBeGreaterThan(roots.length);
    const brief = [...graph].filter((f) => relative(src, f).startsWith('brief/'));
    expect(brief, 'module du dossier atteint depuis la politique').toEqual([]);
  });
});
