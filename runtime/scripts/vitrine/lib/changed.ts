// SPDX-License-Identifier: AGPL-3.0-only
// Filtre par chemin du job `vitrine` (22 §3.6) : il ne tourne que si la PR touche la vitrine. La CI ne filtre jamais
// `quality` (aucun filtre de chemin sur le workflow) : le filtre est celui de ce job, décidé ici, testé ici.
// Le registre des allégations (`check.mjs claims`) n'est pas filtré : ses preuves sont des tests de tout le monorepo.
const PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /^README[^/]*$/,
  /^LICENSE$/,
  /^runtime\/apps\/docs\//,
  /^runtime\/LICENSES\//,
  /^runtime\/scripts\/vitrine\//,
  /^runtime\/tests\/vitrine\//,
  /^runtime\/tests\/public-showcase\.unit\.test\.ts$/,
  /^runtime\/deploy\//,
  /^render\.yaml$/,
  /^runtime\/[^/]+\.md$/,
  /^runtime\/docs\//,
  /^runtime\/package\.json$/,
];

/** `true` si au moins un des fichiers modifiés (chemins depuis la racine du dépôt) concerne la vitrine. */
export function vitrineTouched(files: readonly string[]): boolean {
  return files.some((file) => PATTERNS.some((pattern) => pattern.test(file)));
}
