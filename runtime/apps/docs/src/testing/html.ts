// SPDX-License-Identifier: AGPL-3.0-only
// Lecture du HTML construit pour les tests de la landing : texte visible, attributs lisibles, balises du head. Le HTML de VitePress
// est régulier (rendu serveur d'un seul moteur) : des expressions régulières suffisent, sans analyseur supplémentaire.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return (name && ENTITIES[name]) ?? all;
  });
}

/** Contenu de `<body>` sans scripts, styles ni commentaires. */
export function bodyOf(html: string): string {
  const body = html.slice(html.indexOf('<body>') + 6);
  return body.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

/** Texte visible du corps : une icône SYM 👻 (`data-sym-ghost`) redevient « 👻 » pour comparer au registre ; les blocs séparés par une espace. */
export function visibleText(html: string): string {
  const withGhost = bodyOf(html).replace(/<svg\b[^>]*(?:data-sym-ghost|sym-signature__icon)[^>]*>[\s\S]*?<\/svg>/g, "👻");
  const withoutIcons = withGhost.replace(/<svg\b[\s\S]*?<\/svg>/g, '');
  return decodeEntities(withoutIcons.replace(/<[^>]+>/g, ' ')).replace(/[\s\u00a0\u202f]+/g, ' ').trim();
}

/** Textes que les tests de lexique lisent en plus du corps : titre, descriptions, alt, title et aria-label, textes de la source. */
export function attributeTexts(html: string): string[] {
  const values = [...html.matchAll(/\s(?:alt|title|aria-label)="([^"]*)"/g)].map((match) => decodeEntities(match[1] ?? ''));
  const meta = [...html.matchAll(/<meta\b[^>]*\bcontent="([^"]*)"[^>]*>/g)].filter((match) => !/http-equiv=/.test(match[0])).map((match) => decodeEntities(match[1] ?? ''));
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1];
  return [...values, ...meta, ...(title ? [decodeEntities(title)] : [])];
}

export const headOf = (html: string): string => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

/** Balises `<link>` du head, sous forme d'attributs. */
export function linkTags(html: string): Record<string, string>[] {
  return [...headOf(html).matchAll(/<link\b([^>]*)>/g)].map((match) => attributesOf(match[1] ?? ''));
}

export function metaTags(html: string): Record<string, string>[] {
  return [...headOf(html).matchAll(/<meta\b([^>]*)>/g)].map((match) => attributesOf(match[1] ?? ''));
}

function attributesOf(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1] ?? '', decodeEntities(match[2] ?? '')]));
}

/** Valeurs d'un attribut pour un élément (`id` de chaque section, `href` de chaque lien…), dans l'ordre du document. */
export function attributeValues(html: string, tag: string, attribute: string): string[] {
  return [...bodyOf(html).matchAll(new RegExp(`<${tag}\\b[^>]*?\\s${attribute}="([^"]*)"`, 'g'))].map((match) => decodeEntities(match[1] ?? ''));
}

/** Dimensions d'un PNG, lues dans son en-tête IHDR. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('pas un PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
