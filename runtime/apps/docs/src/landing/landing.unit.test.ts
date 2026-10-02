// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.11, niveau « contenu » (22b § 2), sans navigateur ni build : la landing est une fonction pure de ses entrées.
// - assert_landing_i18n_parity : mêmes sections, mêmes ancres, mêmes liens, mêmes entrées du registre ; title ≤ 60, description ≤ 155 ;
// - assert_landing_claims_sourced : chaque phrase factuelle vient du registre, relue, avec preuve et date ; rien d'autre ne s'affiche ;
// - assert_landing_no_bypass_copy, assert_landing_no_third_party_brand, assert_landing_fr_tutoiement, assert_landing_demo_allowlist ;
// - assert_landing_ghost_icon (contenu), assert_landing_stars_build_time (valeurs), assert_landing_contrast_tokens (feuille de style) ;
// - la commande de démarrage est celle du tutoriel que la CI rejoue (assert_readme_quickstart_matches_ci, volet landing).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { contrast, cssVariables, resolveColor, type Rgb } from '@runtime/ui/testing/contrast';
import { hardcodedColors, sheetViolations } from '@runtime/ui/testing/color-rules';
import { parseQuickstart } from '../quickstart.ts';
import { loadClaims, normalizeText, resolveClaim, type ClaimsRegistry } from './claims.ts';
import { buildLanding, startCommand, STARS_THRESHOLD, type BuildInputs } from './content.ts';
import { hrefOf, internalPath } from './href.ts';
import { pagesBase, pagesOrigin, publicRepository, renderDeployUrl } from './identity.ts';
import { findTerms, loadBrandExceptions, loadBrands, loadLexicon, normalizeForLexicon } from './lexicon.ts';
import { buildInputs, readStars, siteEnv } from './site.ts';
import type { Href, Lang, LandingData } from './types.ts';
import { LANGS } from './types.ts';

const registry = loadClaims();
const inputs: BuildInputs = buildInputs(siteEnv({}, '/sym/'));
const landing = (lang: Lang, overrides: Partial<BuildInputs> = {}): LandingData => buildLanding(lang, { ...inputs, ...overrides });
const BUDGETS = (JSON.parse(readFileSync(new URL('../../../../scripts/vitrine/budgets.json', import.meta.url), 'utf8')) as { landing: { titleChars: number; descriptionChars: number } }).landing;

/** Tous les textes d'une valeur, dans l'ordre : la matière que lit le visiteur. */
function texts(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) texts(item, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (!['href', 'to', 'id', 'from', 'hreflang', 'lang', 'style'].includes(key)) texts(item, out);
  return out;
}

/** Les liens d'une valeur (objets portant `href`), en clair. */
function links(value: unknown, out: Href[] = []): Href[] {
  if (Array.isArray(value)) for (const item of value) links(item, out);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record['href'] && typeof record['href'] === 'object') out.push(record['href'] as Href);
    for (const item of Object.values(record)) links(item, out);
  }
  return out;
}

/** Forme d'une valeur : clés et longueurs de listes, sans les textes. */
function shape(value: unknown): unknown {
  if (typeof value === 'string') return 'texte';
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'id' || key === 'to' || key === 'from' || key === 'style' ? item : shape(item)]));
  return value;
}

describe('assert_landing_i18n_parity : une structure, deux langues', () => {
  test('même forme, mêmes ancres, mêmes liens (hors langue), mêmes entrées du registre', () => {
    const en = landing('en');
    const fr = landing('fr');
    expect(shape(fr.page)).toEqual(shape(en.page));
    expect(en.claims).toEqual(fr.claims);
    const stable = (data: LandingData): string[] =>
      links(data.page)
        .filter((href) => !(href.to === 'home' || href.to === 'legal'))
        .map((href) => JSON.stringify(href));
    expect(stable(fr)).toEqual(stable(en));
    const ids = (data: LandingData): string[] => ['hero', data.page.demo.id, data.page.banner.id, data.page.proof.id, data.page.how.id, data.page.cost.id, data.page.far.id, data.page.install.id, data.page.faq.id, data.page.community.id];
    expect(ids(fr)).toEqual(ids(en));
    expect(ids(en)).toEqual(['hero', 'demo', 'bandeau', 'preuves', 'comment', 'cout', 'va-loin', 'installer', 'faq', 'communaute']);
  });

  test('title ≤ 60 et description ≤ 155 caractères, chacune dans sa langue', () => {
    for (const lang of LANGS) {
      const { meta } = landing(lang);
      expect(meta.title.length, lang).toBeLessThanOrEqual(BUDGETS.titleChars);
      expect(meta.description.length, lang).toBeLessThanOrEqual(BUDGETS.descriptionChars);
    }
    expect(landing('fr').meta.title).toBe('Scrapyomama · API de données auto-hébergées');
    expect(landing('en').meta.title).toBe('Scrapyomama · Self-hosted data APIs over MCP');
  });

  test('le tableau comparatif est éteint par défaut : aucune section « comparer » sans le drapeau de build', () => {
    expect(landing('en').page.compare).toBeUndefined();
    expect(landing('fr').page.compare).toBeUndefined();
  });

  test('FAQ de 4 à 10 questions, une réponse de 2 à 4 lignes chacune', () => {
    for (const lang of LANGS) {
      const { entries } = landing(lang).page.faq;
      expect(entries.length).toBeGreaterThanOrEqual(4);
      expect(entries.length).toBeLessThanOrEqual(10);
      for (const entry of entries) expect(entry.answer.length, entry.question).toBeLessThan(260);
    }
  });
});

describe('assert_landing_claims_sourced : chaque phrase factuelle vient du registre', () => {
  test('chaque entrée affichée existe, est « relu », a une preuve et une date', () => {
    for (const lang of LANGS) {
      for (const id of landing(lang).claims) {
        const claim = registry.claims.find((entry) => entry.id === id);
        expect(claim, id).toBeDefined();
        expect(claim?.status, id).toBe('relu');
        expect(claim?.proof.length, id).toBeGreaterThan(0);
        expect(claim?.reviewed, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  test('chaque texte de claim apparaît tel quel dans la page, dans sa langue', () => {
    for (const lang of LANGS) {
      const all = texts({ chrome: landing(lang).chrome, page: landing(lang).page }).map(normalizeText);
      for (const id of landing(lang).claims) expect(all, `${lang} ${id}`).toContain(normalizeText(resolveClaim(registry, id, lang)));
    }
  });

  test('une entrée « à relire » ou « bloqué » ne s\'affiche jamais : le build échoue', () => {
    for (const status of ['à relire', 'bloqué'] as const) {
      const bad: ClaimsRegistry = { ...registry, claims: registry.claims.map((claim) => (claim.id === 'license' ? { ...claim, status } : claim)) };
      expect(() => landing('en', { registry: bad })).toThrow(/ne s'affiche pas/);
    }
    const missing: ClaimsRegistry = { ...registry, claims: registry.claims.filter((claim) => claim.id !== 'license') };
    expect(() => landing('en', { registry: missing })).toThrow(/absente du registre/);
  });

  test('aucune entrée affichée n\'est « bloqué » ou « à relire » : le tableau comparatif et le User-Agent restent hors de la page', () => {
    const displayed = new Set(landing('en').claims);
    for (const claim of registry.claims.filter((entry) => entry.status !== 'relu')) expect(displayed.has(claim.id), claim.id).toBe(false);
    expect(registry.claims.find((claim) => claim.id === 'responsible.user-agent')?.status).toBe('bloqué');
  });

  test('un chiffre sans mesure fait échouer : tout nombre de la page est dans une entrée du registre ou dans la liste blanche', () => {
    for (const lang of LANGS) {
      const data = landing(lang);
      const claimTexts = data.claims.map((id) => resolveClaim(registry, id, lang));
      const commandText = data.page.hero.command.text;
      for (const text of texts({ chrome: data.chrome, page: { ...data.page, hero: { ...data.page.hero, command: undefined } } })) {
        if (claimTexts.some((claim) => normalizeText(claim) === normalizeText(text))) continue;
        // Liste blanche : noms propres (books.toscrape.com, AGPL-3.0, MIT), pas de mesure.
        const stripped = text.replace(/AGPL-3\.0|MIT|403|2\.0/g, '').replace(/books\.toscrape\.com|\.example/g, '');
        expect(stripped, `${lang} : « ${text} »`).not.toMatch(/\d/);
      }
      expect(commandText.length).toBeGreaterThan(50);
    }
  });

  test('chaque phrase du registre de la landing a une preuve nommée connue (test:, inv:, file:, page:, decision:)', () => {
    for (const claim of registry.claims) for (const proof of claim.proof) expect(proof, claim.id).toMatch(/^(test|inv|file|page|decision):\S+$/);
  });
});

describe('assert_landing_no_bypass_copy : un seul régime de lexique', () => {
  const lexicon = loadLexicon();
  const pages = (lang: Lang): string => texts(landing(lang)).join('\n');

  test('0 mot de la liste P et 0 mot de la liste L sur la landing, fr et en', () => {
    for (const lang of LANGS) {
      expect(findTerms(pages(lang), lexicon.promises), `${lang} : liste P`).toEqual([]);
      expect(findTerms(pages(lang), lexicon.limits), `${lang} : liste L`).toEqual([]);
    }
  });

  test('le détecteur voit les formes écrites autrement : casse, accents, traits d\'union, espace insécable', () => {
    expect(findTerms('PASSE partout', lexicon.promises)).toContain('passe-partout');
    expect(findTerms('Indetectable', lexicon.promises)).toContain('indétectable');
    expect(findTerms('Anti detect', lexicon.promises)).toContain('anti-detect');
    expect(findTerms('Les captchas', lexicon.limits)).toContain('captcha');
    expect(findTerms('On contourne le blocage', lexicon.promises)).toContain('contourn-');
    expect(findTerms('un mot de passe', lexicon.promises)).toEqual([]);
    expect(normalizeForLexicon('Résidentiel')).toBe('residentiel');
  });

  test('aucune promesse implicite par un idiome du fantôme : le 👻 n\'est qu\'une icône de signature', () => {
    for (const lang of LANGS) for (const text of texts(landing(lang))) expect(text, lang).not.toMatch(/fant[ôo]me|ghost|spectre|hant/i);
  });
});

describe('assert_landing_no_third_party_brand : aucune marque de tiers, « Claude » seulement dans l\'accroche', () => {
  const brands = loadBrands();
  const exceptions = loadBrandExceptions();

  test('0 marque de la liste noire hors accroche D-46 et exceptions descriptives', () => {
    for (const lang of LANGS) {
      const data = landing(lang);
      const hook = data.page.banner.hook;
      const body = texts(data).filter((text) => text !== hook).join('\n');
      expect(findTerms(body, brands), `${lang}`).toEqual([]);
      // « Claude » n'est admis que dans l'accroche, égale mot pour mot à son entrée du registre.
      expect(findTerms(hook, ['claude'])).toEqual(['claude']);
      expect(normalizeText(hook)).toBe(normalizeText(resolveClaim(registry, 'brand.hook', lang)));
    }
  });

  test('les exceptions descriptives restent des exceptions : aucune n\'est dans la liste noire', () => {
    for (const exception of exceptions) expect(brands, exception).not.toContain(exception);
  });

  test('« Apify agentique » n\'apparaît dans aucun texte public du site, llms.txt compris', async () => {
    const { SITE_SUMMARY, buildLlmsTxt } = await import('../site.ts');
    expect(SITE_SUMMARY).not.toMatch(/apify/i);
    expect(buildLlmsTxt('/')).not.toMatch(/apify/i);
  });
});

describe('assert_landing_fr_tutoiement : la page française tutoie', () => {
  test('aucun « vous », « votre », « vos » dans la page française', () => {
    const text = texts(landing('fr')).join('\n');
    expect(text).not.toMatch(/\b(?:vous|votre|vos)\b/i);
    expect(text).toMatch(/\b(?:tu|ton|ta|tes|te|toi)\b/i);
  });
});

describe('assert_landing_demo_allowlist : books.toscrape.com seul site réel', () => {
  const FILES = new Set(['txt', 'json', 'md', 'yml', 'yaml', 'env', 'ts', 'js', 'css', 'svg', 'png', 'xml', 'sh']);
  test('les domaines de la démo et de sa transcription sont books.toscrape.com ou en .example', () => {
    for (const lang of LANGS) {
      const demo = landing(lang).page.demo;
      const text = [...demo.messages.map((message) => message.text), demo.caption].join('\n');
      const domains = [...text.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi)].map((match) => match[0].toLowerCase()).filter((domain) => !FILES.has(domain.split('.').pop() ?? ''));
      expect(domains.length).toBeGreaterThan(1);
      for (const domain of domains) expect(domain === 'books.toscrape.com' || domain.endsWith('.example'), `${lang} ${domain}`).toBe(true);
    }
  });

  test('aucun réseau social ni site à compte dans la démo', () => {
    for (const lang of LANGS) expect(findTerms(landing(lang).page.demo.messages.map((m) => m.text).join('\n'), loadBrands())).toEqual([]);
  });
});

describe('assert_landing_ghost_icon : le 👻 est une icône, jamais un texte de métadonnée', () => {
  test('le titre, la description et le texte alternatif de l\'image sociale n\'ont aucun emoji', () => {
    for (const lang of LANGS) for (const value of Object.values(landing(lang).meta)) expect(value, lang).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test('le 👻 n\'apparaît que dans les textes que le rendu convertit en icône (titre, accroches), avec « SYM » à côté', () => {
    for (const lang of LANGS) {
      const data = landing(lang);
      const withGhost = texts(data).filter((text) => text.includes('👻'));
      expect(withGhost.length).toBeGreaterThanOrEqual(3);
      for (const text of withGhost) expect(text, lang).toMatch(/SYM\s*👻/);
    }
  });

  test('en français, SYM qui parle prend l\'espace insécable avant les deux-points', () => {
    expect(landing('fr').page.banner.hook).toContain('SYM 👻 : OK');
    expect(landing('en').page.banner.hook).toContain('SYM 👻: On it');
  });
});

describe('assert_landing_stars_build_time : étoiles et version écrites au build', () => {
  test('aucun nombre sous le seuil, aucun appel à l\'API GitHub dans le contenu', () => {
    expect(landing('en', { stars: 99 }).chrome.github.stars).toBeNull();
    expect(landing('en', { stars: 0 }).chrome.github.stars).toBeNull();
    expect(landing('en', { stars: STARS_THRESHOLD }).chrome.github.stars).toBe(100);
    expect(JSON.stringify(landing('en'))).not.toContain('api.github.com');
  });

  test('landing/stars.json est lu tel quel (valeur gardée si l\'API échoue) ; avant la première release : aucune version', () => {
    const stars = readStars();
    expect(typeof stars.stars).toBe('number');
    expect(stars.version === null || /^\d+\.\d+\.\d+/.test(stars.version)).toBe(true);
  });
});

describe('commande de démarrage : celle du tutoriel que la CI rejoue (4.8)', () => {
  const steps = parseQuickstart(readFileSync(new URL('../../content/tutoriels/quickstart.md', import.meta.url), 'utf8'));
  const script = (id: string): string => steps.find((step) => step.id === id)?.script ?? '';

  test('le bloc contient octet pour octet les étapes « secrets » et « start » du tutoriel', () => {
    for (const lang of LANGS) {
      const command = landing(lang).page.hero.command.text;
      expect(command).toContain(script('secrets'));
      expect(command).toContain(script('start'));
      expect(command.startsWith('git clone')).toBe(true);
    }
    expect(landing('fr').page.hero.command.text).toBe(landing('en').page.hero.command.text);
  });

  test('jamais « latest », jamais « curl … | sh » ; avec une version publiée, le clone épingle l\'étiquette', () => {
    expect(startCommand(inputs)).not.toMatch(/latest|curl|\|\s*(?:ba)?sh/);
    expect(startCommand({ ...inputs, version: null })).not.toContain('--branch');
    expect(startCommand({ ...inputs, version: '1.2.3' })).toContain('--branch v1.2.3');
  });
});

describe('identité et liens : une seule source, PUBLIC_REPOSITORY', () => {
  test('tout dérive de la variable : adresse GitHub Pages, chemin de base, lien Render', () => {
    expect(publicRepository({})).toBe('scrap-yo-mama/sym');
    expect(publicRepository({ PUBLIC_REPOSITORY: 'org/depot' })).toBe('org/depot');
    expect(() => publicRepository({ PUBLIC_REPOSITORY: 'pas-un-depot' })).toThrow();
    expect(pagesOrigin('Org/depot')).toBe('https://org.github.io');
    expect(pagesBase('org/depot')).toBe('/depot/');
    expect(renderDeployUrl('org/depot')).toBe('https://render.com/deploy?repo=https://github.com/org/depot');
    expect(JSON.stringify(landing('en'))).toContain('https://github.com/scrap-yo-mama/sym');
    expect(JSON.stringify(buildLanding('en', { ...inputs, repository: 'org/depot' }))).not.toContain('scrap-yo-mama');
  });

  test('un seul bouton plein par vue : le CTA Render du hero ; il porte « compte Render requis »', () => {
    for (const lang of LANGS) {
      const { hero, install } = landing(lang).page;
      expect(hero.ctas.filter((cta) => cta.style === 'primary')).toHaveLength(1);
      expect(hero.ctas[0]?.label).toMatch(/Render/);
      expect(hero.ctas[0]?.label).toMatch(lang === 'fr' ? /compte Render requis/ : /Render account required/);
      expect(install.cards.some((card) => card.cta.style === 'primary')).toBe(false);
      expect(hero.ctas[0]?.href).toEqual({ to: 'external', url: 'https://render.com/deploy?repo=https://github.com/scrap-yo-mama/sym' });
    }
  });

  test('les liens internes se résolvent avec le chemin de base ; une ancre reste une ancre', () => {
    expect(hrefOf({ to: 'home', lang: 'fr' }, '/sym/')).toBe('/sym/fr/');
    expect(hrefOf({ to: 'home', lang: 'en', anchor: 'faq' }, '/sym/')).toBe('/sym/#faq');
    expect(hrefOf({ to: 'doc', path: 'tutoriels/quickstart' }, '/sym/')).toBe('/sym/tutoriels/quickstart');
    expect(hrefOf({ to: 'anchor', id: 'demo' }, '/sym/')).toBe('#demo');
    expect(internalPath({ to: 'external', url: 'https://x.example/' })).toBeUndefined();
  });
});

describe('assert_landing_contrast_tokens : paires de jetons de la landing', () => {
  const themeCss = readFileSync(new URL('../../../../packages/ui/src/theme.css', import.meta.url), 'utf8');
  const landingCss = readFileSync(new URL('../../content/.vitepress/theme/landing/landing.css', import.meta.url), 'utf8');
  const root = cssVariables(themeCss, ':root');
  const dark = cssVariables(themeCss, '.dark, .sym-on-ink');
  const variables = { light: root, dark: { ...root, ...dark } };
  const token = (theme: 'light' | 'dark', name: string): Rgb => resolveColor(variables[theme], `var(--${name})`);

  // Paires de texte (≥ 4,5:1) et d'éléments (≥ 3:1) que la feuille de la landing pose : jeton de premier plan sur jeton de fond.
  const TEXT: [string, string][] = [
    ['foreground', 'background'],
    ['muted-foreground', 'background'],
    ['card-foreground', 'card'],
    ['primary', 'background'],
    ['primary', 'card'],
    ['primary-foreground', 'primary'],
    ['secondary-foreground', 'secondary'],
    ['accent-foreground', 'accent'],
    ['signature-foreground', 'signature'],
    ['nav-foreground', 'nav'],
    ['nav-muted-foreground', 'nav'],
    ['foreground', 'muted'],
    ['background', 'foreground'],
    ['muted-foreground', 'card'],
    ['primary', 'muted'],
  ];
  const ELEMENTS: [string, string][] = [
    ['foreground', 'background'],
    ['ring', 'background'],
    ['nav-muted-foreground', 'nav'],
    ['nav-foreground', 'nav'],
  ];
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} : texte à 4,5:1 au moins`, () => {
      for (const pair of TEXT) {
        const [fg, bg] = pair;
        expect(contrast(token(theme, fg), token(theme, bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    test(`${theme} : éléments d'interface (bordures, anneau de focus) à 3:1 au moins`, () => {
      for (const [fg, bg] of ELEMENTS) expect(contrast(token(theme, fg), token(theme, bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }

  test('blanc sur orange, orange en texte et bleu sur anthracite en texte font échouer la CI : la feuille n\'en pose aucun', () => {
    expect(sheetViolations(landingCss, variables, 'landing.css')).toEqual([]);
    expect(sheetViolations('.a { color: #FFFFFF; background: var(--sym-orange); }', variables)).not.toEqual([]);
    expect(sheetViolations('.a { color: var(--sym-orange); }', variables)).not.toEqual([]);
    expect(sheetViolations('.sym-on-ink .a { color: var(--sym-blue); background: var(--sym-ink); }', variables)).not.toEqual([]);
  });

  test('aucune couleur écrite en dur dans la feuille ni dans les composants de la landing (jetons de packages/ui seulement)', () => {
    const files = ['landing.css', 'parts.ts', 'LandingPage.ts', 'LegalPage.ts'].map((file) => new URL(`../../content/.vitepress/theme/landing/${file}`, import.meta.url));
    for (const file of files) expect(hardcodedColors(readFileSync(file, 'utf8'), file.pathname), file.pathname).toEqual([]);
  });

  test('le texte du bouton plein est lisible : papier sur bleu (clair), anthracite sur lilas (sombre)', () => {
    expect(contrast(token('light', 'primary-foreground'), token('light', 'primary'))).toBeGreaterThanOrEqual(6.5);
    expect(contrast(token('dark', 'primary-foreground'), token('dark', 'primary'))).toBeGreaterThanOrEqual(7);
  });
});
