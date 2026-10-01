// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.8 : llms.txt, versions Markdown, vérificateur de liens, pages de référence générées.
// - assert_llms_txt_cites_every_page : llms.txt liste chaque page une fois (lien vers sa version .md), llms-full.txt la contient ;
// - assert_docs_links_clean : le vérificateur de liens détecte lien mort, ancre absente, ressource externe, llms.txt non cité ;
// - assert_docs_rest_reference_generated : la référence REST couvre chaque opération de l'OpenAPI, l'état « en préparation » compris.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { PAGES } from './nav.ts';
import { renderReasonsReference } from './reasons-reference.ts';
import { listOperations, plain, renderRestReference, type OpenApiDocument } from './rest-reference.ts';
import { buildLlmsFull, buildLlmsTxt, checkSite, normalizeBase, siteLink, stripFrontmatter, writeLlmsFiles } from './site.ts';
import { handWritten, readSource, runtimeDir } from './testing/pages.ts';

describe('assert_llms_txt_cites_every_page : llms.txt et versions Markdown', () => {
  test('llms.txt a un titre, un résumé et chaque page une seule fois, avec le lien vers sa version .md', () => {
    const text = buildLlmsTxt('/');
    expect(text.startsWith('# Scrapyomama Runtime\n\n> ')).toBe(true);
    for (const page of PAGES) {
      const link = `(/${page.path}.md)`;
      expect(text.split(link).length - 1, page.path).toBe(1);
    }
    for (const heading of ['## Tutoriels', '## Guides pratiques', '## Référence', '## Explications']) expect(text).toContain(heading);
    expect(text).toContain('(/llms-full.txt)');
  });

  test('base et adresse publique : les liens suivent DOCS_BASE et DOCS_SITE_URL, sans doubler les barres', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('docs')).toBe('/docs/');
    expect(normalizeBase('/docs/')).toBe('/docs/');
    expect(siteLink('guides/render.md', '/docs/')).toBe('/docs/guides/render.md');
    expect(siteLink('llms.txt', '/', 'https://doc.example.org/')).toBe('https://doc.example.org/llms.txt');
    expect(buildLlmsTxt('/docs/', 'https://doc.example.org')).toContain('(https://doc.example.org/docs/tutoriels/quickstart.md)');
  });

  test('llms-full.txt contient le corps de chaque page, sans son en-tête YAML', () => {
    const full = buildLlmsFull((page) => (page.generated ? `# ${page.title}\n` : readSource(page)));
    for (const page of PAGES) expect(full, page.path).toContain(`<page path="${page.path}" quadrant="${page.quadrant}">`);
    expect(full).not.toMatch(/^description: /m);
    expect(stripFrontmatter('---\ntitle: x\n---\n# Corps')).toBe('# Corps');
  });

  test('les fichiers écrits : une version .md par page, llms.txt et llms-full.txt', () => {
    const dist = mkdtempSync(join(tmpdir(), 'zz_test_llms_'));
    const content = mkdtempSync(join(tmpdir(), 'zz_test_content_'));
    try {
      for (const page of PAGES) {
        mkdirSync(dirname(join(content, `${page.path}.md`)), { recursive: true });
        writeFileSync(join(content, `${page.path}.md`), page.generated ? `---\ntitle: x\n---\n# ${page.title}\n` : readSource(page));
      }
      writeLlmsFiles(content, dist, '/');
      for (const page of PAGES) expect(readFileSync(join(dist, `${page.path}.md`), 'utf8').startsWith('---')).toBe(false);
      expect(readFileSync(join(dist, 'llms.txt'), 'utf8')).toContain('/guides/render.md');
      expect(readFileSync(join(dist, 'llms-full.txt'), 'utf8')).toContain('Usage responsable');
    } finally {
      rmSync(dist, { recursive: true, force: true });
      rmSync(content, { recursive: true, force: true });
    }
  });
});

describe('assert_docs_links_clean : le vérificateur de liens', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Un site minimal valide : toutes les pages du registre, llms.txt, llms-full.txt, une ancre. */
  function site(mutate: (write: (path: string, html: string) => void) => void = () => undefined): string {
    const dist = mkdtempSync(join(tmpdir(), 'zz_test_site_'));
    dirs.push(dist);
    const write = (path: string, body: string): void => {
      mkdirSync(dirname(join(dist, path)), { recursive: true });
      writeFileSync(join(dist, path), body);
    };
    const html = (extra = '', id = 'haut'): string => `<html><body><h1 id="${id}">T</h1><a href="/llms.txt">llms.txt</a>${extra}</body></html>`;
    for (const page of PAGES) {
      write(`${page.path}.html`, html('<a href="/tutoriels/quickstart#haut">ok</a><a href="https://example.org/doc">externe</a>'));
      write(`${page.path}.md`, `# ${page.title}\n`);
    }
    write('index.html', html());
    write('404.html', '<html><body>404</body></html>');
    write('llms.txt', '# x\n');
    write('llms-full.txt', '# x\n');
    mutate(write);
    return dist;
  }

  test('un site propre passe', () => {
    expect(checkSite(site(), '/')).toEqual([]);
  });

  test('un lien interne mort est signalé, avec la page qui le porte', () => {
    const dist = site((write) => write('guides/render.html', '<html><body><a href="/llms.txt">l</a><a href="/guides/inexistante">x</a></body></html>'));
    expect(checkSite(dist, '/')).toContainEqual({ page: 'guides/render.html', problem: 'lien mort : /guides/inexistante' });
  });

  test('une ancre absente de la page visée est signalée', () => {
    const dist = site((write) => write('guides/render.html', '<html><body><a href="/llms.txt">l</a><a href="/tutoriels/quickstart#nulle-part">x</a></body></html>'));
    expect(checkSite(dist, '/')).toContainEqual({ page: 'guides/render.html', problem: 'ancre introuvable : /tutoriels/quickstart#nulle-part' });
  });

  test('une ressource chargée hors du site est signalée : script, feuille de style, image', () => {
    const dist = site((write) =>
      write('guides/render.html', '<html><head><script src="https://cdn.example.org/a.js"></script><link rel="stylesheet" href="//fonts.example.org/f.css"></head><body><a href="/llms.txt">l</a><img src="https://x.example.org/i.png"></body></html>'),
    );
    const problems = checkSite(dist, '/').map((p) => p.problem);
    expect(problems).toContain('ressource chargée hors du site : https://cdn.example.org/a.js');
    expect(problems).toContain('ressource chargée hors du site : //fonts.example.org/f.css');
    expect(problems).toContain('image chargée hors du site : https://x.example.org/i.png');
  });

  test('une page qui ne cite pas llms.txt est signalée ; la page 404 est exemptée', () => {
    const dist = site((write) => write('guides/render.html', '<html><body>rien</body></html>'));
    const problems = checkSite(dist, '/');
    expect(problems).toContainEqual({ page: 'guides/render.html', problem: 'aucun lien vers llms.txt' });
    expect(problems.some((p) => p.page === '404.html')).toBe(false);
  });

  test('un fichier llms manquant ou une page sans version .md est signalé', () => {
    const dist = site();
    rmSync(join(dist, 'llms-full.txt'));
    rmSync(join(dist, 'guides/render.md'));
    const problems = checkSite(dist, '/');
    expect(problems).toContainEqual({ page: 'llms-full.txt', problem: 'fichier absent' });
    expect(problems).toContainEqual({ page: 'guides/render', problem: 'version .md absente' });
  });

  test('sous un préfixe, les liens doivent le porter', () => {
    const dist = site();
    expect(checkSite(dist, '/docs/').length).toBeGreaterThan(0);
  });

  test('les liens externes ne sont jamais suivis : la vérification n\'ouvre aucune connexion', () => {
    const source = readFileSync(new URL('./site.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bfetch\(|node:https?|node:net|undici/);
  });
});

describe('assert_docs_rest_reference_generated : référence REST depuis l\'OpenAPI', () => {
  const openapi = parse(readFileSync(join(runtimeDir, 'packages/client/openapi/openapi.yaml'), 'utf8')) as OpenApiDocument;
  const page = renderRestReference(openapi);

  test('chaque opération de l\'OpenAPI a sa ligne et son détail, avec son état de livraison', () => {
    const operations = listOperations(openapi);
    expect(operations.length).toBeGreaterThan(90);
    for (const { method, path, op } of operations) {
      expect(page, `${method} ${path}`).toContain(`| ${method} | [\`${path}\`]`);
      expect(page, `${method} ${path}`).toContain(`#### ${method} \`${path}\``);
      if (op['x-pending']) expect(page).toContain(`en préparation (${op['x-pending']})`);
    }
    const delivered = operations.filter((e) => !e.op['x-pending']).length;
    expect(page).toContain(`**${operations.length} opérations**, dont **${delivered} disponibles**`);
  });

  test('chaque schéma nommé est décrit, et les renvois internes ont leur cible', () => {
    for (const name of Object.keys(openapi.components?.schemas ?? {})) expect(page, name).toContain(`### ${name} {#schema-${name.toLowerCase()}}`);
    for (const match of page.matchAll(/\]\(#([a-z0-9-]+)\)/g)) expect(page, match[1]).toContain(`{#${match[1] ?? ''}}`);
  });

  test('aucun renvoi interne au cahier des charges ni HTML non maîtrisé dans les textes repris', () => {
    expect(page).not.toMatch(/\(\d+b? §/);
    expect(plain('Une <balise> | cellule {{x}} (13 § 4) fin')).toBe('Une &lt;balise&gt; \\| cellule {&#8203;{x}} fin');
    expect(page).not.toMatch(/\{\{/);
  });

  test('la page déclare les modes d\'authentification ; une route d\'administration livrée n\'accepte pas de clé d\'API ; une route en préparation est dite « prévue »', () => {
    expect(page).toContain('jamais de scope d\'administration');
    expect(page).toContain('(prévue)');
    for (const entry of listOperations(openapi).filter((e) => !e.op['x-pending'])) {
      if (entry.path.startsWith('/api/admin/') || entry.path.startsWith('/api/users')) {
        const auth = entry.op.security ?? openapi.security ?? [];
        expect(auth.some((a) => 'apiKey' in a), `${entry.method} ${entry.path}`).toBe(false);
      }
    }
  });

  test('codes de raison : chaque code de la table figée est dans la page générée, avec le texte de la console', () => {
    const fr = JSON.parse(readFileSync(join(runtimeDir, 'apps/web/src/i18n/locales/fr.json'), 'utf8')) as Parameters<typeof renderReasonsReference>[0];
    const spec = (JSON.parse(readFileSync(join(runtimeDir, 'apps/web/src/testing/spec-reason-codes.json'), 'utf8')) as { codes: string[] }).codes;
    const reasons = renderReasonsReference(fr, spec);
    for (const code of spec) expect(reasons, code).toContain(`| \`${code}\` |`);
    expect(reasons).toContain('Le site demande aux robots de ne pas visiter cette page.');
    expect(reasons).toContain('## Classes d\'échec');
  });

  test('chaque code de raison cité dans les pages écrites à la main existe dans la console', () => {
    const fr = JSON.parse(readFileSync(join(runtimeDir, 'apps/web/src/i18n/locales/fr.json'), 'utf8')) as { reasons: Record<string, string>; failureClass: Record<string, string> };
    const known = new Set([...Object.keys(fr.reasons), ...Object.keys(fr.failureClass)]);
    for (const page of handWritten) {
      if (page.path !== 'reference/statuts-et-raisons') continue;
      for (const match of readSource(page).matchAll(/^\| `([a-z_*]+)` \|/gm)) {
        const code = match[1] ?? '';
        if (['enquete', 'sain', 'warning', 'reparation', 'erreur', 'action_requise', 'bloquee'].includes(code) || code === 'llm_*') continue;
        expect(known.has(code), `statuts-et-raisons : classe ${code} inconnue de la console`).toBe(true);
      }
    }
  });
});
