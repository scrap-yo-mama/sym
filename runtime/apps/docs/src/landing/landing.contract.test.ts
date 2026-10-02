// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.11, niveau « site construit » (22b § 2) : le build de production (DOCS_BASE=/sym/, comme GitHub Pages) est relu sans
// navigateur. Deux builds du même commit, dans deux dossiers à part (dist-landing-*), pour juger les empreintes sha256 déterministes.
// - assert_landing_csp_strict (forme et empreintes), assert_landing_no_signup, assert_landing_seo_meta, assert_landing_hreflang_reciprocal ;
// - assert_landing_i18n_parity, assert_landing_claims_sourced, assert_landing_no_bypass_copy, assert_landing_no_third_party_brand,
//   assert_landing_fr_tutoiement, assert_landing_ghost_icon, assert_landing_demo_allowlist (sur le HTML rendu) ;
// - assert_landing_links_resolve, assert_landing_stars_build_time, assert_readme_quickstart_matches_ci (volet landing).
// Le volet navigateur (requêtes, cookies, CSP vue par Chromium, axe, mouvement, budgets) est dans apps/docs/e2e.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { checkSite } from '../site.ts';
import { PAGES } from '../nav.ts';
import { attributeTexts, attributeValues, bodyOf, decodeEntities, headOf, linkTags, metaTags, pngSize, visibleText } from '../testing/html.ts';
import { withBuildLock } from '../testing/build-lock.ts';
import { docsDir } from '../testing/pages.ts';
import { loadClaims, normalizeText, resolveClaim } from './claims.ts';
import { buildCsp, cspOf, inlineScripts } from './csp.ts';
import { buildLanding, startCommand } from './content.ts';
import { HOME_PATHS, LEGAL_PATHS } from './href.ts';
import { findTerms, loadBrandExceptions, loadBrands, loadLexicon } from './lexicon.ts';
import { TRACKER_DOMAINS } from './trackers.ts';
import { buildInputs, siteEnv } from './site.ts';
import type { Lang } from './types.ts';
import { LANGS } from './types.ts';

const BASE = '/sym/';
const SITE_URL = 'https://scrap-yo-mama.github.io';
const OUT = ['dist-landing-a', 'dist-landing-b'] as const;
const dist = (index: 0 | 1): string => join(docsDir, OUT[index]);
const registry = loadClaims();
const inputs = buildInputs(siteEnv({}, BASE));

const read = (index: 0 | 1, path: string): string => readFileSync(join(dist(index), path), 'utf8');
const pageFile = (lang: Lang): string => `${HOME_PATHS[lang]}index.html`;
const legalFiles = (lang: Lang): string[] => Object.values(LEGAL_PATHS[lang]).map((path) => `${path}.html`);
const LANDING_FILES = [...LANGS.map(pageFile), ...LANGS.flatMap(legalFiles)];
const url = (path: string): string => `${SITE_URL}${BASE}${path}`;

beforeAll(async () => {
  for (const [index, outDir] of OUT.entries()) {
    const result = await withBuildLock(docsDir, () => spawnSync('node', ['scripts/build.ts'], { cwd: docsDir, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DOCS_BASE: BASE, DOCS_OUT_DIR: outDir, DOCS_SITE_URL: '', PUBLIC_REPOSITORY: '' } }));
    if (result.status !== 0) throw new Error(`build ${index} échoué (code ${result.status}) :\n${result.stdout}${result.stderr}`);
  }
}, 600_000);

describe('assert_landing_csp_strict : balise meta et empreintes calculées au build', () => {
  test('chaque page de la landing porte la balise CSP en première position du head, avec ses empreintes exactes', () => {
    for (const file of LANDING_FILES) {
      const html = read(0, file);
      expect(html.indexOf('<head>') + '<head>'.length, file).toBe(html.indexOf('\n    <meta http-equiv="Content-Security-Policy"'));
      const csp = cspOf(html) ?? '';
      expect(csp, file).toBe(buildCsp(inlineScripts(html)));
      expect(csp, file).not.toMatch(/unsafe-inline|unsafe-eval|frame-ancestors/);
      expect(csp, file).toContain("form-action 'none'");
      expect(inlineScripts(html).length, `${file} : scripts en ligne connus`).toBe(2);
      expect(html.indexOf('<meta charset'), `${file} : charset dans les 1024 premiers octets`).toBeLessThan(1024);
      expect(html, file).toContain('<meta name="referrer" content="strict-origin-when-cross-origin">');
    }
  });

  test('deux builds du même commit produisent les mêmes empreintes', () => {
    for (const file of LANDING_FILES) expect(cspOf(read(0, file)), file).toBe(cspOf(read(1, file)));
    const unique = new Set(LANDING_FILES.map((file) => cspOf(read(0, file))));
    expect(unique.size, 'une seule politique pour toutes les pages de la landing').toBe(1);
  });

  test('aucun attribut style="" dans le HTML des pages de la landing', () => {
    for (const file of LANDING_FILES) expect(read(0, file), file).not.toMatch(/\sstyle="/);
  });

  test('le repli Cloudflare Pages : _headers porte la même politique, plus frame-ancestors, et seulement sur les pages de la landing', () => {
    const headers = read(0, '_headers');
    const csp = cspOf(read(0, 'index.html')) ?? '';
    expect(headers).toContain(`Content-Security-Policy: ${csp}; frame-ancestors 'none'`);
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(headers.split('\n').filter((line) => /^\//.test(line))).toEqual(['/sym/', '/sym/fr/', '/sym/legal/privacy', '/sym/legal/legal-notice', '/sym/fr/legal/confidentialite', '/sym/fr/legal/mentions-legales']);
  });

  test('les pages de doc ne portent pas la CSP de la landing (leur recherche charge du WebAssembly)', () => {
    expect(cspOf(read(0, 'tutoriels/quickstart.html'))).toBeUndefined();
  });
});

describe('assert_landing_no_signup (HTML) : ni formulaire ni inscription', () => {
  test('0 form, 0 champ e-mail ou mot de passe, aucun lien vers une liste d\'attente ou une inscription', () => {
    for (const file of LANDING_FILES) {
      const html = bodyOf(read(0, file));
      expect(html, file).not.toMatch(/<form\b|<input\b|<textarea\b|<select\b|type="(?:email|password)"/);
      expect(visibleText(read(0, file)), file).not.toMatch(/waitlist|liste d'attente|newsletter|inscri|sign ?up|s'abonner|subscribe/i);
    }
  });

  test('les liens externes vont à GitHub, à la doc de GitHub ou à Render, et à personne d\'autre', () => {
    const allowed = new Set(['github.com', 'docs.github.com', 'render.com']);
    for (const file of LANDING_FILES) {
      const hosts = attributeValues(read(0, file), 'a', 'href').filter((href) => /^https?:/.test(href)).map((href) => new URL(href).host);
      expect(hosts.length, file).toBeGreaterThan(0);
      for (const host of hosts) expect(allowed.has(host), `${file} : ${host}`).toBe(true);
    }
  });
});

describe('assert_landing_seo_meta : canonique, OG, JSON-LD, robots, sitemap, llms.txt', () => {
  for (const lang of LANGS) {
    test(`${lang} : title ≤ 60, description ≤ 155, canonique, un seul h1, aucun noindex, OG 1200×630`, () => {
      const file = pageFile(lang);
      const html = read(0, file);
      const title = decodeEntities(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '');
      const meta = metaTags(html);
      const description = meta.find((tag) => tag['name'] === 'description')?.['content'] ?? '';
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title).toBe(buildLanding(lang, inputs).meta.title);
      expect(description.length).toBeGreaterThan(50);
      expect(description.length).toBeLessThanOrEqual(155);
      expect(linkTags(html).find((tag) => tag['rel'] === 'canonical')?.['href']).toBe(url(HOME_PATHS[lang]));
      expect(bodyOf(html).match(/<h1\b/g)?.length).toBe(1);
      expect(html).not.toMatch(/noindex/i);
      const og = (property: string): string => meta.find((tag) => tag['property'] === property)?.['content'] ?? '';
      expect(og('og:image')).toBe(url(`og/og-${lang}.png`));
      expect([og('og:image:width'), og('og:image:height')]).toEqual(['1200', '630']);
      expect(og('og:title')).toBe(title);
      expect(og('og:url')).toBe(url(HOME_PATHS[lang]));
      expect(og('og:locale')).toBe(lang === 'en' ? 'en_US' : 'fr_FR');
      expect(og('og:image:alt').length).toBeGreaterThan(10);
      expect(meta.find((tag) => tag['name'] === 'twitter:card')?.['content']).toBe('summary_large_image');
      expect(pngSize(readFileSync(join(dist(0), `og/og-${lang}.png`)))).toEqual({ width: 1200, height: 630 });
      expect(statSync(join(dist(0), `og/og-${lang}.png`)).size).toBeLessThan(400 * 1024);
    });

    test(`${lang} : JSON-LD SoftwareApplication valide, sans aggregateRating, sans emoji`, () => {
      const html = read(0, pageFile(lang));
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
      expect(blocks).toHaveLength(1);
      const data = JSON.parse(blocks[0] ?? '{}') as Record<string, unknown>;
      expect(data['@context']).toBe('https://schema.org');
      expect(data['@type']).toBe('SoftwareApplication');
      expect(data['inLanguage']).toBe(lang);
      expect(data['url']).toBe(url(HOME_PATHS[lang]));
      expect(JSON.stringify(data)).not.toMatch(/aggregateRating|review|\p{Extended_Pictographic}/u);
      expect(String(data['description'])).toBe(buildLanding(lang, inputs).page.hero.definition);
    });
  }

  test('robots.txt ouvert avec l\'adresse absolue du sitemap, sitemap.xml complet, llms.txt présent', () => {
    expect(read(0, 'robots.txt')).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${url('sitemap.xml')}\n`);
    const sitemap = read(0, 'sitemap.xml');
    for (const page of [...LANGS.map((lang) => HOME_PATHS[lang]), ...LANGS.flatMap((lang) => Object.values(LEGAL_PATHS[lang])), ...PAGES.map((entry) => entry.path)]) expect(sitemap, page).toContain(`<loc>${url(page)}</loc>`);
    expect(existsSync(join(dist(0), 'llms.txt'))).toBe(true);
    expect(existsSync(join(dist(0), 'favicon.svg'))).toBe(true);
    for (const file of LANDING_FILES) expect(read(0, file), file).toContain('llms.txt');
  });

  test('aucun noindex en production : ni dans les pages, ni dans les en-têtes écrits', () => {
    for (const file of LANDING_FILES) expect(read(0, file)).not.toMatch(/robots"[^>]*noindex/);
    expect(read(0, '_headers')).not.toMatch(/X-Robots-Tag/i);
  });
});

describe('assert_landing_hreflang_reciprocal : auto-référent, réciproque, avec x-default', () => {
  const alternates = (html: string): Record<string, string> => Object.fromEntries(linkTags(html).filter((tag) => tag['rel'] === 'alternate' && tag['hreflang']).map((tag) => [tag['hreflang'] ?? '', tag['href'] ?? '']));

  test('accueil : chaque page liste les deux langues et x-default = l\'anglais, et se désigne elle-même', () => {
    const en = alternates(read(0, pageFile('en')));
    const fr = alternates(read(0, pageFile('fr')));
    expect(en).toEqual({ en: url(''), fr: url('fr/'), 'x-default': url('') });
    expect(fr).toEqual(en);
    expect(linkTags(read(0, pageFile('en'))).find((tag) => tag['rel'] === 'canonical')?.['href']).toBe(en['en']);
    expect(linkTags(read(0, pageFile('fr'))).find((tag) => tag['rel'] === 'canonical')?.['href']).toBe(fr['fr']);
  });

  test('pages juridiques : la version française et la version anglaise se désignent l\'une l\'autre', () => {
    for (const page of ['privacy', 'notice'] as const) {
      const en = read(0, `${LEGAL_PATHS.en[page]}.html`);
      const fr = read(0, `${LEGAL_PATHS.fr[page]}.html`);
      expect(alternates(en)).toEqual({ en: url(LEGAL_PATHS.en[page]), fr: url(LEGAL_PATHS.fr[page]), 'x-default': url(LEGAL_PATHS.en[page]) });
      expect(alternates(fr)).toEqual(alternates(en));
    }
  });

  test('le sitemap porte les mêmes alternatives', () => {
    const sitemap = read(0, 'sitemap.xml');
    expect(sitemap).toContain(`<xhtml:link rel="alternate" hreflang="fr" href="${url('fr/')}"/>`);
    expect(sitemap).toContain(`<xhtml:link rel="alternate" hreflang="x-default" href="${url('')}"/>`);
  });

  test('`<html lang>` suit la langue de la page, la doc reste en français', () => {
    expect(read(0, pageFile('en'))).toMatch(/<html lang="en"/);
    expect(read(0, pageFile('fr'))).toMatch(/<html lang="fr"/);
    for (const file of legalFiles('en')) expect(read(0, file), file).toMatch(/<html lang="en"/);
    for (const file of legalFiles('fr')) expect(read(0, file), file).toMatch(/<html lang="fr"/);
    expect(read(0, 'tutoriels/quickstart.html')).toMatch(/<html lang="fr-FR"/);
  });
});

describe('assert_landing_i18n_parity (HTML) : mêmes ids, mêmes liens, mêmes entrées', () => {
  test('mêmes identifiants de section et mêmes liens vers l\'extérieur et vers la doc dans les deux langues', () => {
    const en = read(0, pageFile('en'));
    const fr = read(0, pageFile('fr'));
    expect(attributeValues(fr, 'section', 'id')).toEqual(attributeValues(en, 'section', 'id'));
    const stable = (html: string): string[] => attributeValues(html, 'a', 'href').filter((href) => !/\/fr\/|\/legal\/|^\/sym\/$|^\/sym\/#/.test(href));
    expect(stable(fr)).toEqual(stable(en));
    expect(bodyOf(fr).match(/<h[23]\b/g)?.length).toBe(bodyOf(en).match(/<h[23]\b/g)?.length);
  });
});

describe('assert_landing_claims_sourced (HTML) : le texte rendu vient du registre', () => {
  for (const lang of LANGS) {
    test(`${lang} : chaque entrée annoncée est dans le texte rendu, mot pour mot, et rien de chiffré n'y échappe`, () => {
      const html = read(0, pageFile(lang));
      const text = normalizeText(visibleText(html));
      const data = buildLanding(lang, inputs);
      for (const id of data.claims) expect(text, `${lang} ${id}`).toContain(normalizeText(resolveClaim(registry, id, lang)));
      const claimed = data.claims.map((id) => normalizeText(resolveClaim(registry, id, lang)));
      let rest = text;
      for (const claim of claimed) rest = rest.split(claim).join(' ');
      const command = normalizeText(data.page.hero.command.text);
      rest = rest.split(command).join(' ');
      expect(rest.replace(/AGPL-3\.0|MIT|books\.toscrape\.com/g, ''), `${lang} : chiffre hors registre`).not.toMatch(/\d/);
    });
  }

  test('aucune entrée « à relire » ou « bloqué » n\'est affichée', () => {
    for (const lang of LANGS) {
      const text = normalizeText(visibleText(read(0, pageFile(lang))));
      for (const claim of registry.claims.filter((entry) => entry.status !== 'relu')) expect(text, claim.id).not.toContain(normalizeText(claim[lang]));
    }
  });

  test('aucun témoignage, logo, étoile ou chiffre inventé : pas de citation, pas d\'image de tiers', () => {
    for (const lang of LANGS) {
      const html = bodyOf(read(0, pageFile(lang)));
      expect(html).not.toMatch(/<img\b|<blockquote\b|<picture\b/);
      expect(visibleText(read(0, pageFile(lang)))).not.toMatch(/témoignage|testimonial|\d+\s*(?:étoiles|stars)/i);
    }
  });
});

describe('assert_landing_no_bypass_copy (HTML), assert_landing_no_third_party_brand (HTML)', () => {
  const lexicon = loadLexicon();
  const brands = loadBrands();
  const everything = (file: string): string => [visibleText(read(0, file)), ...attributeTexts(read(0, file))].join('\n');

  test('0 mot de P et de L sur les pages d\'accueil : texte, title, meta, alt, aria-label', () => {
    for (const file of LANGS.map(pageFile)) {
      expect(findTerms(everything(file), lexicon.promises), `${file} : P`).toEqual([]);
      expect(findTerms(everything(file), lexicon.limits), `${file} : L`).toEqual([]);
    }
  });

  test('0 mot de P sur les pages juridiques non plus (L y est admis : elles décrivent le projet)', () => {
    for (const file of LANGS.flatMap(legalFiles)) expect(findTerms(everything(file), lexicon.promises), file).toEqual([]);
  });

  test('0 marque de tiers hors exceptions ; « Claude » seulement dans l\'accroche du bandeau', () => {
    for (const lang of LANGS) {
      const hook = resolveClaim(registry, 'brand.hook', lang);
      const text = normalizeText(everything(pageFile(lang))).split(normalizeText(hook)).join(' ');
      expect(findTerms(text, brands), lang).toEqual([]);
      const bandeau = /<section id="bandeau"[\s\S]*?<\/section>/.exec(read(0, pageFile(lang)))?.[0] ?? '';
      expect(normalizeText(visibleText(`<body>${bandeau}`))).toContain(normalizeText(hook));
      expect(findTerms(visibleText(read(0, pageFile(lang))).replace(hook, ''), ['claude'])).toEqual([]);
    }
    // Pages juridiques : l'adresse de contact (un e-mail) n'est pas une marque citée.
    for (const file of LANGS.flatMap(legalFiles)) expect(findTerms(everything(file).replace(/\S+@\S+/g, ' '), brands.filter((brand) => !loadBrandExceptions().includes(brand))), file).toEqual([]);
  });

  test('aucun logo de tiers : la landing ne charge aucune image, seulement des icônes SVG en ligne', () => {
    for (const file of LANDING_FILES) expect(bodyOf(read(0, file)), file).not.toMatch(/<img\b/);
  });
});

describe('assert_landing_fr_tutoiement (HTML)', () => {
  test('aucun « vous » dans les pages françaises (accueil et pages juridiques), hors licence', () => {
    for (const file of [pageFile('fr'), ...legalFiles('fr')]) expect(visibleText(read(0, file)), file).not.toMatch(/\b(?:vous|votre|vos)\b/i);
  });
});

describe('assert_landing_ghost_icon (HTML) : une icône SVG, jamais un emoji', () => {
  test('aucun 👻 littéral dans le HTML ; chaque icône est aria-hidden, à côté du texte « SYM »', () => {
    for (const file of LANDING_FILES) {
      const html = read(0, file);
      expect(html, file).not.toContain('👻');
      const icons = [...html.matchAll(/<svg\b[^>]*(?:data-sym-ghost|sym-signature__icon)[^>]*>/g)].map((match) => match[0]);
      for (const icon of icons) expect(icon, file).toContain('aria-hidden="true"');
    }
    for (const lang of LANGS) {
      const html = read(0, pageFile(lang));
      const icons = html.match(/<svg\b[^>]*(?:data-sym-ghost|sym-signature__icon)[^>]*>/g) ?? [];
      expect(icons.length, lang).toBeGreaterThanOrEqual(5);
      // Chaque icône touche le texte « SYM » (avant ou après : badge, signature, accroche) : le nom accessible reste « SYM ».
      const text = visibleText(html);
      expect([...text.matchAll(/👻/g)].length, lang).toBe(icons.length);
      for (const match of text.matchAll(/(.{0,5})👻(.{0,5})/g)) expect(`${match[1]}|${match[2]}`, lang).toMatch(/SYM\s*\||\|\s*SYM/);
    }
  });

  test('jamais dans le title, les meta, les og:* ni le JSON-LD', () => {
    for (const file of LANDING_FILES) {
      const head = headOf(read(0, file));
      expect(head, file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('assert_landing_demo_allowlist (HTML)', () => {
  test('le seul domaine réel de la page est books.toscrape.com, hors liens vers GitHub, Render et la doc', () => {
    for (const lang of LANGS) {
      const html = read(0, pageFile(lang)).replace(/<pre class="lp-command__code"[\s\S]*?<\/pre>/, '');
      const text = visibleText(html);
      const domains = [...text.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi)].map((match) => match[0].toLowerCase()).filter((domain) => !['txt', 'json', 'md', 'env', 'yml', 'sh'].includes(domain.split('.').pop() ?? '') && !/^\d/.test(domain));
      for (const domain of domains) expect(domain === 'books.toscrape.com' || domain.endsWith('.example') || /^(?:github\.com|render\.com)$/.test(domain) || /^\d+\.\d+$/.test(domain), `${lang} ${domain}`).toBe(true);
    }
  });
});

describe('assert_landing_links_resolve : aucun lien mort', () => {
  test('le vérificateur de liens du site (fichiers, ancres, ressources) ne trouve rien sur le build de production', () => {
    expect(checkSite(dist(0), BASE)).toEqual([]);
  });

  test('les liens de la landing vers la doc, les pages juridiques et l\'autre langue existent', () => {
    for (const file of LANDING_FILES) {
      for (const href of attributeValues(read(0, file), 'a', 'href').filter((value) => value.startsWith(BASE))) {
        const [path = '', fragment] = href.slice(BASE.length).split('#') as [string, string | undefined];
        const target = [path, `${path}.html`, join(path, 'index.html')].map((candidate) => join(dist(0), candidate)).find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        expect(target, `${file} : ${href}`).toBeDefined();
        if (fragment && target?.endsWith('.html')) expect(readFileSync(target, 'utf8'), `${file} : ancre ${href}`).toContain(`id="${fragment}"`);
      }
    }
  });
});

describe('assert_landing_stars_build_time : étoiles écrites au build', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => (statSync(join(dir, entry)).isDirectory() ? walk(join(dir, entry)) : [join(dir, entry)]));

  test('aucun appel à l\'API GitHub depuis le navigateur : ni dans le HTML ni dans le code livré', () => {
    for (const file of walk(join(dist(0), 'assets')).filter((path) => /\.(js|css)$/.test(path) && !/pagefind|reference_rest/.test(path))) expect(readFileSync(file, 'utf8'), file).not.toContain('api.github.com');
    for (const file of LANDING_FILES) expect(read(0, file), file).not.toContain('api.github.com');
  });

  test('avant 100 étoiles, aucun nombre dans l\'en-tête ; le compteur est statique', () => {
    for (const lang of LANGS) expect(bodyOf(read(0, pageFile(lang))), lang).not.toContain('lp-stars');
  });

  test('aucun traceur connu n\'est référencé dans le code livré à la landing', () => {
    for (const file of walk(join(dist(0), 'assets')).filter((path) => /\.(js|css)$/.test(path) && !/pagefind|reference_rest|guides_|explications_|reference_|tutoriels_/.test(path))) {
      const text = readFileSync(file, 'utf8');
      const hits = TRACKER_DOMAINS.filter((domain) => text.includes(domain));
      expect(hits, file).toEqual([]);
    }
  });
});

describe('assert_readme_quickstart_matches_ci (volet landing)', () => {
  test('la commande affichée est celle que la CI rejoue : le tutoriel « Démarrage rapide »', () => {
    for (const lang of LANGS) {
      const html = read(0, pageFile(lang));
      const shown = decodeEntities(/<pre class="lp-command__code"[^>]*><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? '');
      expect(shown).toBe(startCommand(inputs));
      expect(shown).toContain('docker compose up --build');
    }
  });
});
