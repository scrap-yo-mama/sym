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

/** Corps compressé de taille inconnue (sans `Content-Length`) lu au plus jusqu'à cette taille transférée. */
const COMPRESSED_READ_MAX = 32 * 1024;

/**
 * Corps BRUT d'une réponse de document (HTML compris), tel que le serveur l'a servi, AVANT que les scripts de la page
 * ne le transforment : c'est sur lui que tourne la garde de classification (1.7, 04 §5), avant toute attente du rendu.
 * La taille est prise au niveau réseau (`Content-Length`, taille transférée de `Request.sizes()`), jamais à la page,
 * qui pourrait la falsifier. `undefined` : taille inconnue (corps compressé volumineux sans longueur annoncée), le
 * corps brut n'est pas lu ; `TOO_LARGE` : au-delà du plafond.
 */
export async function boundedDocumentBody(response: Response, maxBytes: number, timeoutMs = 10_000): Promise<string | typeof TOO_LARGE | undefined> {
  const headers = response.headers();
  const declared = Number(headers['content-length'] ?? NaN);
  const encoding = (headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const identity = encoding === '' || encoding === 'identity';
  // Un document qui ne finit jamais de se charger n'est pas attendu au-delà du délai : corps brut non lu.
  const transferred = await withTimeout(response.request().sizes().then((s) => s.responseBodySize), timeoutMs);
  if ((Number.isFinite(declared) && declared > maxBytes) || (transferred !== undefined && transferred > maxBytes)) return TOO_LARGE;
  // Corps compressé : la taille décodée n'est connue qu'après lecture ; seul un petit transfert est lu (un interstitiel
  // est petit), ce qui borne aussi une bombe de compression.
  const readable = identity ? Number.isFinite(declared) || transferred !== undefined : (transferred ?? (Number.isFinite(declared) ? declared : Infinity)) <= COMPRESSED_READ_MAX;
  if (!readable) return undefined;
  const body = await withTimeout(response.text(), timeoutMs);
  if (body === undefined) return undefined;
  return bytesOk(body, maxBytes) ? body : TOO_LARGE;
}

/** Valeur de la promesse, ou `undefined` si elle échoue ou dépasse le délai. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise.catch(() => undefined), new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
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
