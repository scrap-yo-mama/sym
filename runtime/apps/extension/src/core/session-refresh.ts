// SPDX-License-Identifier: AGPL-3.0-only
// Rafraîchissement des sessions poussées à l'instance (CDC sym-sessions V1, B2, F3). Sans API Chrome : les capacités sont
// injectées. Trois déclencheurs, un seul chemin de poussée :
// - signal de l'instance (`GET /api/extension/refresh-requests`) au réveil et sur une alarme périodique ;
// - `cookies.onChanged` sur un domaine connecté en usage serveur (reconnexion, rotation), regroupé par un anti-rebond ;
// - jamais sur un domaine non connecté ni sans permission d'hôte (`refreshableDomains`).
// Propriétaire unique : une poussée à la fois par domaine (file en mémoire du service worker) ; une demande reçue pendant
// une poussée en cours est regroupée en une seule suivante, que l'empreinte rend inoffensive si rien n'a changé.
// Aucune valeur de cookie ici : seuls des noms de domaine et des codes d'erreur sont journalisés.
import { cookieMatchesDomain } from './host-guard.ts';

export type RefreshDeps = {
  refreshRequests(): Promise<string[]>;
  refreshableDomains(): Promise<string[]>;
  /** Lit et pousse la session du domaine si elle diffère de la dernière poussée réussie (`capture` du noyau). */
  push(domain: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Journal sans valeur secrète : domaine et code d'erreur seulement. */
  log?(message: string): void;
};

export const DEBOUNCE_MS = 5_000;
export const RETRY_DELAYS_MS = [2_000, 8_000] as const;

/** Changement de cookie (forme réduite de `chrome.cookies.CookieChangeInfo` : la valeur n'est jamais lue). */
export type CookieChange = { removed: boolean; cookie: { domain: string }; cause?: string };

export class SessionRefresher {
  readonly #deps: RefreshDeps;
  readonly #timers = new Map<string, unknown>();
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #queued = new Set<string>();

  constructor(deps: RefreshDeps) {
    this.#deps = deps;
  }

  /** Réveil ou alarme : relit le signal de l'instance et repousse les domaines demandés qui sont poussables ici. */
  async pollRequests(): Promise<number> {
    let requested: string[];
    try {
      requested = await this.#deps.refreshRequests();
    } catch {
      this.#deps.log?.('refresh-requests: instance injoignable');
      return 0;
    }
    if (requested.length === 0) return 0;
    const allowed = new Set(await this.#deps.refreshableDomains());
    let pushed = 0;
    for (const domain of new Set(requested)) {
      if (allowed.has(domain) && (await this.refresh(domain))) pushed += 1;
    }
    return pushed;
  }

  /** `cookies.onChanged` : ignore les suppressions ; un cookie posé ou modifié sur un domaine poussable arme l'anti-rebond. */
  async onCookieChanged(change: CookieChange): Promise<void> {
    if (change.removed) return;
    const domains = await this.#deps.refreshableDomains();
    for (const domain of domains) {
      if (!cookieMatchesDomain(change.cookie.domain, domain)) continue;
      const previous = this.#timers.get(domain);
      if (previous !== undefined) this.#deps.clearTimer(previous);
      this.#timers.set(
        domain,
        this.#deps.setTimer(() => {
          this.#timers.delete(domain);
          void this.refresh(domain);
        }, DEBOUNCE_MS),
      );
    }
  }

  /**
   * Poussée sérialisée par domaine, avec retentatives bornées (2 de plus, backoff 2 s puis 8 s). Rend vrai si une session
   * est partie. Deux appels simultanés : le second attend la fin du premier puis s'exécute une seule fois.
   */
  refresh(domain: string): Promise<boolean> {
    const running = this.#inFlight.get(domain);
    if (running) {
      this.#queued.add(domain);
      return running.then(() => (this.#queued.delete(domain) ? this.refresh(domain) : false));
    }
    let pushed = false;
    const run = this.#attempt(domain).then((p) => {
      pushed = p;
    });
    const tracked = run.finally(() => {
      this.#inFlight.delete(domain);
    });
    this.#inFlight.set(domain, tracked);
    return tracked.then(() => pushed);
  }

  async #attempt(domain: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#deps.push(domain);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'network';
        // Refus définitifs (consentement, permission, jeton, domaine déconnecté) : inutile de réessayer.
        if (code !== 'network' && code !== 'instance_error') return false;
        const delay = RETRY_DELAYS_MS[attempt];
        this.#deps.log?.(`push ${domain}: échec (${code}), tentative ${attempt + 1}`);
        if (delay === undefined) return false;
        await this.#deps.sleep(delay);
      }
    }
  }
}
