// Tâche 0.8 : garde X6, versions épinglées, licences, liste noire INV6.
// Les fixtures ne contiennent que des noms de fichiers ou de paquets à refuser.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { checkCatalog, checkDockerfile, checkPackageJson, checkRepo as checkPinned, checkWorkflow } from '../scripts/check-deps-pinned.ts';
import { DENY_PATTERNS, findDenied } from '../scripts/check-blacklist.ts';
import { classify, evaluate } from '../scripts/check-licenses.ts';
import { checkRepo as checkX6, findX6Violations } from '../scripts/check-x6.ts';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('supply chain (tâche 0.8)', () => {
  test('assert_x6_guard', () => {
    expect(findX6Violations(['a/b.py', 'c/D.IPYNB', 'x/anticaptcha_v2.ts', 'y/my_captcha_solver.ts'])).toHaveLength(4);
    expect(findX6Violations(['scraper.py', 'google_scraper.py'])).toHaveLength(2);
    expect(findX6Violations(['runtime/src/index.ts', 'docs/anti-captcha.md', 'README.md'])).toEqual([]);
    // Garde réelle, depuis la racine du dépôt : aucun .py ni .ipynb indexé.
    expect(checkX6()).toEqual([]);
  });

  test('assert_deps_pinned', () => {
    expect(checkCatalog('catalog:\n  a: 1.2.3\n  b: ^1.2.3\n  \'@c/d\': ~2.0.0\n  e: latest\n  f: "*"\n')).toHaveLength(4);
    expect(checkCatalog('catalog:\n  a: 1.2.3 # ok\nminimumReleaseAge: 10080\n')).toEqual([]);
    expect(checkPackageJson('p', '{"dependencies":{"a":"^1.0.0","b":"catalog:","c":"workspace:*","d":"1.0.0"}}')).toHaveLength(1);
    expect(checkPackageJson('p', '{"devDependencies":{"a":"latest","b":"*","c":"~1.0.0"}}')).toHaveLength(3);

    const pinned = `permissions:\n  contents: read\njobs:\n  j:\n    steps:\n      - uses: actions/checkout@${SHA} # v1\n      - run: pnpm install --frozen-lockfile\n`;
    expect(checkWorkflow('w', pinned)).toEqual([]);
    expect(checkWorkflow('w', pinned.replace(SHA, 'v4'))).toHaveLength(1);
    expect(checkWorkflow('w', pinned.replace('permissions:\n  contents: read\n', ''))).toHaveLength(1);
    expect(checkWorkflow('w', pinned.replace(' --frozen-lockfile', ''))).toHaveLength(1);
    expect(checkWorkflow('w', `${pinned}    services:\n      db:\n        image: postgres:16\n`)).toHaveLength(1);

    expect(checkDockerfile('d', `ARG X_IMAGE=img:1@${DIGEST}\nFROM \${X_IMAGE} AS a\n`)).toEqual([]);
    expect(checkDockerfile('d', 'ARG X_IMAGE=img:1\nRUN pnpm install\n')).toHaveLength(2);

    // Dépôt réel.
    expect(checkPinned(new URL('..', import.meta.url).pathname)).toEqual([]);
  });

  test('assert_licenses_compatible', () => {
    for (const ok of ['MIT', 'Apache-2.0', '(MIT OR CC0-1.0)', 'MIT AND BSD-3-Clause', 'Python-2.0', 'LGPL-3.0-or-later']) {
      expect(classify(ok)).toBe('allowed');
    }
    for (const bad of ['SSPL-1.0', 'BUSL-1.1', 'Commons Clause', 'Proprietary', 'GPL-2.0-only']) {
      expect(classify(bad)).toBe('forbidden');
    }
    expect(classify('WTFPL-inconnue')).toBe('unknown');
    expect(classify('MIT AND SSPL-1.0')).toBe('forbidden');
    const report = { MIT: [{ name: 'a', versions: ['1.0.0'] }], 'BUSL-1.1': [{ name: 'b', versions: ['2.0.0'] }], Nope: [{ name: 'c', versions: ['3.0.0'] }] };
    expect(evaluate(report, {})).toHaveLength(2);
    expect(evaluate(report, { b: 'exception justifiée', c: 'exception justifiée' })).toEqual([]);
  });

  test('assert_deps_blacklist_inv6', () => {
    const lock = (names: string[]) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      ok:\n        version: 1.0.0\n\npackages:\n\n${names.map((n) => `  '${n}@1.0.0':\n    resolution: {integrity: x}\n`).join('')}\nsnapshots:\n\n${names.map((n) => `  '${n}@1.0.0': {}\n`).join('')}`;
    expect(findDenied(lock(['vitest', '@scope/lib']))).toEqual([]);
    // Un nom refusé, même transitif (section packages/snapshots), fait échouer.
    for (const name of ['puppeteer-extra-plugin-stealth', 'playwright-extra', '@x/some-captcha-lib', 'undetected-foo', 'fingerprint-injector', 'fingerprint-generator', 'rebrowser-playwright']) {
      expect(findDenied(lock(['vitest', name]))).toEqual([name]);
    }
    expect(DENY_PATTERNS.length).toBeGreaterThan(10);
    // Lockfile réel.
    expect(findDenied(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'))).toEqual([]);
  });
});
