// SPDX-License-Identifier: AGPL-3.0-only
// Aides des tests de contenu : lecture des pages sources et retrait du code, qui n'est pas de la prose.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PAGES, type PageEntry } from '../nav.ts';

export const docsDir = new URL('../../', import.meta.url).pathname;
export const contentDir = join(docsDir, 'content');
export const runtimeDir = new URL('../../../../', import.meta.url).pathname;

export const pageFile = (page: PageEntry | string): string => join(contentDir, `${typeof page === 'string' ? page : page.path}.md`);

/** Pages écrites à la main : celles dont la source est dans le dépôt. */
export const handWritten: readonly PageEntry[] = PAGES.filter((page) => !page.generated);

export const readSource = (page: PageEntry | string): string => readFileSync(pageFile(page), 'utf8');

/** Le texte d'une page sans ses blocs de code, son code en ligne ni ses commentaires HTML : de la prose seulement. */
export function prose(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** Blocs de code d'une langue donnée. */
export function codeBlocks(markdown: string, language: string): string[] {
  return [...markdown.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map((m) => m[1] ?? '');
}

export function markdownFiles(dir: string = contentDir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) out.push(relative(contentDir, full).replace(/\.md$/, ''));
  }
  return out.sort();
}
