// SPDX-License-Identifier: MIT
// `events()` (04 § 10) : itérateur asynchrone sur le flux SSE `GET /v1/sessions/{id}/events` (une session) ou
// `GET /v1/events` (toutes les sessions du client). Lecture conforme au format `text/event-stream` (champs `id`, `event`,
// `data` sur plusieurs lignes, `retry`, commentaires). Une coupure du flux est reprise avec `Last-Event-ID` ; le flux d'une
// session s'arrête de lui-même après son événement `state` terminal (`ended`, `timed_out`, `failed`). Un `signal`
// d'abandon arrête l'itération sans erreur.
import { TERMINAL_SESSION_STATES, type SessionEvent } from '@sym/contracts/browser';
import { SymBrowserError } from './errors.js';
import type { HttpClient } from './http.js';

export type EventsOptions = {
  signal?: AbortSignal;
  /** Délai avant reprise après une coupure (défaut 1 000 ms, ou la valeur `retry:` du serveur). */
  retryDelayMs?: number;
  /** Reprises consécutives sans aucun événement reçu au-delà desquelles l'itération échoue (défaut 5). */
  maxRetries?: number;
  /** Reprise à partir d'un identifiant d'événement déjà reçu. */
  lastEventId?: string;
};

type RawEvent = { id: string | undefined; event: string; data: string };

/** Découpe un flux `text/event-stream` en événements (spécification HTML, « event stream interpretation »). */
class SseParser {
  #buffer = '';
  #data: string[] = [];
  #event = '';
  #id: string | undefined;
  /** Dernière valeur `retry:` reçue (ms). */
  retry: number | undefined;

  push(chunk: string): RawEvent[] {
    this.#buffer += chunk;
    const out: RawEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.#buffer);
      if (!match) break;
      const line = this.#buffer.slice(0, match.index);
      this.#buffer = this.#buffer.slice(match.index + match[0].length);
      if (line === '') {
        if (this.#data.length > 0) out.push({ id: this.#id, event: this.#event || 'message', data: this.#data.join('\n') });
        this.#data = [];
        this.#event = '';
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') this.#data.push(value);
      else if (field === 'event') this.#event = value;
      else if (field === 'id' && !value.includes('\0')) this.#id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    }
    return out;
  }
}

function toSessionEvent(raw: RawEvent): SessionEvent {
  const value = JSON.parse(raw.data) as Partial<SessionEvent> & Record<string, unknown>;
  return (typeof value.type === 'string' ? value : { ...value, type: raw.event }) as SessionEvent;
}

const isTerminal = (event: SessionEvent): boolean =>
  event.type === 'state' && (TERMINAL_SESSION_STATES as readonly string[]).includes((event.data as { state?: string }).state ?? '');

export async function* streamEvents(http: HttpClient, sessionId: string | undefined, options: EventsOptions = {}): AsyncGenerator<SessionEvent, void, undefined> {
  const path = sessionId === undefined ? '/v1/events' : `/v1/sessions/${encodeURIComponent(sessionId)}/events`;
  let lastEventId = options.lastEventId;
  let retryDelay = options.retryDelayMs ?? 1_000;
  let failures = 0;
  const maxRetries = options.maxRetries ?? 5;

  while (!options.signal?.aborted) {
    const local = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
    let received = false;
    try {
      let response: Response;
      try {
        response = await http.send({ method: 'GET', path, headers: { accept: 'text/event-stream', 'last-event-id': lastEventId }, signal, stream: true });
      } catch (error) {
        if (options.signal?.aborted) return;
        // Erreur typée de l'API (401, 403, 404…) : rendue telle quelle ; réseau : reprise bornée.
        if (!(error instanceof SymBrowserError) || error.code !== 'network_error' || ++failures > maxRetries) throw error;
        await delay(retryDelay, options.signal);
        continue;
      }
      if (!response.body) throw new SymBrowserError({ code: 'http_error', message: `GET ${path} : flux SSE sans corps`, status: response.status });
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const raw of parser.push(decoder.decode(value, { stream: true }))) {
            if (raw.id !== undefined) lastEventId = raw.id;
            const event = toSessionEvent(raw);
            received = true;
            failures = 0;
            yield event;
            if (sessionId !== undefined && isTerminal(event)) return;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) return;
        if (++failures > maxRetries) throw new SymBrowserError({ code: 'network_error', message: `GET ${path} : flux SSE coupé`, retryable: true, cause: error });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // Lecture encore en cours (abandon) : le flux est fermé par l'abandon ci-dessous.
        }
      }
      if (parser.retry !== undefined) retryDelay = parser.retry;
      if (!received && ++failures > maxRetries) throw new SymBrowserError({ code: 'network_error', message: `GET ${path} : flux SSE fermé sans événement`, retryable: true });
    } finally {
      local.abort();
    }
    await delay(retryDelay, options.signal);
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
