// SPDX-License-Identifier: AGPL-3.0-only
// E1 `fetch` (tâche 1.6 ; 04 §3.1) : requête HTTP par la couche réseau de l'essai (garde SSRF, barreau N1-N3, coût
// proxy), extraction déclarative. Corps lu en flux avec plafond (`max_response_bytes`) : une réponse trop grosse est
// coupée avant d'être chargée en mémoire.
import { DslError } from '../dsl/errors.js';
import type { RenderedRequest } from '../dsl/template.js';
import type { NetworkSession } from '../net/modes/session.js';
import { decodeBody } from './charset.js';
import { runDeclarative, type DeclarativeRunOptions, type DeclarativeRunResult } from './declarative.js';
import type { HttpExchange, Transport } from './types.js';

export type FetchTransportOptions = {
  /** Plafond du corps, en octets. */
  readonly maxResponseBytes: number;
  /** Délai d'une requête (connexion, en-têtes, corps). */
  readonly timeoutMs: number;
};

type BodyInit = { body?: string; contentType?: string };

/** Corps d'une requête rendue (le type de contenu n'est posé que si la stratégie ne l'a pas fixé). */
export function encodeRequestBody(request: RenderedRequest): BodyInit {
  const body = request.body;
  if (body === undefined) return {};
  if (body.kind === 'json') return { body: JSON.stringify(body.value), contentType: 'application/json' };
  if (body.kind === 'form') return { body: new URLSearchParams(body.value).toString(), contentType: 'application/x-www-form-urlencoded' };
  return { body: body.value, contentType: 'text/plain;charset=UTF-8' };
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, contentType?: string): Promise<string> {
  if (stream === null) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
    }
    chunks.push(value);
  }
  return decodeBody(Buffer.concat(chunks), contentType);
}

/** Transport E1 : la session réseau de l'essai (garde SSRF à chaque connexion, redirections recontrôlées). */
export function fetchTransport(session: Pick<NetworkSession, 'fetch'>, options: FetchTransportOptions): Transport {
  return async (request, signal): Promise<HttpExchange> => {
    const { body, contentType } = encodeRequestBody(request);
    const headers: Record<string, string> = { ...request.headers };
    if (contentType !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = contentType;
    const response = await session.fetch(request.url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    const text = await readCapped(response.body as ReadableStream<Uint8Array> | null, options.maxResponseBytes, response.headers.get('content-type') ?? undefined);
    const out: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
    return { status: response.status, headers: out, body: text, url: response.url === '' ? request.url : response.url };
  };
}

/** Délai par requête d'E1 (connexion + réponse complète). */
export const E1_REQUEST_TIMEOUT_MS = 30_000;

/** E1 de bout en bout : boucle déclarative sur la session réseau de l'essai. */
export function runFetchExecutor(
  session: Pick<NetworkSession, 'fetch'>,
  options: Omit<DeclarativeRunOptions, 'transport'> & { readonly requestTimeoutMs?: number },
): Promise<DeclarativeRunResult> {
  const maxResponseBytes = options.spec.limits?.max_response_bytes ?? 5_000_000;
  const transport = fetchTransport(session, { maxResponseBytes, timeoutMs: options.requestTimeoutMs ?? E1_REQUEST_TIMEOUT_MS });
  return runDeclarative({ ...options, transport });
}
