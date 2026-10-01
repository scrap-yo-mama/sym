// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle d'un SVG versionné (20b § 3.1, assert_svg_safe ; définition unique reprise par 4.12, 22b § 3) : ni script, ni
// attribut `on*`, ni `<foreignObject`, ni lien ou image externe, ni `@import`, ni `<style`, ni `style=` ; pour packages/ui
// seulement, aucun texte dans un SVG (u5 R19). Outil de test seulement.

/** Motifs refusés dans tout SVG, avec leur raison. */
const FORBIDDEN: readonly { reason: string; pattern: RegExp }[] = [
  { reason: '<script', pattern: /<script/i },
  { reason: 'attribut on* (dont onload=)', pattern: /\son[a-z]+\s*=/i },
  { reason: '<foreignObject', pattern: /<foreignObject/i },
  { reason: '<image (image externe)', pattern: /<image\b/i },
  { reason: 'lien externe (href vers http, https ou //)', pattern: /(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?\/\//i },
  { reason: 'URL externe dans url()', pattern: /url\(\s*["']?\s*(?:https?:)?\/\//i },
  { reason: '@import', pattern: /@import/i },
  { reason: '<style', pattern: /<style/i },
  { reason: 'style=', pattern: /\sstyle\s*=/i },
];

/** Éléments qui portent du texte : interdits dans packages/ui. */
const TEXT_ELEMENTS: readonly { reason: string; pattern: RegExp }[] = [
  { reason: 'texte dans un SVG (<text>)', pattern: /<text\b/i },
  { reason: 'texte dans un SVG (<tspan>)', pattern: /<tspan\b/i },
  { reason: 'texte dans un SVG (<textPath>)', pattern: /<textPath\b/i },
  { reason: 'texte dans un SVG (<title>)', pattern: /<title\b/i },
  { reason: 'texte dans un SVG (<desc>)', pattern: /<desc\b/i },
];

/** Raisons pour lesquelles `svg` n'est pas sûr (liste vide : sûr). `noText` : règle propre à packages/ui. */
export function svgProblems(svg: string, options: { noText: boolean }): string[] {
  const rules = options.noText ? [...FORBIDDEN, ...TEXT_ELEMENTS] : FORBIDDEN;
  return rules.filter(({ pattern }) => pattern.test(svg)).map(({ reason }) => reason);
}

/** Blocs `<svg …>…</svg>` d'un composant ou d'une source (SVG en ligne dans un gabarit). */
export function inlineSvgs(source: string): string[] {
  return [...source.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].map((match) => match[0]);
}
