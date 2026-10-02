// SPDX-License-Identifier: AGPL-3.0-only
// Relais interne du nœud (cdc/sym-browser 04b § 8, 04f § 4, tâche 2.3) : `WS /internal/sessions/{id}/{playwright|cdp}`,
// ouvert par la passerelle seule. Ordre des contrôles, avant toute lecture et toute connexion vers Chromium :
//   1. `Authorization: Bearer {NODE_TOKEN}`, comparé à temps constant (P12 : 401 sinon) ;
//   2. protocole servi (`playwright`, `cdp`) ; session tenue par ce nœud (404 sinon) ; CDP sur une session shared : 409
//      `protocol_not_served` (04f § 2, BINV1).
// Puis relais vers le point local de Chromium (WebSocket Playwright de `launchServer`, ou CDP sur 127.0.0.1) : chaque
// message du client passe par les réécritures (rewrite.ts) et compte comme activité (délai d'inactivité, tâche 1.2) ; les
// messages du navigateur reviennent tels quels ; les codes de fermeture se propagent ; au-delà de `maxMessageBytes`,
// fermeture 1009. La déconnexion du client ne libère pas la session (04 § 8) ; seul `Browser.close` le fait.
// Vue en direct (tâche 3.2, 04d § 1.2) : `WS /internal/sessions/{id}/live`, après le même contrôle du jeton de nœud ; le
// visionneur est rattaché à la `LiveView` de la session dans le mode annoncé par la passerelle (`x-symb-live-mode`, qui a
// vérifié le jeton de vue) : `rw` seulement s'il est annoncé, lecture seule sinon.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { sendableCloseCode } from '@sym-browser/core';
import type { SessionType } from '@sym/contracts/browser';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { attachLiveSocket, type LiveView } from '../live/index.js';
import { rewriteCdpMessage, rewritePlaywrightMessage, type RewriteContext, type RewriteResult } from './rewrite.js';

/** Points locaux d'une session tenue par ce nœud (pool 1.1, sessions 1.3 et 1.4, egress 1.5). */
export type NodeSessionEndpoints = {
  type: SessionType;
  /** WebSocket Playwright local (`launchServer`). */
  playwright: string;
  /** Point CDP local (`ws://127.0.0.1:…/devtools/browser/…`) ; `null` pour une session shared. */
  cdp: string | null;
  egressProxyUrl: string | null;
  downloadsDir: string | null;
  /** Libération de la session (raison `released`), demandée par `Browser.close`. */
  release(): Promise<void>;
};

type NodeSessionDirectory = { get(sessionId: string): NodeSessionEndpoints | undefined };

export type NodeRelayOptions = {
  nodeToken: string;
  sessions: NodeSessionDirectory;
  onActivity?: (sessionId: string) => void;
  /** Taille maximale d'un message (`SYMB_CDP_MAX_MESSAGE_BYTES`, 100 Mio par défaut) ; au-delà, fermeture 1009. */
  maxMessageBytes?: number;
  onError?: (error: unknown) => void;
  /** Vues en direct des sessions de ce nœud (tâche 3.2) ; sans elles, `/live` répond 404. */
  live?: { get(sessionId: string): LiveView | undefined };
};

export type NodeRelay = {
  /** Traite un upgrade sous `/internal/sessions/` ; `false` si le chemin n'est pas celui du relais (l'appelant décide). */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
};

const PATH = /^\/internal\/sessions\/([^/?#]+)\/([^/?#]+)$/;
const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict' };

function refuse(socket: Duplex, status: 401 | 404 | 409, code: string): void {
  const body = JSON.stringify({ error: { code, message: STATUS_TEXT[status], retryable: false } });
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function createNodeRelay(options: NodeRelayOptions): NodeRelay {
  const expected = digest(`Bearer ${options.nodeToken}`);
  const maxPayload = options.maxMessageBytes ?? 104_857_600;
  const onError = options.onError ?? (() => undefined);
  const wss = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const upstreams = new Set<WebSocket>();

  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization;
    return typeof header === 'string' && timingSafeEqual(digest(header), expected);
  };

  function pipe(client: WebSocket, sessionId: string, session: NodeSessionEndpoints, protocol: 'playwright' | 'cdp'): void {
    const endpoint = protocol === 'cdp' ? session.cdp : session.playwright;
    const ctx: RewriteContext = { egressProxyUrl: session.egressProxyUrl, downloadsDir: session.downloadsDir };
    const rewrite = protocol === 'cdp' ? rewriteCdpMessage : rewritePlaywrightMessage;
    const upstream = new WebSocket(endpoint ?? 'ws://127.0.0.1:1/', { maxPayload, perMessageDeflate: false });
    upstreams.add(upstream);
    const queue: string[] = [];
    let closing = false;

    const closeBoth = (code: number, reason = ''): void => {
      if (closing) return;
      closing = true;
      const sendable = sendableCloseCode(code);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(sendable, reason.slice(0, 120));
      if (upstream.readyState === WebSocket.OPEN) upstream.close(sendable, reason.slice(0, 120));
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    };

    const handle = (result: RewriteResult): void => {
      if (result.kind === 'reject') return closeBoth(result.code, result.reason);
      if (result.kind === 'reply') {
        client.send(result.text);
        if (result.release) void session.release().catch(onError);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(result.text);
      else queue.push(result.text);
    };

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (closing) return;
      options.onActivity?.(sessionId);
      if (isBinary) return closeBoth(1007, 'message binaire refusé');
      handle(rewrite(data.toString(), ctx));
    });
    client.on('close', (code, reason) => closeBoth(code, reason.toString()));
    client.on('error', (error) => {
      onError(error);
      closeBoth(1011);
    });

    upstream.on('open', () => {
      for (const text of queue.splice(0)) upstream.send(text);
    });
    upstream.on('message', (data: RawData, isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', (code, reason) => {
      upstreams.delete(upstream);
      closeBoth(code, reason.toString());
    });
    upstream.on('error', (error) => {
      onError(error);
      closeBoth(1011, 'navigateur injoignable');
    });
  }

  return {
    handleUpgrade(request, socket, head) {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (!path.startsWith('/internal/sessions/')) return false;
      // 1. Jeton de nœud, avant toute autre lecture (P12).
      if (!authorized(request)) {
        refuse(socket, 401, 'unauthorized');
        return true;
      }
      const match = PATH.exec(path);
      const protocol = match?.[2];
      const sessionId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
      if (sessionId && protocol === 'live') {
        const view = options.live?.get(sessionId);
        if (!view) {
          refuse(socket, 404, 'session_not_found');
          return true;
        }
        const mode = request.headers['x-symb-live-mode'] === 'rw' ? 'rw' : 'ro';
        wss.handleUpgrade(request, socket, head, (client) => attachLiveSocket(view, client, mode));
        return true;
      }
      if (!sessionId || (protocol !== 'playwright' && protocol !== 'cdp')) {
        refuse(socket, 404, 'session_not_found');
        return true;
      }
      const session = options.sessions.get(sessionId);
      if (!session) {
        refuse(socket, 404, 'session_not_found');
        return true;
      }
      if (protocol === 'cdp' && (session.type !== 'dedicated' || session.cdp === null)) {
        refuse(socket, 409, 'protocol_not_served');
        return true;
      }
      wss.handleUpgrade(request, socket, head, (client) => pipe(client, sessionId, session, protocol));
      return true;
    },
    async close() {
      for (const upstream of upstreams) upstream.terminate();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
