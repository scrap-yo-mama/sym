// SPDX-License-Identifier: AGPL-3.0-only
// Réécritures du relais du nœud (cdc/sym-browser 04f § 4, tâche 2.3 ; liste figée par la tâche 2.8 contre la suite de
// compatibilité). Chaque message du client est lu (JSON objet, sinon refus 1007), réécrit si sa méthode est dans la liste
// fermée, puis RE-SÉRIALISÉ : le navigateur reçoit exactement ce que le relais a lu (une clé en double ou une forme ambiguë
// ne peut pas faire lire au navigateur une autre commande que celle contrôlée ici).
// CDP :
//   - Target.createBrowserContext : proxyServer = egress de la session, proxyBypassList = <-loopback> (BINV2) ;
//   - Browser.setDownloadBehavior, Page.setDownloadBehavior : downloadPath = dossier de téléchargements de la session (BINV3) ;
//   - Browser.close : non transmis ; réponse au client puis libération de la session, raison `released` (BINV3).
// Playwright natif (même règle BINV2, extension de la liste de 04f § 4 au protocole natif) : `newContext` et
// `newContextForReuse` reçoivent le proxy de l'egress de la session, quel que soit le proxy demandé.
// Sans egress ou sans dossier de session connu, la commande concernée est refusée (fermé par défaut), jamais transmise.
// Audit de sécurité 5.3 (docs/audit-securite.md, S01 à S05), refus répondus au client, jamais transmis :
//   - Playwright : `newCDPSession` et `newBrowserCDPSession` (CDP brut hors réécritures, 409 shared contourné : BINV1),
//     `launch*` et `connect*` (lancement ou connexion sortante du serveur), `localPaths` et `localDirectory` ;
//   - CDP : `DOM.setFileInputFiles` hors de `sessions/{id}/uploads/`, `Tethering.*`, `Target.exposeDevToolsProtocol`,
//     `Browser.crash*` ;
//   - navigation pilotée (`Page.navigate`, `Target.createTarget`, `goto`) vers un autre schéma que http(s), about:, data:,
//     blob: (ni `file://` ni pages internes de Chromium) ;
//   - téléchargements : `allowAndName` (Page : `allow`) vers le dossier de la session, événements actifs, ou `deny`.
// Relecture de browser-v1 (docs/audit-securite.md § 9, S18 à S20) :
//   - Playwright `saveAs` (copie d'un artefact vers un chemin du NŒUD : écriture arbitraire) et `pathAfterFinished` (chemin
//     local) refusés ; un client distant utilise `saveAsStream` ;
//   - CDP `Target.sendMessageToTarget` refusé : son message imbriqué atteindrait la cible sans passer par ces réécritures
//     (les clients du marché utilisent le mode aplati, `flatten: true`) ;
//   - CDP `Input.dispatchDragEvent` : `data.files` soumis à la même règle que `DOM.setFileInputFiles`.
import { normalize } from 'node:path';

export type RewriteContext = { egressProxyUrl: string | null; downloadsDir: string | null };

export type RewriteResult =
  | { kind: 'forward'; text: string }
  | { kind: 'reply'; text: string; release: boolean }
  | { kind: 'reject'; code: 1007; reason: string };

const LOOPBACK_ONLY = '<-loopback>';
const DOWNLOAD_METHODS = new Set(['Browser.setDownloadBehavior', 'Page.setDownloadBehavior']);
const PLAYWRIGHT_CONTEXT_METHODS = new Set(['newContext', 'newContextForReuse']);
const DENIED_CDP_METHODS = new Set(['Tethering.bind', 'Tethering.unbind', 'Target.exposeDevToolsProtocol', 'Target.sendMessageToTarget', 'Browser.crash', 'Browser.crashGpuProcess']);
const DENIED_PLAYWRIGHT_METHODS = new Set(['newCDPSession', 'newBrowserCDPSession', 'launch', 'launchPersistentContext', 'launchServer', 'connectOverCDP', 'connect', 'saveAs', 'pathAfterFinished']);
const NAVIGATION_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:']);
const CDP_NAVIGATIONS = new Set(['Page.navigate', 'Target.createTarget']);

/** Navigation pilotée admise : URL absolue de schéma http(s), about:, data: ou blob: (jamais `file:` ni `chrome:`). */
function navigable(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return NAVIGATION_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Chemin absolu, normalisé, strictement sous `sessions/{id}/uploads/` (dossier frère des téléchargements). */
function insideUploads(path: unknown, downloadsDir: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  const uploads = `${downloadsDir.replace(/\/downloads\/?$/, '')}/uploads/`;
  return path === normalize(path) && path.startsWith(uploads) && path.length > uploads.length;
}

type Message = Record<string, unknown> & { id?: unknown; method?: unknown; params?: unknown };

function parse(text: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

const paramsOf = (message: Message): Record<string, unknown> =>
  message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params) ? { ...(message.params as Record<string, unknown>) } : {};

/** Réponse d'erreur au client ; en session aplatie, le `sessionId` est repris (sinon le client ne la rattache à rien). */
const cdpError = (request: Message, message: string): RewriteResult => ({
  kind: 'reply',
  text: JSON.stringify({ id: request.id, ...(typeof request['sessionId'] === 'string' ? { sessionId: request['sessionId'] } : {}), error: { code: -32000, message } }),
  release: false,
});

export function rewriteCdpMessage(text: string, ctx: RewriteContext): RewriteResult {
  const message = parse(text);
  if (!message) return { kind: 'reject', code: 1007, reason: 'message CDP illisible' };
  const method = message.method;
  if (typeof method === 'string' && DENIED_CDP_METHODS.has(method)) return cdpError(message, `${method} refusé par SYM Browser`);
  if (typeof method === 'string' && CDP_NAVIGATIONS.has(method) && !navigable(paramsOf(message)['url'])) return cdpError(message, 'schéma de navigation refusé par SYM Browser');
  if (method === 'DOM.setFileInputFiles') {
    const files = paramsOf(message)['files'];
    const downloadsDir = ctx.downloadsDir;
    if (!downloadsDir || !Array.isArray(files) || !files.every((file) => insideUploads(file, downloadsDir))) {
      return cdpError(message, 'fichiers hors des envois de la session (POST /v1/sessions/{id}/uploads)');
    }
    return { kind: 'forward', text: JSON.stringify(message) };
  }
  if (method === 'Input.dispatchDragEvent') {
    const data = paramsOf(message)['data'];
    const files = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)['files'] : undefined;
    if (files === undefined) return { kind: 'forward', text: JSON.stringify(message) };
    const downloadsDir = ctx.downloadsDir;
    if (!downloadsDir || !Array.isArray(files) || !files.every((file) => insideUploads(file, downloadsDir))) {
      return cdpError(message, 'fichiers hors des envois de la session (POST /v1/sessions/{id}/uploads)');
    }
    return { kind: 'forward', text: JSON.stringify(message) };
  }
  if (method === 'Target.createBrowserContext') {
    if (!ctx.egressProxyUrl) return cdpError(message, 'egress de la session indisponible');
    return { kind: 'forward', text: JSON.stringify({ ...message, params: { ...paramsOf(message), proxyServer: ctx.egressProxyUrl, proxyBypassList: LOOPBACK_ONLY } }) };
  }
  if (typeof method === 'string' && DOWNLOAD_METHODS.has(method)) {
    const params = paramsOf(message);
    if (params['behavior'] === 'deny') {
      const { downloadPath: _ignored, ...rest } = params;
      return { kind: 'forward', text: JSON.stringify({ ...message, params: rest }) };
    }
    // Tout autre comportement (allow, allowAndName, default, inconnu) : dossier de la session, nommage par guid et
    // événements actifs (plafonds de téléchargement tenus par le nœud, BINV3).
    if (!ctx.downloadsDir) return cdpError(message, 'dossier de téléchargements de la session indisponible');
    const forced = method === 'Browser.setDownloadBehavior' ? { behavior: 'allowAndName', downloadPath: ctx.downloadsDir, eventsEnabled: true } : { behavior: 'allow', downloadPath: ctx.downloadsDir };
    return { kind: 'forward', text: JSON.stringify({ ...message, params: { ...params, ...forced } }) };
  }
  if (method === 'Browser.close') return { kind: 'reply', text: JSON.stringify({ id: message.id, result: {} }), release: true };
  return { kind: 'forward', text: JSON.stringify(message) };
}

const playwrightError = (id: unknown, text: string): RewriteResult => ({ kind: 'reply', text: JSON.stringify({ id, error: { error: { name: 'Error', message: text } } }), release: false });

export function rewritePlaywrightMessage(text: string, ctx: RewriteContext): RewriteResult {
  const message = parse(text);
  if (!message) return { kind: 'reject', code: 1007, reason: 'message Playwright illisible' };
  const params = paramsOf(message);
  if (typeof message.method === 'string' && DENIED_PLAYWRIGHT_METHODS.has(message.method)) return playwrightError(message.id, `${message.method} refusé par SYM Browser (CDP : connectUrls.cdp des sessions dedicated)`);
  if ('localPaths' in params || 'localDirectory' in params) return playwrightError(message.id, 'chemins locaux du nœud refusés : envoyer le contenu des fichiers');
  if (message.method === 'goto' && !navigable(params['url'])) return playwrightError(message.id, 'schéma de navigation refusé par SYM Browser');
  if (typeof message.method === 'string' && PLAYWRIGHT_CONTEXT_METHODS.has(message.method)) {
    if (!ctx.egressProxyUrl) return playwrightError(message.id, 'egress de la session indisponible');
    return { kind: 'forward', text: JSON.stringify({ ...message, params: { ...params, proxy: { server: ctx.egressProxyUrl, bypass: LOOPBACK_ONLY } } }) };
  }
  return { kind: 'forward', text: JSON.stringify(message) };
}
