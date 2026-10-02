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

export type RewriteContext = { egressProxyUrl: string | null; downloadsDir: string | null };

export type RewriteResult =
  | { kind: 'forward'; text: string }
  | { kind: 'reply'; text: string; release: boolean }
  | { kind: 'reject'; code: 1007; reason: string };

const LOOPBACK_ONLY = '<-loopback>';
const DOWNLOAD_METHODS = new Set(['Browser.setDownloadBehavior', 'Page.setDownloadBehavior']);
const PLAYWRIGHT_CONTEXT_METHODS = new Set(['newContext', 'newContextForReuse']);

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

const cdpError = (id: unknown, message: string): RewriteResult => ({ kind: 'reply', text: JSON.stringify({ id, error: { code: -32000, message } }), release: false });

export function rewriteCdpMessage(text: string, ctx: RewriteContext): RewriteResult {
  const message = parse(text);
  if (!message) return { kind: 'reject', code: 1007, reason: 'message CDP illisible' };
  const method = message.method;
  if (method === 'Target.createBrowserContext') {
    if (!ctx.egressProxyUrl) return cdpError(message.id, 'egress de la session indisponible');
    return { kind: 'forward', text: JSON.stringify({ ...message, params: { ...paramsOf(message), proxyServer: ctx.egressProxyUrl, proxyBypassList: LOOPBACK_ONLY } }) };
  }
  if (typeof method === 'string' && DOWNLOAD_METHODS.has(method)) {
    const params = paramsOf(message);
    const allows = params['behavior'] === 'allow' || params['behavior'] === 'allowAndName';
    if (allows || 'downloadPath' in params) {
      if (!ctx.downloadsDir) return cdpError(message.id, 'dossier de téléchargements de la session indisponible');
      return { kind: 'forward', text: JSON.stringify({ ...message, params: { ...params, downloadPath: ctx.downloadsDir } }) };
    }
    return { kind: 'forward', text: JSON.stringify(message) };
  }
  if (method === 'Browser.close') return { kind: 'reply', text: JSON.stringify({ id: message.id, result: {} }), release: true };
  return { kind: 'forward', text: JSON.stringify(message) };
}

export function rewritePlaywrightMessage(text: string, ctx: RewriteContext): RewriteResult {
  const message = parse(text);
  if (!message) return { kind: 'reject', code: 1007, reason: 'message Playwright illisible' };
  if (typeof message.method === 'string' && PLAYWRIGHT_CONTEXT_METHODS.has(message.method)) {
    if (!ctx.egressProxyUrl) {
      return { kind: 'reply', text: JSON.stringify({ id: message.id, error: { error: { name: 'Error', message: 'egress de la session indisponible' } } }), release: false };
    }
    return { kind: 'forward', text: JSON.stringify({ ...message, params: { ...paramsOf(message), proxy: { server: ctx.egressProxyUrl, bypass: LOOPBACK_ONLY } } }) };
  }
  return { kind: 'forward', text: JSON.stringify(message) };
}
