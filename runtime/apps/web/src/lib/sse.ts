// SPDX-License-Identifier: AGPL-3.0-only
// Client SSE de la console (06 § 3) : UN flux multiplexé par onglet (`GET /api/events`), reprise par l'en-tête
// `Last-Event-ID`, aucun événement rejoué (dédoublonnage par identifiant), commentaire `: ping` comme signe de vie,
// reconnexion avec attente croissante. On n'utilise pas EventSource : il ne laisse pas choisir l'en-tête de reprise
// après une fermeture définitive (401, 503) ni distinguer l'état « reconnexion » de l'état « arrêté ».

/** Une trame SSE complète. */
export type SseEvent = { id: string | null; event: string; data: string };

/** Analyseur incrémental du format `text/event-stream` (WHATWG HTML § 9.2). */
export class SseParser {
  #buffer = '';
  #id: string | null = null;
  #event = '';
  #data: string[] = [];

  /** Nombre de millisecondes demandé par un champ `retry:` (dernière valeur), sinon null. */
  retryMs: number | null = null;

  /** Ajoute un fragment de flux ; renvoie les trames complétées. Un commentaire ne produit aucune trame. */
  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.#buffer);
      if (!match) break;
      // Un `\r` en fin de tampon peut précéder un `\n` du fragment suivant : on attend.
      if (match[0] === '\r' && match.index === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      const event = this.#line(line);
      if (event) out.push(event);
    }
    return out;
  }

  #line(line: string): SseEvent | null {
    if (line === '') {
      const hadData = this.#data.length > 0;
      const event: SseEvent | null = hadData ? { id: this.#id, event: this.#event || 'message', data: this.#data.join('\n') } : null;
      this.#event = '';
      this.#data = [];
      this.#id = null;
      return event;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
    return null;
  }
}

/** `live` : flux ouvert ; `reconnecting` : coupure (bandeau affiché) ; `stopped` : arrêt demandé ou session finie. */
export type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped';

export type EventStreamOptions = {
  url: string;
  /** `fetch` injectable (tests). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Attente avant la tentative n (0 = première reconnexion). Défaut : 1 s doublée jusqu'à 30 s. */
  backoffMs?: (attempt: number) => number;
  /** Silence maximal toléré (le serveur envoie un ping toutes les 15 à 20 s) avant de considérer le flux coupé. */
  idleTimeoutMs?: number;
  /** Attente interruptible (tests). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Taille de la mémoire de dédoublonnage. */
  dedupeSize?: number;
};

export const defaultBackoff = (attempt: number): number => Math.min(30_000, 1_000 * 2 ** attempt);

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export class EventStreamClient {
  #options: Required<Omit<EventStreamOptions, 'fetch'>> & { fetch: NonNullable<EventStreamOptions['fetch']> };
  #controller: AbortController | null = null;
  #seen = new Set<string>();
  #statusListeners = new Set<(status: StreamStatus) => void>();
  #eventListeners = new Set<(event: SseEvent) => void>();
  #unauthorizedListeners = new Set<() => void>();
  #status: StreamStatus = 'idle';

  /** Dernier identifiant reçu : renvoyé dans `Last-Event-ID` à chaque reconnexion. */
  lastEventId: string | null = null;

  constructor(options: EventStreamOptions) {
    this.#options = {
      backoffMs: defaultBackoff,
      idleTimeoutMs: 45_000,
      sleep: defaultSleep,
      dedupeSize: 1_000,
      fetch: (input, init) => fetch(input, init),
      ...options,
    };
  }

  get status(): StreamStatus {
    return this.#status;
  }

  onStatus(listener: (status: StreamStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onEvent(listener: (event: SseEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Appelé quand le serveur répond 401 : la session est finie, le flux s'arrête sans reconnexion. */
  onUnauthorized(listener: () => void): () => void {
    this.#unauthorizedListeners.add(listener);
    return () => this.#unauthorizedListeners.delete(listener);
  }

  /** Ouvre le flux (sans effet s'il est déjà ouvert). La boucle de reconnexion tourne jusqu'à `stop()`. */
  start(): void {
    if (this.#controller) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#setStatus('connecting');
    void this.#run(controller);
  }

  /** Arrête le flux et oublie la position de reprise : un nouveau `start()` repart de zéro (autre session possible). */
  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.lastEventId = null;
    this.#seen.clear();
    this.#setStatus('stopped');
  }

  #setStatus(status: StreamStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #remember(id: string): boolean {
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > this.#options.dedupeSize) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }

  async #run(controller: AbortController): Promise<void> {
    const { signal } = controller;
    let attempt = 0;
    let serverRetry: number | null = null;
    while (!signal.aborted) {
      const parser = new SseParser();
      // Chaque tentative a son propre signal : le silence du serveur l'interrompt sans arrêter la boucle.
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort();
      signal.addEventListener('abort', abortAttempt, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(abortAttempt, this.#options.idleTimeoutMs);
      };
      try {
        const headers: Record<string, string> = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
        if (this.lastEventId !== null) headers['last-event-id'] = this.lastEventId;
        armIdle();
        const response = await this.#options.fetch(this.#options.url, { headers, credentials: 'same-origin', signal: attemptController.signal });
        if (response.status === 401) {
          this.stop();
          for (const listener of this.#unauthorizedListeners) listener();
          return;
        }
        if (response.status === 404) {
          // Route absente (serveur sans flux d'événements) : rien à reprendre, pas de boucle de reconnexion ni de bandeau.
          this.stop();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`flux refusé (HTTP ${response.status})`);
        this.#setStatus('live');
        attempt = 0;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          for (const event of parser.push(value)) this.#dispatch(event);
          if (parser.retryMs !== null) serverRetry = parser.retryMs;
        }
      } catch {
        // coupure réseau, silence du serveur ou refus : on retombe sur la reconnexion ci-dessous
      } finally {
        clearTimeout(idle);
        signal.removeEventListener('abort', abortAttempt);
        attemptController.abort();
      }
      if (signal.aborted) return;
      this.#setStatus('reconnecting');
      await this.#options.sleep(serverRetry ?? this.#options.backoffMs(attempt), signal);
      attempt += 1;
    }
  }

  #dispatch(event: SseEvent): void {
    // Un événement déjà vu (reprise qui chevauche) n'est jamais rejoué.
    if (event.id !== null) {
      // La position de reprise n'avance que sur une trame complète : une trame coupée en route sera renvoyée.
      this.lastEventId = event.id;
      if (!this.#remember(event.id)) return;
    }
    for (const listener of this.#eventListeners) listener(event);
  }
}
