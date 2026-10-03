// SPDX-License-Identifier: AGPL-3.0-only
// Envoi d'un webhook sous la garde réseau de l'egress (04c § 1.2, réutilisée par la tâche 2.5) : schéma http(s) seul, sans
// identifiants dans l'URL, nom résolu une fois (adresse publique ou SYMB_PRIVATE_HOSTS, jamais les classes dures), connexion
// sur l'adresse épinglée (`lookup`), adresse distante du socket recontrôlée, aucune redirection suivie (une 3xx est une
// réponse, donc un échec de livraison). Contrôle refait à chaque envoi : un rebinding entre l'enregistrement et l'envoi est
// refusé. Délai borné ; la réponse n'est pas lue au-delà de son statut.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction, Socket } from 'node:net';
import { EgressDeniedError, normalizeHostname, type EgressGuard } from '@sym-browser/core';

export type WebhookUrlProblem = 'scheme' | 'credentials' | 'address_not_public' | 'unresolvable';

/** URL de webhook refusée (motif repris dans `details` de la 422, ou dans `last_error` d'une livraison). */
export class WebhookUrlError extends Error {
  override name = 'WebhookUrlError';
  readonly reason: WebhookUrlProblem;
  constructor(reason: WebhookUrlProblem) {
    super(`URL de webhook refusée : ${reason}`);
    this.reason = reason;
  }
}

/** Contrôles statiques puis résolution unique ; rend l'URL et l'adresse épinglée. */
export async function checkWebhookUrl(raw: string, guard: EgressGuard): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('scheme');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebhookUrlError('scheme');
  if (url.username !== '' || url.password !== '') throw new WebhookUrlError('credentials');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  try {
    const pinned = await guard.resolve(url.hostname, port);
    return { url, address: pinned.address, family: pinned.family };
  } catch (error) {
    if (error instanceof EgressDeniedError) throw new WebhookUrlError(error.reason === 'unresolvable' ? 'unresolvable' : 'address_not_public');
    throw error;
  }
}

export type WebhookResult = { status: number } | { error: WebhookUrlProblem | 'timeout' | 'network' };

export async function sendWebhook(input: { url: string; guard: EgressGuard; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<WebhookResult> {
  let target: Awaited<ReturnType<typeof checkWebhookUrl>>;
  try {
    target = await checkWebhookUrl(input.url, input.guard);
  } catch (error) {
    if (error instanceof WebhookUrlError) return { error: error.reason };
    throw error;
  }
  const { url, address, family } = target;
  const host = normalizeHostname(url.hostname);
  // Résolution figée : le socket s'ouvre sur l'adresse validée, jamais sur une nouvelle résolution.
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all === true) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<WebhookResult>((resolve) => {
    let settled = false;
    const done = (result: WebhookResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        lookup,
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(input.body)), 'user-agent': 'sym-browser-webhooks', ...input.headers },
      },
      (res: IncomingMessage) => {
        done({ status: res.statusCode ?? 0 });
        res.resume();
        res.destroy();
      },
    );
    req.setTimeout(input.timeoutMs, () => {
      req.destroy();
      done({ error: 'timeout' });
    });
    req.on('socket', (socket: Socket) => {
      const check = (): void => {
        try {
          input.guard.checkAddress(host, socket.remoteAddress ?? '');
        } catch {
          req.destroy();
          done({ error: 'address_not_public' });
        }
      };
      if (socket.connecting) socket.once('connect', check);
      else check();
    });
    req.on('error', () => done({ error: 'network' }));
    req.end(input.body);
  });
}
