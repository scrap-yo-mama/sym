// SPDX-License-Identifier: AGPL-3.0-only
// Langue et fuseau de l'interface : jamais vers un site cible (tâche 3.20, 21 § 6, 21b M8, exclusion X2), volet statique.
//   assert_engine_project_has_no_locale : aucun contexte ni projet Playwright du MOTEUR ne fixe `locale` ni `timezoneId` (seuls les
//     projets d'interface `ui-en`, `ui-fr` et `ui-pseudo`, qui pilotent notre console, le peuvent) ;
//   assert_no_locale_cdp_override : aucune commande CDP de langue ou de fuseau, aucun `--lang` dans le code qui pilote Chromium ;
//   frontière : le code qui émet des requêtes vers un site (navigateur, réseau, accès, exécution, tunnel, bac à sable) ne lit ni
//     `users.locale`, ni `default_locale`, ni `runs.locale`, ni `users.timezone`, et n'importe pas `@runtime/i18n`.
// Le volet dynamique (vrai Chromium, en-têtes reçus, commandes CDP envoyées) : tests/browser/engine-accept-language.security.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

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

const isProduction = (f: string): boolean => /\.(ts|mts|js|mjs)$/.test(f) && !/\.(unit|prop|integration|contract|security|image|e2e)\.test\.ts$/.test(f) && !/\.e2e\.ts$/.test(f) && !f.includes('/testing/');
const code = (file: string): string =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

/** Code qui pilote Chromium ou émet les requêtes du robot vers un site cible. */
const ENGINE_DIRS = [
  'apps/worker/src/browser',
  'apps/worker/src/sandbox',
  'apps/worker/src/tunnel',
  'packages/core/src/net',
  'packages/core/src/access',
  'packages/core/src/exec',
  'packages/core/src/tunnel',
  'apps/extension/src/core',
];
const ENGINE_FILES = ['packages/agent/src/playwright-channel.ts', 'packages/agent/src/tunnel-channel.ts', 'packages/agent/src/snapshot.ts', 'packages/agent/src/stagehand-engine.ts', 'packages/agent/src/stagehand-guards.ts'];

function engineCode(): { file: string; code: string }[] {
  const files = [...ENGINE_DIRS.flatMap((dir) => walk(join(root, dir), isProduction)), ...ENGINE_FILES.map((f) => join(root, f))];
  return files.map((file) => ({ file: relative(root, file), code: code(file) }));
}

describe('assert_engine_project_has_no_locale', () => {
  test('aucun newContext, launch ni launchPersistentContext du moteur ne fixe locale, timezoneId ni géolocalisation', () => {
    const sources = engineCode();
    expect(sources.length).toBeGreaterThan(40);
    for (const { file, code: text } of sources) {
      for (const [, call] of text.matchAll(/(?:newContext|launchPersistentContext|launch|newPage)\(\s*(\{[^)]*\})/gs)) {
        expect(call, `${file} : option de langue ou de fuseau`).not.toMatch(/\b(locale|timezoneId|geolocation|permissions)\s*:/);
      }
      expect(text, file).not.toMatch(/\btimezoneId\b/);
    }
  });

  test('les projets Playwright qui fixent locale ou timezoneId sont ceux de l’interface seulement (ui-en, ui-fr, ui-pseudo)', () => {
    const configs = [...walk(root, (f) => /playwright\.config\.ts$/.test(f)), join(root, 'tests/e2e/playwright.config.ts')];
    const flagged = new Set<string>();
    for (const file of new Set(configs)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!/\b(locale|timezoneId)\s*:/.test(text)) continue;
      // Chaque configuration qui fixe une langue ou un fuseau pilote notre console, jamais le moteur : elle le dit dans son en-tête.
      flagged.add(relative(root, file));
      expect(text, `${relative(root, file)} doit nommer un projet d'interface`).toMatch(/ui-(en|fr|pseudo)|console|interface/i);
    }
    // Le moteur n'a pas de projet Playwright : il est piloté par `playwright-core` dans le worker (contrôlé ci-dessus).
    for (const file of flagged) expect(file).not.toMatch(/apps\/worker|packages\/(core|agent)/);
  });
});

describe('assert_no_locale_cdp_override', () => {
  test('aucune commande CDP de langue, de fuseau ou de géolocalisation, aucun --lang, dans le code du moteur', () => {
    const FORBIDDEN: [string, RegExp][] = [
      ['Emulation.setLocaleOverride', /setLocaleOverride/],
      ['Emulation.setTimezoneOverride', /setTimezoneOverride/],
      ['Emulation.setAcceptLanguage ou acceptLanguage', /setAcceptLanguage|acceptLanguage/],
      ['Emulation.setGeolocationOverride', /setGeolocationOverride/],
      ['argument --lang', /['"`]--(lang|accept-lang|force-lang)\b/],
      ['en-tête Accept-Language ajouté à un contexte (setExtraHTTPHeaders)', /setExtraHTTPHeaders\([^)]*accept-language/is],
    ];
    const sources = engineCode();
    for (const [label, pattern] of FORBIDDEN) {
      const hits = sources.filter((s) => pattern.test(s.code)).map((s) => s.file);
      expect(hits, label).toEqual([]);
    }
  });
});

describe('frontière langue d’interface / requêtes vers un site (21 § 6)', () => {
  test('le code du moteur n’importe pas @runtime/i18n et ne lit ni langue de compte, ni langue d’instance, ni langue de run, ni fuseau', () => {
    const sources = engineCode();
    for (const { file, code: text } of sources) {
      expect(text, `${file} : import du paquet de langues`).not.toMatch(/@runtime\/i18n/);
      expect(text, `${file} : langue ou fuseau de l'interface`).not.toMatch(/users\.locale|default_locale|DEFAULT_LOCALE|runs\.locale|users\.timezone|proseLocale|\bm?essage_locale\b|resolveLocale/);
    }
  });

  test('la seule langue envoyée à un site est la constante du moteur (ENGINE_ACCEPT_LANGUAGE), posée par le client HTTP', () => {
    const session = readFileSync(join(root, 'packages/core/src/net/modes/session.ts'), 'utf8');
    expect(session).toMatch(/headers\.set\('accept-language', ENGINE_ACCEPT_LANGUAGE\)/);
    const hits = engineCode().filter((s) => /['"]accept-language['"]/i.test(s.code) && s.file !== 'packages/core/src/net/modes/session.ts').map((s) => s.file);
    // Les listes d'en-têtes inter-origines (bac à sable, fetch) NOMMENT l'en-tête pour le filtrer ; aucun ne l'écrit.
    for (const file of hits) expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/\.set\(\s*['"]accept-language['"]/i);
  });
});
