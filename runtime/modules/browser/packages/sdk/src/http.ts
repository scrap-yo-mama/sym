// SPDX-License-Identifier: MIT
// Transport HTTP du SDK : `fetch` (Node 24), clé d'API en `Authorization: Bearer`, JSON, erreurs typées. `call` exécute une
// opération de la table générée depuis l'OpenAPI (src/generated/openapi.ts) avec des arguments et une réponse typés par
// les types `operations` d'openapi-typescript : ajouter une route au contrat puis régénérer suffit à l'exposer ici.
import { errorFromResponse, SymBrowserError } from './errors.js';
import { OPERATIONS, type OperationId, type operations } from './generated/openapi.js';

type Op<Id extends OperationId> = operations[Id];
type Params<Id extends OperationId> = Op<Id>['parameters'];
type JsonBody<Id extends OperationId> = Op<Id> extends { requestBody?: { content: { 'application/json': infer B } } } ? B : never;
type Responses<Id extends OperationId> = Op<Id>['responses'];

/** Corps JSON des réponses 2xx déclarées par l'OpenAPI pour l'opération. */
export type OperationResult<Id extends OperationId> = {
  [S in keyof Responses<Id>]: S extends 200 | 201 | 202 ? (Responses<Id>[S] extends { content: { 'application/json': infer R } } ? R : never) : never;
}[keyof Responses<Id>];

/** Arguments d'une opération : paramètres de chemin, de requête et d'en-tête, corps JSON. */
export type OperationArgs<Id extends OperationId> = {
  path?: Params<Id> extends { path?: infer P } ? NonNullable<P> : never;
  query?: Params<Id> extends { query?: infer Q } ? NonNullable<Q> : never;
  header?: Params<Id> extends { header?: infer H } ? NonNullable<H> : never;
  body?: JsonBody<Id>;
  /** Paramètres de requête hors schéma (filtres `metadata.{clé}` de la liste, 04 § 9). */
  extraQuery?: Record<string, string>;
};

export type RawRequest = {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string | undefined>;
  json?: unknown;
  form?: FormData;
  auth?: boolean;
  signal?: AbortSignal;
  /** Flux (SSE) : le délai ne couvre que l'attente des en-têtes, jamais la lecture du corps. */
  stream?: boolean;
};

export type HttpOptions = { baseUrl: string; apiKey: string; fetch: typeof fetch; timeoutMs: number };

export class HttpClient {
  readonly #options: HttpOptions;

  constructor(options: HttpOptions) {
    this.#options = options;
  }

  get baseUrl(): string {
    return this.#options.baseUrl;
  }

  /** En-têtes d'authentification (flux SSE, WebSocket). */
  authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.#options.apiKey}` };
  }

  /** Requête brute : réponse 2xx rendue telle quelle, toute autre réponse en `SymBrowserError`. */
  async send(request: RawRequest): Promise<Response> {
    const url = new URL(this.#options.baseUrl + request.path);
    for (const [name, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [name, value] of Object.entries(request.headers ?? {})) if (value !== undefined) headers[name.toLowerCase()] = value;
    if (request.auth !== false) Object.assign(headers, this.authHeaders());
    let body: string | FormData | undefined;
    if (request.form !== undefined) body = request.form;
    else if (request.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.json);
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#options.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
    let response: Response;
    try {
      response = await this.#options.fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), signal });
      if (request.stream) clearTimeout(timer);
    } catch (error) {
      clearTimeout(timer);
      if (timeout.signal.aborted) throw new SymBrowserError({ code: 'timeout', message: `${request.method} ${request.path} : pas de réponse en ${this.#options.timeoutMs} ms`, retryable: true, cause: error });
      if (request.signal?.aborted) throw error;
      throw new SymBrowserError({ code: 'network_error', message: `${request.method} ${request.path} : ${(error as Error).message}`, retryable: true, cause: error });
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw errorFromResponse(response.status, response.headers, await response.text().catch(() => ''));
    }
    // Corps non diffusé : le délai court jusqu'à sa lecture complète, puis le minuteur s'éteint de lui-même.
    if (!request.stream) timer.unref();
    return response;
  }

  /** Requête JSON : corps 2xx décodé. */
  async json<T>(request: RawRequest): Promise<T> {
    const response = await this.send(request);
    const text = await response.text();
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new SymBrowserError({ code: 'http_error', message: `${request.method} ${request.path} : réponse JSON illisible`, status: response.status, cause: error });
    }
  }

  /** Opération de l'OpenAPI, par son `operationId`. */
  call<Id extends OperationId>(id: Id, args: OperationArgs<Id> = {}, signal?: AbortSignal): Promise<OperationResult<Id>> {
    const operation = OPERATIONS[id];
    const pathParams = (args.path ?? {}) as Record<string, string>;
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = pathParams[name];
      if (value === undefined) throw new TypeError(`${id} : paramètre de chemin « ${name} » manquant`);
      return encodeURIComponent(value);
    });
    return this.json<OperationResult<Id>>({
      method: operation.method,
      path,
      query: { ...(args.query as Record<string, string | number | boolean | undefined> | undefined), ...args.extraQuery },
      headers: args.header as Record<string, string | undefined> | undefined,
      ...(operation.body && args.body !== undefined ? { json: args.body } : {}),
      auth: operation.auth,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
