// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12b (D-60), `assert_readme_matches_maquette` : le README en reprend la planche Readme.dc.html (textes, couleurs de badges,
// titres, puces, transcription, mentions) ; chaque écart est dans la table EXPLAINED, avec sa raison. La planche vit dans cdc/, absent
// du dépôt public (D-44) : sur le dépôt public le test est ignoré, le contrôle reste joué sur le dépôt de travail.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { badges, bannerTexts, codeBlocks, headings, loadBudgets, readReadme, whatItDoes } from '../../scripts/vitrine/lib/readme.ts';
import { loadClaims } from '../../scripts/vitrine/lib/claims.ts';
import { githubDir, repoRoot } from '../../scripts/vitrine/lib/paths.ts';

const PLANCHE = join(repoRoot, 'cdc/scrapyomama-runtime/maquette-ux/latest/project/Readme.dc.html');
const present = existsSync(PLANCHE);
const html = present ? readFileSync(PLANCHE, 'utf8') : '';
const en = readReadme('en');
const fr = readReadme('fr');
const budgets = loadBudgets();

const decode = (s: string): string => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[’]/g, "'");
const plain = (s: string): string => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
/** Textes de la planche, par étiquette de style. */
const spans = (style: string): string[] => [...html.matchAll(new RegExp(`<span style="[^"]*${style}[^"]*">([\\s\\S]*?)</span>(?=\\s*(?:<|$))`, 'g'))].map((m) => plain(m[1] ?? ''));

/**
 * Écarts assumés entre la planche et le README (chacun avec sa raison). Aucun autre écart n'est admis.
 *  - cost : un montant (« $0.0004 per replay », « about $38/month ») est un chiffre sans mesure (22 §3.2, test « aucun prix sans source ») ;
 *  - commands : la planche abrège le démarrage en deux lignes, mais `docker compose up` seul ne démarre pas sans MASTER_KEY : les commandes
 *    sont celles du quickstart rejoué en CI (assert_readme_quickstart_matches_ci) ;
 *  - verify : la planche abrège le bloc par « … » et un `--certificate-identity-regexp` : le bloc est celui que dérive l'identité publique
 *    (assert_verify_snippet_works) ;
 *  - selector : le sélecteur de langue en première ligne est exigé par 22 §3.1 (u8 R2) en plus du lien final « Lire en français » ;
 *  - alert : une ligne « Not delivered yet » nomme ce qui manque encore (la reprise étape par étape de 2.13 : « repairs step by step »,
 *    « it repairs the step that broke ») et disparaît à sa livraison (tests/public-showcase : les promesses restent vraies) ;
 *  - verify-note : sous le bloc « Verify », une ligne dit de remplacer X.Y.Z (la planche écrit [VERSION]) et que rien n'est publié avant
 *    la première version, pour qu'aucun lecteur ne lance cosign sur une étiquette qui n'existe pas ;
 *  - links : la planche n'a qu'un lien (« Lire en français »), les mots des mentions en portent trois de plus (licence, usage responsable, doc, signalement
 *    privé) : D-46 et 22 §3.1 exigent le lien d'usage responsable, et « see the docs » sans lien n'ouvre rien ;
 *  - github : GitHub n'offre ni gris sur une ligne d'un bloc de code, ni police ou couleur des mentions (seule la taille de la légende de « Deploy to Render »,
 *    par <sub>), ni couleur d'alerte autre que la sienne ; l'indentation de la 3e ligne de la transcription, sans effet dans la planche (HTML), est retirée.
 */
const EXPLAINED = {
  cost: [', $0.0004 per replay', ', no model cost per replay'],
  render: [', about $38/month', ''],
} as const;

const claims = loadClaims();
/** Traduction fr d'un texte en de la planche : l'entrée du registre (surface readme) dont le texte en le contient. */
const frOf = (en: string): string | undefined => claims.claims.find((c) => c.surfaces.includes('readme') && c.en.replace(/\*\*/g, '').includes(en))?.fr;
const FR_HEADINGS = ['Ce que ça donne', 'Ce que SYM fait', 'Ce que SYM sait gérer', 'Démarrage rapide', 'Vérifie ce que tu lances'];
/** Dernier paragraphe (mentions), liens retirés. */
const lastParagraph = (text: string): string => text.trimEnd().split('\n\n').pop()!;
const unlinked = (text: string): string => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/**
 * README fr fidèle à la planche, traduite (guide de 3.19) : mêmes titres traduits, puces et accroche = traductions du registre
 * des textes en de la planche, transcription de même forme (mêmes étapes, mêmes nombres), mentions de même structure (mêmes liens,
 * licences, usage responsable, sécurité, IA, lien vers l'anglais). Liste vide : conforme.
 */
function frDrift(fr: string, en: string): string[] {
  const problems: string[] = [];
  if (headings(fr).join('|') !== FR_HEADINGS.join('|')) problems.push(`titres fr ${JSON.stringify(headings(fr))}`);
  const li = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => plain(m[1] ?? ''));
  const wanted = li.map(frOf);
  if (wanted.some((t) => t === undefined) || whatItDoes(fr, 'fr').join('|') !== wanted.join('|')) problems.push('puces fr : pas les traductions du registre des puces de la planche, dans l\'ordre');
  const hero = plain(/<p style="margin: 0; font-size: 16px[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '');
  const heroFr = frOf(hero);
  if (!heroFr || !fr.replace(/\*\*/g, '').includes(heroFr)) problems.push('accroche fr : pas la traduction du registre de l\'accroche de la planche');
  const alert = plain(/border-left: 4px solid #FFC727[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '');
  const alertFr = frOf(alert);
  if (!alertFr || !fr.replace(/\*\*/g, '').replace(/\n> /g, ' ').includes(alertFr)) problems.push('alerte fr : pas la traduction du registre de l\'alerte de la planche');
  const caption = plain(/<span style="font-size: 13px; color: #59636E">(coming with[^<]*)<\/span>/.exec(html)?.[1] ?? '').replace(EXPLAINED.render[0], EXPLAINED.render[1]);
  const captionFr = frOf(caption);
  if (!captionFr || !fr.includes(`<sub>${captionFr}</sub>`)) problems.push('légende « Deploy to Render » fr : pas la traduction du registre');
  const lines = codeBlocks(fr).find((b) => b.lang === 'text')?.body.split('\n') ?? [];
  const linesEn = codeBlocks(en).find((b) => b.lang === 'text')?.body.split('\n') ?? [];
  const shape = [/^toi> .*books\.toscrape\.com/, /^SYM 👻 : \S/, /^1\/4 \S.* · 2\/4 \S.* \(robots\.txt ok\) · 3\/4 \S.* · 4\/4 \S.*, ok$/, /^SYM 👻 : C'est fait\. /];
  if (lines.length !== 4 || shape.some((re, i) => !re.test(lines[i] ?? ''))) problems.push(`transcription fr : forme ${JSON.stringify(lines)}`);
  const numbers = (l: string[]): string => l.map((x) => (x.match(/\d+/g) ?? []).join(',')).join('|');
  if (numbers(lines) !== numbers(linesEn)) problems.push('transcription fr : nombres différents de l\'anglais');
  const closing = lastParagraph(fr);
  const hrefs = (text: string): string[] => [...text.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1] ?? '').filter((h) => !/README(\.fr)?\.md$/.test(h));
  if (hrefs(closing).join('|') !== hrefs(lastParagraph(en)).join('|')) problems.push('mentions fr : liens différents de l\'anglais');
  const plainClosing = unlinked(closing);
  for (const [what, re] of [['licences', /AGPL-3\.0.*\bMIT\b/], ['usage responsable', /\[Usage responsable\]\([^)]*usage-responsable\.md\)/], ['sécurité', /Sécurité : [^.]*\]\([^)]*SECURITY\.md\)/], ['IA', /\bIA\b.*relu par des humains/], ['anglais', /\[Lire en anglais\]\(README\.md\)\.$/]] as const) {
    if (!re.test(what === 'licences' || what === 'IA' ? plainClosing : closing)) problems.push(`mentions fr : ${what}`);
  }
  for (const sentence of unlinked(lastParagraph(en)).replace(/ Lire en français\.$/, '').split(/(?<=\.) /)) {
    const t = frOf(sentence);
    if (!t || !plainClosing.includes(t)) problems.push(`mentions fr : pas la traduction du registre de « ${sentence} »`);
  }
  return problems;
}

describe.skipIf(!present)('assert_readme_matches_maquette : README en fidèle à la planche Readme.dc.html (D-60)', () => {
  test('bandeau : trois textes de la planche (titre, accroche barrée, ligne de contexte) et ses couleurs', () => {
    const title = spans('font-size: 54px')[0];
    const tagline = spans('font-size: 22px')[0];
    const context = spans('font-size: 13px; color: #C9C4BA')[0];
    expect(title).toBe('SYM 👻');
    expect(bannerTexts()).toEqual([title, tagline, context]);
    const svg = readFileSync(join(githubDir, 'assets/src/banner-light.svg'), 'utf8');
    for (const color of ['#24252D', '#FF5A1F', '#D8BDF7', '#FFC727', '#FBF8F3', '#8F8A80', '#C9C4BA']) expect(svg, color).toContain(color);
    expect(svg).toContain('text-decoration="line-through"');
    expect(svg, 'coins arrondis de la planche (14 px à 860 px de large)').toContain('rx="26"');
  });

  test('badges : cinq, mêmes étiquettes, mêmes messages et mêmes couleurs que la planche', () => {
    const wanted = [...html.matchAll(/<span style="font-size: 12px; font-weight: 700; border-radius: 6px[^"]*"><span style="background: (#\w+);[^"]*">([^<]*)<\/span><span style="background: (#\w+);[^"]*">([^<]*)<\/span>/g)]
      .map((m) => ({ label: m[2], message: m[4], color: (m[3] ?? '').slice(1).toUpperCase(), labelColor: (m[1] ?? '').slice(1).toUpperCase() }));
    expect(wanted).toHaveLength(5);
    const shown = badges(en, budgets).map((b) => {
      const url = new URL(b.src);
      const [label, message, color] = url.pathname.replace(/^\/badge\//, '').replace(/--/g, '\0').split('-').map((s) => decodeURIComponent(s).replace(/\0/g, '-'));
      return { label, message, color: (color ?? '').toUpperCase(), labelColor: (url.searchParams.get('labelColor') ?? '').toUpperCase() };
    });
    expect(shown).toEqual(wanted);
  });

  test('titres, puces, accroche, alerte de pré-version : mots pour mots', () => {
    const h2 = [...html.matchAll(/<h2 [^>]*>([^<]*)<\/h2>/g)].map((m) => plain(m[1] ?? ''));
    expect(headings(en)).toEqual(h2);
    const li = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => plain(m[1] ?? ''));
    expect(li).toHaveLength(10);
    expect(whatItDoes(en, 'en')).toEqual(li);
    const hero = plain(/<p style="margin: 0; font-size: 16px[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '');
    expect(en.replace(/\*\*/g, '')).toContain(hero);
    expect(hero).toMatch(/^You ask your AI for data\./);
    const alert = plain(/border-left: 4px solid #FFC727[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '');
    expect(en.replace(/\*\*/g, '').replace(/\n> /g, ' ')).toContain(alert);
  });

  test('« How it feels » : la transcription de la planche, au montant près', () => {
    const block = /<div style="background: #F6F8FA[^>]*JetBrains Mono[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] ?? '';
    const lines = [...`${block}</div>`.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)].map((m) => decode((m[1] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+$/, ''));
    expect(lines).toHaveLength(4);
    const shown = codeBlocks(en).find((b) => b.lang === 'text')?.body.split('\n') ?? [];
    // L'indentation de la 3e ligne n'a aucun effet dans la planche (HTML) : elle est retirée du README.
    expect(shown).toEqual(lines.map((l) => l.trim().replace(EXPLAINED.cost[0], EXPLAINED.cost[1])));
  });

  test('démarrage : « Deploy to Render » et sa légende, au montant près ; l\'adresse du dépôt cloné est celle de la planche', () => {
    const chip = spans('font-size: 13px; font-weight: 700; border-radius: 6px')[0];
    const caption = plain(/<span style="font-size: 13px; color: #59636E">(coming with[^<]*)<\/span>/.exec(html)?.[1] ?? '');
    expect(chip).toBe('Deploy to Render');
    expect(en).toContain(`alt="${chip}"`);
    expect(en).toContain(caption.replace(EXPLAINED.render[0], EXPLAINED.render[1]));
    const clone = /git clone ([^\s<]+)/.exec(html)?.[1];
    expect(codeBlocks(en).find((b) => b.body.includes('docker compose up'))?.body).toContain(`git clone ${clone}`);
  });

  test('mentions : le paragraphe final de la planche (liens retirés), dans les deux langues', () => {
    const closing = plain(/<p style="margin: 0; font-size: 14px; line-height: 1.6; color: #59636E">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '');
    const last = (text: string): string => text.trimEnd().split('\n\n').pop()!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    expect(last(en)).toBe(closing);
    expect(last(fr)).toContain('Lire en anglais');
    expect(closing).toContain('Lire en français');
  });

  test('README fr : la planche traduite (titres, puces, accroche, alerte, légende, transcription, mentions)', () => {
    expect(frDrift(fr, en)).toEqual([]);
  });

  test('cas négatifs fr : titre, puce, accroche, transcription ou mentions qui s\'écartent de la planche traduite', () => {
    const drift = (from: string, to: string): string => {
      const changed = fr.replace(from, to);
      expect(changed, from).not.toBe(fr);
      return frDrift(changed, en).join();
    };
    expect(drift('## Ce que SYM sait gérer', '## Ce que SYM gère')).toMatch(/titres fr/);
    expect(drift('- Choisit la méthode la moins chère qui marche', '- Choisit toujours la méthode la moins chère')).toMatch(/puces fr/);
    expect(drift('Ton serveur, ta base, ton modèle.', 'Ton serveur, ta base.')).toMatch(/accroche fr/);
    expect(drift('Suis le dépôt pour la première version.', 'Reviens plus tard.')).toMatch(/alerte fr/);
    expect(drift('20 livres', '25 livres')).toMatch(/nombres différents/);
    expect(drift('toi> ', 'moi> ')).toMatch(/transcription fr : forme/);
    expect(drift('Fait avec l\'aide d\'une IA, relu par des humains.', 'Fait à la main.')).toMatch(/mentions fr : IA/);
    expect(drift('[Lire en anglais](README.md)', 'Lire en anglais')).toMatch(/mentions fr : anglais/);
    expect(drift('Sécurité : le [signalement privé des failles]', 'Sécurité : le signalement privé des failles [ici]')).toMatch(/mentions fr/);
  });
});
