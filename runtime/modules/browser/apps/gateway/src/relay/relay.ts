// SPDX-License-Identifier: AGPL-3.0-only
// Relais WSS public de la passerelle (cdc/sym-browser 04 § 8, 04f § 2 à § 4, tâche 2.3) : `/v1/sessions/{id}/playwright` et
// `/v1/sessions/{id}/cdp`. Tout se décide dans `preValidation`, AVANT l'upgrade et avant tout contact avec le nœud (BINV7) :
//   1. secret : jeton court en query `token` OU en `Authorization: Bearer` (jeton de session ou clé d'API) ;
//   2. résolveur : session du bon client, `running`, protocole servi (CDP sur shared : 409), nœud porteur ;
//   3. `/playwright` : version du client Playwright (`User-Agent`) = version servie en majeure.mineure, sinon 428.
// Puis relais vers le nœud propriétaire (`WS /internal/sessions/{id}/{protocole}`, `Authorization: Bearer {NODE_TOKEN}` ; le
// secret du client n'est jamais transmis) : messages transmis sans modification (réécritures : nœud), codes de fermeture
// propagés dans les deux sens, ping toutes les 20 s et fermeture 1001 après deux pongs manquants, messages plafonnés
// (`SYMB_CDP_MAX_MESSAGE_BYTES`, fermeture 1009), nœud injoignable : 1011. Fermer la WebSocket ne libère pas la session.
import { sendableCloseCode } from '@sym-browser/core';
import { BROWSER_ENGINE } from '@sym/contracts/browser';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { ApiProblem, preferredLanguage } from '../api/errors.js';

type RelayProtocol = 'playwright' | 'cdp';

export type RelayAuthorization = { ok: true; nodeUrl: string; sessionId: string } | { ok: false; problem: ApiProblem };

export interface RelayResolver {
  /** `secret` : jeton de session ou clé d'API reçu par le client ; `null` s'il n'en a donné aucun. */
  authorize(input: { sessionId: string; protocol: RelayProtocol; secret: string | null }): Promise<RelayAuthorization>;
}

export type RelayOptions = {
  resolver: RelayResolver;
  /** Secret partagé passerelle ↔ nœud (`NODE_TOKEN`). */
  nodeToken: string;
  /** Période du ping (04 § 8 : 20 s). */
  pingIntervalMs?: number;
  /** Taille maximale d'un message relayé (`SYMB_CDP_MAX_MESSAGE_BYTES`, 100 Mio). */
  cdpMaxMessageBytes?: number;
  onError?: (error: unknown) => void;
};

declare module 'fastify' {
  interface FastifyRequest {
    relayTarget?: { nodeUrl: string; sessionId: string };
  }
}

const SERVED_MINOR = BROWSER_ENGINE.playwright.split('.').slice(0, 2).join('.');

/** Version du client Playwright lue dans `User-Agent: Playwright/1.63.0 (…)` : même majeure.mineure exigée (04 § 8). */
function playwrightClientAccepted(userAgent: string | undefined): boolean {
  const match = /^Playwright\/(\d+)\.(\d+)\.\d+/.exec(userAgent ?? '');
  return match !== null && `${match[1]}.${match[2]}` === SERVED_MINOR;
}

function secretOf(request: FastifyRequest): string | null {
  const token = (request.query as Record<string, unknown>)['token'];
  if (typeof token === 'string' && token !== '') return token;
  const header = request.headers.authorization;
  const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
  return bearer ?? null;
}

export async function registerRelay(app: FastifyInstance, options: RelayOptions): Promise<void> {
  const pingIntervalMs = options.pingIntervalMs ?? 20_000;
  const maxPayload = options.cdpMaxMessageBytes ?? 104_857_600;
  const onError = options.onError ?? (() => undefined);
  await app.register(fastifyWebsocket, { options: { maxPayload, perMessageDeflate: false } });

  const fail = (request: FastifyRequest, reply: FastifyReply, problem: ApiProblem): FastifyReply => {
    if (problem.retryAfter !== undefined) reply.header('retry-after', String(problem.retryAfter));
    reply.header('x-request-id', request.id);
    return reply.code(problem.status).send(problem.body(request.id, preferredLanguage(request.headers['accept-language'])));
  };

  const route = (protocol: RelayProtocol): void => {
    app.get(
      `/v1/sessions/:id/${protocol}`,
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const sessionId = (request.params as { id: string }).id;
          const decision = await options.resolver.authorize({ sessionId, protocol, secret: secretOf(request) });
          if (!decision.ok) return fail(request, reply, decision.problem);
          if (protocol === 'playwright' && !playwrightClientAccepted(request.headers['user-agent'])) {
            return fail(request, reply, new ApiProblem('playwright_version_mismatch', `Playwright client ${SERVED_MINOR}.x required.`, { details: { served: BROWSER_ENGINE.playwright } }));
          }
          request.relayTarget = { nodeUrl: decision.nodeUrl, sessionId: decision.sessionId };
          return undefined;
        },
      },
      (client, request) => {
        const target = request.relayTarget;
        if (!target) return client.close(1011, 'relais sans cible');
        const nodeWs = `${target.nodeUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/internal/sessions/${encodeURIComponent(target.sessionId)}/${protocol}`;
        const upstream = new WebSocket(nodeWs, { headers: { authorization: `Bearer ${options.nodeToken}` }, maxPayload, perMessageDeflate: false });
        const queue: { data: RawData; binary: boolean }[] = [];
        let closing = false;
        let missedPongs = 0;

        const closeBoth = (code: number, reason = ''): void => {
          if (closing) return;
          closing = true;
          clearInterval(ping);
          const sendable = sendableCloseCode(code);
          if (client.readyState === WebSocket.OPEN) client.close(sendable, reason.slice(0, 120));
          if (upstream.readyState === WebSocket.OPEN) upstream.close(sendable, reason.slice(0, 120));
          else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
        };

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
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else queue.push({ data, binary });
        });
        client.on('close', (code, reason) => closeBoth(code, reason.toString()));
        client.on('error', (error) => {
          onError(error);
          closeBoth(1011);
        });

        upstream.on('open', () => {
          for (const { data, binary } of queue.splice(0)) upstream.send(data, { binary });
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
}
