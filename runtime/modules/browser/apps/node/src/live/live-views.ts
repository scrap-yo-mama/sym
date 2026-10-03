// SPDX-License-Identifier: AGPL-3.0-only
// Registre des vues en direct du nœud (tâche 3.2) : une `LiveView` par session ouverte par le nœud (sessions shared 1.3 ;
// dedicated par le superviseur de 1.2), retrouvée par le relais interne (`/internal/sessions/{id}/live`), fermée à la fin de
// la session.
import type { BrowserContext } from 'playwright-core';
import { LiveView, type LiveEvent, type LiveViewOptions } from './live-view.js';

export type LiveViewsOptions = Omit<LiveViewOptions, 'sessionId' | 'context' | 'interactive' | 'onEvent'> & { onEvent?: (event: LiveEvent) => void };

export class LiveViews {
  readonly #views = new Map<string, LiveView>();
  readonly #options: LiveViewsOptions;

  constructor(options: LiveViewsOptions = {}) {
    this.#options = options;
  }

  open(request: { sessionId: string; context: BrowserContext; interactive: boolean }): LiveView {
    if (this.#views.has(request.sessionId)) throw new RangeError(`vue en direct déjà ouverte pour ${request.sessionId}`);
    const view = new LiveView({ ...this.#options, ...request, ...(this.#options.onEvent ? { onEvent: this.#options.onEvent } : {}) });
    this.#views.set(request.sessionId, view);
    return view;
  }

  get(sessionId: string): LiveView | undefined {
    return this.#views.get(sessionId);
  }

  async close(sessionId: string, reason: string): Promise<void> {
    const view = this.#views.get(sessionId);
    this.#views.delete(sessionId);
    await view?.close(reason);
  }
}
