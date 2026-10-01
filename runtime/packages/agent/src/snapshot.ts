// SPDX-License-Identifier: AGPL-3.0-only
// Instantanés du canal `agent_step` (07 §3) : arbre d'accessibilité « ai » de Playwright (`[ref=eN]`), tronqué, avec un
// `snapshot_id` lié à son contenu. Les fonctions pures de l'arbre vivent dans `@runtime/core` (partagées avec l'extension,
// tâche 0.6b) ; restent ici l'empreinte SHA-256 du canal Playwright et le verrou de domaines.
import { createHash } from 'node:crypto';

export { DEFAULT_MAX_TREE_CHARS, hasRef, semanticOf, truncateTree } from '@runtime/core';

/** Empreinte du contenu : deux instantanés d'une page inchangée ont la même, un `ref` reste alors valable. */
export function contentDigest(url: string, tree: string): string {
  return createHash('sha256').update(url).update('\n').update(tree).digest('hex').slice(0, 12);
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
