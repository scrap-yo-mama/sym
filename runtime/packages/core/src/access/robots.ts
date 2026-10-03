// SPDX-License-Identifier: AGPL-3.0-only
// robots.txt, source d'information (D-91) : l'agent d'enquête ou une étape de workflow peut choisir de lire un robots.txt
// comme une page parmi d'autres, par exemple pour trouver le sitemap. Ce module en extrait les lignes `Sitemap`, sans
// I/O ; il ne rend aucun verdict et ne conditionne aucune requête.

/** Lignes `Sitemap` retenues au plus (défense contre un fichier hostile). */
const MAX_SITEMAPS = 50;
/** Longueur maximale d'une ligne lue et d'une URL retenue. */
const MAX_LINE = 4096;
const MAX_URL = 2048;

/**
 * URL des lignes `Sitemap` d'un robots.txt (texte déjà borné par le lecteur), absolues http(s), sans doublon, résolues
 * par rapport à `base` si elle est donnée. Ne lève jamais : une ligne illisible est ignorée.
 */
export function robotsSitemaps(text: string, base?: string): string[] {
  const out: string[] = [];
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    if (out.length >= MAX_SITEMAPS) break;
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine;
    const hash = line.indexOf('#');
    const content = (hash === -1 ? line : line.slice(0, hash)).trim();
    const colon = content.indexOf(':');
    if (colon <= 0 || content.slice(0, colon).trim().toLowerCase() !== 'sitemap') continue;
    const value = content.slice(colon + 1).trim();
    if (value === '' || value.length > MAX_URL) continue;
    let url: URL;
    try {
      url = base === undefined ? new URL(value) : new URL(value, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.username = '';
    url.password = '';
    url.hash = '';
    if (!out.includes(url.href)) out.push(url.href);
  }
  return out;
}
