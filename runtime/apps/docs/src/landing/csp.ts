// SPDX-License-Identifier: AGPL-3.0-only
// CSP de la landing en balise `<meta http-equiv="Content-Security-Policy">` (22 § 2.9, D-43) : GitHub Pages ne pose aucun
// en-tête. Les empreintes sha256 des scripts en ligne (thème sombre et détection macOS de VitePress) sont calculées au build à
// partir du HTML produit, jamais écrites à la main. `frame-ancestors` est ignoré dans une balise meta : il n'y figure pas
// (perte consignée) ; sur le repli Cloudflare Pages, `_headers` le rétablit.
// `'self'` (forme imposée par 22 § 2.9) vaut l'origine `https://<propriétaire>.github.io`, que partagent TOUS les sites Pages d'un même
// propriétaire : un autre dépôt du propriétaire avec Pages pourrait servir des scripts et des feuilles que cette politique autorise. Une
// source restreinte par chemin (`https://<propriétaire>.github.io/<dépôt>/assets/`) ne marcherait pas sur la préproduction servie en
// local (autre origine) et s'écarterait de la politique spécifiée ; la règle retenue est donc : ce dépôt est le SEUL site Pages de son
// propriétaire, vérifié avant la mise en ligne (pages.yml) et chaque semaine (landing-production.yml) par `landing:pages-origin`.
import { createHash } from 'node:crypto';

/** Contenu des scripts en ligne exécutables d'un document : ceux qui exigent une empreinte. Un bloc de données (JSON-LD) n'est pas exécuté. */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attributes = match[1] ?? '';
    if (/\bsrc\s*=/.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/.exec(attributes)?.[1]?.toLowerCase();
    if (type !== undefined && type !== 'module' && !/(?:java|ecma)script/.test(type)) continue;
    scripts.push(match[2] ?? '');
  }
  return scripts;
}

/** Source CSP d'un script en ligne : `'sha256-…'`, calculée sur le texte exact de la balise. */
const sha256Source = (script: string): string => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;

/** Politique de la landing, avec l'empreinte de chaque script en ligne (sans doublon, triée : deux builds du même commit donnent la même balise). */
export function buildCsp(scripts: readonly string[]): string {
  const hashes = [...new Set(scripts.map(sha256Source))].sort();
  return [
    "default-src 'none'",
    `script-src 'self'${hashes.length > 0 ? ` ${hashes.join(' ')}` : ''}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** Pose la CSP et la politique de référent en tête du `<head>` : la CSP est la première balise, avant tout script. */
function injectSecurityMeta(html: string, csp: string): string {
  const tags = `\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <meta name="referrer" content="strict-origin-when-cross-origin">`;
  if (!/<head>/.test(html)) throw new Error('document sans <head> : CSP impossible');
  return html.replace('<head>', `<head>${tags}`);
}

/** Politique d'une page : calculée sur le HTML final, balise posée. */
export function withCsp(html: string): string {
  return injectSecurityMeta(html, buildCsp(inlineScripts(html)));
}

/** Politique posée par la balise meta d'une page construite, ou `undefined`. */
export function cspOf(html: string): string | undefined {
  return /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
}

/**
 * `_headers` du repli Cloudflare Pages (22 § 2.9) : la même politique que les balises meta (mêmes empreintes, lues dans le HTML
 * construit), plus `frame-ancestors 'none'` et les en-têtes que GitHub Pages ne permet pas de poser. Réservé aux pages de la landing :
 * les pages de doc chargent le moteur de recherche (WebAssembly) et gardent leur propre régime. `paths` : `landingHeaderPaths(base)`,
 * toutes les adresses de chaque page sous le chemin de base du build.
 */
export function buildHeadersFile(paths: readonly string[], csp: string): string {
  const rule = (path: string): string =>
    [
      path,
      `  Content-Security-Policy: ${csp}; frame-ancestors 'none'`,
      '  Referrer-Policy: strict-origin-when-cross-origin',
      '  X-Content-Type-Options: nosniff',
      '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
      '  Cross-Origin-Opener-Policy: same-origin',
    ].join('\n');
  return `${paths.map(rule).join('\n\n')}\n`;
}
