// SPDX-License-Identifier: AGPL-3.0-only
// Espion de connexions sortantes du processus de test (INV9) : enregistre chaque `net.Socket#connect` (TCP, donc aussi
// TLS, HTTP et pg) et chaque appel à `fetch`. Sert à prouver qu'une commande locale n'ouvre que la connexion à la base.
import net from 'node:net';

export type SocketSpy = { targets: () => string[]; fetchCalls: () => number; stop: () => void };

function describe(args: unknown[]): string {
  const [first, second] = args;
  if (first !== null && typeof first === 'object') {
    const o = first as { port?: number; host?: string; path?: string };
    return o.path ? `unix:${o.path}` : `${o.host ?? 'localhost'}:${o.port ?? '?'}`;
  }
  if (typeof first === 'number') return `${typeof second === 'string' ? second : 'localhost'}:${first}`;
  return `unix:${String(first)}`;
}

export function spyOnSockets(): SocketSpy {
  const targets: string[] = [];
  let fetches = 0;
  const original = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    targets.push(describe(args));
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetches += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  return {
    targets: () => [...targets],
    fetchCalls: () => fetches,
    stop: () => {
      net.Socket.prototype.connect = original;
      globalThis.fetch = originalFetch;
    },
  };
}

/** `hôte:port` de la base d'une URL PostgreSQL. */
export function dbTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}`;
}
