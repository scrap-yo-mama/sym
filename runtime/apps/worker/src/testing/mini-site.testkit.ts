// SPDX-License-Identifier: AGPL-3.0-only
// Sites de test de l'enquête (tâche 2.1, correctifs de vérification) : un serveur http local à hôtes virtuels
// (`zz_test_*.localhost` et leurs sous-domaines, résolus en 127.0.0.1 par `fixtureGuard`), et une extension simulée
// (`TunnelPort`) qui sert `page_fetch` depuis le même site, sans réseau. Aucun site réel n'est jamais contacté.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TunnelOutcome, TunnelPort } from '../tunnel/client.js';

export type MiniRequest = { readonly host: string; readonly path: string; readonly query: URLSearchParams; readonly method: string; readonly body: string; readonly n: number };
export type MiniResponse = { readonly status?: number; readonly headers?: Record<string, string>; readonly body?: string; readonly delayMs?: number };
export type MiniHandler = (req: MiniRequest) => MiniResponse | undefined | Promise<MiniResponse | undefined>;

export type MiniSite = {
  readonly port: number;
  /** Requêtes reçues (par le réseau ou par l'extension simulée), dans l'ordre. */
  readonly hits: { readonly host: string; readonly path: string; readonly via: 'http' | 'tunnel' }[];
  url(host: string, path?: string): string;
  /** Réponse du site à une requête (partagée par le serveur http et l'extension simulée). */
  answer(url: string, method: string, body: string, via: 'http' | 'tunnel'): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  reset(): void;
  close(): Promise<void>;
};

export async function startMiniSite(handler: MiniHandler): Promise<MiniSite> {
  const hits: { host: string; path: string; via: 'http' | 'tunnel' }[] = [];
  const counts = new Map<string, number>();
  let port = 0;
  const answer = async (url: string, method: string, body: string, via: 'http' | 'tunnel') => {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    hits.push({ host, path: u.pathname, via });
    const key = `${host}${u.pathname}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const res = (await handler({ host, path: u.pathname, query: u.searchParams, method, body, n })) ?? { status: 404, body: 'not found' };
    if (res.delayMs !== undefined) await new Promise((r) => setTimeout(r, res.delayMs));
    return { status: res.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...res.headers }, body: res.body ?? '' };
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      answer(`http://${host}:${port}${req.url ?? '/'}`, req.method ?? 'GET', Buffer.concat(chunks).toString('utf8'), 'http')
        .then((out) => {
          res.writeHead(out.status, out.headers);
          res.end(out.body);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (host, path = '/') => `http://${host}:${port}${path}`,
    answer,
    reset: () => {
      hits.length = 0;
      counts.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Extension simulée : `page_fetch` servi par le site de test (jamais par le réseau du serveur). `offlineWhen(p)` :
 * l'extension se déconnecte dès qu'une commande vérifie `p` (elle et toutes les suivantes → `tunnel_offline`).
 */
export function miniTunnel(site: MiniSite): TunnelPort & { sent: { cmd: string; url: string }[]; offlineWhen(p: ((cmd: string, url: string) => boolean) | null): void } {
  const sent: { cmd: string; url: string }[] = [];
  let when: ((cmd: string, url: string) => boolean) | null = null;
  let offline = false;
  return {
    sent,
    offlineWhen(p) {
      when = p;
      offline = false;
    },
    async send(input): Promise<TunnelOutcome> {
      const args = input.args as { url?: string; method?: string; body?: string };
      const url = typeof args.url === 'string' ? args.url : '';
      if (offline || (when !== null && when(input.cmd, url))) {
        offline = true;
        return { kind: 'error', error: 'tunnel_offline' };
      }
      sent.push({ cmd: input.cmd, url });
      if (input.cmd !== 'page_fetch' || url === '') return { kind: 'error', error: 'method_not_allowed' };
      const out = await site.answer(url, (args.method ?? 'GET').toUpperCase(), typeof args.body === 'string' ? args.body : '', 'tunnel');
      return { kind: 'result', result: { ok: true, error: null, ms: 1, snapshot_id: null, body: { status: out.status, headers: out.headers, body: out.body, url } } };
    },
  };
}
