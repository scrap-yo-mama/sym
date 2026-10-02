// SPDX-License-Identifier: AGPL-3.0-only
// assert_module_boundaries (ADR 23 § 9 A4, volet SYM Browser ; cdc/sym-browser 06 tâche 0.1) : la configuration ESLint
// RÉELLE du workspace (runtime/eslint.config.mjs) refuse tout import du module hors de `@sym/contracts/browser` et de
// `@runtime/ui` (packages/ui), y compris par chemin relatif ou absolu (cible réelle, liens symboliques résolus), import() ou require()
// par gabarit sans expression, createRequire, require.resolve et module.require, et dans les fichiers .cts, .cjs, .tsx, .jsx ; `pnpm lint` échoue alors en nommant l'import.
import { execFileSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';
import { boundaryViolation, MODULE_ROOT } from '../eslint.boundaries.mjs';

const runtimeDir = join(MODULE_ROOT, '..', '..');
const eslint = new ESLint({ cwd: runtimeDir });
const RULE = 'sym-browser/boundaries';

/** Messages de la règle de frontière pour un fichier virtuel (chemin relatif à runtime/). */
async function violations(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(runtimeDir, file) });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

const GATEWAY = 'modules/browser/apps/gateway/src/zz-boundary.ts';

describe('assert_module_boundaries : frontière du module SYM Browser', () => {
  test.each([
    ["import { x } from '@runtime/core';", '@runtime/core'],
    ["import type { Db } from '@runtime/db';", '@runtime/db'],
    ["export { y } from '@runtime/worker';", '@runtime/worker'],
    ["import type { S } from '@sym/contracts';", '@sym/contracts'],
    ["import '@sym/contracts/strategy';", '@sym/contracts/strategy'],
    ["import { z } from '../../../../../packages/core/src/index.js';", '../../../../../packages/core/src/index.js'],
    ["export * from '../../../../../apps/worker/src/browser/pool.js';", '../../../../../apps/worker/src/browser/pool.js'],
    ["const m = await import('@runtime/llm');\nexport { m };", '@runtime/llm'],
    ["import { w } from '/opt/runtime/packages/core/src/index.ts';", '/opt/runtime/packages/core/src/index.ts'],
    ["type T = import('@runtime/agent').Agent;\nexport type { T };", '@runtime/agent'],
    // Formes de contournement (revue browser-0.1) : gabarit sans expression, createRequire, require.resolve, module.require.
    ["const m = await import(`@runtime/core`);\nexport { m };", '@runtime/core'],
    ["const m = require(`@runtime/core`);\nexport { m };", '@runtime/core'],
    ["import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const m = r('@runtime/db');", '@runtime/db'],
    ["import { createRequire } from 'node:module';\nexport const m = createRequire(import.meta.url)('@runtime/core');", '@runtime/core'],
    ["import module from 'node:module';\nconst r = module.createRequire(import.meta.url);\nexport const m = r('@runtime/llm');", '@runtime/llm'],
    ["import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const p = r.resolve('@runtime/core');", '@runtime/core'],
    ["export const p = require.resolve('@runtime/core');", '@runtime/core'],
    ["export const m = module.require('@runtime/agent');", '@runtime/agent'],
    // Lien node_modules de pnpm : le chemin reste dans le module mais la cible (lien symbolique) en sort.
    ["export { BROWSER_ENGINE } from '../node_modules/@sym/contracts/src/browser/version.js';", '../node_modules/@sym/contracts/src/browser/version.js'],
    ["export { x } from '../../../node_modules/@runtime/core/dist/index.js';", '../../../node_modules/@runtime/core/dist/index.js'],
  ])('refusé : %s', async (code, specifier) => {
    const found = await violations(GATEWAY, code);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(specifier);
  });

  test('refusé aussi dans un composant .vue de la console', async () => {
    const found = await violations('modules/browser/apps/console/src/ZzBoundary.vue', "<script setup lang=\"ts\">\nimport { api } from '@runtime/client';\nvoid api;\n</script>\n<template><p /></template>\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('@runtime/client');
  });

  test.each([
    ['zz-boundary.cts', "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const m: unknown = r('@runtime/core');\n"],
    ['zz-boundary.cjs', "module.exports = require('@runtime/core');\n"],
    ['zz-boundary.tsx', "import { x } from '@runtime/core';\nexport const el = <div>{String(x)}</div>;\n"],
    ['zz-boundary.jsx', "import { x } from '@runtime/core';\nexport const el = <div>{x}</div>;\n"],
  ])('refusé aussi dans un fichier %s', async (name, code) => {
    const found = await violations(`modules/browser/apps/gateway/src/${name}`, code);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('@runtime/core');
  });

  test('symlinks : un chemin interne dont la cible réelle sort du module est refusé', () => {
    const file = join(MODULE_ROOT, 'apps/gateway/src/zz.ts');
    // apps/gateway/node_modules/@sym/contracts : lien pnpm vers runtime/packages/contracts.
    expect(boundaryViolation('../node_modules/@sym/contracts/package.json', file)).toBeDefined();
    expect(boundaryViolation('./describe.js', file)).toBeUndefined();
    // Lien symbolique hors node_modules : la cible réelle (fs.realpathSync) décide, pas le chemin écrit.
    const link = join(MODULE_ROOT, 'tests', '.zz-link-out');
    rmSync(link, { force: true });
    symlinkSync(join(runtimeDir, 'packages', 'core'), link, 'dir');
    try {
      expect(boundaryViolation('./.zz-link-out/package.json', join(MODULE_ROOT, 'tests', 'zz.ts'))).toBeDefined();
      expect(boundaryViolation('./.zz-link-out/src/absent.js', join(MODULE_ROOT, 'tests', 'zz.ts'))).toBeDefined();
    } finally {
      rmSync(link, { force: true });
    }
  });

  test('permis : createRequire et require.resolve vers un paquet npm ou un module de Node', async () => {
    const code = [
      "import { createRequire } from 'node:module';",
      'const r = createRequire(import.meta.url);',
      "export const v = r('vue');",
      "export const p = r.resolve('playwright-core/package.json');",
      "export const f = createRequire(import.meta.url)('node:fs');",
    ].join('\n');
    expect(await violations(GATEWAY, code)).toEqual([]);
  });

  test('permis : contrat browser, packages/ui, paquets du module, chemins internes, Node et npm', async () => {
    const code = [
      "import type { Session } from '@sym/contracts/browser';",
      "import { SymSignature } from '@runtime/ui';",
      "import '@runtime/ui/theme.css';",
      "import { isServiceMode } from '@sym-browser/core';",
      "import { describeRole } from './describe.js';",
      "import { TABLES } from '../../../packages/db/src/index.js';",
      "import { readFileSync } from 'node:fs';",
      "import { createApp } from 'vue';",
      'export type { Session };',
      'export { SymSignature, isServiceMode, describeRole, TABLES, readFileSync, createApp };',
    ].join('\n');
    expect(await violations(GATEWAY, code)).toEqual([]);
  });

  test('hors du module, la règle ne s’applique pas (Core importe librement ses paquets)', async () => {
    expect(await violations('apps/worker/src/zz-boundary.ts', "import { x } from '@runtime/core';\nexport { x };")).toEqual([]);
  });

  test('boundaryViolation : sortie du module détectée quelle que soit la profondeur', () => {
    const deep = join(MODULE_ROOT, 'apps/gateway/src/a/b/c.ts');
    expect(boundaryViolation('../../../../../../packages/core/src/index.js', deep)).toBeDefined();
    expect(boundaryViolation('../../../../../packages/sdk/src/index.js', deep)).toBeUndefined();
    expect(boundaryViolation('../../../../../../browser/packages/sdk/src/index.js', deep)).toBeUndefined();
    expect(boundaryViolation('../../../../../../../packages/ui/src/index.ts', deep)).toBeDefined();
    expect(boundaryViolation('file:///etc/passwd', deep)).toBeDefined();
  });

  test('en CLI : `eslint` sort en code 1 et nomme l’import interdit', () => {
    const bin = join(dirname(createRequire(import.meta.url).resolve('eslint/package.json')), 'bin/eslint.js');
    let status = 0;
    let output = '';
    try {
      execFileSync(process.execPath, [bin, '--stdin', '--stdin-filename', GATEWAY], { cwd: runtimeDir, input: "import { x } from '@runtime/core';\nexport { x };\n", encoding: 'utf8' });
    } catch (error) {
      const failure = error as { status: number; stdout: string };
      status = failure.status;
      output = failure.stdout;
    }
    expect(status).toBe(1);
    expect(output).toContain(RULE);
    expect(output).toContain('@runtime/core');
  });
});
