// SPDX-License-Identifier: AGPL-3.0-only
// Documentation de SYM Browser (cdc/sym-browser 06, tâche 3.8) : quickstart, guides (SDK, déploiement, nœuds, topologies avec
// SYM ou isolée), un guide par client CDP de 04f § 7, référence générée (API depuis l'OpenAPI du contrat, configuration
// depuis le catalogue d'environnement). Français au tutoiement et anglais, mêmes pages dans les deux langues, voix SYM.
// Le quickstart lui-même est rejoué de bout en bout par tests/docs-quickstart.chromium.test.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { browserOpenApi } from '@sym/contracts/browser';
import { describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';
import { BROWSER_ENV_CATALOG } from '../packages/core/src/config/env-catalog.ts';
import { DOC_LOCALES, DOC_PAGES, codeBlocks, extractQuickstart, proseOf } from '../scripts/docs-lib.ts';
import { ENV_DESCRIPTIONS_EN, REFERENCE_PAGES, renderReference } from '../scripts/docs-reference.ts';

const DOCS = join(MODULE_ROOT, 'docs');
const read = (path: string) => readFileSync(join(DOCS, path), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [relative(DOCS, path)];
  });
}

describe('pages : mêmes pages en fr et en en', () => {
  test('liste attendue (quickstart, guides, un guide par client CDP de 04f § 7, référence), rien d’autre que du Markdown', () => {
    expect(DOC_PAGES).toEqual([
      'README.md',
      'quickstart.md',
      'sdk.md',
      'deployment.md',
      'nodes.md',
      'topologies.md',
      'clients/README.md',
      'clients/playwright.md',
      'clients/puppeteer.md',
      'clients/stagehand.md',
      'clients/browser-use.md',
      'clients/skyvern.md',
      'clients/playwright-mcp.md',
      'clients/chrome-devtools-mcp.md',
      'reference/api.md',
      'reference/configuration.md',
    ]);
    const expected = ['README.md', ...DOC_LOCALES.flatMap((locale) => DOC_PAGES.map((page) => join(locale, page)))].sort();
    expect(files(DOCS).sort()).toEqual(expected);
  });

  test('chaque page commence par un seul titre de niveau 1', () => {
    for (const locale of DOC_LOCALES) {
      for (const page of DOC_PAGES) {
        const prose = proseOf(read(join(locale, page)));
        expect(prose.trimStart().startsWith('# '), `${locale}/${page}`).toBe(true);
        expect(prose.match(/^# /gm), `${locale}/${page}`).toHaveLength(1);
      }
    }
  });

  test('liens relatifs : chaque cible existe (et reste dans la langue de la page, sauf le choix de langue)', () => {
    for (const path of files(DOCS)) {
      const text = proseOf(read(path));
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = match[1]!;
        if (/^(https?:|mailto:|#)/.test(href)) continue;
        const target = resolve(dirname(join(DOCS, path)), href.split('#')[0]!);
        expect(existsSync(target), `${path} → ${href}`).toBe(true);
        if (path !== 'README.md' && !href.startsWith('../../')) {
          expect(relative(DOCS, target).split('/')[0], `${path} → ${href}`).toBe(path.split('/')[0]);
        }
      }
    }
  });
});

describe('langue et voix', () => {
  test('français au tutoiement : ni « vous », ni « votre », ni « vos » hors des blocs de code', () => {
    for (const page of DOC_PAGES) {
      const prose = proseOf(read(join('fr', page)));
      expect(prose.match(/\b(vous|votre|vos)\b/gi), `fr/${page}`).toBeNull();
    }
  });

  test('voix SYM : « SYM 👻 : » en français (espace insécable), « SYM 👻: » en anglais, sur l’accueil et le quickstart', () => {
    for (const page of ['README.md', 'quickstart.md']) {
      expect(read(join('fr', page)), `fr/${page}`).toContain('SYM 👻 :');
      expect(read(join('en', page)), `en/${page}`).toContain('SYM 👻:');
    }
  });

  test('aucun secret réel : clés et MASTER_KEY sont générées ou factices', () => {
    for (const path of files(DOCS)) {
      const text = read(path);
      // Une MASTER_KEY écrite en dur (44 caractères base64) ou une clé d'API complète n'ont rien à faire dans la doc.
      expect(text.match(/MASTER_KEY=[A-Za-z0-9+/]{42,}={0,2}/g), path).toBeNull();
      expect(text.match(/symb_live_[A-Za-z0-9]{20,}/g), path).toBeNull();
    }
  });

  test('exemples Python (browser-use, Skyvern) seulement dans des blocs de code, jamais en fichier', () => {
    for (const locale of DOC_LOCALES) {
      for (const page of ['clients/browser-use.md', 'clients/skyvern.md']) {
        const text = read(join(locale, page));
        expect(codeBlocks(text).some((b) => b.info.startsWith('python')), `${locale}/${page}`).toBe(true);
        expect(proseOf(text), `${locale}/${page}`).not.toMatch(/^\s*(from|import) [a-z_]+/m);
      }
    }
    expect(files(DOCS).filter((f) => /\.(py|pyc|ipynb)$/.test(f))).toEqual([]);
  });
});

describe('quickstart', () => {
  test('même code en fr et en en (les commentaires seuls diffèrent), avec la session, CDP et la libération', () => {
    const fr = extractQuickstart(read('fr/quickstart.md'));
    const en = extractQuickstart(read('en/quickstart.md'));
    expect(fr.code).toBe(en.code);
    expect(en.blocks).toBeGreaterThanOrEqual(3);
    expect(en.code).toContain("from 'playwright-core'");
    expect(en.code).toContain('/v1/sessions');
    expect(en.code).toContain('chromium.connectOverCDP(session.connectUrls.cdp)');
    expect(en.code).toMatch(/method: 'DELETE'/);
    expect(en.code).toContain('process.env.SYMB_URL');
    expect(en.code).toContain('process.env.SYMB_API_KEY');
  });

  test("docker run de l'image de la doc : seccomp, no-new-privileges et --cap-drop ALL, MASTER_KEY générée", () => {
    for (const path of files(DOCS)) {
      for (const block of codeBlocks(read(path))) {
        // Seules les commandes qui lancent l'image SYM Browser (pas celle de PostgreSQL).
        const commands = block.code.replace(/\\\n\s*/g, ' ').split('\n').filter((line) => /\bdocker run\b/.test(line) && line.includes('sym-browser:'));
        for (const line of commands) {
          expect(line, path).toContain('--security-opt seccomp=');
          expect(line, path).toContain('--security-opt no-new-privileges');
          expect(line, path).toContain('--cap-drop ALL');
          // MASTER_KEY : générée sur place, ou exportée avant (et sauvegardée) puis passée par `-e MASTER_KEY` ; jamais écrite.
          for (const m of line.matchAll(/MASTER_KEY(=\S*)?/g)) expect(m[1] ?? '', path).toMatch(/^(|="?\$\(openssl rand -base64 32\)"?|="?\$\{?MASTER_KEY\}?"?)$/);
        }
      }
    }
    expect(codeBlocks(read('en/quickstart.md')).some((b) => /\bdocker run\b/.test(b.code))).toBe(true);
  });
});

describe('guides', () => {
  const mentions: Record<string, string[]> = {
    'deployment.md': ['SYMB_MODE', 'MASTER_KEY', 'DATABASE_URL', 'PORT', 'OBJECT_STORE', '/healthz', '/readyz', '--check-config'],
    'nodes.md': ['SYMB_MODE=gateway', 'SYMB_MODE=node', 'NODE_TOKEN', 'NODE_PUBLIC_URL', 'MAX_SESSIONS', 'WARM_BROWSERS', 'SHUTDOWN_GRACE_SECONDS', '/v1/admin/nodes'],
    'topologies.md': ['BROWSER_URL', 'BROWSER_API_KEY', 'SYMB_BOOTSTRAP_API_KEY', 'MASTER_KEY', 'DATABASE_URL'],
    'sdk.md': ['@sym-browser/sdk', 'SYMB_URL', 'SYMB_API_KEY', 'connectCDP', 'connect(', 'events(', 'await using'],
  };
  for (const [page, words] of Object.entries(mentions)) {
    test(`${page} : ${words.join(', ')}`, () => {
      for (const locale of DOC_LOCALES) for (const word of words) expect(read(join(locale, page)), `${locale}/${page} : ${word}`).toContain(word);
    });
  }

  test('topologies : avec SYM (non isolée), isolée, développement', () => {
    expect(read('fr/topologies.md')).toMatch(/Avec SYM[\s\S]*Isolée[\s\S]*Développement/);
    expect(read('en/topologies.md')).toMatch(/With SYM[\s\S]*Isolated[\s\S]*Development/);
  });

  test('guide SDK : bandeau « à relire » tant que le client de la tâche 3.4 n’est pas dans packages/sdk', () => {
    const sdkHasClient = /class SymBrowser\b/.test(readFileSync(join(MODULE_ROOT, 'packages/sdk/src/index.ts'), 'utf8'));
    expect(read('fr/sdk.md').includes('À relire avec la tâche 3.4')).toBe(!sdkHasClient);
    expect(read('en/sdk.md').includes('To review with task 3.4')).toBe(!sdkHasClient);
  });
});

describe('un guide par client CDP (04f § 7)', () => {
  const CLIENTS: Record<string, { params: string[]; bearer: boolean; lang: string }> = {
    'playwright.md': { params: ['chromium.connectOverCDP', 'connectUrls.cdp', 'headers'], bearer: true, lang: 'ts' },
    'puppeteer.md': { params: ['puppeteer.connect', 'browserWSEndpoint', 'headers'], bearer: true, lang: 'ts' },
    'stagehand.md': { params: ['localBrowserLaunchOptions', 'cdpUrl'], bearer: false, lang: 'ts' },
    'browser-use.md': { params: ['cdp_url'], bearer: false, lang: 'python' },
    'skyvern.md': { params: ['BROWSER_TYPE=cdp-connect', 'BROWSER_REMOTE_DEBUGGING_URL'], bearer: false, lang: 'python' },
    'playwright-mcp.md': { params: ['@playwright/mcp', '--cdp-endpoint', '--cdp-header'], bearer: true, lang: 'json' },
    'chrome-devtools-mcp.md': { params: ['chrome-devtools-mcp', '--wsEndpoint', '--wsHeaders'], bearer: true, lang: 'json' },
  };
  for (const [page, client] of Object.entries(CLIENTS)) {
    test(`clients/${page} : ${client.params.join(', ')}${client.bearer ? ', jeton en Bearer possible' : ', jeton en query'}`, () => {
      for (const locale of DOC_LOCALES) {
        const text = read(join(locale, 'clients', page));
        for (const param of client.params) expect(text, `${locale}/clients/${page} : ${param}`).toContain(param);
        // Jeton de connexion en en-tête `Authorization: Bearer` pour les clients qui le permettent (la création de session,
        // elle, passe toujours la clé d'API en Bearer : on ne teste donc pas l'absence du mot pour les autres).
        if (client.bearer) expect(text, `${locale}/clients/${page} : Bearer`).toMatch(/Bearer (\$\{token\}|<connect token>|<jeton de connexion>)/);
        expect(text, `${locale}/clients/${page} : jeton en query`).toContain('?token=');
        expect(codeBlocks(text).some((b) => b.info.startsWith(client.lang)), `${locale}/clients/${page} : bloc ${client.lang}`).toBe(true);
      }
    });
  }

  test('index des clients : un lien par guide', () => {
    for (const locale of DOC_LOCALES) {
      const index = read(join(locale, 'clients/README.md'));
      for (const page of Object.keys(CLIENTS)) expect(index, `${locale}/clients/README.md → ${page}`).toContain(`](${page})`);
    }
  });
});

describe('référence générée (scripts/docs-reference.ts)', () => {
  test('fichiers à jour : régénérer avec `pnpm --filter @sym-browser/module docs:reference`', () => {
    for (const locale of DOC_LOCALES) {
      for (const page of REFERENCE_PAGES) {
        expect(read(join(locale, page)), `${locale}/${page}`).toBe(renderReference(locale, page));
      }
    }
  });

  test('API : chaque opération de l’OpenAPI du contrat, ses statuts et chaque code d’erreur', () => {
    for (const locale of DOC_LOCALES) {
      const api = read(join(locale, 'reference/api.md'));
      for (const [path, operations] of Object.entries(browserOpenApi.paths)) {
        for (const method of Object.keys(operations as object)) expect(api, `${locale} ${method} ${path}`).toContain(`\`${method.toUpperCase()} /v1${path}\``);
      }
      for (const code of ['unauthorized', 'session_not_found', 'protocol_not_served', 'playwright_version_mismatch', 'no_node']) expect(api, code).toContain(`\`${code}\``);
      expect(api).toContain(browserOpenApi.info.version);
    }
  });

  test('configuration : chaque variable du catalogue, décrite en anglais aussi', () => {
    expect(Object.keys(ENV_DESCRIPTIONS_EN).sort()).toEqual(BROWSER_ENV_CATALOG.map((v) => v.name).sort());
    for (const locale of DOC_LOCALES) {
      const config = read(join(locale, 'reference/configuration.md'));
      for (const variable of BROWSER_ENV_CATALOG) expect(config, `${locale} ${variable.name}`).toContain(`\`${variable.name}\``);
    }
  });
});
