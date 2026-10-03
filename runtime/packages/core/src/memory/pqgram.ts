// SPDX-License-Identifier: AGPL-3.0-only
// Re-classement structurel en V1 (tâche 2.12, 19 §2, r1 R11) : pq-grammes de la séquence de balises et Jaccard des
// classes CSS, pondérés 0,3 / 0,7 (à calibrer sur les fixtures de r1). Calcul local écrit en TypeScript, sans
// bibliothèque. La séquence de balises est lue dans l'ordre du document (balises ouvrantes, profondeur comprise) : un
// pq-gramme y est la suite de `p` ancêtres et `q` voisins (approximation linéaire des pq-grammes d'arbre d'Augsten),
// haché en 8 caractères hexadécimaux. Aucun texte ni nom de classe ne sort en clair.
import { createHash } from 'node:crypto';

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const MAX_TAGS = 5_000;

/** Balises ouvrantes préfixées de leur profondeur (`2:li`), sans attribut ni texte ; scripts et styles sautés. */
export function tagSequence(html: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '<$1></$1>');
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})\b[^>]*?(\/?)>/g)) {
    const name = m[2]!.toLowerCase();
    if (m[1] === '/') {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    out.push(`${stack.length}:${name}`);
    if (out.length >= MAX_TAGS) break;
    if (m[3] !== '/' && !VOID.has(name)) stack.push(name);
  }
  return out;
}

/** pq-grammes hachés (multiensemble trié) : `p` ancêtres de la pile, puis `q` balises consécutives. */
export function pqGrams(tags: readonly string[], p = 2, q = 3): string[] {
  const out: string[] = [];
  const path: string[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    const [depthText, name] = tags[i]!.split(':') as [string, string];
    const depth = Number(depthText);
    path.length = Math.min(path.length, depth);
    const ancestors = path.slice(-p);
    while (ancestors.length < p) ancestors.unshift('*');
    const window: string[] = [];
    for (let j = i; j < i + q; j += 1) window.push(tags[j]?.split(':')[1] ?? '*');
    out.push(short(`${ancestors.join('/')}|${window.join(',')}`));
    path[depth] = name;
  }
  return out.sort();
}

/** Distance pq-gramme normalisée (0 identique, 1 disjoint) entre deux multiensembles. */
export function pqGramDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const count = new Map<string, number>();
  for (const g of a) count.set(g, (count.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of b) {
    const n = count.get(g) ?? 0;
    if (n > 0) {
      common += 1;
      count.set(g, n - 1);
    }
  }
  return 1 - (2 * common) / (a.length + b.length);
}

/** Classes CSS du document, hachées et dédoublonnées. */
export function cssClassTokens(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass\s*=\s*["']([^"']{0,500})["']/gi)) {
    for (const c of (m[1] ?? '').split(/\s+/)) if (/^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/.test(c)) out.add(short(c));
    if (out.size >= 1_000) break;
  }
  return [...out].sort();
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Pondération du re-classement (r1 R11, à calibrer) : 0,3 pq-gramme, 0,7 Jaccard des classes. */
export const STRUCTURAL_WEIGHTS = Object.freeze({ pqgram: 0.3, classes: 0.7 });

export function structuralSimilarity(a: { readonly tag_grams: readonly string[]; readonly class_tokens: readonly string[] }, b: { readonly tag_grams: readonly string[]; readonly class_tokens: readonly string[] }): number {
  return STRUCTURAL_WEIGHTS.pqgram * (1 - pqGramDistance(a.tag_grams, b.tag_grams)) + STRUCTURAL_WEIGHTS.classes * jaccard(a.class_tokens, b.class_tokens);
}
