// SPDX-License-Identifier: AGPL-3.0-only
// assert_no_fingerprint_spoofing (INV6, X2, tâche 1.11, décision du 2026-10-01), volet statique : aucune dépendance
// « stealth », aucun code qui touche `navigator.webdriver`, le matériel, le fuseau, la langue ou les indices clients
// (`userAgentMetadata`), aucune rotation de User-Agent. Seul admis : le User-Agent exact du moteur, posé par
// `Emulation.setUserAgentOverride` dans un module unique (`USER_AGENT_OVERRIDE`) avec les indices clients RELUS sur le
// moteur (`getHighEntropyValues` d'un contexte vierge, aucune valeur écrite dans le code), ou par `--user-agent` au
// lancement. L'option `userAgent` de Playwright est refusée : elle déduit de la chaîne des indices clients inventés
// (architecture « x86 », version de plateforme de la chaîne). Le volet dynamique (commandes CDP réellement envoyées,
// `navigator.webdriver` vrai dans la page, chaîne stable entre runs) est dans tests/browser/engine-user-agent.security.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { findDenied } from '../scripts/check-blacklist.ts';

const root = new URL('..', import.meta.url).pathname;
/** Seul module autorisé à poser `Emulation.setUserAgentOverride` (indices clients relus sur le moteur). */
const USER_AGENT_OVERRIDE = 'apps/worker/src/browser/user-agent-override.ts';
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

/** Code de production qui pilote Chromium ou émet les requêtes du robot (worker, agent, accès, réseau, exécution, tunnel), hors tests, sans les lignes de commentaire. */
function productionCode(): { file: string; code: string }[] {
  const files = ['apps/worker/src', 'packages/agent/src', 'packages/core/src/access', 'packages/core/src/agent', 'packages/core/src/exec', 'packages/core/src/net', 'packages/core/src/tunnel'].flatMap((dir) =>
    walk(join(root, dir), (f) => /\.(ts|mts|js|mjs)$/.test(f) && !/\.(unit|prop|integration|contract|security|image)\.test\.ts$/.test(f) && !f.includes('/testing/')),
  );
  return files.map((file) => ({
    file: relative(root, file),
    code: readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n'),
  }));
}

describe('assert_no_fingerprint_spoofing : volet statique', () => {
  test('aucune dépendance « stealth » ni d’empreinte (pnpm check:blacklist)', () => {
    expect(findDenied(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))).toEqual([]);
  });

  test('aucun code ne falsifie l’empreinte : webdriver, matériel, fuseau, langue, indices clients, plugins', () => {
    const code = productionCode();
    expect(code.length).toBeGreaterThan(60);
    const FORBIDDEN: [string, RegExp][] = [
      ['navigator.webdriver', /webdriver/i],
      ['setHardwareConcurrencyOverride', /setHardwareConcurrencyOverride|hardwareConcurrency|deviceMemory/],
      ['setNavigatorOverrides', /setNavigatorOverrides/],
      ['userAgentMetadata ou setUserAgentOverride hors du module unique', /userAgentMetadata|setUserAgentOverride/],
      ['option userAgent de Playwright (indices clients déduits de la chaîne)', /newContext\(\{[^)]*\buserAgent\s*[:,}]/s],
      ['fuseau ou langue trompeurs', /setTimezoneOverride|setLocaleOverride|timezoneId|\blocale\s*:/],
      ['géolocalisation simulée', /setGeolocationOverride|\bgeolocation\s*:/],
      ['plugins ou langues du navigateur réécrits', /navigator\.(plugins|languages|platform|vendor)|navigator\s*,\s*['"](plugins|languages|platform|vendor)/],
      ['injection de profil de matériel', /Object\.defineProperty\(\s*navigator\s*,/],
      ['rotation de User-Agent', /user-?agents?(List|Pool|s)\b|rotateUserAgent|randomUserAgent/i],
      ['paquet de furtivité', /stealth|puppeteer-extra|playwright-extra|fingerprint-(injector|generator)|undetected/i],
    ];
    for (const [label, pattern] of FORBIDDEN) {
      const hits = code.filter((c) => pattern.test(c.code) && !(c.file === USER_AGENT_OVERRIDE && /userAgentMetadata/.test(label))).map((c) => c.file);
      expect(hits, label).toEqual([]);
    }
  });

  test('module unique du User-Agent : indices clients relus sur le moteur, aucune valeur de plateforme, d’architecture ni de marque écrite', () => {
    const module = productionCode().find((c) => c.file === USER_AGENT_OVERRIDE);
    expect(module, USER_AGENT_OVERRIDE).toBeDefined();
    const code = module!.code;
    expect(code).toMatch(/getHighEntropyValues/);
    expect(code).toMatch(/Emulation\.setUserAgentOverride/);
    // Aucun littéral de plateforme, d'architecture, de bitness, de modèle ou de marque : tout vient du moteur.
    expect(code).not.toMatch(/['"`](x86|arm|arm64|Windows|macOS|Linux|Android|iOS|Chrome OS|Chromium|Google Chrome|HeadlessChrome|Not[ _.;A-Za-z]*Brand|32|64)['"`]/);
    // Ni langue, ni plateforme de `navigator.platform` surchargées.
    expect(code).not.toMatch(/acceptLanguage|\bplatform\s*:\s*['"`]/);
  });

  test('aucune copie du User-Agent de l’utilisateur côté serveur dans le chemin d’exécution', () => {
    const copies = productionCode()
      .filter((c) => /headers\[['"]user-agent['"]\]|headers\.get\(['"]user-agent['"]\)/i.test(c.code))
      .map((c) => c.file);
    expect(copies).toEqual([]);
  });
});
