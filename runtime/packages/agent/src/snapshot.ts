// SPDX-License-Identifier: AGPL-3.0-only
// Instantanés du canal `agent_step` (07 §3) : arbre d'accessibilité « ai » de Playwright (`[ref=eN]`), tronqué, avec un
// `snapshot_id` lié à son contenu. Fonctions pures : testables sans navigateur.
import { createHash } from 'node:crypto';

export const DEFAULT_MAX_TREE_CHARS = 16_000;

/** Tronque l'arbre à une limite de caractères, sur une fin de ligne. */
export function truncateTree(tree: string, maxChars: number): { text: string; truncated: boolean } {
  if (tree.length <= maxChars) return { text: tree, truncated: false };
  const cut = tree.lastIndexOf('\n', maxChars);
  return { text: `${tree.slice(0, cut > 0 ? cut : maxChars)}\n- [truncated]`, truncated: true };
}

/** Empreinte du contenu : deux instantanés d'une page inchangée ont la même, un `ref` reste alors valable. */
export function contentDigest(url: string, tree: string): string {
  return createHash('sha256').update(url).update('\n').update(tree).digest('hex').slice(0, 12);
}

const REF_LINE = /^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=([a-z0-9]+)\]/;

/**
 * Sélecteur sémantique (rôle + nom accessible) d'un `ref` dans un arbre : c'est lui que la trace consigne, jamais le
 * seul `ref` (04 §3.1, compilation E6 → E5).
 */
export function semanticOf(tree: string, ref: string): { role: string; name: string } | undefined {
  for (const line of tree.split('\n')) {
    if (!line.includes(`[ref=${ref}]`)) continue;
    const match = REF_LINE.exec(line);
    if (match?.[3] !== ref) continue;
    return { role: match[1] ?? 'generic', name: (match[2] ?? '').replace(/\\(.)/g, '$1') };
  }
  return undefined;
}

/** Vrai si le `ref` figure dans l'arbre (sinon : référence inconnue, traitée comme périmée). */
export function hasRef(tree: string, ref: string): boolean {
  return /^[a-z0-9]+$/.test(ref) && tree.includes(`[ref=${ref}]`);
}

/** Hôte d'une URL, en minuscules ; null si l'URL n'est pas http(s). */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Verrou de domaines (08 §4, mesure 2) : égalité exacte d'hôte, ou sous-domaine d'un domaine déclaré `*.x`. */
export function hostAllowed(host: string | null, allowed: readonly string[]): boolean {
  if (host === null) return false;
  return allowed.some((a) => {
    const d = a.toLowerCase();
    return d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d;
  });
}
