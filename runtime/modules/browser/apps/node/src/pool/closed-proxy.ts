// SPDX-License-Identifier: AGPL-3.0-only
// Proxy de lancement FERMÉ des Chromium chauds (04c § 1.1, « Branchement shared ») : toute demande reçoit 403
// `egress_closed`, comptée. Rien ne sort d'un Chromium chaud hors d'un contexte de session, qui recevra l'egress de sa session
// (tâches 1.3 et 1.5). Version minimale de la tâche 1.1 : l'egress de session (1.5, `packages/core`) la reprendra avec ses
// compteurs et sa journalisation.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ClosedLaunchProxy = {
  /** `http://127.0.0.1:<port>` : seule forme acceptée par `chromiumLaunchOptions`. */
  readonly url: string;
  /** Demandes refusées depuis le démarrage. */
  refused(): number;
  close(): Promise<void>;
};

const BODY = JSON.stringify({ error: 'egress_closed' });

export async function startClosedLaunchProxy(): Promise<ClosedLaunchProxy> {
  let refused = 0;
  const server: Server = createServer((request, response) => {
    refused += 1;
    request.resume();
    response.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(BODY), connection: 'close' });
    response.end(BODY);
  });
  server.on('connect', (_request, socket) => {
    refused += 1;
    socket.on('error', () => undefined);
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(BODY)}\r\nconnection: close\r\n\r\n${BODY}`);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
