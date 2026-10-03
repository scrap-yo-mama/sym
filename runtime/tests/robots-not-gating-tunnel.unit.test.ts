// SPDX-License-Identifier: AGPL-3.0-only
// assert_robots_not_gating, volet tunnel (D-91, 17 § critères). Le tunnel est couvert par ABSENCE de code : ni la couche
// réseau du runtime (modes direct, proxys, tunnel, egress) ni la passerelle SYM Browser (relais, admission) ne lisent,
// ne demandent ni ne contrôlent un robots.txt (D-33 : la passerelle n'a jamais eu de contrôle robots). Une requête qui
// passe par le tunnel ne peut donc pas être arrêtée de ce fait. Les volets fetch et Chromium sont exercés en run réel
// (apps/worker/src/exec/robots-not-gating.security.test.ts, agent-robots-not-gating.security.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'dist', '.output', 'coverage', 'test-results']);
const SCOPES = ['packages/core/src/net', 'modules/browser/apps', 'modules/browser/packages'];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|mjs|js)$/.test(entry.name) && !/\.(test|spec)\.[tj]s$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Fichiers de `scopes` dont le code mentionne un robots.txt (ou une politique « robots »). */
function mentionsRobots(files: Map<string, string>): string[] {
  return [...files].filter(([, text]) => /robots(\.txt|_disallowed|_unreachable)|\brobots\b/i.test(text)).map(([file]) => file);
}

describe('assert_robots_not_gating : tunnel, couvert par absence de code', () => {
  test('la garde repère un fichier qui parle de robots.txt (contrôle de la garde elle-même)', () => {
    const sample = new Map([
      ['propre.ts', 'export const x = 1;'],
      ['gate.ts', "const r = await fetch(origin + '/robots.txt');"],
      ['classe.ts', "return 'robots_disallowed';"],
    ]);
    expect(mentionsRobots(sample)).toEqual(['gate.ts', 'classe.ts']);
  });

  test('couche réseau et passerelle : aucun fichier source ne lit ni ne contrôle un robots.txt', () => {
    const files = new Map<string, string>();
    for (const scope of SCOPES) for (const file of sources(join(root, scope))) files.set(relative(root, file), readFileSync(file, 'utf8'));
    expect(files.size).toBeGreaterThan(20);
    expect(mentionsRobots(files)).toEqual([]);
  });
});
