// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle de CHAQUE requête réseau de Chromium, sauts de redirection compris (tâche 1.11, revue de 1.11).
// Playwright n'appelle `context.route` que pour la première URL d'une chaîne de redirections (il poursuit lui-même les
// sauts suivants), et le proxy d'egress ne voit pas le chemin d'une requête https (CONNECT). Le seul point où Chromium
// présente chaque saut AVANT de l'envoyer est le domaine CDP `Fetch` au stade Request : ce module l'active sur la page du
// run et, par attachement automatique (`Target.setAutoAttach`, cible retenue jusqu'à la fin de l'installation), sur
// chaque cible enfant (cadres hors processus, workers). Les requêtes des workers dédiés passent par la page ; un cadre
// hors processus a sa propre interception. Chaque requête http(s) d'un domaine de l'API est soumise à `check` :
// `false` la coupe (`Fetch.failRequest`, BlockedByClient) avant toute connexion.
// Mode non aplati (`flatten: false`) : les messages d'une cible enfant passent par `Target.sendMessageToTarget` de la
// session parente, seule voie qu'offre une `CDPSession` de Playwright. Un cadre hors processus dont l'interception ne
// peut pas être posée reste suspendu (échec fermé) : il ne charge rien.
//
// WebSocket des workers dédiés (revue de 1.11) : la poignée de main d'un WebSocket ouvert depuis un worker (de la
// page ou d'un cadre, hors processus ou non, imbriqué ou non) n'est vue ni par `routeWebSocket` (qui ne remplace
// `WebSocket` que dans les cadres), ni par CDP Fetch (qui n'intercepte pas les WebSocket), ni par le proxy d'egress (un
// CONNECT sans chemin). Voies écartées, constatées sur Chromium 153 : la suspension du worker au démarrage ne tient pas
// (Playwright relance lui-même chaque worker qu'il joint, avant toute évaluation de notre part) ; `Network.setBlockedURLs`
// ne coupe pas les WebSocket ; l'émulation réseau par règle ne couvre ni les workers imbriqués ni ceux d'un cadre du même
// processus ; une CSP ajoutée à la réponse d'un DOCUMENT par `Fetch.continueResponse` n'est pas appliquée. Échec fermé :
// - chaque réponse de script ou « autre » (dont le script principal d'un worker http(s), classique ou module) reçoit la
//   CSP `connect-src http: https: blob: data:`, que Chromium applique au worker : sans ws: ni wss:, il n'ouvre aucun
//   WebSocket (ni WebSocketStream), et ses workers blob: en héritent. Sans effet sur une ressource qui n'est ni un document
//   ni un worker ; elle ne fait que s'ajouter à celles du site (intersection). Une réponse dont la CSP ne peut pas être
//   posée est coupée ;
// - un document ne crée aucun worker blob: ou data: (garde des documents, page-guard.ts) : le code d'un worker vient
//   toujours d'une réponse http(s) qui passe ici.
// Les WebSocket de la page et des cadres restent contrôlés par `routeWebSocket`.
// Règles de spéculation (revue de 1.11) : une réponse `application/speculationrules+json` (règles chargées par l'en-tête
// `Speculation-Rules`) est coupée ; le préchargement qu'elle déclencherait part du navigateur hors de toute interception
// (voir page-guard.ts).
// SharedWorker et service workers (revue de fix-inv11-agent, F-20261001-07) : hors de l'attachement automatique de la page,
// ils sont coupés par une interception `Fetch` au niveau du navigateur (`blockBackgroundWorkers`, ci-dessous), qui ne
// dépend d'aucune suspension de cible (Playwright et Stagehand relancent eux-mêmes les workers qu'ils joignent).
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { WEBSOCKET_STREAM_NEUTRALIZER } from './page-guard.js';

/** Requête présentée au contrôle (un saut d'une chaîne de redirections, ou la requête initiale). */
export type BrowserRequestCheck = {
  readonly url: string;
  /** Saut de redirection (faux pour la requête initiale). */
  readonly redirect: boolean;
  /** URL de la requête initiale de la chaîne (égale à `url` hors redirection). */
  readonly rootUrl: string;
  /** Type de ressource CDP (`Document`, `XHR`, `Fetch`, `Image`, `WebSocket`…). */
  readonly resourceType: string;
  /** Document du cadre principal de la page du run (navigation de la page, saut compris). */
  readonly mainFrame: boolean;
  /** Méthode HTTP de la requête (`GET` pour la poignée de main d'un WebSocket). */
  readonly method: string;
  /** Corps de l'écriture (POST, XHR, beacon), décodé en texte ; absent pour une lecture ou un corps binaire. */
  readonly body?: string;
};

export type RequestCheck = (request: BrowserRequestCheck) => Promise<boolean>;

type Listener = (params: Record<string, unknown>) => void;

/** Canal CDP : la session de la page (Playwright) ou une cible enfant jointe à travers sa session parente. */
export type Channel = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, listener: Listener): void;
};

/** Racines des chaînes (identifiant réseau → URL initiale), bornées. */
const MAX_ROOTS = 2000;
/** Longueur lue d'un corps d'écriture pour le contrôle des valeurs sensibles. */
const MAX_BODY_CHARS = 1_000_000;

/** Canal de la session Playwright. */
export function sessionChannel(session: CDPSession): Channel {
  const raw = session as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    on(event: string, listener: Listener): void;
  };
  return { send: (method, params) => raw.send(method, params), on: (event, listener) => void raw.on(event, listener) };
}

/** Cibles enfants d'un canal, en mode non aplati : réponses et événements arrivent par `Target.receivedMessageFromTarget`. */
export function childChannels(parent: Channel): (sessionId: string) => Channel {
  const children = new Map<string, { dispatch(message: Record<string, unknown>): void; close(): void }>();
  parent.on('Target.receivedMessageFromTarget', (params) => {
    const child = children.get(String(params['sessionId']));
    if (child === undefined || typeof params['message'] !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(params['message']);
    } catch {
      return;
    }
    if (typeof message === 'object' && message !== null) child.dispatch(message as Record<string, unknown>);
  });
  parent.on('Target.detachedFromTarget', (params) => {
    const id = String(params['sessionId']);
    children.get(id)?.close();
    children.delete(id);
  });
  return (sessionId) => {
    let next = 0;
    const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
    const listeners = new Map<string, Listener[]>();
    children.set(sessionId, {
      dispatch(message) {
        if (typeof message['id'] === 'number') {
          const waiter = pending.get(message['id']);
          pending.delete(message['id']);
          if (waiter === undefined) return;
          if (message['error'] !== undefined) waiter.reject(new Error(`CDP : ${JSON.stringify(message['error']).slice(0, 200)}`));
          else waiter.resolve((message['result'] as Record<string, unknown> | undefined) ?? {});
          return;
        }
        if (typeof message['method'] !== 'string') return;
        for (const listener of listeners.get(message['method']) ?? []) listener((message['params'] as Record<string, unknown> | undefined) ?? {});
      },
      close() {
        for (const waiter of pending.values()) waiter.reject(new Error('CDP : cible détachée'));
        pending.clear();
      },
    });
    return {
      send(method, params = {}) {
        const id = ++next;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          parent.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch((error: unknown) => {
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
      },
      on(event, listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    };
  };
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: false } as const;
/** CSP ajoutée à chaque script et ressource « autre » (script principal d'un worker) : aucun WebSocket. */
const WORKER_CSP = 'connect-src http: https: blob: data:';
/** Type MIME des règles de spéculation chargées par l'en-tête `Speculation-Rules` (seul type accepté par Chromium). */
const SPECULATION_RULES_MIME = 'application/speculationrules+json';
/** Chaque requête au stade Request ; scripts et ressources « autres » aussi au stade Response. */
const INTERCEPT_ALL = {
  patterns: [
    { urlPattern: '*', requestStage: 'Request' },
    ...['Script', 'Other'].map((resourceType) => ({ urlPattern: '*', resourceType, requestStage: 'Response' })),
  ],
};

type HeaderEntry = { name: string; value: string };

/**
 * Script ou ressource « autre » interceptés à la réception : règles de spéculation coupées ; CSP `WORKER_CSP` ajoutée au
 * reste. Échec fermé : une réponse dont la CSP ne peut pas être posée est coupée.
 */
async function onResponse(channel: Channel, params: Record<string, unknown>, neutralize: boolean): Promise<void> {
  const requestId = params['requestId'];
  const fail = () => channel.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  if (typeof params['responseErrorReason'] === 'string') {
    await channel.send('Fetch.failRequest', { requestId, errorReason: params['responseErrorReason'] }).catch(() => undefined);
    return;
  }
  const headers = (Array.isArray(params['responseHeaders']) ? params['responseHeaders'] : []) as HeaderEntry[];
  const mime = (h: HeaderEntry) => String(h.value).split(';')[0]!.trim().toLowerCase();
  if (headers.some((h) => String(h.name).toLowerCase() === 'content-type' && mime(h) === SPECULATION_RULES_MIME)) {
    await fail();
    return;
  }
  // Script principal d'un worker dédié (type « Other », JavaScript) : `WebSocketStream` retiré avant son exécution (tâche 4.6).
  // Un document est couvert par le script d'init (page-guard.ts) ; une évaluation dans la cible du worker suspendue au
  // démarrage ne vaut pas (contexte jeté avant le script, constaté sur Chromium 153).
  const javascript = headers.some((h) => String(h.name).toLowerCase() === 'content-type' && /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(mime(h)));
  if (neutralize && params['resourceType'] === 'Other' && javascript) {
    await neutralizeWorkerScript(channel, params, headers);
    return;
  }
  const phrase = typeof params['responseStatusText'] === 'string' && params['responseStatusText'] !== '' ? { responsePhrase: params['responseStatusText'] } : {};
  const responseHeaders = [...headers, { name: 'Content-Security-Policy', value: WORKER_CSP }];
  const sent = await channel.send('Fetch.continueResponse', { requestId, responseCode: params['responseStatusCode'], ...phrase, responseHeaders }).then(
    () => true,
    () => false,
  );
  if (!sent) await fail();
}

/** Réponse du script principal d'un worker dédié, précédée du retrait de `WebSocketStream`, avec la CSP sans WebSocket. Échec fermé. */
async function neutralizeWorkerScript(channel: Channel, params: Record<string, unknown>, headers: readonly HeaderEntry[]): Promise<void> {
  const requestId = params['requestId'];
  try {
    const got = (await channel.send('Fetch.getResponseBody', { requestId })) as { body?: unknown; base64Encoded?: unknown };
    if (typeof got['body'] !== 'string') throw new Error('corps illisible');
    const source = got['base64Encoded'] === true ? Buffer.from(got['body'], 'base64').toString('utf8') : got['body'];
    const body = Buffer.from(`${WEBSOCKET_STREAM_NEUTRALIZER}\n${source}`, 'utf8').toString('base64');
    // Le corps lu est décodé : ni longueur ni codage de transfert d'origine.
    const kept = headers.filter((h) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(String(h.name).toLowerCase()));
    const phrase = typeof params['responseStatusText'] === 'string' && params['responseStatusText'] !== '' ? { responsePhrase: params['responseStatusText'] } : {};
    await channel.send('Fetch.fulfillRequest', { requestId, responseCode: params['responseStatusCode'], ...phrase, responseHeaders: [...kept, { name: 'Content-Security-Policy', value: WORKER_CSP }], body });
  } catch {
    await channel.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  }
}

/**
 * Verdict d'une requête présentée par CDP : `check` pour toute requête http(s) d'un domaine de l'API ; hors http(s)
 * (data:, blob:) ou hors des domaines (coupée par le verrou de domaines et le proxy d'egress), rien à contrôler ici.
 * Échec fermé : une URL illisible est coupée, comme un contrôle qui échoue.
 */
export async function requestVerdict(
  url: string,
  inScope: (url: string) => boolean,
  check: RequestCheck,
  hop: Omit<BrowserRequestCheck, 'url'>,
  offsiteRedirect?: { readonly cut: boolean; readonly onBlocked?: (url: string) => void },
): Promise<boolean> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return true;
  if (!inScope(url)) {
    // Saut de redirection hors des domaines (tâche 4.6 ; 04g §4) : coupé ICI, sans compter sur l'egress (un navigateur distant
    // n'a pas celui de SYM). Une requête initiale hors domaines, elle, est coupée par la route du contexte de run.
    if (!hop.redirect || offsiteRedirect?.cut !== true) return true;
    offsiteRedirect.onBlocked?.(url);
    return false;
  }
  return check({ url, ...hop }).catch(() => false);
}

/** Corps d'une écriture, en texte (`postData`, ou entrées binaires décodées en UTF-8) : le contrôle des valeurs sensibles y lit aussi. Borné. */
function postBodyOf(request: { postData?: unknown; postDataEntries?: unknown } | undefined): string | undefined {
  if (request === undefined) return undefined;
  if (typeof request.postData === 'string') return request.postData.slice(0, MAX_BODY_CHARS);
  if (!Array.isArray(request.postDataEntries)) return undefined;
  const parts = request.postDataEntries.flatMap((e: unknown) => (typeof e === 'object' && e !== null && typeof (e as { bytes?: unknown }).bytes === 'string' ? [Buffer.from((e as { bytes: string }).bytes, 'base64').toString('utf8')] : []));
  return parts.length === 0 ? undefined : parts.join('').slice(0, MAX_BODY_CHARS);
}

/**
 * Pose le contrôle de chaque requête sur `page` (et ses cibles enfants) AVANT toute navigation. La session vit jusqu'à
 * la fermeture du contexte : jamais détachée avant (détachée, elle laisserait repartir les requêtes suspendues).
 */
export type RequestGuardOptions = {
  /**
   * Saut de redirection hors domaines coupé par la garde elle-même (`Fetch.failRequest`), sans compter sur l'egress ; défaut
   * `true`. `false` : l'egress de SYM voit chaque saut et le coupe (fournisseurs `local` et `sym-browser` : même guet, mêmes
   * compteurs qu'avant la tâche 4.6).
   */
  readonly cutOffsiteRedirects?: boolean;
  /** Saut de redirection hors domaines coupé par la garde (l'URL du saut) : comptage et signalement de l'appelant. */
  readonly onDomainBlocked?: (url: string) => void;
  /** `WebSocketStream` retiré du script principal de chaque worker dédié (voir `WEBSOCKET_STREAM_NEUTRALIZER`, page-guard.ts). */
  readonly neutralizeLaunchFeatures?: boolean;
};

export async function installRequestGuard(context: BrowserContext, page: Page, inScope: (url: string) => boolean, check: RequestCheck, options: RequestGuardOptions = {}): Promise<void> {
  const session = await context.newCDPSession(page);
  const roots = new Map<string, string>();
  const remember = (networkId: string, url: string) => {
    if (roots.size >= MAX_ROOTS) {
      const oldest = roots.keys().next();
      if (oldest.done !== true) roots.delete(oldest.value);
    }
    roots.set(networkId, url);
  };

  const onPaused = (channel: Channel, mainFrameId: string | undefined) => async (params: Record<string, unknown>) => {
    if (params['responseStatusCode'] !== undefined || params['responseErrorReason'] !== undefined) {
      await onResponse(channel, params, options.neutralizeLaunchFeatures === true);
      return;
    }
    const requestId = params['requestId'];
    const request = params['request'] as { url?: unknown; method?: unknown; postData?: unknown; postDataEntries?: unknown } | undefined;
    const url = typeof request?.url === 'string' ? request.url : '';
    const method = typeof request?.method === 'string' ? request.method : 'GET';
    const networkId = typeof params['networkId'] === 'string' ? params['networkId'] : undefined;
    // Saut de redirection : `redirectedRequestId` (même origine), ou identifiant réseau déjà vu (redirection vers une
    // autre origine d'une requête CORS, que Chromium relance sans `redirectedRequestId`).
    const known = networkId === undefined ? undefined : roots.get(networkId);
    const redirect = typeof params['redirectedRequestId'] === 'string' || known !== undefined;
    const rootUrl = known ?? url;
    if (known === undefined && networkId !== undefined) remember(networkId, url);
    const resourceType = typeof params['resourceType'] === 'string' ? params['resourceType'] : 'Other';
    const mainFrame = mainFrameId !== undefined && params['frameId'] === mainFrameId && resourceType === 'Document';
    const body = postBodyOf(request);
    const allowed = await requestVerdict(url, inScope, check, { redirect, rootUrl, resourceType, mainFrame, method, ...(body === undefined ? {} : { body }) }, { cut: options.cutOffsiteRedirects !== false, ...(options.onDomainBlocked === undefined ? {} : { onBlocked: options.onDomainBlocked }) });
    if (allowed) await channel.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
    else await channel.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  };

  /** Interception et attachement automatique d'un canal ; `true` si l'interception est posée. */
  const arm = async (channel: Channel, mainFrameId: string | undefined, intercepting: boolean): Promise<boolean> => {
    channel.on('Fetch.requestPaused', (params) => void onPaused(channel, mainFrameId)(params));
    const child = childChannels(channel);
    channel.on('Target.attachedToTarget', (params) => {
      const sessionId = String(params['sessionId']);
      const info = (params['targetInfo'] ?? {}) as { type?: unknown };
      const target = child(sessionId);
      void (async () => {
        // Workers : leurs requêtes passent par l'interception de la page (Fetch n'existe pas sur leur cible) ; leurs
        // propres enfants restent attachés. Cadre hors processus : interception propre, exigée avant de le laisser partir.
        const frame = info.type === 'iframe' || info.type === 'page';
        const armed = await arm(target, undefined, frame);
        if (frame && !armed) return; // Échec fermé : le cadre reste suspendu, aucune requête ne part.
        await target.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
      })();
    });
    let armed = true;
    if (intercepting) armed = await channel.send('Fetch.enable', INTERCEPT_ALL).then(() => true, () => false);
    await channel.send('Target.setAutoAttach', AUTO_ATTACH).catch(() => undefined);
    return armed;
  };

  try {
    const tree = (await session.send('Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown } } };
    const mainFrameId = typeof tree.frameTree?.frame?.id === 'string' ? tree.frameTree.frame.id : undefined;
    if (!(await arm(sessionChannel(session), mainFrameId, true))) throw new Error('interception CDP indisponible');
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
}

/** Poignée du blocage des workers d'arrière-plan : à fermer APRÈS le contexte du run (fermée avant, l'interception tomberait). */
export type BackgroundWorkerBlock = { close(): Promise<void> };

/** Workers d'arrière-plan : cibles propres, hors de la page, jamais admises à émettre une requête. */
const BACKGROUND_WORKERS = [{ type: 'shared_worker' }, { type: 'service_worker' }] as const;
/** Cibles dont les requêtes passent par le contrôle de la page du run (page, cadres hors processus, workers dédiés). */
const PAGE_TARGETS: ReadonlySet<string> = new Set(['page', 'iframe', 'worker', 'tab']);
/** Verdicts mémorisés (identifiant de cadre ou de cible → requêtes admises), bornés. */
const MAX_ORIGINS = 2000;

/**
 * Échec fermé sur les SharedWorker et les service workers (revue de 1.11 et de fix-inv11-agent ; F-20261001-07).
 * Leurs requêtes ne passent ni par `context.route` (Playwright ne route pas celles d'un service worker d'un contexte
 * `serviceWorkers: 'block'`, ni jamais celles d'un SharedWorker), ni par le contrôle CDP de la page (cibles hors de son
 * attachement automatique). Les suspendre au démarrage ne tient pas : Playwright relance lui-même chaque service worker
 * (`Runtime.runIfWaitingForDebugger`) et se détache aussitôt d'un SharedWorker, ce qui le relance aussi (constaté sur
 * Chromium 153 : un SharedWorker fermé par `Target.closeTarget` avait parfois déjà envoyé une requête, ≈ 1 run sur 5).
 * `serviceWorkers: 'block'` ne remplace que `register` de l'INSTANCE `navigator.serviceWorker` :
 * `ServiceWorkerContainer.prototype.register.call(...)` enregistrait le worker.
 * Couche CDP, sans course : une interception `Fetch` au niveau du NAVIGATEUR, posée avant le contexte du run, voit chaque
 * requête de chaque cible, celle d'un worker d'arrière-plan portant l'identifiant de sa cible (`frameId`). Toute requête
 * d'un SharedWorker ou d'un service worker est coupée (`BlockedByClient`), script principal du service worker compris :
 * son enregistrement échoue, il ne s'exécute jamais. Les autres requêtes (page, cadres, workers dédiés), déjà passées par
 * `context.route` et le contrôle CDP de la page (consultés avant cette interception), continuent. Une requête sans
 * origine (`frameId` absent) est coupée ; un identifiant inconnu est résolu une fois (`Target.getTargetInfo`) : cible
 * d'une page → admise, autre cible → coupée, aucune cible → cadre du même processus, admis. Les cibles des workers
 * d'arrière-plan sont connues avant leur première requête (découverte et attachement automatique au niveau du
 * navigateur) et fermées aussitôt (`Target.closeTarget`) ; jamais relancées par cette session.
 * WebSocket (que `Fetch` ne voit pas) : le script http(s) d'un SharedWorker reçoit la CSP sans WebSocket du contrôle de la
 * page ; un SharedWorker blob: ou data: est refusé par la garde des documents (page-guard.ts), comme un worker dédié.
 */
export async function blockBackgroundWorkers(browser: Browser): Promise<BackgroundWorkerBlock> {
  const session = await browser.newBrowserCDPSession();
  const raw = sessionChannel(session);
  const verdicts = new Map<string, Promise<boolean>>();
  const remember = (id: string, verdict: Promise<boolean>): Promise<boolean> => {
    if (verdicts.size >= MAX_ORIGINS && !verdicts.has(id)) {
      const oldest = verdicts.keys().next();
      if (oldest.done !== true) verdicts.delete(oldest.value);
    }
    verdicts.set(id, verdict);
    return verdict;
  };
  const onTarget = (params: Record<string, unknown>) => {
    const info = (params['targetInfo'] ?? {}) as { type?: unknown; targetId?: unknown };
    if (typeof info.targetId !== 'string' || !BACKGROUND_WORKERS.some((w) => w.type === info.type)) return; // Filtre : rien d'autre.
    remember(info.targetId, Promise.resolve(false));
    void raw.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
  };
  raw.on('Target.targetCreated', onTarget);
  raw.on('Target.attachedToTarget', onTarget);
  const admitted = (origin: unknown): Promise<boolean> => {
    if (typeof origin !== 'string' || origin === '') return Promise.resolve(false);
    return (
      verdicts.get(origin) ??
      remember(
        origin,
        raw.send('Target.getTargetInfo', { targetId: origin }).then(
          (result) => PAGE_TARGETS.has(String(((result['targetInfo'] ?? {}) as { type?: unknown }).type)),
          () => true,
        ),
      )
    );
  };
  raw.on('Fetch.requestPaused', (params) => {
    const requestId = params['requestId'];
    void admitted(params['frameId']).then((ok) =>
      (ok ? raw.send('Fetch.continueRequest', { requestId }) : raw.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })).catch(() => undefined),
    );
  });
  try {
    await raw.send('Target.setDiscoverTargets', { discover: true, filter: [...BACKGROUND_WORKERS] });
    await raw.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await raw.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [...BACKGROUND_WORKERS] });
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw new Error(`blocage des workers d'arrière-plan indisponible : ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return { close: () => session.detach().catch(() => undefined) };
}
