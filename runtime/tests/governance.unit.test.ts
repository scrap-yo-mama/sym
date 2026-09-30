// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.7 : gouvernance open source (16 §1, §2, §8). Fichiers présents, licences cohérentes, SPDX, CLA présent mais désactivé.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addHeader, commentPrefix, expectedLicense, findSpdx, listSources, MIT_PACKAGES, missingHeaders } from '../scripts/spdx-headers.ts';

const runtimeDir = new URL('..', import.meta.url).pathname;
const repoRoot = join(runtimeDir, '..');
const rt = (file: string): string => readFileSync(join(runtimeDir, file), 'utf8');
const gh = (file: string): string => readFileSync(join(repoRoot, file), 'utf8');

const LAWYER = /à valider par un avocat/i;

describe('gouvernance : fichiers obligatoires (4.7)', () => {
  test('fichiers présents', () => {
    const inRuntime = [
      'LICENSE', 'LICENSES/MIT.txt', 'NOTICE', 'TRADEMARK.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
      'CLA.md', 'DCO.md', 'docs/hors-perimetre.md', ...MIT_PACKAGES.map((p) => `${p}/LICENSE`),
    ];
    for (const file of inRuntime) expect(existsSync(join(runtimeDir, file)), file).toBe(true);
    const inRepo = [
      '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml',
      '.github/ISSUE_TEMPLATE/documentation.yml', '.github/ISSUE_TEMPLATE/config.yml',
      '.github/cla/cla-assistant.json', '.github/workflows/cla.yml',
    ];
    for (const file of inRepo) expect(existsSync(join(repoRoot, file)), file).toBe(true);
  });

  test('LICENSE : AGPL-3.0 intégral ; paquets MIT : texte MIT identique à LICENSES/MIT.txt', () => {
    const agpl = rt('LICENSE');
    expect(agpl).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(agpl).toContain('Version 3, 19 November 2007');
    expect(agpl).toContain('END OF TERMS AND CONDITIONS');
    const mit = rt('LICENSES/MIT.txt');
    expect(mit.startsWith('MIT License')).toBe(true);
    expect(mit).not.toMatch(/<year>|<copyright holders>/);
    for (const pkg of MIT_PACKAGES) {
      expect(rt(`${pkg}/LICENSE`), pkg).toBe(mit);
      expect((JSON.parse(rt(`${pkg}/package.json`)) as { license: string }).license, pkg).toBe('MIT');
    }
  });

  test('tout paquet du workspace déclare sa licence ; seuls client et schemas sont MIT', () => {
    const manifests = ['package.json', 'fixtures/package.json'];
    for (const group of ['packages', 'apps']) {
      for (const entry of readdirSync(join(runtimeDir, group), { withFileTypes: true })) {
        if (entry.isDirectory()) manifests.push(`${group}/${entry.name}/package.json`);
      }
    }
    for (const manifest of manifests) {
      const license = (JSON.parse(rt(manifest)) as { license?: string }).license;
      const dir = manifest.replace(/\/?package\.json$/, '');
      const expected = (MIT_PACKAGES as readonly string[]).includes(dir) ? 'MIT' : 'AGPL-3.0-only';
      expect(license, manifest).toBe(expected);
    }
  });

  test('client et schemas n\'importent jamais le cœur (le sens inverse serait silencieux)', () => {
    for (const pkg of MIT_PACKAGES) {
      const manifest = JSON.parse(rt(`${pkg}/package.json`)) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          expect(name, `${pkg} ${field}`).not.toMatch(/^@runtime\/(core|db|llm|server|worker|cli)$/);
        }
      }
      const sources = listSources(runtimeDir).filter((f) => f.startsWith(`${pkg}/src/`));
      for (const file of sources) expect(rt(file), file).not.toMatch(/@runtime\/(core|db|llm|server|worker|cli)\b/);
    }
  });

  test('textes juridiques non officiels : marqués « à valider par un avocat »', () => {
    for (const file of ['CLA.md', 'TRADEMARK.md', 'SECURITY.md', 'NOTICE', 'docs/hors-perimetre.md']) {
      expect(rt(file), file).toMatch(LAWYER);
    }
    expect(rt('CONTRIBUTING.md')).toMatch(LAWYER);
  });

  test('Contributor Covenant 3.0 : texte officiel, sans emplacement resté vide', () => {
    const coc = rt('CODE_OF_CONDUCT.md');
    expect(coc).toContain('# Contributor Covenant 3.0 Code of Conduct');
    for (const heading of ['## Our Pledge', '## Encouraged Behaviors', '## Restricted Behaviors', '## Reporting an Issue', '## Addressing and Repairing Harm', '## Scope', '## Attribution']) {
      expect(coc, heading).toContain(heading);
    }
    expect(coc).not.toContain('[NOTE:');
    expect(coc).toContain('https://www.contributor-covenant.org/version/3/0/');
  });

  test('SECURITY.md : canal privé et accusé de réception sous 72 h', () => {
    const security = rt('SECURITY.md');
    expect(security).toMatch(/72 heures/);
    expect(security).toMatch(/jamais par une issue/i);
    expect(security).toMatch(/signalement privé de vulnérabilité/i);
  });

  test('page « Hors périmètre » : X1 à X6, sans nom d\'outil de franchissement ni mode opératoire', () => {
    const page = rt('docs/hors-perimetre.md');
    for (const id of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6']) expect(page, id).toMatch(new RegExp(`\\| ${id} \\|`));
    expect(page).not.toMatch(/2captcha|capsolver|anti-?captcha|datadome|perimeterx|turnstile|undetected|puppeteer-extra|fingerprint/i);
    expect(page).not.toMatch(/```/);
    const contributing = rt('CONTRIBUTING.md');
    expect(contributing).toContain('docs/hors-perimetre.md');
    for (const id of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6']) expect(contributing, id).toContain(`(${id})`);
  });

  test('modèles d\'issues et de PR : diagnostic du bug, case « hors périmètre », DCO, X1 à X6', () => {
    expect(gh('.github/ISSUE_TEMPLATE/bug.yml')).toMatch(/Diagnostic \(obligatoire\)/);
    for (const file of ['bug', 'feature', 'documentation']) {
      expect(gh(`.github/ISSUE_TEMPLATE/${file}.yml`), file).toMatch(/Hors périmètre/);
    }
    expect(gh('.github/ISSUE_TEMPLATE/config.yml')).toMatch(/blank_issues_enabled:\s*false/);
    const pr = gh('.github/PULL_REQUEST_TEMPLATE.md');
    expect(pr).toMatch(/Signed-off-by/);
    expect(pr).toMatch(/X1 à X6/);
  });
});

describe('CLA et DCO (4.7)', () => {
  test('config CLA présente et non activée ; workflow CLA présent mais désactivé (workflow_dispatch seul)', () => {
    const config = JSON.parse(gh('.github/cla/cla-assistant.json')) as Record<string, unknown>;
    expect(config.active).toBe(false);
    expect(config['path-to-document']).toBe('runtime/CLA.md');
    expect(existsSync(join(repoRoot, 'runtime/CLA.md'))).toBe(true);

    const workflow = gh('.github/workflows/cla.yml');
    const on = /^on:\n((?:[ ]{2}.*\n|\n)+)/m.exec(workflow)?.[1] ?? '';
    const triggers = on.split('\n').filter((line) => /^ {2}[a-z_]+:/.test(line)).map((line) => line.trim().replace(/:.*/, ''));
    expect(triggers).toEqual(['workflow_dispatch']);
    expect(workflow).not.toMatch(/^\s*(pull_request_target|pull_request|issue_comment|push|schedule):/m);
    expect(workflow).toContain('path-to-document: runtime/CLA.md');
  });

  test('CLA.md : texte provisoire, non relu par un avocat, non cessionnaire', () => {
    const cla = rt('CLA.md');
    expect(cla).toMatch(/TEXTE PROVISOIRE/);
    expect(cla).toMatch(LAWYER);
    expect(cla).toMatch(/\| Relu par un avocat \| \*\*non\*\* \|/);
    expect(cla).toMatch(/Pas de cession/);
  });

  test('DCO 1.1 : texte officiel ; CONTRIBUTING demande le sign-off', () => {
    const dco = rt('DCO.md');
    expect(dco).toContain("Developer's Certificate of Origin 1.1");
    expect(dco).toContain('(d) I understand and agree that this project and the contribution');
    expect(rt('CONTRIBUTING.md')).toMatch(/Signed-off-by/);
  });

  // Critère du tableau 10 « le bot CLA bloque une PR non signée » : impossible sans dépôt publié ni bot activé.
  test.todo('le bot CLA bloque une PR non signée (reporté à la publication, tâche 4.5)');
});

describe('en-têtes SPDX (4.7)', () => {
  test('findSpdx, addHeader, commentPrefix', () => {
    expect(findSpdx('// SPDX-License-Identifier: MIT\nx')).toBe('MIT');
    expect(findSpdx('-- SPDX-License-Identifier: AGPL-3.0-only\nx')).toBe('AGPL-3.0-only');
    expect(findSpdx('#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-only\nx')).toBe('AGPL-3.0-only');
    expect(findSpdx('// autre\n// SPDX-License-Identifier: MIT\n')).toBeUndefined();
    expect(findSpdx('#!/bin/sh\nset -e\n')).toBeUndefined();
    expect(addHeader('const a = 1;\n', '//', 'MIT')).toBe('// SPDX-License-Identifier: MIT\nconst a = 1;\n');
    expect(addHeader('#!/bin/sh\nset -e\n', '#', 'AGPL-3.0-only')).toBe('#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-only\nset -e\n');
    expect(findSpdx(addHeader('#!/bin/sh\nset -e\n', '#', 'MIT'))).toBe('MIT');
    expect(commentPrefix('a/b.ts')).toBe('//');
    expect(commentPrefix('a/up.sql')).toBe('--');
    expect(commentPrefix('scripts/hooks/pre-commit')).toBe('#');
    expect(commentPrefix('README.md')).toBeUndefined();
    expect(commentPrefix('package.json')).toBeUndefined();
  });

  test('licence attendue par paquet', () => {
    expect(expectedLicense(runtimeDir, 'packages/client/src/index.ts')).toBe('MIT');
    expect(expectedLicense(runtimeDir, 'packages/schemas/src/index.ts')).toBe('MIT');
    expect(expectedLicense(runtimeDir, 'packages/core/src/index.ts')).toBe('AGPL-3.0-only');
    expect(expectedLicense(runtimeDir, 'apps/server/src/index.ts')).toBe('AGPL-3.0-only');
    expect(expectedLicense(runtimeDir, 'scripts/ci-local.ts')).toBe('AGPL-3.0-only');
  });

  test('chaque source du dépôt porte un en-tête, cohérent avec la licence de son paquet (pnpm spdx:add pour corriger)', () => {
    expect(missingHeaders(runtimeDir).map((m) => m.file)).toEqual([]);
    const sources = listSources(runtimeDir);
    expect(sources.length).toBeGreaterThan(50);
    const wrong: string[] = [];
    for (const file of sources) {
      const found = findSpdx(rt(file));
      const expected = expectedLicense(runtimeDir, file);
      if (found !== expected) wrong.push(`${file} : ${found ?? 'absent'} au lieu de ${expected}`);
    }
    expect(wrong).toEqual([]);
  });
});
