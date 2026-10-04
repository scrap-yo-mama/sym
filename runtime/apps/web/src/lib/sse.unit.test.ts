// SPDX-License-Identifier: AGPL-3.0-only
// Client SSE (06 § 3). `assert_sse_banner_and_resume_last_event_id` : le critère complet (navigateur réel, bandeau sans
// vol de focus) est rejoué en E2E par la tâche 3.6 ; ici, le contrat du client et du bandeau est vérifié sans navigateur.
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createI18n } from 'vue-i18n';
import { describe, expect, test } from 'vitest';
import ConnectionBanner from '@/components/ConnectionBanner.vue';
import en from '@runtime/i18n/locales/en.json';
import { defaultBackoff, EventStreamClient, SseParser, STOP_ON_NOT_FOUND_DEFAULT, type SseEvent, type StreamStatus } from './sse';

const frame = (id: string, data: string, event = 'run.updated') => `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;

/** Réponse SSE dont le flux se ferme après les fragments donnés (ou reste ouvert si `hold`). */
function sseResponse(chunks: string[], options: { hold?: AbortSignal; status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.hold) options.hold.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      else controller.close();
    },
  });
  return new Response(options.status && options.status >= 400 ? null : body, { status: options.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  expect(condition()).toBe(true);
}

describe('SseParser', () => {
  test('assemble des trames coupées en fragments arbitraires et ignore les commentaires', () => {
    const parser = new SseParser();
    const out = [...parser.push(': ping\n\nid: 1\nev'), ...parser.push('ent: run.updated\ndata: {"a"'), ...parser.push(':1}\n\n')];
    expect(out).toEqual([{ id: '1', event: 'run.updated', data: '{"a":1}' }]);
  });

  test('gère CRLF, données multi-lignes, événement par défaut et retry', () => {
    const parser = new SseParser();
    const out = parser.push('retry: 2500\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(out).toEqual([{ id: null, event: 'message', data: 'a\nb' }]);
    expect(parser.retryMs).toBe(2500);
  });

  test('un \\r en fin de fragment attend son \\n et ne produit pas de ligne vide parasite', () => {
    const parser = new SseParser();
    expect(parser.push('data: x\r')).toEqual([]);
    expect(parser.push('\n\r\n')).toEqual([{ id: null, event: 'message', data: 'x' }]);
  });

  test('une trame sans données n’est pas livrée', () => {
    expect(new SseParser().push('id: 7\n\n')).toEqual([]);
  });
});

describe('EventStreamClient', () => {
  test('assert_sse_banner_and_resume_last_event_id : reconnexion avec Last-Event-ID, aucun événement perdu ni rejoué', async () => {
    const calls: Array<Record<string, string>> = [];
    const statuses: StreamStatus[] = [];
    const received: string[] = [];
    const client = new EventStreamClient({
      url: '/api/events',
      sleep: async () => undefined,
      fetch: async (_url, init) => {
        calls.push(init.headers as Record<string, string>);
        // 1re connexion : événements 1 et 2, puis coupure. 2e connexion : le serveur rejoue 2 (chevauchement), puis 3.
        if (calls.length === 1) return sseResponse([frame('1', '"a"'), frame('2', '"b"')]);
        if (calls.length === 2) return sseResponse([frame('2', '"b"'), frame('3', '"c"')], { hold: init.signal as AbortSignal });
        throw new Error('inattendu');
      },
    });
    client.onStatus((status) => statuses.push(status));
    client.onEvent((event) => received.push(`${event.id}:${event.data}`));
    client.start();
    await until(() => received.length === 3);
    expect(received).toEqual(['1:"a"', '2:"b"', '3:"c"']);
    expect(calls[0]).not.toHaveProperty('last-event-id');
    expect(calls[1]?.['last-event-id']).toBe('2');
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting', 'live']);
    client.stop();
    expect(client.status).toBe('stopped');
  });

  test('une trame coupée en route n’avance pas la position de reprise', async () => {
    const calls: Array<Record<string, string>> = [];
    const received: SseEvent[] = [];
    const client = new EventStreamClient({
      url: '/api/events',
      sleep: async () => undefined,
      fetch: async (_url, init) => {
        calls.push(init.headers as Record<string, string>);
        if (calls.length === 1) return sseResponse([frame('1', '"a"'), 'id: 2\nevent: run.updated\ndata: "b']);
        return sseResponse([frame('2', '"b"')], { hold: init.signal as AbortSignal });
      },
    });
    client.onEvent((event) => received.push(event));
    client.start();
    await until(() => received.length === 2);
    expect(calls[1]?.['last-event-id']).toBe('1');
    expect(received.map((event) => event.id)).toEqual(['1', '2']);
    client.stop();
  });

  test('une réponse 401 arrête le flux sans reconnexion et prévient l’appelant', async () => {
    let calls = 0;
    let unauthorized = 0;
    const client = new EventStreamClient({
      url: '/api/events',
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        return sseResponse([], { status: 401 });
      },
    });
    client.onUnauthorized(() => (unauthorized += 1));
    client.start();
    await until(() => client.status === 'stopped');
    await tick();
    expect(calls).toBe(1);
    expect(unauthorized).toBe(1);
  });

  test('avec stopOnNotFound, une route absente (404) arrête le flux sans reconnexion ni bandeau', async () => {
    let calls = 0;
    const statuses: StreamStatus[] = [];
    const client = new EventStreamClient({
      url: '/api/events',
      stopOnNotFound: true,
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        return sseResponse([], { status: 404 });
      },
    });
    client.onStatus((status) => statuses.push(status));
    client.start();
    await until(() => client.status === 'stopped');
    await tick();
    expect(calls).toBe(1);
    expect(statuses).toEqual(['connecting', 'stopped']);
  });

  test('une fois /api/events livré (3.1), une 404 est une coupure : bandeau et reconnexion, pas un arrêt silencieux', async () => {
    let calls = 0;
    const statuses: StreamStatus[] = [];
    const client = new EventStreamClient({
      url: '/api/events',
      stopOnNotFound: false,
      sleep: async () => undefined,
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) return sseResponse([], { status: 404 });
        return sseResponse([frame('1', '"a"')], { hold: init.signal as AbortSignal });
      },
    });
    client.onStatus((status) => statuses.push(status));
    client.start();
    await until(() => client.status === 'live');
    expect(calls).toBe(2);
    expect(statuses).toEqual(['connecting', 'reconnecting', 'live']);
    client.stop();
  });

  test('par défaut, la 404 est une coupure (GET /api/events livré par 3.1)', () => {
    // Lien avec le registre des routes : voir tests/openapi-client.contract.test.ts (STOP_ON_NOT_FOUND_DEFAULT).
    expect(typeof STOP_ON_NOT_FOUND_DEFAULT).toBe('boolean');
  });

  test('un refus 503 déclenche une reconnexion avec attente croissante, puis la reprise', async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = new EventStreamClient({
      url: '/api/events',
      sleep: async (ms) => void waits.push(ms),
      fetch: async (_url, init) => {
        calls += 1;
        if (calls <= 2) return sseResponse([], { status: 503 });
        return sseResponse([frame('1', '"a"')], { hold: init.signal as AbortSignal });
      },
    });
    client.start();
    await until(() => client.status === 'live');
    expect(waits).toEqual([defaultBackoff(0), defaultBackoff(1)]);
    expect(defaultBackoff(10)).toBe(30_000);
    client.stop();
  });

  test('un silence plus long que le délai coupe le flux et reconnecte (ping manquant)', async () => {
    const calls: number[] = [];
    const client = new EventStreamClient({
      url: '/api/events',
      idleTimeoutMs: 20,
      sleep: async () => undefined,
      fetch: async (_url, init) => {
        calls.push(Date.now());
        return sseResponse([': ping\n\n'], { hold: init.signal as AbortSignal });
      },
    });
    client.start();
    await until(() => calls.length >= 2);
    client.stop();
  });

  test('stop() oublie la position de reprise : un autre compte ne reçoit pas le Last-Event-ID du précédent', async () => {
    const headers: Array<Record<string, string>> = [];
    const client = new EventStreamClient({
      url: '/api/events',
      sleep: async () => undefined,
      fetch: async (_url, init) => {
        headers.push(init.headers as Record<string, string>);
        return sseResponse([frame('9', '"a"')], { hold: init.signal as AbortSignal });
      },
    });
    const received: SseEvent[] = [];
    client.onEvent((event) => received.push(event));
    client.start();
    await until(() => received.length === 1);
    client.stop();
    client.start();
    await until(() => received.length === 2);
    expect(headers[1]).not.toHaveProperty('last-event-id');
    client.stop();
  });
});

describe('ConnectionBanner', () => {
  async function render(status: StreamStatus): Promise<string> {
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
    return renderToString(createSSRApp({ render: () => h(ConnectionBanner, { status }) }).use(i18n));
  }

  test('le bandeau n’apparaît que pendant la reconnexion, dans une région status qui ne prend pas le focus', async () => {
    for (const status of ['idle', 'connecting', 'live', 'stopped'] as const) {
      const html = await render(status);
      expect(html).toContain('role="status"');
      expect(html).not.toContain(en.stream.reconnecting);
    }
    const html = await render('reconnecting');
    expect(html).toContain('role="status"');
    expect(html).toContain(en.stream.reconnecting);
    expect(html).not.toMatch(/tabindex|autofocus|role="alert"/);
  });

  // Ce rendu SSR ne prouve pas l'absence de vol de focus. Le contrôle navigateur est porté par la tâche 3.6
  // (tests/invariants.json, `assert_sse_banner_and_resume_last_event_id`).
  test.todo('3.6 : en navigateur, document.activeElement est inchangé pendant l’affichage puis la disparition du bandeau');
});
