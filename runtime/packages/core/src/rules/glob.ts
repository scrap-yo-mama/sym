// SPDX-License-Identifier: AGPL-3.0-only
// Globs de domaine des règles (tâche 2.10, 18 §4.3) : comparaison sur le nom d'hôte normalisé (minuscules, point final
// retiré, IDN en punycode) ; `*` couvre tout, `*.x` couvre les sous-domaines de `x` mais pas `x`, un littéral est exact.
import { domainToASCII } from 'node:url';

/** Nom d'hôte normalisé, ou `null` s'il est illisible. */
export function normalizeHost(host: string): string | null {
  const trimmed = host.trim().replace(/\.$/, '');
  if (trimmed === '' || trimmed.length > 253) return null;
  const ascii = domainToASCII(trimmed.toLowerCase());
  return ascii === '' ? null : ascii;
}

/** Normalise le glob (`*.x` : partie littérale en punycode). */
function normalizeGlob(glob: string): string | null {
  if (glob === '*') return '*';
  if (glob.startsWith('*.')) {
    const rest = normalizeHost(glob.slice(2));
    return rest === null ? null : `*.${rest}`;
  }
  return normalizeHost(glob);
}

export function domainGlobMatches(glob: string, host: string): boolean {
  const g = normalizeGlob(glob);
  const h = normalizeHost(host);
  if (g === null || h === null) return false;
  if (g === '*') return true;
  if (g.startsWith('*.')) return h.endsWith(g.slice(1));
  return h === g;
}

/** Spécificité : nombre de libellés littéraux (départage à niveau égal, 18 §4.3). */
export function globSpecificity(glob: string): number {
  if (glob === '*') return 0;
  return glob.split('.').filter((label) => label !== '*').length;
}
