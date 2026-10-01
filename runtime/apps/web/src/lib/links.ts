// SPDX-License-Identifier: AGPL-3.0-only
// Liens sortants construits à partir de valeurs du serveur (API officielle trouvée sur un site scrapé, par exemple) : seuls
// les schémas `https:` et `http:` deviennent un lien (jamais `javascript:` ni `data:`).

export function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
