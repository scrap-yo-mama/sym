// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.8 : « Build du site vert ». Construit le site pour de bon (pages générées, VitePress, versions Markdown, llms.txt,
// vérificateur de liens, index Pagefind) puis relit le résultat. Aucune publication : la sortie reste dans apps/docs/dist.
// - assert_docs_site_builds : `scripts/build.ts` sort en 0 et produit une page HTML, une version .md et une entrée llms.txt
//   par page, un index de recherche et aucun lien mort ;
// - assert_docs_no_external_resources : aucune page ne charge une ressource hors du site (INV9, « aucun traceur »).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { PAGES } from './nav.ts';
import { checkSite } from './site.ts';
import { withBuildLock } from './testing/build-lock.ts';
import { docsDir } from './testing/pages.ts';

const dist = join(docsDir, 'dist');
let output = '';

beforeAll(async () => {
  const result = await withBuildLock(docsDir, () => spawnSync('node', ['scripts/build.ts'], { cwd: docsDir, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DOCS_BASE: '/' } }));
  output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`la construction du site a échoué (code ${result.status}) :\n${output}`);
}, 300_000);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

describe('assert_docs_site_builds : le site se construit et passe ses contrôles', () => {
  test('la construction se termine par le résumé du vérificateur de liens et de l\'index de recherche', () => {
    expect(output).toMatch(/0 lien mort/);
    expect(output).toMatch(/\d+ pages indexées par Pagefind/);
  });

  test('chaque page du registre a sa page HTML, sa version Markdown et sa ligne dans llms.txt', () => {
    const llms = readFileSync(join(dist, 'llms.txt'), 'utf8');
    for (const page of PAGES) {
      expect(existsSync(join(dist, `${page.path}.html`)), `${page.path}.html`).toBe(true);
      const markdown = readFileSync(join(dist, `${page.path}.md`), 'utf8');
      expect(markdown.length, `${page.path}.md`).toBeGreaterThan(200);
      expect(markdown.startsWith('---'), `${page.path}.md : en-tête YAML retiré`).toBe(false);
      expect(llms, page.path).toContain(`(/${page.path}.md)`);
    }
  });

  test('chaque page HTML cite llms.txt, et le vérificateur de liens ne trouve rien', () => {
    expect(checkSite(dist, '/')).toEqual([]);
  });

  test('l\'index Pagefind est écrit et couvre les pages', () => {
    for (const file of ['pagefind.js', 'pagefind-ui.js', 'pagefind-ui.css', 'pagefind-entry.json']) expect(existsSync(join(dist, 'pagefind', file)), file).toBe(true);
    const entry = JSON.parse(readFileSync(join(dist, 'pagefind', 'pagefind-entry.json'), 'utf8')) as { languages: Record<string, { page_count: number }> };
    const total = Object.values(entry.languages).reduce((sum, language) => sum + language.page_count, 0);
    expect(total).toBeGreaterThanOrEqual(PAGES.length);
  });

  test('la page « Usage responsable » construite porte ses 11 sections', () => {
    const html = readFileSync(join(dist, 'explications/usage-responsable.html'), 'utf8');
    expect(html.match(/<h2 id="[^"]+"[^>]*>\s*(?:<span[^>]*>)?\d+\. /g)?.length).toBe(11);
    expect(html).toContain('Ceci n&#39;est pas un avis juridique.');
  });

  test('la référence REST construite liste les opérations disponibles et en préparation', () => {
    const html = readFileSync(join(dist, 'reference/rest.html'), 'utf8');
    expect(html).toContain('en préparation (3.1)');
    expect(html).toContain('disponible');
  });
});

describe('assert_docs_no_external_resources : aucune ressource ne vient d\'ailleurs', () => {
  test('aucun script, feuille de style, police ni image ne pointe hors du site', () => {
    const external = /(?:src|href)="(?:https?:)?\/\/(?!localhost)[^"]+"/g;
    const offenders: string[] = [];
    for (const file of walk(dist).filter((f) => /\.(html|css|js)$/.test(f) && !f.includes(`${join(dist, 'pagefind')}`))) {
      const text = readFileSync(file, 'utf8');
      if (file.endsWith('.html')) {
        // Les liens `<a href>` externes (sources citées) sont des liens, pas des ressources chargées.
        for (const match of text.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*>/g)) {
          // Une balise canonique ou d'alternative de langue désigne une page (adresse absolue voulue), elle ne charge rien.
          if (external.test(match[0]) && !/\brel="(?:canonical|alternate)"/.test(match[0])) offenders.push(`${file} : ${match[0].slice(0, 120)}`);
          external.lastIndex = 0;
        }
      } else {
        for (const match of text.matchAll(/url\((?:https?:)?\/\/[^)]+\)|@import\s+["']https?:/g)) offenders.push(`${file} : ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('aucun traceur : pas de balise de mesure ni de script d\'analyse connu', () => {
    for (const file of walk(dist).filter((f) => f.endsWith('.html'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/google-analytics|googletagmanager|gtag\(|plausible|matomo|segment\.com|hotjar|fullstory/i);
    }
  });
});
