// SPDX-License-Identifier: AGPL-3.0-only
// assert_no_circumvention (INV6, tâche 1.7), volet statique : aucune dépendance de furtivité ni de captcha
// (lockfile, manifestes, imports du code), et aucune suite d'échec ne propose le tunnel ni un changement de réseau
// après un refus. Le volet dynamique (garde de classification sur les fixtures) est dans
// packages/core/src/exec/classify*.unit.test.ts, packages/core/src/exec/guard.unit.test.ts,
// apps/worker/src/exec/classification-guard.integration.test.ts et tests/browser/executors.security.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FAILURE_CLASSES } from '../packages/core/src/model/enums.ts';
import { failureRoute } from '../packages/core/src/exec/guard.ts';
import { DENY_PATTERNS, findDenied, lockfilePackageNames } from '../scripts/check-blacklist.ts';

const root = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'dist', '.output', '.wxt', 'coverage', 'test-results', 'blob-report']);

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

const DENY = DENY_PATTERNS.map((glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
const denied = (name: string): boolean => DENY.some((re) => re.test(name));
/** Nom de paquet d'un spécificateur d'import (`@scope/nom/sous-chemin` → `@scope/nom`). */
const packageOf = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec));

describe('assert_no_circumvention : aucune dépendance « stealth » ni captcha', () => {
  test('lockfile : aucune dépendance (directe ou transitive) de la liste de refus', () => {
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    // Le parseur lit bien les noms (un changement de format du lockfile ne doit pas rendre ce test creux).
    const names = lockfilePackageNames(lockfile);
    expect(names.size).toBeGreaterThan(100);
    expect(names.has('playwright-core') && names.has('vitest')).toBe(true);
    expect(findDenied(lockfile)).toEqual([]);
  });

  test('manifestes : aucune dépendance déclarée de la liste de refus, ni de nom contenant stealth ou captcha', () => {
    const manifests = walk(root, (f) => f.endsWith('package.json'));
    expect(manifests.length).toBeGreaterThan(8);
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = Object.keys((pkg[field] as Record<string, string> | undefined) ?? {});
        expect(deps.filter((d) => denied(d) || /stealth|captcha/i.test(d)), `${relative(root, file)} ${field}`).toEqual([]);
      }
    }
  });

  test('code : aucun import ni require d’un paquet de la liste de refus', () => {
    const sources = walk(root, (f) => /\.(ts|mts|js|mjs|vue)$/.test(f));
    expect(sources.length).toBeGreaterThan(100);
    const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
    for (const file of sources) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const spec = match[1] ?? '';
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        expect(denied(packageOf(spec)), `${relative(root, file)} importe ${spec}`).toBe(false);
      }
    }
  });
});

describe('assert_no_circumvention : aucune suite d’échec ne contourne un refus', () => {
  test('aucune classe ne propose le tunnel ; seule `network` change de réseau ; un refus n’invoque jamais l’agent', () => {
    for (const cls of FAILURE_CLASSES) {
      const route = failureRoute(cls);
      expect(JSON.stringify(route), cls).not.toMatch(/tunnel/i);
      if (cls !== 'network') expect(route.network, cls).not.toBe('escalate');
      if (['blocked_by_protection', 'forbidden', 'rate_limited', 'auth_required', 'payment_required', 'account_limit'].includes(cls)) {
        expect(route.agent, cls).toBe(false);
      }
    }
  });
});
