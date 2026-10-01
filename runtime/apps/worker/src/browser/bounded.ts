// SPDX-License-Identifier: AGPL-3.0-only
// Lectures bornées AVANT transfert au worker (tâche 1.6, revue) : une page hostile ne doit pas pouvoir faire charger des
// centaines de Mo dans le processus Node (disponibilité des runs des autres membres). Chaque lecture est faite dans la
// page, et la page ne rend qu'une chaîne primitive dont la longueur est contrôlée dans la page : `typeof` et la longueur
// d'une chaîne primitive ne se surchargent pas, donc une page qui remplace `JSON.stringify`, `TextDecoder`, `outerHTML`
// ou `ArrayBuffer.prototype.byteLength` peut fausser les données qu'elle sert (c'est son contenu), jamais la borne.
// Le plafond en octets est ensuite revérifié côté hôte (UTF-8) ; le cgroup reste le dernier filet.
import type { Page, Response } from 'playwright-core';

/** Valeur trop grande ou illisible : l'appelant la refuse (`response_too_large`, `output_limit`). */
export const TOO_LARGE = Symbol('too_large');

/** Formes minimales du DOM vues depuis le worker (le paquet n'embarque pas la bibliothèque `dom`). */
type PageGlobals = {
  document: { doctype: unknown; documentElement: { outerHTML: unknown } | null };
  XMLSerializer: new () => { serializeToString(node: unknown): string };
  performance: { getEntriesByType(type: string): { decodedBodySize: number }[] };
};

const bytesOk = (value: string, maxBytes: number): boolean => Buffer.byteLength(value) <= maxBytes;

/** HTML sérialisé du document (doctype + `documentElement`), comme `page.content()`, borné dans la page. */
export async function boundedContent(page: Page, maxBytes: number): Promise<string | typeof TOO_LARGE> {
  const html = await page.evaluate((max: number) => {
    let out: unknown;
    try {
      const g = globalThis as unknown as PageGlobals;
      const d = g.document;
      out = (d.doctype ? new g.XMLSerializer().serializeToString(d.doctype) : '') + String(d.documentElement ? d.documentElement.outerHTML : '');
    } catch {
      return null;
    }
    return typeof out === 'string' && out.length <= max ? out : null;
  }, maxBytes);
  return typeof html === 'string' && bytesOk(html, maxBytes) ? html : TOO_LARGE;
}

/**
 * Corps d'une réponse de navigation hors HTML (JSON, texte) : un tel document n'exécute aucun script de page, sa taille
 * décodée (`PerformanceNavigationTiming.decodedBodySize`) est donc fiable ; `Content-Length` est contrôlé d'abord.
 */
export async function boundedRawBody(page: Page, response: Response, maxBytes: number): Promise<string | typeof TOO_LARGE> {
  const declared = Number(response.headers()['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return TOO_LARGE;
  const decoded = await page
    .evaluate(() => {
      const entry = (globalThis as unknown as PageGlobals).performance.getEntriesByType('navigation')[0];
      return entry === undefined ? -1 : entry.decodedBodySize;
    })
    .catch(() => -1);
  if (typeof decoded === 'number' && decoded >= 0) {
    // Taille décodée (après décompression) : seule mesure qui borne aussi une bombe de compression.
    if (decoded > maxBytes) return TOO_LARGE;
  } else if (!(Number.isFinite(declared) && declared <= maxBytes)) {
    // Taille inconnue sans Content-Length : refus plutôt qu'un transfert non borné.
    return TOO_LARGE;
  }
  const body = await response.text();
  return bytesOk(body, maxBytes) ? body : TOO_LARGE;
}

/** Texte JSON reçu de la page : borne en octets revérifiée, analyse. */
export function parseBounded(text: unknown, maxBytes: number): unknown {
  if (typeof text !== 'string' || !bytesOk(text, maxBytes)) return TOO_LARGE;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return TOO_LARGE;
  }
}
