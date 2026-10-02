// SPDX-License-Identifier: AGPL-3.0-only
// Relais interne du nœud (cdc/sym-browser 04b § 8, 04f § 4, tâche 2.3) : `WS /internal/sessions/{id}/{playwright|cdp}`,
// ouvert par la passerelle seule. Ordre des contrôles, avant toute lecture et toute connexion vers Chromium :
//   1. `Authorization: Bearer {NODE_TOKEN}`, comparé à temps constant (P12 : 401 sinon) ;
//   2. protocole servi (`playwright`, `cdp`) ; session tenue par ce nœud (404 sinon) ; CDP sur une session shared : 409
//      `protocol_not_served` (04f § 2, BINV1).
// Puis relais vers le point local de Chromium (WebSocket Playwright de `launchServer`, ou CDP sur 127.0.0.1) : chaque
// message du client passe par les réécritures (rewrite.ts) et compte comme activité (délai d'inactivité, tâche 1.2) ; les
// messages du navigateur reviennent tels quels ; les codes de fermeture se propagent ; au-delà de `maxMessageBytes`,
// fermeture 1008 (04f § 4 ; plafond dur de la bibliothèque au-delà de plafond + max(plafond, 1 Mio) : 1009). La déconnexion du client ne libère pas la
// session (04 § 8) ; seul `Browser.close` le fait.
// Découverte (tâche 2.8) : `GET /internal/sessions/{id}/cdp/json/version` (mêmes contrôles) rend les champs de
// `/json/version` de Chromium, liste blanche, SANS ses points locaux : la passerelle pose le sien, à jeton neuf (04f § 2).
// Vue en direct (tâche 3.2, 04d § 1.2) : `WS /internal/sessions/{id}/live`, après le même contrôle du jeton de nœud ; le
// visionneur est rattaché à la `LiveView` de la session dans le mode annoncé par la passerelle (`x-symb-live-mode`, qui a
// vérifié le jeton de vue) : `rw` seulement s'il est annoncé, lecture seule sinon.
import { createHash, timingSafeEqual } from 'node:crypto';
import { get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
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
  /** Taille maximale d'un message (`SYMB_CDP_MAX_MESSAGE_BYTES`, 100 Mio par défaut) ; au-delà, fermeture 1008. */
  maxMessageBytes?: number;
  onError?: (error: unknown) => void;
  /** Vues en direct des sessions de ce nœud (tâche 3.2) ; sans elles, `/live` répond 404. */
  live?: { get(sessionId: string): LiveView | undefined };
};

export type NodeRelay = {
  /** Traite un upgrade sous `/internal/sessions/` ; `false` si le chemin n'est pas celui du relais (l'appelant décide). */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Traite `GET /internal/sessions/{id}/cdp/json/version` ; `false` pour toute autre requête. */
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean;
  close(): Promise<void>;
};

/** Identifiant décodé ; `undefined` si l'encodage est invalide (audit 5.3 S06 : jamais d'exception dans l'upgrade). */
function decodeId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** Délai d'ouverture de la connexion vers Chromium (local : quelques millisecondes). */
const UPSTREAM_HANDSHAKE_MS = 10_000;

const PATH = /^\/internal\/sessions\/([^/?#]+)\/([^/?#]+)$/;
const JSON_VERSION_PATH = /^\/internal\/sessions\/([^/?#]+)\/cdp\/json\/version\/?$/;
/** Champs de `/json/version` rendus (liste blanche) : jamais `webSocketDebuggerUrl` ni `devtoolsFrontendUrl` locaux. */
const VERSION_FIELDS = ['Browser', 'Protocol-Version', 'User-Agent', 'V8-Version', 'WebKit-Version', 'Android-Package'] as const;
const DISCOVERY_TIMEOUT_MS = 5_000;

/** Taille d'un message reçu par `ws` (Buffer, ArrayBuffer ou fragments). */
const sizeOf = (data: RawData): number => (Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length);

/** `/json/version` du Chromium local de la session (point CDP en 127.0.0.1), champs de la liste blanche seulement. */
function chromiumVersion(cdpEndpoint: string): Promise<Record<string, string>> {
  const { host } = new URL(cdpEndpoint);
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: host.split(':')[0], port: Number(host.split(':')[1]), path: '/json/version', timeout: DISCOVERY_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          resolve(Object.fromEntries(VERSION_FIELDS.filter((k) => typeof raw[k] === 'string').map((k) => [k, raw[k] as string])));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('json/version : délai dépassé')));
    req.on('error', reject);
  });
}
const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict' };

function refuse(socket: Duplex, status: 401 | 404 | 409, code: string): void {
  const body = JSON.stringify({ error: { code, message: STATUS_TEXT[status], retryable: false } });
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function createNodeRelay(options: NodeRelayOptions): NodeRelay {
  const expected = digest(`Bearer ${options.nodeToken}`);
  const maxMessageBytes = options.maxMessageBytes ?? 104_857_600;
  // Plafond dur de la bibliothèque (1009) bien au-dessus du plafond : entre les deux, le relais ferme lui-même en 1008 (04f § 4).
  const maxPayload = maxMessageBytes + Math.max(maxMessageBytes, 1_048_576);
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
    const upstream = new WebSocket(endpoint ?? 'ws://127.0.0.1:1/', { maxPayload, perMessageDeflate: false, handshakeTimeout: UPSTREAM_HANDSHAKE_MS });
    upstreams.add(upstream);
    // Audit 5.3 S07 : file d'attente avant l'ouverture du navigateur bornée à un plafond de message, sinon 1008.
    const queue: string[] = [];
    let queuedBytes = 0;
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
      if (upstream.readyState === WebSocket.OPEN) return upstream.send(result.text);
      queuedBytes += Buffer.byteLength(result.text);
      if (queuedBytes > maxMessageBytes) return closeBoth(1008, 'file d’attente au-delà du plafond');
      queue.push(result.text);
    };

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (closing) return;
      if (sizeOf(data) > maxMessageBytes) return closeBoth(1008, 'message au-delà du plafond');
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
      queuedBytes = 0;
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
      const sessionId = decodeId(match?.[1]);
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
    handleRequest(request, response) {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const match = JSON_VERSION_PATH.exec(path);
      if (!match || request.method !== 'GET') return false;
      const reply = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
        response.end(text);
      };
      if (!authorized(request)) {
        reply(401, { error: { code: 'unauthorized' } });
        return true;
      }
      const id = decodeId(match[1]);
      const session = id === undefined ? undefined : options.sessions.get(id);
      if (!session) {
        reply(404, { error: { code: 'session_not_found' } });
        return true;
      }
      if (session.type !== 'dedicated' || session.cdp === null) {
        reply(409, { error: { code: 'protocol_not_served' } });
        return true;
      }
      chromiumVersion(session.cdp).then(
        (version) => reply(200, version),
        (error: unknown) => {
          onError(error);
          reply(502, { error: { code: 'browser_unreachable' } });
        },
      );
      return true;
    },
    async close() {
      for (const upstream of upstreams) upstream.terminate();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
