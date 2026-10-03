// SPDX-License-Identifier: AGPL-3.0-only
// `storageState` d'une session dedicated (cdc/sym-browser 04c § 4.3, tâche 3.1) : import à la création (appliqué au
// contexte par défaut, donc au profil, sauvegardé à la fin d'une session en écriture) et export (cookies et origines de la
// session en cours). Les routes REST (`GET /v1/sessions/{id}/storage-state`, `POST /v1/profiles/{id}/import`) les
// appellent ; le contenu n'est jamais journalisé.
import type { StorageState } from '@sym/contracts/browser';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

/** Session dedicated en cours : point CDP local du nœud (connexion interne, refermée après usage). */
export type StorageStateTarget = { cdpEndpoint: string | undefined };

async function withDefaultContext<T>(target: StorageStateTarget, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  if (target.cdpEndpoint === undefined) throw new RangeError('storageState : session dedicated requise');
  const browser: Browser = await chromium.connectOverCDP(target.cdpEndpoint);
  try {
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('storageState : contexte par défaut introuvable');
    return await fn(context);
  } finally {
    // Déconnexion seulement : Chromium et son contexte par défaut restent à la session.
    await browser.close().catch(() => undefined);
  }
}

/** Remplace cookies et stockages du profil de la session par `state`. */
export async function importStorageState(target: StorageStateTarget, state: StorageState): Promise<void> {
  await withDefaultContext(target, (context) => context.setStorageState(state as Parameters<BrowserContext['setStorageState']>[0]));
}

/**
 * Cookies et origines de la session en cours. Comme `context.storageState()`, le localStorage exporté est celui des
 * origines ouvertes dans une page ; une connexion CDP neuve ne connaît pas les origines visitées avant elle, d'où la
 * lecture page par page.
 */
export async function exportStorageState(target: StorageStateTarget): Promise<StorageState> {
  return withDefaultContext(target, async (context) => {
    const state = (await context.storageState()) as StorageState;
    const origins = new Map(state.origins.map((o) => [o.origin, o]));
    for (const page of context.pages()) {
      let origin: string;
      try {
        const url = new URL(page.url());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        origin = url.origin;
      } catch {
        continue;
      }
      if (origins.has(origin)) continue;
      const localStorage = await page
        .evaluate(() => Object.entries((globalThis as unknown as { localStorage: Record<string, string> }).localStorage).map(([name, value]) => ({ name, value: String(value) })))
        .catch(() => undefined);
      if (localStorage !== undefined && localStorage.length > 0) origins.set(origin, { origin, localStorage });
    }
    return { cookies: state.cookies, origins: [...origins.values()] };
  });
}
