// SPDX-License-Identifier: AGPL-3.0-only
// Relais WSS public de la passerelle (cdc/sym-browser 04 § 8, 04f § 2 à § 4, tâche 2.3) : `/v1/sessions/{id}/playwright` et
// `/v1/sessions/{id}/cdp`. Tout se décide dans `preValidation`, AVANT l'upgrade et avant tout contact avec le nœud (BINV7) :
//   1-2. résolveur : décision de la tâche 2.1 (`authorizeConnection` : jeton court en query `token` ou en
//        `Authorization: Bearer`, ou clé d'API en Bearer ; session du bon client, `running`), puis protocole servi (CDP
//        sur shared : 409) et nœud porteur ;
//   3. `/playwright` : version du client Playwright (`User-Agent`) = version servie en majeure.mineure, sinon 428.
// Puis relais vers le nœud propriétaire (`WS /internal/sessions/{id}/{protocole}`, `Authorization: Bearer {NODE_TOKEN}` ; le
// secret du client n'est jamais transmis) : messages transmis sans modification (réécritures : nœud), codes de fermeture
// propagés dans les deux sens, ping toutes les 20 s et fermeture 1001 après deux pongs manquants, messages plafonnés
// (`SYMB_CDP_MAX_MESSAGE_BYTES`, fermeture 1008, 04f § 4), nœud injoignable : 1011. Fermer la WebSocket ne libère pas la
// session.
// Découverte (tâche 2.8, F5) : `GET /v1/sessions/{id}/cdp/json/version`, mêmes contrôles que l'upgrade `/cdp`, rend les
// champs de `/json/version` de Chromium (lus par le nœud, liste blanche) et un `webSocketDebuggerUrl` de la passerelle à
// jeton neuf : un client qui découvre son point (Puppeteer `browserURL`, Chrome DevTools MCP `--browserUrl`) ne voit
// jamais le point local du nœud.
// Vue en direct (tâche 3.2, 04d § 1.1) : `/v1/sessions/{id}/live/stream?t=<jeton de vue>`, jeton vérifié de la même façon
// avant l'upgrade (seul secret accepté : la query `t`), relais vers `/internal/sessions/{id}/live` avec le mode du jeton
// (`x-symb-live-mode`) ; le jeton du visionneur n'est jamais transmis au nœud.
// Arrêt de la passerelle (SIGTERM, 04b § 9, tâche 2.7) : hook `preClose`, chaque relais ouvert est fermé en 1012 (redémarrage
// du service) des deux côtés ; les sessions continuent sur leurs nœuds, le client se reconnecte par une autre passerelle.
import { sendableCloseCode } from '@sym-browser/core';
import { BROWSER_ENGINE } from '@sym/contracts/browser';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { ApiProblem, preferredLanguage } from '../api/errors.js';

type RelayProtocol = 'playwright' | 'cdp' | 'live';

export type RelayAuthorization = { ok: true; nodeUrl: string; sessionId: string; liveMode?: 'ro' | 'rw'; notAfter?: Date } | { ok: false; problem: ApiProblem };

export interface RelayResolver {
  /** En-têtes et query de la demande d'upgrade, tels que reçus (seuls `authorization`, `token` et, pour `live`, `t` sont lus). */
  authorize(input: {
    sessionId: string;
    protocol: RelayProtocol;
    headers: { authorization?: string | string[] | undefined };
    query: { token?: string | string[] | undefined; t?: string | string[] | undefined };
  }): Promise<RelayAuthorization>;
}

export type RelayOptions = {
  resolver: RelayResolver;
  /** Secret partagé passerelle ↔ nœud (`NODE_TOKEN`). */
  nodeToken: string;
  /** Période du ping (04 § 8 : 20 s). */
  pingIntervalMs?: number;
  /** Taille maximale d'un message relayé (`SYMB_CDP_MAX_MESSAGE_BYTES`, 100 Mio). */
  cdpMaxMessageBytes?: number;
  /** Point WebSocket CDP public d'une session, à jeton neuf (`json/version`) ; absent : découverte non servie. */
  cdpWebSocketUrl?: (sessionId: string, notAfter: Date | undefined, request: FastifyRequest) => string | Promise<string>;
  onError?: (error: unknown) => void;
};

declare module 'fastify' {
  interface FastifyRequest {
    relayTarget?: { nodeUrl: string; sessionId: string; liveMode?: 'ro' | 'rw' };
  }
}

const SERVED_MINOR = BROWSER_ENGINE.playwright.split('.').slice(0, 2).join('.');
/** Champs de `/json/version` rendus au client (liste blanche, 04f § 2). */
const VERSION_FIELDS = ['Browser', 'Protocol-Version', 'User-Agent', 'V8-Version', 'WebKit-Version', 'Android-Package'] as const;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** Délai d'ouverture de la connexion vers le nœud ; au-delà, 1011 (nœud injoignable). */
const NODE_HANDSHAKE_MS = 10_000;

const sizeOf = (data: RawData): number => (Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length);

/** Version du client Playwright lue dans `User-Agent: Playwright/1.63.0 (…)` : même majeure.mineure exigée (04 § 8). */
function playwrightClientAccepted(userAgent: string | undefined): boolean {
  const match = /^Playwright\/(\d+)\.(\d+)\.\d+/.exec(userAgent ?? '');
  return match !== null && `${match[1]}.${match[2]}` === SERVED_MINOR;
}

export async function registerRelay(app: FastifyInstance, options: RelayOptions): Promise<void> {
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const maxMessageBytes = options.cdpMaxMessageBytes ?? 104_857_600;
  // Plafond dur de la bibliothèque (1009) bien au-dessus : entre les deux, le relais ferme lui-même en 1008 (04f § 4).
  const maxPayload = maxMessageBytes + Math.max(maxMessageBytes, 1_048_576);
  const onError = options.onError ?? (() => undefined);
  // Relais ouverts : fermés en 1012 à l'arrêt. Hook posé AVANT celui de @fastify/websocket, qui fermerait sans code.
  const open = new Set<(code: number, reason?: string) => void>();
  app.addHook('preClose', async () => {
    for (const close of [...open]) close(1012, 'arrêt de la passerelle');
  });
  await app.register(fastifyWebsocket, { options: { maxPayload, perMessageDeflate: false } });

  const fail = (request: FastifyRequest, reply: FastifyReply, problem: ApiProblem): FastifyReply => {
    if (problem.retryAfter !== undefined) reply.header('retry-after', String(problem.retryAfter));
    reply.header('x-request-id', request.id);
    return reply.code(problem.status).send(problem.body(request.id, preferredLanguage(request.headers['accept-language'])));
  };

  const decide = (request: FastifyRequest, protocol: RelayProtocol): Promise<RelayAuthorization> => {
    const query = request.query as Record<string, unknown>;
    const text = (value: unknown): string | string[] | undefined => (typeof value === 'string' || Array.isArray(value) ? (value as string | string[]) : undefined);
    return options.resolver.authorize({
      sessionId: (request.params as { id: string }).id,
      protocol,
      headers: { authorization: request.headers.authorization },
      query: protocol === 'live' ? { t: text(query['t']) } : { token: text(query['token']) },
    });
  };

  const cdpWebSocketUrl = options.cdpWebSocketUrl;
  if (cdpWebSocketUrl) {
    app.get('/v1/sessions/:id/cdp/json/version', async (request, reply) => {
      const decision = await decide(request, 'cdp');
      if (!decision.ok) return fail(request, reply, decision.problem);
      const url = `${decision.nodeUrl.replace(/\/+$/, '')}/internal/sessions/${encodeURIComponent(decision.sessionId)}/cdp/json/version`;
      let response: Response;
      try {
        response = await fetch(url, { headers: { authorization: `Bearer ${options.nodeToken}` }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      } catch (error) {
        onError(error);
        return fail(request, reply, new ApiProblem('no_node', 'Session node unreachable.', { retryAfter: 1 }));
      }
      if (response.status === 409) return fail(request, reply, new ApiProblem('protocol_not_served', 'CDP is served for dedicated sessions only.'));
      if (!response.ok) return fail(request, reply, new ApiProblem('no_node', 'Session node unavailable.', { retryAfter: 1 }));
      const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const fields = Object.fromEntries(VERSION_FIELDS.filter((k) => typeof raw[k] === 'string').map((k) => [k, raw[k]]));
      reply.header('x-request-id', request.id).header('cache-control', 'no-store');
      return { ...fields, webSocketDebuggerUrl: await cdpWebSocketUrl(decision.sessionId, decision.notAfter, request) };
    });
  }

  const route = (protocol: RelayProtocol): void => {
    app.get(
      protocol === 'live' ? '/v1/sessions/:id/live/stream' : `/v1/sessions/:id/${protocol}`,
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const decision = await decide(request, protocol);
          if (!decision.ok) return fail(request, reply, decision.problem);
          if (protocol === 'playwright' && !playwrightClientAccepted(request.headers['user-agent'])) {
            return fail(request, reply, new ApiProblem('playwright_version_mismatch', `Playwright client ${SERVED_MINOR}.x required.`, { details: { served: BROWSER_ENGINE.playwright } }));
          }
          request.relayTarget = { nodeUrl: decision.nodeUrl, sessionId: decision.sessionId, ...(protocol === 'live' ? { liveMode: decision.liveMode === 'rw' ? 'rw' : 'ro' } : {}) };
          return undefined;
        },
      },
      (client, request) => {
        const target = request.relayTarget;
        if (!target) return client.close(1011, 'relais sans cible');
        const nodeWs = `${target.nodeUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/internal/sessions/${encodeURIComponent(target.sessionId)}/${protocol}`;
        const headers: Record<string, string> = { authorization: `Bearer ${options.nodeToken}` };
        if (target.liveMode !== undefined) headers['x-symb-live-mode'] = target.liveMode;
        const upstream = new WebSocket(nodeWs, { headers, maxPayload, perMessageDeflate: false, handshakeTimeout: NODE_HANDSHAKE_MS });
        // Audit 5.3 S13 : avant l'ouverture vers le nœud, l'attente est bornée à un plafond de message (sinon 1008).
        const queue: { data: RawData; binary: boolean }[] = [];
        let queuedBytes = 0;
        let closing = false;
        let missedPongs = 0;

        const closeBoth = (code: number, reason = ''): void => {
          if (closing) return;
          closing = true;
          open.delete(closeBoth);
          clearInterval(ping);
          const sendable = sendableCloseCode(code);
          if (client.readyState === WebSocket.OPEN) client.close(sendable, reason.slice(0, 120));
          if (upstream.readyState === WebSocket.OPEN) upstream.close(sendable, reason.slice(0, 120));
          else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        };

        open.add(closeBoth);

        // Ping toutes les `pingIntervalMs` ; deux pongs manquants : fermeture 1001 (04 § 8).
        const ping = setInterval(() => {
          if (missedPongs >= 2) return closeBoth(1001, 'pong manquant');
          missedPongs += 1;
          if (client.readyState === WebSocket.OPEN) client.ping();
        }, pingIntervalMs);
        ping.unref();
        client.on('pong', () => {
          missedPongs = 0;
        });

        client.on('message', (data: RawData, binary: boolean) => {
          if (closing) return;
          if (sizeOf(data) > maxMessageBytes) return closeBoth(1008, 'message au-delà du plafond');
          if (upstream.readyState === WebSocket.OPEN) return upstream.send(data, { binary });
          queuedBytes += sizeOf(data);
          if (queuedBytes > maxMessageBytes) return closeBoth(1008, 'file d’attente au-delà du plafond');
          queue.push({ data, binary });
        });
        client.on('close', (code, reason) => closeBoth(code, reason.toString()));
        client.on('error', (error) => {
          onError(error);
          closeBoth(1011);
        });

        upstream.on('open', () => {
          for (const { data, binary } of queue.splice(0)) upstream.send(data, { binary });
          queuedBytes = 0;
        });
        upstream.on('message', (data: RawData, binary: boolean) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        upstream.on('unexpected-response', (_req, res) => {
          res.resume();
          closeBoth(1011, `nœud : ${res.statusCode ?? 0}`);
        });
        upstream.on('close', (code, reason) => closeBoth(code, reason.toString()));
        upstream.on('error', (error) => {
          onError(error);
          closeBoth(1011, 'nœud injoignable');
        });
        return undefined;
      },
    );
  };
  route('playwright');
  route('cdp');
  route('live');
}
