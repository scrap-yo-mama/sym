// SPDX-License-Identifier: AGPL-3.0-only
// Client SSE de test (tâche 2.5) : lit un flux `text/event-stream` par fetch et le découpe en trames (WHATWG HTML § 9.2),
// commentaires (`: ping`) compris. Chaque trame garde son instant de réception (mesure de latence).

export type SseFrame = { id?: string; event: string; data: string; receivedAt: number };

export type SseStream = {
  status: number;
  headers: Headers;
  frames: SseFrame[];
  comments: string[];
  /** Corps d'une réponse d'erreur (JSON) quand le flux n'est pas ouvert. */
  body?: unknown;
  /** Attend une condition sur les trames reçues ; rend les trames à ce moment. */
  waitFor(check: (frames: SseFrame[]) => boolean, ms?: number): Promise<SseFrame[]>;
  /** Résolu à la fin du flux par le serveur. */
  ended: Promise<void>;
  close(): void;
};

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* texte */
    }
    return { status: response.status, headers: response.headers, frames, comments, body, waitFor: async () => frames, ended: Promise.resolve(), close: () => undefined };
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const ended = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const frame: SseFrame = { event: 'message', data: '', receivedAt: Date.now() };
          const data: string[] = [];
          let hasField = false;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) {
              comments.push(line.slice(1).trim());
              continue;
            }
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'data') data.push(value);
            else if (field === 'event') frame.event = value;
            else if (field === 'id') frame.id = value;
            else if (field !== 'retry') continue;
            hasField = true;
          }
          frame.data = data.join('\n');
          if (hasField && (data.length > 0 || frame.id !== undefined)) frames.push(frame);
        }
      }
    } catch {
      // Flux coupé par close() : fin normale du test.
    }
  })();
  return {
    status: response.status,
    headers: response.headers,
    frames,
    comments,
    waitFor: async (check, ms = 5_000) => {
      const end = Date.now() + ms;
      while (!check(frames) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
      return frames;
    },
    ended,
    close: () => controller.abort(),
  };
}

/** Données JSON d'une trame (`SessionEvent` du contrat). */
export const eventOf = <T = { type: string; sessionId: string; at: string; data: Record<string, unknown> }>(frame: SseFrame): T => JSON.parse(frame.data) as T;
