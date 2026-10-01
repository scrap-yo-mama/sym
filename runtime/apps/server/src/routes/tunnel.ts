// SPDX-License-Identifier: AGPL-3.0-only
// Route WSS du tunnel (tâche 2.7, 07 § 6, 08b § 2). Avant l'ouverture : aucun paramètre d'URL (le jeton n'est JAMAIS dans
// l'URL, `assert_ws_token_not_in_url`) et `Origin` d'une extension (`assert_ws_origin_checked`) ; sinon refus HTTP, aucune
// WSS. L'identité vient ensuite du premier message (`hello`), traité par la passerelle.
import type { FastifyInstance } from 'fastify';
import { TUNNEL_PATH } from '@runtime/core/tunnel';
import type { ExtensionOriginPolicy } from '../config.js';
import type { TunnelGateway } from '../tunnel/gateway.js';
import { tunnelOriginAllowed } from '../tunnel/gateway.js';
import { sendError } from './guard.js';

export function tunnelRoutes(app: FastifyInstance, gateway: TunnelGateway, origins: ExtensionOriginPolicy): void {
  app.get(
    TUNNEL_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (request.raw.url?.includes('?')) return sendError(reply, 400, 'token_in_url', 'aucun paramètre d’URL : le jeton part dans le premier message');
        if (!tunnelOriginAllowed(request.headers.origin, origins)) return sendError(reply, 403, 'origin_not_allowed', 'origine refusée');
        if (!request.ws) return sendError(reply, 426, 'upgrade_required', 'WebSocket attendue');
        return undefined;
      },
    },
    (socket, request) => gateway.accept(socket, request.ip),
  );
}
