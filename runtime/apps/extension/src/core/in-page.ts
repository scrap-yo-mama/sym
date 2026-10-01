// SPDX-License-Identifier: AGPL-3.0-only
// Fonctions EMPAQUETÉES exécutées dans un onglet par `chrome.scripting.executeScript({ func })` (07 § 3) : aucun code ne
// vient du serveur, seules ces fonctions du paquet s'exécutent, avec des arguments de données. Monde isolé (pas celui de
// la page). Chaque fonction est autonome (sérialisée par Chrome) : aucune référence à un module.
import type { InPageRequest, InPageResult, PageInspection } from './browser-api.ts';

/**
 * `page_fetch` : `fetch` dans la page du site (origine, cookies, en-têtes du site), corps lu avec plafond. Redirections
 * JAMAIS suivies (`redirect: 'manual'`) : suivre puis contrôler l'URL finale émettrait déjà la requête vers une IP privée
 * ou un autre domaine dans le navigateur de l'utilisateur (INV10, 08b). Une redirection est rendue `redirect`.
 */
export async function pageFetchInPage(a: InPageRequest): Promise<InPageResult> {
  try {
    const init: RequestInit = { method: a.method, headers: a.headers, credentials: 'include', redirect: 'manual', cache: 'no-store' };
    if (a.body !== null) init.body = a.body;
    const r = await fetch(a.url, init);
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) return { kind: 'redirect' };
    const parts: Uint8Array[] = [];
    let size = 0;
    const reader = r.body === null ? null : r.body.getReader();
    if (reader !== null) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > a.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { kind: 'too_large' };
        }
        parts.push(chunk.value);
      }
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      buffer.set(part, offset);
      offset += part.byteLength;
    }
    const h: Record<string, string> = {};
    r.headers.forEach((value, name) => {
      h[name.toLowerCase()] = value;
    });
    const meta = JSON.stringify(h);
    if (meta.length > a.maxMeta) return { kind: 'error' };
    return { kind: 'ok', status: r.status, headers: meta, body: new TextDecoder().decode(buffer), url: r.url };
  } catch {
    return { kind: 'error' };
  }
}

/** Lecture bornée de la page (titre, URL, début du document) pour la détection de défi : rien n'est modifié. */
export function inspectPage(): PageInspection {
  // Globals de la page, typés ici (le noyau se compile aussi sans la bibliothèque DOM).
  const page = globalThis as unknown as { document: { title: string; documentElement: { outerHTML: string } | null }; location: { href: string } };
  const html = page.document.documentElement?.outerHTML ?? '';
  return { title: page.document.title.slice(0, 500), url: page.location.href, text: html.slice(0, 200_000) };
}
