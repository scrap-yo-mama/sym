// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles du README en et fr (22 §3.1, 22b §3). Chaque fonction renvoie la liste des problèmes (vide : conforme).
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize as normalizePath } from 'node:path';
import { githubDir, repoRoot, vitrineDir } from './paths.ts';
import { verifyBlock, type PublicIdentity } from './identity.ts';
import { findEntries, loadList, normalize, stripPhrases } from './text.ts';
import { plainBullet, type ClaimsFile } from './claims.ts';
import { parseQuickstart } from '../../../apps/docs/src/quickstart.ts';

export type Lang = 'en' | 'fr';
export type Budgets = {
  readme: { minLines: number; maxLines: number; maxBytes: number; commandBeforeLine: number; maxBadges: number; maxHeadings: number };
  assets: Record<string, number | string>;
  demo: { durationToleranceSeconds: number; stepPixelDiffRatio: number };
  repo: { descriptionMaxChars: number; topicsMin: number; topicsMax: number };
  images: { allowedHosts: string[] };
  /** `allowedPaths` : sortes de badge admises (préfixe du chemin shields), V1 : licence, dernière version, CI (22 §3.1, bloc 3). */
  badges: { allowedHosts: string[]; allowedPaths: string[] };
};

export const loadBudgets = (): Budgets => JSON.parse(readFileSync(join(vitrineDir, 'budgets.json'), 'utf8')) as Budgets;

export const README_FILES: Record<Lang, string> = { en: 'README.md', fr: 'README.fr.md' };
export const readReadme = (lang: Lang): string => readFileSync(join(githubDir, README_FILES[lang]), 'utf8');

/**
 * Titres `##` attendus, dans l'ordre (22 §3.1, blocs 5 à 11 ; les blocs 1 à 4 n'ont pas de titre).
 * Écart assumé (tâche 4.12, à reporter au CDC) : le bloc 6 s'intitule « Try it (no model key) » / « Essaie (sans clé de
 * modèle) » et non « Try it in two minutes (no key) » : la première construction de l'image prend plusieurs minutes, « deux
 * minutes » serait une allégation sans mesure (22 §3.2) ; et le quickstart crée deux secrets d'instance (MASTER_KEY, jeton
 * d'amorçage) : la seule clé qu'il ne demande pas est celle d'un modèle (le mode démo sans aucune clé arrive avec 3.11). Le lien vers la landing (bloc 2, 4.11) et la vignette de démo (bloc 4, 3.11) sont
 * des test.todo de tests/vitrine/readme.unit.test.ts tant que la landing et l'enregistrement n'existent pas.
 */
const SECTION_TITLES: Record<Lang, string[]> = {
  en: ['What it does', 'Try it (no model key)', 'Connect your AI chat (MCP)', 'Verify what you download', "How it's built", 'Licenses', 'Contribute'],
  fr: ['Ce que ça fait', 'Essaie (sans clé de modèle)', 'Branche ton chat IA (MCP)', 'Vérifie ce que tu télécharges', "Comment c'est construit", 'Licences', 'Contribuer'],
};

export type CodeBlock = { lang: string; body: string; line: number };
export type Image = { src: string; alt: string | undefined; kind: 'markdown' | 'img' | 'source'; line: number };
type Link = { href: string; text: string; line: number };

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

export function headings(text: string): string[] {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => (m[1] ?? '').trim());
}

export function codeBlocks(text: string): CodeBlock[] {
  return [...text.matchAll(/^```([a-z]*)\n([\s\S]*?)\n```$/gm)].map((m) => ({ lang: m[1] ?? '', body: m[2] ?? '', line: lineOf(text, m.index ?? 0) }));
}

export function images(text: string): Image[] {
  const found: Image[] = [];
  for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) found.push({ src: m[2] ?? '', alt: m[1] ?? '', kind: 'markdown', line: lineOf(text, m.index ?? 0) });
  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\ssrc="([^"]*)"/.exec(tag)?.[1];
    const alt = /\salt="([^"]*)"/.exec(tag);
    if (src !== undefined) found.push({ src, alt: alt ? (alt[1] ?? '') : undefined, kind: 'img', line: lineOf(text, m.index ?? 0) });
  }
  for (const m of text.matchAll(/<source\b[^>]*>/gi)) {
    const src = /\ssrcset="([^"]*)"/.exec(m[0])?.[1];
    if (src !== undefined) found.push({ src, alt: undefined, kind: 'source', line: lineOf(text, m.index ?? 0) });
  }
  return found;
}

function links(text: string): Link[] {
  const found: Link[] = [];
  const withoutImages = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  for (const m of withoutImages.matchAll(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) found.push({ href: m[2] ?? '', text: m[1] ?? '', line: 0 });
  for (const m of text.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) found.push({ href: m[1] ?? '', text: (m[2] ?? '').replace(/<[^>]+>/g, ''), line: lineOf(text, m.index ?? 0) });
  return found;
}

function pictures(text: string): string[] {
  return [...text.matchAll(/<picture>[\s\S]*?<\/picture>/gi)].map((m) => m[0]);
}

/** Les badges : images servies par un service de badges. */
export function badges(text: string, budgets: Budgets): Image[] {
  return images(text).filter((image) => budgets.badges.allowedHosts.some((host) => image.src.startsWith(`https://${host}/`)));
}

// --- Contrôles ------------------------------------------------------------------------------------------------------

export function lengthProblems(text: string, budgets: Budgets): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  const count = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const { minLines, maxLines, maxBytes, commandBeforeLine } = budgets.readme;
  if (count < minLines || count > maxLines) problems.push(`${count} lignes (attendu ${minLines} à ${maxLines})`);
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) problems.push(`${bytes} octets (maximum ${maxBytes})`);
  const first = codeBlocks(text)[0];
  if (!first) problems.push('aucune commande (bloc de code)');
  else if (first.line >= commandBeforeLine) problems.push(`la première commande est à la ligne ${first.line} (avant la ligne ${commandBeforeLine})`);
  return problems;
}

/** Parité en / fr : titres, blocs de code identiques octet pour octet, mêmes images, sélecteur de langue en première ligne. */
export function parityProblems(en: string, fr: string): string[] {
  const problems: string[] = [];
  if (headings(en).length !== headings(fr).length) problems.push(`${headings(en).length} titres ## en contre ${headings(fr).length} en fr`);
  const a = codeBlocks(en);
  const b = codeBlocks(fr);
  if (a.length !== b.length) problems.push(`${a.length} blocs de code en contre ${b.length} en fr`);
  a.forEach((block, i) => {
    if (b[i] && (block.body !== b[i]?.body || block.lang !== b[i]?.lang)) problems.push(`le bloc de code ${i + 1} diffère entre en et fr`);
  });
  const srcs = (text: string): string => images(text).map((image) => image.src).join('\n');
  if (srcs(en) !== srcs(fr)) problems.push('les URL d\'images diffèrent entre en et fr');
  const nonLangLinks = (text: string): string => links(text).map((l) => l.href).filter((h) => !/README(\.fr)?\.md$/.test(h)).join('\n');
  if (nonLangLinks(en) !== nonLangLinks(fr)) problems.push('les liens (hors sélecteur de langue) diffèrent entre en et fr');
  for (const [lang, text] of [['en', en], ['fr', fr]] as const) {
    const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
    if (!/href="README\.md"/.test(first) || !/href="README\.fr\.md"/.test(first)) problems.push(`${lang} : la première ligne n'est pas le sélecteur de langue`);
  }
  return problems;
}

export function sectionProblems(text: string, lang: Lang): string[] {
  const problems: string[] = [];
  const found = headings(text);
  const expected = SECTION_TITLES[lang];
  if (found.join('|') !== expected.join('|')) problems.push(`${lang} : titres ## ${JSON.stringify(found)}, attendu ${JSON.stringify(expected)} (dans l'ordre, sans autre titre)`);
  const license = text.slice(text.indexOf(`## ${expected[5]}`), text.indexOf(`## ${expected[6]}`));
  const responsible = links(text).filter((l) => /responsible use|usage responsable/i.test(l.text));
  if (responsible.length !== 1) problems.push(`${lang} : ${responsible.length} liens « Responsible use / Usage responsable » (un seul)`);
  else if (!license.includes(responsible[0]?.href ?? '\0')) problems.push(`${lang} : le lien « Usage responsable » n'est pas dans le bloc des licences`);
  const table = license.split('\n').filter((line) => /^\|(?!\s*-)/.test(line) && !/^\|\s*(What|Quoi)\b/.test(line));
  if (table.length !== 3) problems.push(`${lang} : le tableau des licences a ${table.length} lignes (3 attendues)`);
  return problems;
}

/** Sorte d'un badge : le préfixe autorisé de son chemin (`/github/license/`…), undefined hors liste. */
export function badgeKind(src: string, budgets: Budgets): string | undefined {
  let path: string;
  try {
    path = new URL(src).pathname;
  } catch {
    return undefined;
  }
  return budgets.badges.allowedPaths.find((prefix) => path.startsWith(prefix));
}

export function badgeProblems(text: string, budgets: Budgets): string[] {
  const shown = badges(text, budgets);
  const problems = shown.length > budgets.readme.maxBadges ? [`${shown.length} badges (au plus ${budgets.readme.maxBadges})`] : [];
  for (const badge of shown) if (badgeKind(badge.src, budgets) === undefined) problems.push(`badge hors de la liste autorisée (${budgets.badges.allowedPaths.join(', ')}) : ${badge.src}`);
  return problems;
}

/** Puces de « What it does » rendues en texte simple. */
export function whatItDoes(text: string, lang: Lang): string[] {
  const title = SECTION_TITLES[lang][0] as string;
  const start = text.indexOf(`## ${title}`);
  const body = text.slice(start).split(/\n## /)[0] ?? '';
  return body.split('\n').filter((line) => line.startsWith('- ')).map(plainBullet);
}

export function claimsProblems(text: string, lang: Lang, file: ClaimsFile): string[] {
  const problems: string[] = [];
  const bullets = whatItDoes(text, lang);
  if (bullets.length !== 5) problems.push(`${lang} : ${bullets.length} puces dans « ${SECTION_TITLES[lang][0]} » (5 attendues)`);
  for (const bullet of bullets) {
    const claim = file.claims.find((c) => c[lang] === bullet && c.surfaces.includes('readme'));
    if (!claim) problems.push(`${lang} : la puce « ${bullet.slice(0, 50)}… » n'a pas d'entrée dans claims.json (surface readme)`);
    else if (claim.status !== 'relu') problems.push(`${lang} : l'entrée « ${claim.id} » est ${claim.status}`);
  }
  return problems;
}

/** Chiffre avec unité (mémoire, poids, durée, pourcentage, facteur) : un chiffre sans mesure est interdit (22 §3.2). */
const NUMBER_WITH_UNIT = /(?<![\p{L}\d.])\d+(?:[.,]\d+)?\s?(?:%|[kmgt]i?b|[kmgt]o|min(?:ute)?s?|secondes?|seconds?|sec|s|ms|h|hours?|heures?|days?|jours?|x|×|times|fois)(?![\p{L}\d])/iu;
/** Rejeu par la CI : une phrase de « Try it » qui l'affirme cite une preuve (le quickstart rejoué en CI). */
const CI_CLAIM = /\bCI\b/;

/** Texte courant du README : sans blocs de code, commentaires, balises HTML ni cibles de liens. */
function prose(text: string): string {
  return text
    .replace(/^```[\s\S]*?^```/gm, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/https?:\/\/\S+/g, ' ');
}

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.replace(/^[>|#\-*\s]+/, '').trim()).filter((part) => part !== '');

/**
 * Phrases factuelles hors puces (22 §3.2) : une phrase du README qui porte un chiffre avec unité, ou qui affirme dans
 * « Try it » que la CI rejoue les commandes, s'affiche seulement si elle fait partie d'une entrée du registre (surface readme).
 */
export function unregisteredFactsProblems(text: string, lang: Lang, file: ClaimsFile): string[] {
  const registered = file.claims.filter((claim) => claim.surfaces.includes('readme')).map((claim) => normalize(claim[lang]));
  const isRegistered = (sentence: string): boolean => registered.some((phrase) => phrase.includes(normalize(sentence.replace(/\*\*/g, ''))));
  const problems: string[] = [];
  for (const sentence of sentences(prose(text))) {
    const number = NUMBER_WITH_UNIT.exec(sentence);
    if (number && !isRegistered(sentence)) problems.push(`${lang} : chiffre sans mesure au registre (« ${number[0]} ») : « ${sentence} »`);
  }
  const title = SECTION_TITLES[lang][1] as string;
  const start = text.indexOf(`## ${title}`);
  const tryIt = start === -1 ? '' : (text.slice(start + title.length + 3).split(/\n## /)[0] ?? '');
  for (const sentence of sentences(prose(tryIt))) {
    if (CI_CLAIM.test(sentence) && !isRegistered(sentence)) problems.push(`${lang} : « ${sentence} » affirme un rejeu par la CI sans entrée au registre`);
  }
  return problems;
}

/** Entrée de liste affichée sans ses marques de racine (`*`). */
const entryLabel = (entry: string): string => entry.replace(/\*/g, '');

/**
 * Lexique (22b §1) : 0 mot de P hors phrases du registre (`whitelistRegistry`) et 0 mot de L. L se lit sur le texte brut
 * (README, landing, description, formulaires : D-46), sauf `limitTermsInRegistry` (CLAIMS.md, le registre lui-même) où un
 * terme de limite n'est admis que dans une phrase égale mot pour mot à une entrée du registre.
 */
export function copyProblems(text: string, file: ClaimsFile, options: { whitelistRegistry: boolean; limitTermsInRegistry?: boolean; stripIdentifiers?: boolean }): string[] {
  if (options.stripIdentifiers) text = text.replace(/\bassert_[a-z0-9_]+/g, ' ');
  const phrases = file.claims.flatMap((claim) => [claim.en, claim.fr]);
  // Emplois neutres de 20 §2.2 (« mot de passe », « icône invisible aux lecteurs d'écran », aria-hidden) retirés sur toute surface.
  const registered = options.whitelistRegistry ? stripPhrases(text, phrases) : text;
  const p = findEntries(stripPhrases(registered, loadList('neutral-allowed.txt')), loadList('forbidden-p.txt'));
  const l = findEntries(options.limitTermsInRegistry ? stripPhrases(text, phrases) : text, loadList('forbidden-l.txt'));
  return [...p.map((w) => `mot de la liste P : « ${entryLabel(w)} »`), ...l.map((w) => `mot de la liste L : « ${entryLabel(w)} »`)];
}

/** Marques tierces : liste noire hors exceptions descriptives en texte courant (accroche D-46 exceptée). */
export function marksProblems(text: string, extraAllowedPhrases: readonly string[] = []): string[] {
  const allowed = [...loadList('third-party-allowed.txt'), ...extraAllowedPhrases];
  const stripped = stripPhrases(text, allowed);
  return findEntries(stripped, loadList('third-party-marks.txt')).map((mark) => `marque tierce : « ${entryLabel(mark)} »`);
}

// --- Images ---------------------------------------------------------------------------------------------------------

/** Chemin local d'une image du README, relatif au dossier du README (`.github/`) ; undefined si absolue. */
function localImagePath(src: string): string | undefined {
  if (/^[a-z]+:\/\//i.test(src) || src.startsWith('//') || src.startsWith('data:')) return undefined;
  return normalizePath(join(githubDir, src));
}

export function imageResolveProblems(text: string, budgets: Budgets): string[] {
  const problems: string[] = [];
  for (const image of images(text)) {
    const local = localImagePath(image.src);
    if (local === undefined) {
      const bare = image.src.replace(/^https:\/\//, '');
      if (!budgets.images.allowedHosts.some((host) => bare === host || bare.startsWith(`${host}/`))) problems.push(`domaine d'image hors liste blanche : ${image.src}`);
    } else if (!local.startsWith(githubDir) || !existsSync(local)) problems.push(`image introuvable : ${image.src}`);
  }
  return problems;
}

export function altProblems(text: string, decorative: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const image of images(text)) {
    if (image.kind === 'source') continue;
    if (image.alt === undefined) problems.push(`image sans alt : ${image.src}`);
    else if (image.alt.trim() === '' && !decorative.includes(image.src)) problems.push(`alt vide hors images décoratives listées : ${image.src}`);
    else if (/\bimage (de|of)\b|\bscreenshot of\b|\bcapture d'écran de\b/i.test(image.alt)) problems.push(`alt à reformuler : « ${image.alt} »`);
  }
  return problems;
}

/** Textes du bandeau (balises <text> de ses sources SVG claire et sombre), dans l'ordre, sans doublon. */
export function bannerTexts(): string[] {
  const out: string[] = [];
  for (const variant of ['light', 'dark']) {
    const svg = readFileSync(join(githubDir, 'assets/src', `banner-${variant}.svg`), 'utf8');
    for (const m of svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)) {
      const value = (m[1] ?? '').trim();
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/**
 * L'alt du bandeau décrit l'image : il cite chacun de ses textes et ne porte ni accroche ni phrase absente de l'image
 * (pas de deux-points, pas de point final). L'accroche est écrite en vrai texte sous l'image (22 §3.1, bloc 1).
 */
export function bannerAltProblems(text: string, texts: readonly string[]): string[] {
  const picture = pictures(text)[0];
  if (!picture) return ['aucun bandeau <picture>'];
  const alt = /<img\b[^>]*\salt="([^"]*)"/i.exec(picture)?.[1];
  if (!alt) return ['bandeau sans alt'];
  const problems: string[] = [];
  for (const value of texts) if (!alt.includes(value)) problems.push(`l'alt du bandeau ne cite pas « ${value} », texte du bandeau`);
  if (/[:.!?]/.test(alt)) problems.push(`l'alt du bandeau porte une accroche ou une phrase absente de l'image : « ${alt} »`);
  return problems;
}

export function pictureProblems(text: string): string[] {
  const problems: string[] = [];
  for (const picture of pictures(text)) {
    const dark = /<source[^>]*prefers-color-scheme: dark[^>]*srcset="([^"]*)"/i.exec(picture)?.[1];
    const light = /<source[^>]*prefers-color-scheme: light[^>]*srcset="([^"]*)"/i.exec(picture)?.[1];
    const img = /<img\b[^>]*>/i.exec(picture)?.[0];
    if (!dark) problems.push('<picture> sans source dark');
    if (!light) problems.push('<picture> sans source light');
    if (!img || !/\salt="[^"]+"/.test(img)) problems.push('<picture> sans <img> de repli avec alt');
    for (const src of [dark, light, /\ssrc="([^"]*)"/.exec(img ?? '')?.[1]]) {
      if (src) {
        const local = localImagePath(src);
        if (local === undefined || !existsSync(local)) problems.push(`fichier de <picture> introuvable : ${src}`);
      }
    }
  }
  return problems;
}

// --- Liens et identité ----------------------------------------------------------------------------------------------

/** Liens du dépôt public : même dépôt que l'identité, chemin existant (blob ou tree de main). */
export function repoLinkProblems(text: string, identity: PublicIdentity): string[] {
  const problems: string[] = [];
  const base = `https://github.com/${identity.repository}`;
  const urls = [...links(text).map((l) => l.href), ...images(text).map((i) => i.src)];
  for (const href of urls) {
    if (/^https?:\/\/github\.com\//.test(href) && !href.startsWith(`${base}/`) && href !== base) problems.push(`lien vers un autre dépôt que ${identity.repository} : ${href}`);
    const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:blob|tree)/main/([^#?]+)`).exec(href);
    if (match && !existsSync(join(repoRoot, decodeURIComponent(match[1] ?? '')))) problems.push(`chemin introuvable dans le dépôt : ${href}`);
    if (/^[^:/]+\.md(?:#.*)?$/.test(href) && !/^README(\.fr)?\.md$/.test(href) && !existsSync(join(githubDir, href.split('#')[0] ?? ''))) problems.push(`lien relatif introuvable : ${href}`);
    if (/^https?:\/\/(?!img\.shields\.io|github\.com)/.test(href)) problems.push(`lien externe hors liste (${href}) : ajouter à la liste après relecture`);
  }
  for (const m of text.matchAll(/\bghcr\.io\/([^/\s`'"]+)\//g)) if ((m[1] ?? '').toLowerCase() !== identity.owner.toLowerCase()) problems.push(`image GHCR d'un autre propriétaire : ${m[0]}`);
  return problems;
}

/** Les blocs « Verify » du README sont ceux que dérive l'identité publique. */
export function verifyBlockProblems(text: string, identity: PublicIdentity): string[] {
  const expected = verifyBlock(identity);
  return codeBlocks(text).some((block) => block.body === expected) ? [] : [`le bloc « Verify » n'est pas celui dérivé de l'identité publique ${identity.repository}`];
}

/** Commandes de « Try it » : celles du quickstart rejoué en CI (étapes `secrets` et `start`), hors le clonage. */
export function quickstartProblems(text: string): string[] {
  const quickstart = readFileSync(join(repoRoot, 'runtime/apps/docs/content/tutoriels/quickstart.md'), 'utf8');
  const steps = parseQuickstart(quickstart);
  const wanted = ['secrets', 'start'].map((id) => steps.find((step) => step.id === id)?.script);
  if (wanted.some((script) => script === undefined)) return ['le quickstart n\'a plus les étapes « secrets » et « start »'];
  const block = codeBlocks(text).find((b) => b.lang === 'bash' && b.body.includes('docker compose up'));
  if (!block) return ['aucun bloc de commande « docker compose up »'];
  const commands = block.body.split('\n').filter((line) => !/^git clone\b/.test(line)).join('\n');
  return commands === wanted.join('\n') ? [] : ['les commandes de « Try it » ne sont pas celles du quickstart rejoué en CI (étapes secrets et start)'];
}

