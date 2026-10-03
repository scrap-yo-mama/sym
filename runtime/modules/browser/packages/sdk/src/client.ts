// SPDX-License-Identifier: MIT
// Client `SymBrowser` (cdc/sym-browser 04 § 10, 03 § 5 « SDK », tâche 3.4) :
//   - `sessions.create/get/list/release/extend`, `sessions.egress.get/put`, `version()` : opérations REST, appels typés par
//     le client généré depuis l'OpenAPI du contrat (http.ts, src/generated/openapi.ts) ou, pour les routes que l'OpenAPI
//     1.0.0 ne publie pas encore (egress, événements, profils, fichiers : 04 § 2, 04c § 4.4 et § 5), sur leurs chemins de 04 ;
//   - `connect(session)` : `Browser` Playwright en protocole natif (`chromium.connect`), après lecture de `GET /v1/version`
//     (même version majeure.mineure de Playwright exigée, 04 § 6 `playwright_version_mismatch`) ; si la connexion n'a aucun
//     contexte (session shared : le contexte du nœud appartient à sa propre connexion), un contexte est ouvert avec les
//     options de la création (le relais du nœud lui impose l'egress de la session, 04f § 4) : `browser.contexts()[0]` existe ;
//   - `connectCDP(session)` : `Browser` Playwright en `connectOverCDP` sur `connectUrls.cdp` (sessions `dedicated`) ;
//   - `events(id)` : flux SSE ; `profiles`, `files` ;
//   - libération : `await using` (`Symbol.asyncDispose`), `session.release()`, `close()`, et à la sortie du process
//     (exit.ts). Libérer ferme d'abord les `Browser` ouverts par ce client sur la session.
import { createRequire } from 'node:module';
import type { CreateSessionRequest, EgressPolicy, EgressState, Session, SessionEvent, SessionPage, SessionState, SessionType, StorageState, VersionInfo } from '@sym/contracts/browser';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core';
import { SymBrowserError } from './errors.js';
import { streamEvents, type EventsOptions } from './events.js';
import { trackForExit, untrackForExit, type Releasable } from './exit.js';
import { HttpClient } from './http.js';

/** Version de `playwright-core` installée avec le SDK (comparée à celle du serveur avant `connect`). */
export const LOCAL_PLAYWRIGHT_VERSION: string = (createRequire(import.meta.url)('playwright-core/package.json') as { version: string }).version;

export type SymBrowserOptions = {
  /** URL de l'instance (`https://browser.example.com`) ; défaut : `SYMB_URL`. */
  url?: string;
  /** Clé d'API ; défaut : `SYMB_API_KEY`. */
  apiKey?: string;
  /** Libère les sessions créées par ce client à la sortie du process (défaut : oui). */
  releaseOnExit?: boolean;
  /** Délai d'une requête REST (défaut 120 000 ms : une création attend le démarrage, jusqu'à `QUEUE_TIMEOUT_MS`). */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type CreateOptions = { idempotencyKey?: string; wait?: boolean };

export type ListFilter = {
  limit?: number;
  cursor?: string;
  state?: SessionState;
  type?: SessionType;
  createdAfter?: string | Date;
  createdBefore?: string | Date;
  /** Filtre `metadata.{clé}={valeur}` (04 § 9). */
  metadata?: Record<string, string>;
};

export type ConnectOptions = {
  /** Attente maximale d'une session `pending` puis de la connexion (défaut 30 000 ms). */
  timeoutMs?: number;
  /** Options du contexte ouvert quand la connexion n'en a aucun (défaut : options de la création par ce client). */
  contextOptions?: BrowserContextOptions;
};

/** Session rendue par `sessions.create` : un objet `Session` et sa libération (`release()`, `await using`). */
export type SdkSession = Session & AsyncDisposable & { release(): Promise<Session> };

export type Profile = Record<string, unknown> & { id: string; name?: string };
export type SessionFile = { id: string; name: string; size: number; sha256: string; createdAt: string; expiresAt: string };
export type DownloadedFile = { data: Uint8Array; contentType: string | null; fileName: string | null };
export type UploadedFile = { id: string; path: string; size: number; sha256: string };

const CONTEXT_OPTION_KEYS = ['viewport', 'locale', 'timezoneId', 'userAgent', 'extraHTTPHeaders', 'geolocation', 'colorScheme', 'acceptDownloads'] as const;

const majorMinor = (version: string): string => version.split('.').slice(0, 2).join('.');
const isoDate = (value: string | Date | undefined): string | undefined => (value instanceof Date ? value.toISOString() : value);
const id = (session: Session | string): string => (typeof session === 'string' ? session : session.id);
const path = (...parts: string[]): string => `/v1/${parts.map(encodeURIComponent).join('/')}`;

type Tracked = Releasable & { sessionId: string };

export class SymBrowser {
  readonly url: string;
  readonly #http: HttpClient;
  readonly #releaseOnExit: boolean;
  /** Sessions créées par ce client et pas encore libérées. */
  readonly #created = new Map<string, Tracked>();
  /** Options de création (contexte d'une connexion native). */
  readonly #createOptions = new Map<string, CreateSessionRequest>();
  /** `Browser` ouverts par ce client, par session. */
  readonly #browsers = new Map<string, Set<Browser>>();
  #version: Promise<VersionInfo> | undefined;

  constructor(options: SymBrowserOptions = {}) {
    const url = options.url ?? process.env.SYMB_URL;
    const apiKey = options.apiKey ?? process.env.SYMB_API_KEY;
    if (!url) throw new TypeError('SymBrowser : URL de l’instance absente (option `url` ou variable SYMB_URL).');
    if (!apiKey) throw new TypeError('SymBrowser : clé d’API absente (option `apiKey` ou variable SYMB_API_KEY).');
    this.url = url.replace(/\/+$/, '');
    this.#http = new HttpClient({ baseUrl: this.url, apiKey, fetch: options.fetch ?? globalThis.fetch, timeoutMs: options.timeoutMs ?? 120_000 });
    this.#releaseOnExit = options.releaseOnExit ?? true;
  }

  readonly sessions = {
    /** `POST /v1/sessions` : attend que la session soit `running` (ou rend `pending` avec `wait: false`). */
    create: async (request: CreateSessionRequest = {}, options: CreateOptions = {}): Promise<SdkSession> => {
      const session = (await this.#http.call('createSession', {
        body: request as never,
        ...(options.wait === undefined ? {} : { query: { wait: options.wait } }),
        ...(options.idempotencyKey === undefined ? {} : { header: { 'Idempotency-Key': options.idempotencyKey } }),
      })) as Session;
      return this.#adopt(session, request);
    },
    get: async (sessionId: string): Promise<Session> => (await this.#http.call('getSession', { path: { id: sessionId } })) as Session,
    list: async (filter: ListFilter = {}): Promise<SessionPage> => {
      const extraQuery: Record<string, string> = {};
      for (const [key, value] of Object.entries(filter.metadata ?? {})) extraQuery[`metadata.${key}`] = value;
      const createdAfter = isoDate(filter.createdAfter);
      const createdBefore = isoDate(filter.createdBefore);
      return (await this.#http.call('listSessions', {
        query: {
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.type === undefined ? {} : { type: filter.type }),
          ...(filter.limit === undefined ? {} : { limit: filter.limit }),
          ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
          ...(createdAfter === undefined ? {} : { createdAfter }),
          ...(createdBefore === undefined ? {} : { createdBefore }),
        },
        extraQuery,
      })) as SessionPage;
    },
    /** `DELETE /v1/sessions/{id}` (rejouable) ; ferme d'abord les `Browser` ouverts par ce client sur la session. */
    release: async (sessionId: string): Promise<Session> => {
      const tracked = this.#created.get(sessionId);
      if (tracked) return (await tracked.release()) as Session;
      return this.#release(sessionId);
    },
    extend: async (sessionId: string, seconds: number): Promise<Session> =>
      (await this.#http.call('extendSession', { path: { id: sessionId }, body: { timeoutSeconds: seconds } })) as Session,
    egress: {
      /** Compteurs de l'époque en cours (04c § 1.3). */
      get: (sessionId: string): Promise<EgressState> => this.#http.json<EgressState>({ method: 'GET', path: path('sessions', sessionId, 'egress') }),
      /** Remplace la politique d'egress : nouvelle époque (04c § 1.3). */
      put: (sessionId: string, policy: EgressPolicy): Promise<EgressState> => this.#http.json<EgressState>({ method: 'PUT', path: path('sessions', sessionId, 'egress'), json: policy }),
    },
  };

  /** Profils persistants (04c § 4.4). */
  readonly profiles = {
    create: (input: { name: string }): Promise<Profile> => this.#http.json<Profile>({ method: 'POST', path: path('profiles'), json: input }),
    list: (): Promise<{ data: Profile[] } & Record<string, unknown>> => this.#http.json({ method: 'GET', path: path('profiles') }),
    get: (profileId: string): Promise<Profile> => this.#http.json<Profile>({ method: 'GET', path: path('profiles', profileId) }),
    delete: (profileId: string): Promise<unknown> => this.#http.json({ method: 'DELETE', path: path('profiles', profileId) }),
    import: (profileId: string, storageState: StorageState): Promise<Profile> => this.#http.json<Profile>({ method: 'POST', path: path('profiles', profileId, 'import'), json: storageState }),
    storageState: (profileId: string): Promise<StorageState> => this.#http.json<StorageState>({ method: 'GET', path: path('profiles', profileId, 'storage-state') }),
  };

  /** Fichiers d'une session : téléchargements (04c § 5.1) et envois pour les clients CDP (04c § 5.2). */
  readonly files = {
    list: (sessionId: string): Promise<{ data: SessionFile[] }> => this.#http.json({ method: 'GET', path: path('sessions', sessionId, 'files') }),
    download: async (sessionId: string, fileId: string): Promise<DownloadedFile> => {
      const response = await this.#http.send({ method: 'GET', path: path('sessions', sessionId, 'files', fileId), headers: { accept: '*/*' } });
      const disposition = response.headers.get('content-disposition') ?? '';
      const fileName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
      return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type'), fileName: fileName === null ? null : decodeURIComponent(fileName) };
    },
    delete: (sessionId: string, fileId: string): Promise<unknown> => this.#http.json({ method: 'DELETE', path: path('sessions', sessionId, 'files', fileId) }),
    /** Envoi multipart : rend `{id, path, size, sha256}` ; `path` se passe à `DOM.setFileInputFiles` (CDP). */
    upload: (sessionId: string, file: { name: string; data: Uint8Array | ArrayBuffer | Blob; contentType?: string }): Promise<UploadedFile> => {
      const form = new FormData();
      const blob = file.data instanceof Blob ? file.data : new Blob([file.data], { type: file.contentType ?? 'application/octet-stream' });
      form.append('file', blob, file.name);
      return this.#http.json<UploadedFile>({ method: 'POST', path: path('sessions', sessionId, 'uploads'), form });
    },
  };

  /** `GET /v1/version` (sans clé). */
  async version(): Promise<VersionInfo> {
    return (await this.#http.call('getVersion')) as VersionInfo;
  }

  /** `Browser` Playwright en protocole natif sur la session (`connectUrls.playwright`). */
  async connect(session: Session | string, options: ConnectOptions = {}): Promise<Browser> {
    const served = await this.#version_();
    if (majorMinor(served.playwright) !== majorMinor(LOCAL_PLAYWRIGHT_VERSION)) {
      throw new SymBrowserError({
        code: 'playwright_version_mismatch',
        message: `Playwright ${LOCAL_PLAYWRIGHT_VERSION} installé, ${served.playwright} servi par l'instance.`,
        whatToDo: `Installe playwright-core ${majorMinor(served.playwright)}.x.`,
      });
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const browser = await this.#withFreshToken(session, timeoutMs, (running) => chromium.connect(running.connectUrls!.playwright, { timeout: timeoutMs }));
    if (browser.contexts().length === 0) {
      const created = this.#createOptions.get(id(session));
      const contextOptions: BrowserContextOptions = options.contextOptions ?? {};
      if (options.contextOptions === undefined && created) {
        for (const key of CONTEXT_OPTION_KEYS) if (created[key] !== undefined) Object.assign(contextOptions, { [key]: created[key] });
      }
      await browser.newContext(contextOptions);
    }
    return browser;
  }

  /** `Browser` Playwright en `connectOverCDP` sur `connectUrls.cdp` (sessions `dedicated`, type par défaut). */
  async connectCDP(session: Session | string, options: Pick<ConnectOptions, 'timeoutMs'> = {}): Promise<Browser> {
    if (typeof session !== 'string' && session.type === 'shared') throw this.#cdpNotServed();
    const timeoutMs = options.timeoutMs ?? 30_000;
    return this.#withFreshToken(session, timeoutMs, (running) => {
      if (!running.connectUrls?.cdp) throw this.#cdpNotServed();
      return chromium.connectOverCDP(running.connectUrls.cdp, { timeout: timeoutMs });
    });
  }

  /** Flux SSE d'une session (`events(id)`) ou de toutes les sessions du client (`events()`). */
  events(sessionId?: string, options: EventsOptions = {}): AsyncIterable<SessionEvent> {
    return streamEvents(this.#http, sessionId, options);
  }

  /** Libère toutes les sessions créées par ce client et encore vivantes. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#created.values()].map((tracked) => tracked.release()));
  }

  #cdpNotServed(): SymBrowserError {
    return new SymBrowserError({ code: 'protocol_not_served', status: 409, message: 'CDP n’est servi que pour les sessions dedicated.', whatToDo: 'Crée la session en type dedicated (défaut).' });
  }

  #version_(): Promise<VersionInfo> {
    this.#version ??= this.version().catch((error: unknown) => {
      this.#version = undefined;
      throw error;
    });
    return this.#version;
  }

  /** Session `running` avec ses `connectUrls` : relue si besoin, `pending` attendue jusqu'au délai. */
  async #running(session: Session | string, timeoutMs: number, refresh: boolean): Promise<Session> {
    let current = typeof session === 'string' || refresh || session.state !== 'running' || !session.connectUrls ? await this.sessions.get(id(session)) : session;
    const deadline = Date.now() + timeoutMs;
    while (current.state === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await this.sessions.get(current.id);
    }
    if (current.state !== 'running' || !current.connectUrls) {
      throw new SymBrowserError({
        code: current.state === 'pending' ? 'timeout' : 'session_not_running',
        message: `Session ${current.id} : état ${current.state}${current.endReason ? ` (${current.endReason})` : ''}, aucune connexion possible.`,
        retryable: current.state === 'pending',
      });
    }
    return current;
  }

  /** Connexion ; un jeton expiré (401 à l'upgrade, 04 § 7) est renouvelé par une relecture de la session, une fois. */
  async #withFreshToken(session: Session | string, timeoutMs: number, open: (running: Session) => Promise<Browser>): Promise<Browser> {
    let browser: Browser;
    try {
      browser = await open(await this.#running(session, timeoutMs, false));
    } catch (error) {
      if (error instanceof SymBrowserError || !/\b401\b/.test(String((error as Error).message))) throw error;
      browser = await open(await this.#running(session, timeoutMs, true));
    }
    const sessionId = id(session);
    const set = this.#browsers.get(sessionId) ?? new Set<Browser>();
    set.add(browser);
    this.#browsers.set(sessionId, set);
    browser.once('disconnected', () => set.delete(browser));
    return browser;
  }

  #adopt(session: Session, request: CreateSessionRequest): SdkSession {
    let released: Promise<Session> | undefined;
    const tracked: Tracked = {
      sessionId: session.id,
      release: () => {
        released ??= (async () => {
          if (this.#created.get(session.id) === tracked) this.#created.delete(session.id);
          untrackForExit(tracked);
          return this.#release(session.id);
        })();
        return released;
      },
    };
    this.#created.set(session.id, tracked);
    this.#createOptions.set(session.id, request);
    if (this.#releaseOnExit) trackForExit(tracked);
    const sdkSession = session as SdkSession;
    Object.defineProperties(sdkSession, {
      release: { value: () => tracked.release(), enumerable: false },
      [Symbol.asyncDispose]: { value: async () => void (await tracked.release()), enumerable: false },
    });
    return sdkSession;
  }

  async #release(sessionId: string): Promise<Session> {
    const browsers = [...(this.#browsers.get(sessionId) ?? [])];
    this.#browsers.delete(sessionId);
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    try {
      return (await this.#http.call('releaseSession', { path: { id: sessionId } })) as Session;
    } finally {
      this.#createOptions.delete(sessionId);
    }
  }
}
