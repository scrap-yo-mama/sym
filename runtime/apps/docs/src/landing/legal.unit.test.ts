// SPDX-License-Identifier: AGPL-3.0-only
// assert_legal_pages_reference_clause (22b § 2, volet landing) : les pages juridiques propres à la landing (mentions légales,
// Confidentialité), en français et en anglais, portent la clause « en cas de divergence, la version … fait foi », qui nomme la même
// langue de référence partout ; elles sont tutoyées, marquées « à valider par un avocat », et la page Confidentialité mentionne le
// stockage local du thème et de la langue. Les éléments à fournir (éditeur, directeur de publication) restent des champs marqués.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { HOME_PATHS, LEGAL_PATHS, LEGAL_REFERENCE_LANGUAGE, rewriteRepoHref } from './href.ts';
import { LANGS, type Lang, type LegalPage } from './types.ts';

const source = (lang: Lang, page: LegalPage): string => readFileSync(new URL(`../../content/${LEGAL_PATHS[lang][page]}.md`, import.meta.url), 'utf8');
const PAGES: LegalPage[] = ['privacy', 'notice'];

const CLAUSE: Record<Lang, RegExp> = {
  fr: /En cas de divergence, la version (française|anglaise) fait foi\./,
  en: /If the two versions differ, the (French|English) version prevails\./,
};
const NAME: Record<string, Lang> = { française: 'fr', French: 'fr', anglaise: 'en', English: 'en' };

describe('assert_legal_pages_reference_clause : une clause, une seule langue de référence', () => {
  test('chaque page, dans chaque langue, porte la clause et nomme la même langue de référence', () => {
    const named = new Set<Lang>();
    for (const lang of LANGS) for (const page of PAGES) {
      const match = CLAUSE[lang].exec(source(lang, page));
      expect(match, `${lang} ${page}`).not.toBeNull();
      named.add(NAME[match?.[1] ?? ''] as Lang);
    }
    expect([...named]).toEqual([LEGAL_REFERENCE_LANGUAGE]);
  });

  test('chaque version renvoie vers l\'autre (liens complets, hors routeur)', () => {
    for (const page of PAGES) {
      expect(source('en', page)).toContain(`](/${LEGAL_PATHS.fr[page]}){.vp-raw}`);
      expect(source('fr', page)).toContain(`](/${LEGAL_PATHS.en[page]}){.vp-raw}`);
    }
  });

  test('traduction fidèle : mêmes sections, dans le même ordre, avec les mêmes liens, dans les deux langues', () => {
    for (const page of PAGES) {
      const shape = (text: string): string[] => [...text.replace(/^---[\s\S]*?---\n/, '').matchAll(/^(#{1,3} .*|> .*|\S.*)$/gm)].map((m) => (/^#/.test(m[1] ?? '') ? (m[1] ?? '').split(' ')[0] ?? '' : /^>/.test(m[1] ?? '') ? '>' : 'p'));
      expect(shape(source('fr', page)), page).toEqual(shape(source('en', page)));
      const links = (text: string): string[] => [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => (m[1] ?? '').replace(/\{\.vp-raw\}/, '').replace(/^\/(?:fr\/)?legal\/.*$/, '/legal/*'));
      expect(links(source('fr', page)), page).toEqual(links(source('en', page)));
    }
  });
});

describe('pages juridiques de la landing : registre, mentions, éléments à fournir', () => {
  test('toutes sont marquées « à valider par un avocat » et « pas un avis juridique »', () => {
    for (const page of PAGES) {
      expect(source('fr', page)).toMatch(/à valider par un avocat/);
      expect(source('fr', page)).toMatch(/n'est pas un avis juridique/);
      expect(source('en', page)).toMatch(/reviewed by a lawyer/);
      expect(source('en', page)).toMatch(/not legal advice/);
    }
  });

  test('tutoiement dans les versions françaises', () => {
    for (const page of PAGES) {
      expect(source('fr', page)).not.toMatch(/\b(?:vous|votre|vos)\b/i);
      expect(source("fr", page)).toMatch(/\b(?:tu|ton|ta|tes|toi|Écris|Lis)\b/i);
    }
  });

  test('la Confidentialité décrit le stockage local du thème et de la langue, après un choix, sans identifiant (ePrivacy 5(3), à valider)', () => {
    const fr = source('fr', 'privacy');
    expect(fr).toMatch(/stockage local/);
    expect(fr).toMatch(/thème/);
    // La langue : dit explicitement, stockée ou non (un simple mot « langue » ne suffit pas).
    expect(fr).toMatch(/Ta langue (?:n'est pas enregistrée|est gardée dans (?:ce|le) stockage local)/);
    expect(fr).toMatch(/seulement après que tu as fait ce choix|qu'après que tu as fait ce choix/);
    expect(fr).toMatch(/aucun identifiant/);
    expect(fr).toMatch(/article 5, paragraphe 3/);
    const en = source('en', 'privacy');
    expect(en).toMatch(/local storage/);
    expect(en).toMatch(/theme/);
    expect(en).toMatch(/Your language (?:is not stored|is kept in (?:this|the) local storage)/);
    expect(en).toMatch(/only after you have made the choice/);
    expect(en).toMatch(/no identifier/);
    expect(en).toMatch(/article 5\(3\) of the ePrivacy directive/);
  });

  test('la Confidentialité couvre aussi les pages de documentation du même site, dont le sélecteur de thème écrit sa valeur par défaut dès l\'ouverture', () => {
    expect(source('fr', 'privacy')).toMatch(/pages de documentation[^.]*dès (?:leur |l'|son )ouverture/);
    expect(source('fr', 'privacy')).toMatch(/« auto »/);
    expect(source('en', 'privacy')).toMatch(/documentation pages[^.]*as soon as (?:they open|one opens)/);
    expect(source('en', 'privacy')).toMatch(/“auto”/);
  });

  test('la Confidentialité décrit les journaux de l\'hébergeur tels qu\'ils sont : GitHub Pages, adresse IP, aucun journal reçu', () => {
    for (const lang of LANGS) {
      const text = source(lang, 'privacy');
      expect(text).toMatch(/GitHub Pages/);
      expect(text).toMatch(/IP/);
    }
  });

  test('la Confidentialité dit que les agrégats de trafic du dépôt (traffic-archive.yml) sont archivés en artefact PUBLIC, sans adresse IP ni compte', () => {
    // GitHub réserve ces agrégats aux comptes qui ont le droit d'écrire ; un artefact d'un dépôt public se télécharge par tout compte connecté.
    expect(source('fr', 'privacy')).toMatch(/## Ce que le dépôt mesure/);
    expect(source('fr', 'privacy')).toMatch(/agrégats de trafic[^.]*\./);
    expect(source('fr', 'privacy')).toMatch(/publi(?:c|que)[^.]*toute personne connectée à GitHub/);
    expect(source('fr', 'privacy')).toMatch(/ni adresse IP ni compte/);
    expect(source('en', 'privacy')).toMatch(/## What the repository measures/);
    expect(source('en', 'privacy')).toMatch(/traffic aggregates[^.]*\./);
    expect(source('en', 'privacy')).toMatch(/public[^.]*anyone signed in to GitHub/);
    expect(source('en', 'privacy')).toMatch(/no IP address and no account/);
  });

  test('les mentions légales nomment l\'hébergeur et gardent un champ marqué pour l\'éditeur, à compléter avant la mise en ligne', () => {
    expect(source('fr', 'notice')).toMatch(/GitHub, Inc\./);
    expect(source('fr', 'notice')).toMatch(/\[À compléter avant la mise en ligne : nom, forme juridique, adresse et e-mail de l'éditeur\.\]/);
    expect(source('en', 'notice')).toMatch(/\[To be completed before going live: name, legal form, address and e-mail of the publisher\.\]/);
  });

  test('les mentions légales renvoient vers LICENSE et TRADEMARK.md du dépôt public (22 § 2.11), liens dérivés de PUBLIC_REPOSITORY', () => {
    for (const lang of LANGS) {
      const text = source(lang, 'notice');
      expect(text, lang).toContain('](repo:/blob/main/LICENSE)');
      expect(text, lang).toContain('](repo:/blob/main/runtime/TRADEMARK.md)');
      expect(text, lang).not.toMatch(/https:\/\/github\.com\/[^/)]+\/[^/)]+\/blob/);
    }
    expect(rewriteRepoHref('repo:/blob/main/LICENSE', 'org/depot')).toBe('https://github.com/org/depot/blob/main/LICENSE');
    expect(rewriteRepoHref('https://docs.github.com/x', 'org/depot')).toBe('https://docs.github.com/x');
    expect(rewriteRepoHref('/legal/privacy', 'org/depot')).toBe('/legal/privacy');
  });

  test('chaque page juridique renvoie vers Usage responsable et Hors périmètre ou vers les mentions, et vit sous son dossier de langue', () => {
    for (const lang of LANGS) for (const page of PAGES) expect(LEGAL_PATHS[lang][page].startsWith(HOME_PATHS[lang] || 'legal/')).toBe(true);
    expect(source('fr', 'notice')).toContain('(/explications/usage-responsable)');
    expect(source('fr', 'notice')).toContain('(/explications/hors-perimetre)');
    expect(source('en', 'notice')).toContain('(/explications/usage-responsable)');
  });
});
