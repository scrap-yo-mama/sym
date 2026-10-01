// SPDX-License-Identifier: AGPL-3.0-only
// Lectures bornées AVANT transfert au worker (tâche 1.6, revue) : une page hostile ne doit pas pouvoir faire charger des
// centaines de Mo dans le processus Node (disponibilité des runs des autres membres). Chaque lecture est faite dans la
// page, et la page ne rend qu'une chaîne primitive dont la longueur est contrôlée dans la page : `typeof` et la longueur
// d'une chaîne primitive ne se surchargent pas, donc une page qui remplace `JSON.stringify`, `TextDecoder`, `outerHTML`
// ou `ArrayBuffer.prototype.byteLength` peut fausser les données qu'elle sert (c'est son contenu), jamais la borne.
// Le plafond en octets est ensuite revérifié côté hôte (UTF-8) ; le cgroup reste le dernier filet.
import type { CDPSession, Page, Response } from 'playwright-core';

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

/**
 * Taille DÉCODÉE (après décompression) des documents reçus par une page, vue au niveau réseau par CDP
 * (`Network.dataReceived.dataLength`, sommée jusqu'à `Network.loadingFinished`) : la page ne peut pas la falsifier, et
 * elle est connue AVANT de rapatrier le corps dans Node. Sans elle, un corps compressé n'est jamais lu.
 */
export type DecodedSizes = {
  /**
   * Taille décodée du document servi à l'URL de `response` (le plus grand s'il y en a plusieurs : prudent), une fois
   * reçu en entier ; `undefined` si inconnue ou pas finie dans le délai.
   */
  decodedBodySize(response: Response, timeoutMs: number): Promise<number | undefined>;
};

/** Documents suivis au plus (les plus anciens sortent). */
const TRACKED_DOCUMENTS = 64;

type TrackedDocument = { url: string; decoded: number; done: boolean };

/** Suivi des tailles décodées des documents d'une page par sa session CDP (`Network.enable`). */
export async function trackDecodedSizes(session: CDPSession): Promise<DecodedSizes> {
  const documents = new Map<string, TrackedDocument>();
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  session.on('Network.responseReceived', (event) => {
    if (event.type !== 'Document') return;
    documents.set(event.requestId, { url: event.response.url, decoded: 0, done: false });
    if (documents.size > TRACKED_DOCUMENTS) documents.delete(documents.keys().next().value as string);
    wake();
  });
  session.on('Network.dataReceived', (event) => {
    const doc = documents.get(event.requestId);
    if (doc !== undefined) doc.decoded += event.dataLength;
  });
  const finish = (event: { requestId: string }): void => {
    const doc = documents.get(event.requestId);
    if (doc === undefined) return;
    doc.done = true;
    wake();
  };
  session.on('Network.loadingFinished', finish);
  session.on('Network.loadingFailed', finish);
  await session.send('Network.enable');
  /** Taille si tous les documents de cette URL sont finis, `null` s'il faut attendre. */
  const settled = (url: string): number | null => {
    const matching = [...documents.values()].filter((d) => d.url === url);
    if (matching.length === 0 || matching.some((d) => !d.done)) return null;
    return Math.max(...matching.map((d) => d.decoded));
  };
  return {
    decodedBodySize: (response, timeoutMs) => {
      const url = response.url();
      const now = settled(url);
      if (now !== null) return Promise.resolve(now);
      return new Promise((resolve) => {
        const done = (value: number | undefined): void => {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(value);
        };
        const check = (): void => {
          const value = settled(url);
          if (value !== null) done(value);
        };
        const timer = setTimeout(() => done(undefined), timeoutMs);
        waiters.add(check);
      });
    },
  };
}

/**
 * Corps BRUT d'une réponse de document (HTML compris), tel que le serveur l'a servi, AVANT que les scripts de la page
 * ne le transforment : c'est sur lui que tourne la garde de classification (1.7, 04 §5), avant toute attente du rendu.
 * La taille est prise au niveau réseau, jamais à la page, qui pourrait la falsifier : `Content-Length` et taille
 * transférée (`Request.sizes()`) pour un corps non compressé ; pour un corps compressé, sa taille DÉCODÉE (`sizes`,
 * suivi CDP), seule mesure qui borne une bombe de compression (32 Kio de gzip ou de brotli se décodent en dizaines de
 * Mo) AVANT que `response.text()` ne rapatrie le corps décodé dans Node. `undefined` : taille inconnue, le corps brut
 * n'est pas lu ; `TOO_LARGE` : au-delà du plafond.
 */
export async function boundedDocumentBody(response: Response, maxBytes: number, timeoutMs = 10_000, sizes?: DecodedSizes): Promise<string | typeof TOO_LARGE | undefined> {
  const headers = response.headers();
  const declared = Number(headers['content-length'] ?? NaN);
  const encoding = (headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const identity = encoding === '' || encoding === 'identity';
  // Un document qui ne finit jamais de se charger n'est pas attendu au-delà du délai : corps brut non lu.
  const transferred = await withTimeout(response.request().sizes().then((s) => s.responseBodySize), timeoutMs);
  if ((Number.isFinite(declared) && declared > maxBytes) || (transferred !== undefined && transferred > maxBytes)) return TOO_LARGE;
  if (identity) {
    if (!(Number.isFinite(declared) || transferred !== undefined)) return undefined;
  } else {
    const decoded = sizes === undefined ? undefined : await sizes.decodedBodySize(response, timeoutMs);
    if (decoded === undefined) return undefined;
    if (decoded > maxBytes) return TOO_LARGE;
  }
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
