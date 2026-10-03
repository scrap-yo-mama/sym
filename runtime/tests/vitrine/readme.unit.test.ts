// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12, critères README de 22b §3 (u8 R1, R2, R23) : chaque test nommé joue le contrôle sur les vrais README ET prouve par un
// cas négatif que le contrôle échoue quand la règle est violée (un contrôle qui ne sait pas échouer ne prouve rien).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { foreignClaimsDisplayed, loadClaims, type ClaimsFile } from '../../scripts/vitrine/lib/claims.ts';
import { identityOf, publicRepository, verifyBlock } from '../../scripts/vitrine/lib/identity.ts';
import { findEntries, loadList, normalize, parseList } from '../../scripts/vitrine/lib/text.ts';
import {
  altProblems, badgeProblems, badgeKind, badges, bannerAltProblems, bannerTexts, claimsProblems, codeBlocks, copyProblems, headings, imageResolveProblems, images, lengthProblems, loadBudgets, marksProblems,
  parityProblems, pictureProblems, quickstartProblems, readReadme, repoLinkProblems, sectionProblems, unregisteredFactsProblems, verifyBlockProblems, whatItDoes, type Lang,
} from '../../scripts/vitrine/lib/readme.ts';
import { loadThirdPartyRepos, ownerReferenceFiles, ownerReferenceProblems } from '../../scripts/vitrine/lib/owners.ts';
import { runtimeDir } from '../../scripts/vitrine/lib/paths.ts';

const budgets = loadBudgets();
const claims = loadClaims();
const identity = identityOf(publicRepository());
const README = { en: readReadme('en'), fr: readReadme('fr') };
const LANGS: Lang[] = ['en', 'fr'];
/** Organisation homonyme dérivée de l'identité (jamais une constante) : cas négatifs des gardes d'identité. */
const homonym = identityOf(`${identity.owner}-homonyme/${identity.name}`);
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

  // Écart assumé au titre du bloc 6 (22 §3.1 : « Try it in two minutes (no key) ») : la première construction de l'image prend
  // plusieurs minutes, et le quickstart crée deux secrets d'instance : le README dit « Try it (no model key) » / « Essaie (sans
  // clé de modèle) » (voir SECTION_TITLES dans lib/readme.ts).
  test.todo('bloc 2 : lien vers la landing (4.11) à côté de Docs, Quickstart et Discussions, une fois la landing en ligne');
  test.todo('bloc 4 : vignette de démo fr et en (PNG ≤ 150 Ko) cliquable vers la vidéo, ajoutée avec le GIF par 3.11');

  test('cas négatifs : titre ajouté, sections permutées, deuxième lien « Responsible use », lien hors du bloc des licences', () => {
    expect(sectionProblems(`${README.en}\n## Extra\n`, 'en').join()).toMatch(/titres/);
    expect(sectionProblems(README.en.replace('## Licenses', '## Contribute-x').replace('## Contribute\n', '## Licenses\n'), 'en').join()).toMatch(/titres/);
    expect(sectionProblems(`${README.en}\n[Responsible use](${identity.url}/blob/main/LICENSE)\n`, 'en').join()).toMatch(/liens « Responsible use/);
    const moved = `${README.en.replace(/\n\[Responsible use\][^\n]*\n/, '\n')}\n[Responsible use](${identity.url}/blob/main/runtime/NOTICE)\n`;
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

  test('V1 : licence, dernière version et CI seulement (22 §3.1, bloc 3) ; une étoile ou un compteur de téléchargements est refusé', () => {
    for (const lang of LANGS) {
      expect(badges(README[lang], budgets).map((badge) => badgeKind(badge.src, budgets)), lang).toEqual(budgets.badges.allowedPaths);
    }
    expect(budgets.badges.allowedPaths).toEqual(['/github/license/', '/github/v/release/', '/github/actions/workflow/status/']);
    for (const kind of ['github/stars', 'github/downloads', 'github/forks', 'badge/build-passing-green']) {
      const extra = `${README.en}\n![x](https://img.shields.io/${kind}/${identity.repository})\n`;
      expect(badgeProblems(extra, budgets).join(), kind).toMatch(/hors de la liste autorisée/);
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

  test('hors des puces : un chiffre avec unité, ou le rejeu par la CI dans « Try it », ne s\'affiche que si la phrase est au registre (22 §3.2)', () => {
    for (const lang of LANGS) expect(unregisteredFactsProblems(README[lang], lang, claims), lang).toEqual([]);
    const replay = claims.claims.find((c) => c.id === 'quickstart-replayed-by-ci');
    expect(replay?.status).toBe('relu');
    expect(replay?.surfaces).toContain('readme');
    for (const lang of LANGS) expect(README[lang], lang).toContain(replay?.[lang] ?? '\0');
  });

  test('cas négatifs : chiffre sans mesure (« about 4 GB of memory »), rejeu par la CI reformulé hors registre, durée annoncée', () => {
    const memory = README.en.replace('You need Docker with Compose.', 'You need Docker with Compose and about 4 GB of memory.');
    expect(memory).not.toBe(README.en);
    expect(unregisteredFactsProblems(memory, 'en', claims).join()).toMatch(/4 GB/);
    const memoryFr = README.fr.replace('Il te faut Docker avec Compose.', 'Il te faut Docker avec Compose et environ 4 Go de mémoire.');
    expect(memoryFr).not.toBe(README.fr);
    expect(unregisteredFactsProblems(memoryFr, 'fr', claims).join()).toMatch(/4 Go/);
    const replay = claims.claims.find((c) => c.id === 'quickstart-replayed-by-ci')?.en ?? '\0';
    const ci = README.en.replace(replay, 'The CI replays these commands on every commit.');
    expect(ci).not.toBe(README.en);
    expect(unregisteredFactsProblems(ci, 'en', claims).join()).toMatch(/CI replays/);
    expect(unregisteredFactsProblems(`${README.en}\nIt starts in 2 minutes.\n`, 'en', claims).join()).toMatch(/2 minutes/);
  });

  test('« Try it » dit quelle clé il ne demande pas : aucune clé de modèle (le mode démo sans aucune clé arrive avec la première version)', () => {
    expect(headings(README.en)).toContain('Try it (no model key)');
    expect(headings(README.fr)).toContain('Essaie (sans clé de modèle)');
    for (const lang of LANGS) expect(sectionProblems(README[lang].replace(/^## (Try it|Essaie) \(.*\)$/m, '## $1 (no key)'), lang).join(), lang).toMatch(/titres/);
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

  test("cas négatifs rejoués par la vérification : dérivés et éditeurs de captcha ou d'anti-bot, ajoutés à un README conforme, le font échouer", () => {
    for (const bad of ["Stealthy scraping.", "Evading bot walls.", "Solves reCAPTCHA and hCaptcha.", "Works with 2Captcha.", "Antidetect browser.", "Undetectably fast."]) {
      for (const lang of LANGS) {
        const readme = `${README[lang]}\n${bad}\n`;
        const found = [...copyProblems(readme, claims, { whitelistRegistry: true }), ...marksProblems(readme)];
        expect(found, `${lang} : ${bad}`).not.toEqual([]);
      }
    }
    for (const vendor of ["reCAPTCHA", "hCaptcha", "2Captcha", "CapSolver", "Kasada", "Arkose", "GeeTest", "Incapsula"]) {
      expect(marksProblems(`Works with ${vendor}.`), vendor).not.toEqual([]);
    }
  });

  test('cas négatifs rejoués par la vérification : « invisible » seul et « franchi(r) / franchit » (20 §2.2), ajoutés à un README conforme, le font échouer', () => {
    for (const bad of ['SYM reste invisible.', 'Invisible for sites.', 'Invisibles pour les sites.', 'Il franchit un défi.', 'Franchir la protection.', 'Protection franchie.']) {
      for (const lang of LANGS) expect(copyProblems(`${README[lang]}\n${bad}\n`, claims, { whitelistRegistry: true }).join(), `${lang} : ${bad}`).toMatch(/liste P/);
    }
  });

  test('liste blanche des emplois neutres de 20 §2.2 : « icône invisible aux lecteurs d\'écran », « mot de passe », aria-hidden', () => {
    for (const neutral of ['Icône invisible aux lecteurs d\'écran.', 'Icone invisible aux lecteurs d’ecran', 'Saisis ton mot de passe.', '<span aria-hidden="true">x</span>']) {
      expect(copyProblems(neutral, claims, { whitelistRegistry: false }), neutral).toEqual([]);
    }
    // La liste blanche ne retire que la phrase neutre : un « invisible » ailleurs reste pris.
    expect(copyProblems('Icône invisible aux lecteurs d\'écran. SYM reste invisible.', claims, { whitelistRegistry: false }).join()).toMatch(/liste P/);
  });

  test('L reste interdit dans le README, même dans une phrase du registre (D-46) ; seul CLAIMS.md admet L dans une phrase du registre', () => {
    const engagement = claims.claims.find((c) => c.id === 'no-challenge-solving');
    expect(engagement?.en).toMatch(/captcha/i);
    for (const lang of LANGS) {
      const phrase = engagement?.[lang] ?? '';
      const readme = `${README[lang]}\n${phrase}\n`;
      expect(copyProblems(readme, claims, { whitelistRegistry: true }).join(), lang).toMatch(/liste L : « captcha »/);
      expect(copyProblems(phrase, claims, { whitelistRegistry: true, limitTermsInRegistry: true }), lang).toEqual([]);
      expect(copyProblems(`${phrase} Captcha.`, claims, { whitelistRegistry: true, limitTermsInRegistry: true }).join(), lang).toMatch(/captcha/);
    }
  });

  test('une phrase du registre n\'apparaît dans le README que si son entrée porte la surface readme (en et fr)', () => {
    for (const lang of LANGS) expect(foreignClaimsDisplayed(claims, README[lang], 'readme'), lang).toEqual([]);
    for (const claim of claims.claims.filter((c) => !c.surfaces.includes('readme'))) {
      for (const lang of LANGS.filter((l) => claim[l].trim().length >= 12)) expect(foreignClaimsDisplayed(claims, `${README[lang]}\n${claim[lang]}\n`, 'readme').join(), `${claim.id} ${lang}`).toMatch(new RegExp(claim.id));
    }
  });

  test('un mot de P ne passe que dans une phrase du registre', () => {
    const p = loadList('forbidden-p.txt');
    const withP = claims.claims.find((c) => findEntries(c.en, p).length > 0) ?? { en: 'Stealth mode', id: 'fixture' };
    const file: ClaimsFile = { ...claims, claims: [...claims.claims, { ...claims.claims[0]!, id: 'fixture-p', en: withP.en, fr: withP.en }] };
    expect(copyProblems(withP.en, file, { whitelistRegistry: true })).toEqual([]);
    expect(copyProblems(withP.en, file, { whitelistRegistry: false }).join()).toMatch(/liste P/);
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

  test('l\'alt du bandeau décrit ce que montre le bandeau (ses textes), sans accroche ni phrase absente de l\'image', () => {
    const texts = bannerTexts();
    expect(texts).toEqual(['Scrapyomama', 'SYM'].filter((t) => texts.includes(t)));
    for (const lang of LANGS) expect(bannerAltProblems(README[lang], texts), lang).toEqual([]);
    expect(bannerAltProblems(README.en.replace(/(<picture>[\s\S]*?<img alt=")[^"]*"/, '$1Scrapyomama (SYM): describe the data, get an API."'), texts).join()).toMatch(/accroche|phrase/);
    expect(bannerAltProblems(README.en.replace(/(<picture>[\s\S]*?<img alt=")[^"]*"/, '$1Ghost logo"'), texts).join()).toMatch(/Scrapyomama/);
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
    expect(repoLinkProblems(README.en.replace(`${identity.repository}/discussions`, `${homonym.repository}/discussions`), identity).join()).toMatch(/autre dépôt/);
    expect(repoLinkProblems(README.en.replace('runtime/SECURITY.md', 'runtime/ABSENT.md'), identity).join()).toMatch(/introuvable/);
    expect(repoLinkProblems(README.en.replace(identity.image, homonym.image), identity).join()).toMatch(/GHCR/);
  });

  test('le bloc « Verify » est celui que dérive l\'identité (octet pour octet, en et fr)', () => {
    for (const lang of LANGS) expect(verifyBlockProblems(README[lang], identity), lang).toEqual([]);
    expect(codeBlocks(README.en).some((b) => b.body === verifyBlock(identity))).toBe(true);
    const other = identityOf('autre/depot');
    expect(verifyBlockProblems(README.en, other).join()).toMatch(/identité publique autre\/depot/);
  });
});

describe('assert_verify_snippet_works : garde d\'organisation homonyme sur le texte brut des README et des autres surfaces de .github/', () => {
  const thirdParty = loadThirdPartyRepos();
  const at = (text: string): string => ownerReferenceProblems(text, identity, thirdParty).join();
  /** Nom refusé par GitHub (D-37, D-40) : il appartient à un tiers, aucune surface ne doit le citer. */
  const refused = identityOf(`${identity.owner.replace(/-/g, '')}/${identity.name}`);

  test('les deux README, CLAIMS.md, les formulaires d\'issues et le gabarit des notes de version sont dans le périmètre de la garde', () => {
    const files = ownerReferenceFiles();
    for (const file of ['.github/README.md', '.github/README.fr.md', '.github/CLAIMS.md', '.github/release-notes-template.md', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml']) {
      expect(files, file).toContain(file);
    }
  });

  test('le texte brut des README (blocs de code et badges compris) ne cite que le dépôt de PUBLIC_REPOSITORY', () => {
    for (const lang of LANGS) expect(at(README[lang]), lang).toBe('');
  });

  test('cas négatifs : clonage d\'un autre dépôt (que le contrôle des liens et du quickstart laisse passer), badges d\'un autre propriétaire, `-R` d\'un autre dépôt', () => {
    const clone = README.en.replace(`git clone ${identity.url}`, `git clone ${refused.url}`);
    expect(clone).not.toBe(README.en);
    expect(repoLinkProblems(clone, identity)).toEqual([]);
    expect(at(clone)).toMatch(/autre dépôt/);
    const license = README.en.replace(`img.shields.io/github/license/${identity.repository}`, `img.shields.io/github/license/${refused.repository}`);
    expect(license).not.toBe(README.en);
    expect(at(license)).toMatch(/badge/);
    const release = README.fr.replace(`img.shields.io/github/v/release/${identity.repository}`, `img.shields.io/github/v/release/${homonym.repository}`);
    expect(release).not.toBe(README.fr);
    expect(at(release)).toMatch(/badge/);
    const ci = README.en.replace(`img.shields.io/github/actions/workflow/status/${identity.repository}/`, `img.shields.io/github/actions/workflow/status/${homonym.repository}/`);
    expect(ci).not.toBe(README.en);
    expect(at(ci)).toMatch(/badge/);
    const attestation = README.en.replace(`-R ${identity.repository}`, `-R ${homonym.repository}`);
    expect(attestation).not.toBe(README.en);
    expect(at(attestation)).toMatch(/-R/);
  });
});

describe('lexique : normalisation (casse, accents, traits d\'union, espaces) et listes versionnées', () => {
  test('normalize et parseList : « passe partout » = « passe-partout », racines et pluriels', () => {
    expect(normalize('  Passe PARTOUT  ')).toBe(normalize('passe-partout'));
    expect(normalize('Déjoue')).toBe('dejoue');
    expect(parseList('# commentaire\n\nstealth\ncontourn-\n')).toEqual(['stealth', 'contourn*']);
    expect(findEntries('Il contournera tout', parseList('contourn-'))).toEqual(['contourn*']);
    expect(findEntries('anti-bots', parseList('anti-bot'))).toEqual(['anti bot']);
    // Sans tiret, une entrée reste un mot entier (pluriel admis) ; `racine-` = préfixe ; `-racine-` = n'importe où dans un mot.
    expect(findEntries('stealthy', parseList('stealth'))).toEqual([]);
    expect(findEntries('stealthy', parseList('stealth-'))).toEqual(['stealth*']);
    expect(parseList('-captcha-')).toEqual(['*captcha*']);
    expect(findEntries('reCAPTCHA', parseList('-captcha-'))).toEqual(['*captcha*']);
    expect(findEntries('2Captcha', parseList('-captcha-'))).toEqual(['*captcha*']);
    expect(findEntries('capture', parseList('-captcha-'))).toEqual([]);
  });

  test('listes réelles : les dérivés passent par les racines (stealthy, evading, evasion, sneaky…) et « captcha » est trouvé dans un mot', () => {
    const p = loadList('forbidden-p.txt');
    const l = loadList('forbidden-l.txt');
    for (const word of ['stealthy', 'stealthily', 'evading', 'evades', 'evasion', 'evasive', 'sneaky', 'sneaking', 'antidetect', 'undetectably']) {
      expect(findEntries(`SYM is ${word}.`, p), word).not.toEqual([]);
    }
    for (const word of ['reCAPTCHA', 'hCaptcha', '2Captcha', 'FunCaptcha', 'anti-captcha', 'captchas']) expect(findEntries(`Works with ${word}.`, l), word).not.toEqual([]);
    expect(findEntries('Evaluate the event, capture the page.', [...p, ...l])).toEqual([]);
  });

  test('un seul régime de lexique : chaque éditeur de protection interdit dans les chaînes de l\'interface (PROTECTION_NAMES) est pris par les listes de la vitrine', () => {
    const source = readFileSync(join(runtimeDir, 'tests/ui-strings.unit.test.ts'), 'utf8');
    const pattern = /const PROTECTION_NAMES =\s*\/(.+)\/[a-z]*;/.exec(source)?.[1];
    expect(pattern).toBeDefined();
    const lists = [...loadList('third-party-marks.txt'), ...loadList('forbidden-p.txt'), ...loadList('forbidden-l.txt')];
    const marks = loadList('third-party-marks.txt');
    // Chaque alternative de l'expression, déclinée sur ses parties facultatives (`\s?`, `-?`).
    const variants = (alternative: string): string[] => {
      const optional = /\\s\?|-\?/.exec(alternative);
      if (!optional) return [alternative];
      const before = alternative.slice(0, optional.index);
      const after = alternative.slice(optional.index + optional[0].length);
      const filler = optional[0] === '-?' ? '-' : ' ';
      return [...variants(`${before}${after}`), ...variants(`${before}${filler}${after}`)];
    };
    const names = (pattern ?? '').split('|').flatMap(variants);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(findEntries(`Works with ${name}.`, lists), name).not.toEqual([]);
    for (const name of ['turnstile', 'kasada', 'incapsula', 'capsolver', 'flaresolverr', 'geetest', 'arkose']) expect(findEntries(name, marks), name).not.toEqual([]);
  });

  test('les listes P et L, la liste noire et la liste d\'exceptions existent et ne se recouvrent pas', () => {
    const p = loadList('forbidden-p.txt');
    const l = loadList('forbidden-l.txt');
    const marks = loadList('third-party-marks.txt');
    const allowed = loadList('third-party-allowed.txt');
    expect(p.length).toBeGreaterThan(30);
    expect(l).toEqual(expect.arrayContaining(['*captcha*', 'anti bot', 'rotation']));
    expect(p.filter((entry) => l.includes(entry))).toEqual([]);
    expect(marks.filter((entry) => allowed.map((a) => a.toLowerCase()).includes(entry))).toEqual([]);
    expect(allowed).toEqual(expect.arrayContaining(['github', 'docker', 'render', 'railway', 'chrome web store', 'books.toscrape.com', 'model context protocol']));
  });
});
