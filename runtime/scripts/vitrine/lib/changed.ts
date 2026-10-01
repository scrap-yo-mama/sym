// SPDX-License-Identifier: AGPL-3.0-only
// Filtre par chemin du job `vitrine` (22 §3.6) : il ne tourne que si la PR touche la vitrine. La CI ne filtre jamais
// `quality` (aucun filtre de chemin sur le workflow) : le filtre est celui de ce job, décidé ici, testé ici.
const PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /^README[^/]*$/,
  /^LICENSE$/,
  /^runtime\/apps\/docs\//,
  /^runtime\/LICENSES\//,
  /^runtime\/scripts\/vitrine\//,
  /^runtime\/tests\/vitrine\//,
  /^runtime\/tests\/public-showcase\.unit\.test\.ts$/,
  /^runtime\/deploy\/Dockerfile$/,
  /^runtime\/docs\//,
  /^runtime\/package\.json$/,
];

/** `true` si au moins un des fichiers modifiés (chemins depuis la racine du dépôt) concerne la vitrine. */
export function vitrineTouched(files: readonly string[]): boolean {
  return files.some((file) => PATTERNS.some((pattern) => pattern.test(file)));
}
