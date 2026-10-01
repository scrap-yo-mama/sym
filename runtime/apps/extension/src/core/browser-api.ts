// SPDX-License-Identifier: AGPL-3.0-only
// Capacités du navigateur dont l'exécuteur du tunnel a besoin (07 § 3-4), injectées : l'implémentation Chrome est dans
// platform/chrome-api.ts, les tests unitaires utilisent des doubles. Aucune autre porte vers le navigateur.

export type TabInfo = {
  id: number;
  url?: string;
  status?: string;
  discarded?: boolean;
  /** Chrome 132+ : onglet gelé (rien ne s'y exécute). */
  frozen?: boolean;
  autoDiscardable?: boolean;
  active?: boolean;
  groupId?: number;
};

/** Requête exécutée par la fonction empaquetée `pageFetchInPage` (aucun code venu du serveur). */
export type InPageRequest = { url: string; method: string; headers: Record<string, string>; body: string | null; maxBytes: number; maxMeta: number };
export type InPageResult = { kind: 'ok'; status: number; headers: string; body: string; url: string } | { kind: 'too_large' } | { kind: 'error' };
/** Lecture bornée d'une page (détection de défi) par la fonction empaquetée `inspectPage`. */
export type PageInspection = { title: string; url: string; text: string };

export interface BrowserApi {
  readonly tabs: {
    /** Onglet d'automatisation : `active: false`, jamais au premier plan. */
    create(url: string): Promise<TabInfo>;
    get(tabId: number): Promise<TabInfo | null>;
    /** `autoDiscardable: false` (07 § 4) : Chrome ne le décharge pas. */
    keep(tabId: number): Promise<void>;
    reload(tabId: number): Promise<void>;
    remove(tabId: number): Promise<void>;
    /** Attend `status === 'complete'` ; faux au délai. */
    waitComplete(tabId: number, timeoutMs: number): Promise<boolean>;
    /** Range l'onglet dans le groupe « Scrapyomama » (`chrome.tabGroups`). */
    group(tabId: number): Promise<void>;
  };
  readonly scripting: {
    pageFetch(tabId: number, request: InPageRequest): Promise<InPageResult>;
    inspect(tabId: number): Promise<PageInspection | null>;
  };
  readonly debugger: {
    attach(tabId: number): Promise<void>;
    detach(tabId: number): Promise<void>;
    /** Seul point d'envoi CDP : refuse toute méthode hors de la liste blanche avant `chrome.debugger.sendCommand`. */
    send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
    /** Événements CDP de l'onglet (lecture seule) ; rend la fonction de désabonnement. */
    onEvent(tabId: number, handler: (method: string, params: unknown) => void): () => void;
  };
  readonly permissions: { contains(origins: string[]): Promise<boolean> };
  /** `fetch` du service worker (`http_fetch`) : IP de l'utilisateur, cookies du navigateur, rien de posé à la main. */
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; url: string; headers: [string, string][]; text(max: number): Promise<string | null> }>;
}
