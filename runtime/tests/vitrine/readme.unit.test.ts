// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12, critères README de 22b §3 (u8 R1, R2, R23) : chaque test nommé joue le contrôle sur les vrais README ET prouve par un
// cas négatif que le contrôle échoue quand la règle est violée (un contrôle qui ne sait pas échouer ne prouve rien).
import { describe, expect, test } from 'vitest';
import { loadClaims, type ClaimsFile } from '../../scripts/vitrine/lib/claims.ts';
import { identityOf, publicRepository, verifyBlock } from '../../scripts/vitrine/lib/identity.ts';
import { findEntries, loadList, normalize, parseList } from '../../scripts/vitrine/lib/text.ts';
import {
  altProblems, badgeProblems, claimsProblems, codeBlocks, copyProblems, headings, imageResolveProblems, images, lengthProblems, loadBudgets, marksProblems,
  parityProblems, pictureProblems, quickstartProblems, readReadme, repoLinkProblems, sectionProblems, verifyBlockProblems, whatItDoes, type Lang,
} from '../../scripts/vitrine/lib/readme.ts';

const budgets = loadBudgets();
const claims = loadClaims();
const identity = identityOf(publicRepository());
const README = { en: readReadme('en'), fr: readReadme('fr') };
const LANGS: Lang[] = ['en', 'fr'];
const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

describe('assert_readme_length_budget : 90 à 150 lignes, ≤ 12 Ko, commande avant la ligne 40', () => {
  test('les deux README respectent le budget', () => {
    for (const lang of LANGS) {
      expect(lengthProblems(README[lang], budgets), lang).toEqual([]);
      expect(lineCount(README[lang])).toBeGreaterThanOrEqual(90);
      expect(lineCount(README[lang])).toBeLessThanOrEqual(150);
    }
  });

  test('cas négatifs : trop court, trop long, trop lourd, commande trop basse', () => {
    expect(lengthProblems('# court\n\n```bash\nx\n```\n', budgets).join()).toMatch(/lignes/);
    const long = `${README.en}${'ligne en trop\n'.repeat(80)}`;
    expect(lengthProblems(long, budgets).join()).toMatch(/lignes/);
    expect(lengthProblems(`${README.en}${'x'.repeat(13_000)}\n`, budgets).join()).toMatch(/octets/);
    const late = `${'texte\n'.repeat(45)}${README.en}`;
    expect(lengthProblems(late, budgets).join()).toMatch(/première commande/);
  });
});

describe('assert_readme_i18n_parity : mêmes titres, mêmes blocs de code, mêmes images, sélecteur de langue en première ligne', () => {
  test('en et fr sont à parité', () => {
    expect(parityProblems(README.en, README.fr)).toEqual([]);
    expect(headings(README.en)).toHaveLength(headings(README.fr).length);
  });

  test('cas négatifs : un titre en moins, un bloc de code modifié, une image changée, sélecteur absent', () => {
    expect(parityProblems(README.en, README.fr.replace(/^## Contribuer$/m, '')).join()).toMatch(/titres/);
    expect(parityProblems(README.en, README.fr.replace('docker compose up --build', 'docker compose up')).join()).toMatch(/bloc de code/);
    expect(parityProblems(README.en, README.fr.replace('banner-dark.png', 'banner-other.png')).join()).toMatch(/images/);
    expect(parityProblems(README.en, `texte\n${README.fr}`).join()).toMatch(/première ligne/);
  });
});

describe('assert_readme_sections_present : les 11 blocs de 22 §3.1, dans l\'ordre, sans autre titre ##', () => {
  test('titres, ordre, un seul lien « Responsible use » dans le bloc des licences, tableau de 3 lignes', () => {
    for (const lang of LANGS) expect(sectionProblems(README[lang], lang), lang).toEqual([]);
  });

  test('les blocs sans titre : bandeau <picture>, liens, badges, avertissement de pré-version', () => {
    for (const lang of LANGS) {
      const text = README[lang];
      expect(text, lang).toMatch(/<picture>/);
      expect(text, lang).toMatch(/Docs<\/a>/);
      expect(text, lang).toMatch(/Quickstart<\/a>/);
      expect(text, lang).toMatch(/Discussions<\/a>/);
      expect(text, lang).toMatch(/<details>/);
    }
  });

  test('cas négatifs : titre ajouté, sections permutées, deuxième lien « Responsible use », lien hors du bloc des licences', () => {
    expect(sectionProblems(`${README.en}\n## Extra\n`, 'en').join()).toMatch(/titres/);
    expect(sectionProblems(README.en.replace('## Licenses', '## Contribute-x').replace('## Contribute\n', '## Licenses\n'), 'en').join()).toMatch(/titres/);
    expect(sectionProblems(`${README.en}\n[Responsible use](https://github.com/scrap-yo-mama/sym/blob/main/LICENSE)\n`, 'en').join()).toMatch(/liens « Responsible use/);
    const moved = README.en.replace(/\n\[Responsible use\][^\n]*\n/, '\n') + '\n[Responsible use](https://github.com/scrap-yo-mama/sym/blob/main/runtime/NOTICE)\n';
    expect(sectionProblems(moved, 'en').join()).toMatch(/pas dans le bloc des licences/);
  });
});

describe('assert_readme_badges_budget : 5 badges au plus, tous de la liste autorisée', () => {
  test('les README portent au plus 5 badges, servis par le seul service autorisé', () => {
    for (const lang of LANGS) {
      expect(badgeProblems(README[lang], budgets), lang).toEqual([]);
      const hosts = images(README[lang]).filter((i) => i.src.startsWith('http')).map((i) => new URL(i.src).hostname);
      for (const host of hosts) expect(budgets.badges.allowedHosts).toContain(host);
    }
  });

  test('cas négatifs : six badges, domaine hors liste', () => {
    const six = `${README.en}\n${Array.from({ length: 6 }, (_, i) => `![b${i}](https://img.shields.io/badge/x${i}-y-blue)`).join(' ')}\n`;
    expect(badgeProblems(six, budgets).join()).toMatch(/badges/);
    expect(imageResolveProblems(`${README.en}\n![x](https://badges.example.org/a.svg)\n`, budgets).join()).toMatch(/hors liste blanche/);
  });
});

describe('assert_readme_claims_registered : chaque puce de « What it does » a son entrée relue du registre', () => {
  test('les 5 puces de chaque langue ont leur entrée « relu » ; aucune entrée non relue n\'est affichée', () => {
    for (const lang of LANGS) {
      expect(whatItDoes(README[lang], lang)).toHaveLength(5);
      expect(claimsProblems(README[lang], lang, claims), lang).toEqual([]);
    }
  });

  test('cas négatifs : puce sans entrée, entrée « à relire » ou « bloqué »', () => {
    const edited = README.en.replace('- **Guard rails.**', '- **Guard rails, now stronger.**');
    expect(claimsProblems(edited, 'en', claims).join()).toMatch(/n'a pas d'entrée/);
    const stale: ClaimsFile = { ...claims, claims: claims.claims.map((c) => (c.id === 'guard-rails' ? { ...c, status: 'à relire' as const } : c)) };
    expect(claimsProblems(README.en, 'en', stale).join()).toMatch(/à relire/);
    const blocked: ClaimsFile = { ...claims, claims: claims.claims.map((c) => (c.id === 'guard-rails' ? { ...c, status: 'bloqué' as const } : c)) };
    expect(claimsProblems(README.fr, 'fr', blocked).join()).toMatch(/bloqué/);
  });
});

describe('assert_readme_no_bypass_copy : 0 mot de P (hors registre) et 0 mot de L (D-46)', () => {
  test('README en et fr : aucun mot des listes P et L', () => {
    for (const lang of LANGS) expect(copyProblems(README[lang], claims, { whitelistRegistry: true }), lang).toEqual([]);
  });

  test('cas négatifs : promesses en fr et en, idiomes d\'invisibilité, accents et traits d\'union normalisés, termes de limite', () => {
    for (const bad of [
      'SYM is undetectable.', 'Il contourne les protections.', 'Le mode fantôme te rend discret.', 'passe partout', 'passe-partout', 'anti detect',
      'Stealth mode', 'Tu ne seras jamais bloqué.', 'It never gets blocked, a ghost mode.', 'Résout les captchas', 'Fingerprint rotation',
    ]) {
      expect(copyProblems(bad, claims, { whitelistRegistry: false }), bad).not.toEqual([]);
    }
  });

  test('un mot de P ne passe que dans une phrase du registre (L reste interdit dans le README)', () => {
    const phrase = claims.claims.find((c) => c.id === 'no-challenge-solving')?.en ?? '';
    expect(phrase).toMatch(/captcha/i);
    expect(copyProblems(phrase, claims, { whitelistRegistry: true })).toEqual([]);
    expect(copyProblems(phrase, claims, { whitelistRegistry: false }).join()).toMatch(/captcha/);
  });
});

describe('assert_readme_no_third_party_marks : aucune marque de la liste noire hors exceptions descriptives', () => {
  test('README en et fr, texte et alt', () => {
    for (const lang of LANGS) expect(marksProblems(README[lang]), lang).toEqual([]);
  });

  test('cas négatifs : fournisseur de modèle, client MCP, outil de scraping, réseau social ; exceptions descriptives admises', () => {
    for (const bad of ['Works with Claude', 'Built on OpenAI models', 'a Firecrawl alternative', 'Scrape LinkedIn', 'Playwright scripts', 'Cursor and Windsurf']) {
      expect(marksProblems(bad), bad).not.toEqual([]);
    }
    expect(marksProblems('Hosted on GitHub, run with Docker, deploy to Render or Railway, over the Model Context Protocol (MCP), try books.toscrape.com')).toEqual([]);
  });
});

describe('assert_readme_quickstart_matches_ci : « Try it » reprend les commandes du quickstart rejoué en CI (4.8)', () => {
  test('les commandes sont celles des étapes « secrets » et « start » du tutoriel', () => {
    for (const lang of LANGS) expect(quickstartProblems(README[lang]), lang).toEqual([]);
  });

  test('cas négatifs : une commande modifiée, une commande en moins', () => {
    expect(quickstartProblems(README.en.replace('docker compose up --build', 'docker compose up -d')).join()).toMatch(/pas celles du quickstart/);
    expect(quickstartProblems(README.en.replace('  set -C\n', '')).join()).toMatch(/pas celles du quickstart/);
    expect(codeBlocks(README.en)[0]?.body).toContain('docker compose up --build');
  });
});

describe('assert_readme_images_resolve, assert_readme_alt_text, assert_readme_picture_dark_variants', () => {
  test('chaque chemin relatif existe ; tout domaine absolu est dans la liste blanche', () => {
    for (const lang of LANGS) expect(imageResolveProblems(README[lang], budgets), lang).toEqual([]);
    expect(imageResolveProblems('![a](assets/brand/absent.png)', budgets).join()).toMatch(/introuvable/);
    expect(imageResolveProblems('![a](../../etc/passwd)', budgets).join()).toMatch(/introuvable/);
  });

  test('chaque image a un alt, sans « image de » ni « screenshot of »', () => {
    for (const lang of LANGS) expect(altProblems(README[lang]), lang).toEqual([]);
    expect(altProblems('<img src="a.png">').join()).toMatch(/sans alt/);
    expect(altProblems('![](a.png)').join()).toMatch(/alt vide/);
    expect(altProblems('![](a.png)', ['a.png'])).toEqual([]);
    expect(altProblems('![Screenshot of the console](a.png)').join()).toMatch(/à reformuler/);
    expect(altProblems('![Image de la console](a.png)').join()).toMatch(/à reformuler/);
  });

  test('chaque <picture> a ses sources dark et light, un <img> de repli avec alt, et ses fichiers', () => {
    for (const lang of LANGS) expect(pictureProblems(README[lang]), lang).toEqual([]);
    const broken = '<picture><source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.png"><img src="assets/brand/banner-light.png"></picture>';
    const found = pictureProblems(broken).join();
    expect(found).toMatch(/sans source light/);
    expect(found).toMatch(/sans <img> de repli avec alt/);
    expect(pictureProblems(broken.replace('banner-dark', 'absent')).join()).toMatch(/introuvable/);
  });
});

describe('identité : liens du README et bloc « Verify » dérivés de PUBLIC_REPOSITORY', () => {
  test('tous les liens du dépôt visent le dépôt public et un chemin qui existe', () => {
    for (const lang of LANGS) expect(repoLinkProblems(README[lang], identity), lang).toEqual([]);
  });

  test('cas négatifs : autre propriétaire, chemin absent, image GHCR d\'une organisation homonyme', () => {
    expect(repoLinkProblems(README.en.replace(/scrap-yo-mama\/sym\/discussions/, 'scrapyomama/sym/discussions'), identity).join()).toMatch(/autre dépôt/);
    expect(repoLinkProblems(README.en.replace('runtime/SECURITY.md', 'runtime/ABSENT.md'), identity).join()).toMatch(/introuvable/);
    expect(repoLinkProblems(README.en.replace('ghcr.io/scrap-yo-mama/sym', 'ghcr.io/scrapyomama/sym'), identity).join()).toMatch(/GHCR/);
  });

  test('le bloc « Verify » est celui que dérive l\'identité (octet pour octet, en et fr)', () => {
    for (const lang of LANGS) expect(verifyBlockProblems(README[lang], identity), lang).toEqual([]);
    expect(codeBlocks(README.en).some((b) => b.body === verifyBlock(identity))).toBe(true);
    const other = identityOf('autre/depot');
    expect(verifyBlockProblems(README.en, other).join()).toMatch(/identité publique autre\/depot/);
  });
});

describe('lexique : normalisation (casse, accents, traits d\'union, espaces) et listes versionnées', () => {
  test('normalize et parseList : « passe partout » = « passe-partout », racines et pluriels', () => {
    expect(normalize('  Passe PARTOUT  ')).toBe(normalize('passe-partout'));
    expect(normalize('Déjoue')).toBe('dejoue');
    expect(parseList('# commentaire\n\nstealth\ncontourn-\n')).toEqual(['stealth', 'contourn*']);
    expect(findEntries('Il contournera tout', parseList('contourn-'))).toEqual(['contourn*']);
    expect(findEntries('anti-bots', parseList('anti-bot'))).toEqual(['anti bot']);
    expect(findEntries('stealthy', parseList('stealth'))).toEqual([]);
  });

  test('les listes P et L, la liste noire et la liste d\'exceptions existent et ne se recouvrent pas', () => {
    const p = loadList('forbidden-p.txt');
    const l = loadList('forbidden-l.txt');
    const marks = loadList('third-party-marks.txt');
    const allowed = loadList('third-party-allowed.txt');
    expect(p.length).toBeGreaterThan(30);
    expect(l).toEqual(expect.arrayContaining(['captcha', 'anti bot', 'rotation']));
    expect(p.filter((entry) => l.includes(entry))).toEqual([]);
    expect(marks.filter((entry) => allowed.map((a) => a.toLowerCase()).includes(entry))).toEqual([]);
    expect(allowed).toEqual(expect.arrayContaining(['github', 'docker', 'render', 'railway', 'chrome web store', 'books.toscrape.com', 'model context protocol']));
  });
});
