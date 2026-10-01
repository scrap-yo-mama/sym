// SPDX-License-Identifier: AGPL-3.0-only
// Compatibilité avec la CSP stricte de la console (08b § 2 : `script-src 'self'`, `style-src 'self'`) et garde contre le
// HTML non maîtrisé : ni script ni style en ligne dans le HTML servi, aucun `v-html` (jamais de HTML scrapé dans l'origine
// de la console ; un aperçu HTML passera par un <iframe sandbox> sans allow-same-origin, tâche 3.4).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const webRoot = new URL('..', import.meta.url).pathname;

function sources(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sources(full, ext) : ext.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

describe('CSP stricte', () => {
  const html = readFileSync(join(webRoot, 'index.html'), 'utf8');

  test('index.html : aucun script en ligne, aucun style en ligne, aucun gestionnaire d’événement', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  test('le script d’amorçage du thème est un fichier externe', () => {
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(readFileSync(join(webRoot, 'public/theme-init.js'), 'utf8')).toContain("classList.toggle('dark'");
  });

  test('aucun composant n’embarque de bloc <style> (le CSS passe par Tailwind, fichier externe au build)', () => {
    for (const file of sources(join(webRoot, 'src'), /\.vue$/)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/<style[\s>]/i);
  });

  test('aucun v-html, innerHTML ni insertAdjacentHTML dans la console', () => {
    for (const file of sources(join(webRoot, 'src'), /\.(vue|ts)$/)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/v-html|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});

// assert_no_csp_violation (tâche 3.15, 20b § 3.1) : les deux bancs E2E de la console (faux serveur d'API de apps/web/e2e, instance
// réelle de tests/e2e) la servent avec sa CSP stricte (08b § 2) et font échouer TOUT test de la console dès le premier événement
// `securitypolicyviolation` ; ce garde-fou statique vérifie le câblage, le témoin E2E de chaque banc prouve que le contrôle sait échouer.
describe('assert_no_csp_violation', () => {
  const read = (path: string): string => readFileSync(join(webRoot, path), 'utf8');
  const shared = read('e2e/csp.ts');
  const harness = read('e2e/harness.ts');
  const fixture = read('e2e/console.fixture.ts');
  const instance = read('../../tests/e2e/instance.ts');
  const journey = read('../../tests/e2e/invitation.e2e.ts');

  test('la CSP de 08b § 2 est définie une seule fois, sans unsafe-inline ni source tierce', () => {
    const csp = /export const CONSOLE_CSP =\s*"([^"]+)"/.exec(shared)?.[1] ?? '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"]) {
      expect(csp, directive).toContain(directive);
    }
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    for (const file of [harness, instance]) expect(file).not.toMatch(/default-src/);
  });

  test('chaque banc pose cette CSP sur chaque page servie de la console', () => {
    expect(harness).toMatch(/import \{[^}]*\bCONSOLE_CSP\b[^}]*\} from '\.\/csp\.ts'/);
    expect(harness).toContain("res.setHeader('content-security-policy', CONSOLE_CSP)");
    expect(instance).toMatch(/import \{[^}]*\bCONSOLE_CSP\b[^}]*\} from '\.\.\/\.\.\/apps\/web\/e2e\/csp\.ts'/);
    expect(instance).toContain("res.setHeader('content-security-policy', CONSOLE_CSP)");
  });

  test('le relevé partagé écoute securitypolicyviolation sur chaque page du contexte', () => {
    expect(shared).toContain("addEventListener('securitypolicyviolation'");
    expect(shared).toMatch(/context\.exposeBinding\(/);
    expect(shared).toMatch(/context\.addInitScript\(/);
  });

  test('la fixture et le parcours sur instance réelle s’en servent et échouent un test qui a laissé une violation', () => {
    expect(fixture).toMatch(/watchCspViolations\(/);
    expect(fixture).toMatch(/expect\(cspViolations,.*\)\.toEqual\(\[\]\)/);
    expect(journey).toMatch(/import \{[^}]*\bwatchCspViolations\b[^}]*\} from '\.\.\/\.\.\/apps\/web\/e2e\/csp\.ts'/);
    expect(journey).toMatch(/watchCspViolations\(context, cspViolations\)/);
    expect(journey).toMatch(/test\.afterEach\([^)]*\)\s*=>\s*\{?\s*expect\(cspViolations\.splice\(0\),.*\)\.toEqual\(\[\]\)/);
  });
});

// Le build de la console ne dépend que de la console : ni test d'intégration, ni serveur, ni base dans son typage.
// Le typecheck des tests (qui importent le serveur de test) a son propre tsconfig.
describe('assert_console_build_independent_of_server', () => {
  const readJson = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(webRoot, name), 'utf8')) as Record<string, unknown>;
  const pkg = readJson('package.json') as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  test('le build vérifie les types avec tsconfig.app.json, qui exclut les tests et ne sort pas de apps/web', () => {
    expect(pkg.scripts.build).toMatch(/^vue-tsc --noEmit -p tsconfig\.app\.json && vite build$/);
    const app = readJson('tsconfig.app.json') as { include: string[]; exclude?: string[] };
    expect(app.exclude).toContain('src/**/*.test.ts');
    for (const pattern of app.include) expect(pattern, pattern).not.toMatch(/\.\.|tests\//);
  });

  test('le typecheck couvre aussi les tests, par un tsconfig séparé', () => {
    expect(pkg.scripts.typecheck).toMatch(/-p tsconfig\.app\.json/);
    expect(pkg.scripts.typecheck).toMatch(/-p tsconfig\.test\.json/);
    const tests = readJson('tsconfig.test.json') as { include: string[] };
    expect(tests.include).toContain('src/**/*.test.ts');
  });

  test('aucune dépendance artificielle vers le serveur, la base ou les schémas (ordre de build de pnpm -r)', () => {
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(declared.filter((name) => ['@runtime/core', '@runtime/db', '@runtime/schemas'].includes(name))).toEqual([]);
  });
});

// HTML valide et hiérarchie des titres lisible par un lecteur d'écran : un titre ne s'imbrique pas dans un titre.
// `CardTitle` (shadcn-vue) rend un <h3> ; un <h1> posé dedans est invalide. Les tags axe WCAG ne le signalent pas.
describe('assert_no_nested_headings', () => {
  const headingOpen = /<h[1-6]\b/i;

  test('aucune vue ni aucun composant ne pose un titre <h1>-<h6> dans <CardTitle>', () => {
    for (const file of sources(join(webRoot, 'src'), /\.vue$/)) {
      const source = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      for (const match of source.matchAll(/<CardTitle\b[^>]*>([\s\S]*?)<\/CardTitle>/g)) {
        expect(match[1] ?? '', file).not.toMatch(headingOpen);
      }
    }
  });

  test('aucun titre n’en contient un autre', () => {
    for (const file of sources(join(webRoot, 'src'), /\.vue$/)) {
      const source = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      for (const match of source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) expect(match[2] ?? '', file).not.toMatch(headingOpen);
    }
  });

  test('la page de connexion a un <h1> dans l’en-tête de la carte, hors du <h3> de CardTitle', () => {
    const login = readFileSync(join(webRoot, 'src/views/LoginView.vue'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    expect(login).toMatch(/<CardHeader>\s*<h1\b/);
    expect(login).not.toMatch(/<CardTitle\b/);
  });
});
