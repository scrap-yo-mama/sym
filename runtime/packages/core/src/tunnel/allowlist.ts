// SPDX-License-Identifier: AGPL-3.0-only
// Liste blanche CDP du tunnel (07 §3), FIGÉE et versionnée : toute addition passe en revue (`assert_cdp_allowlist`).
// Domaines `Page`, `Input`, `DOM`, `DOMSnapshot`, `Accessibility`, et `Network` en lecture seule. Méthode par méthode,
// avec les seuls paramètres permis : aucun paramètre ne transporte de code (`expression`, `functionDeclaration`,
// `source`…), aucune méthode n'écrit le DOM ni ne modifie le profil du navigateur. Interdits en particulier :
// `Runtime.*` (dont `Runtime.evaluate` et `Runtime.callFunctionOn`), tout `Emulation.*` ([_exclusions] X2),
// `Page.addScriptToEvaluateOnNewDocument`, `Page.setBypassCSP`, `Network.getCookies` / `setCookie` / `setUserAgentOverride`
// / `setExtraHTTPHeaders`, `Fetch.*`, `Debugger.*`, `Target.*`, `Storage.*`, `DOM.set*` / `DOM.remove*`.
// L'extension n'envoie AUCUNE autre méthode à `chrome.debugger.sendCommand`, y compris pour son propre usage.

export const CDP_ALLOWLIST_VERSION = 1;

/** Méthode CDP permise → noms des paramètres permis (tout autre paramètre : `method_not_allowed`). */
export const CDP_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Page : navigation et cycle de vie (jamais de script injecté).
  'Page.enable': [],
  'Page.navigate': ['url'],
  'Page.reload': ['ignoreCache'],
  'Page.stopLoading': [],
  'Page.getFrameTree': [],
  'Page.getLayoutMetrics': [],
  'Page.getNavigationHistory': [],
  'Page.setWebLifecycleState': ['state'],
  // DOM : lecture, focus, défilement (aucune écriture).
  'DOM.enable': [],
  'DOM.getDocument': ['depth', 'pierce'],
  'DOM.querySelector': ['nodeId', 'selector'],
  'DOM.querySelectorAll': ['nodeId', 'selector'],
  'DOM.getOuterHTML': ['nodeId', 'backendNodeId'],
  'DOM.describeNode': ['nodeId', 'backendNodeId', 'depth'],
  'DOM.getAttributes': ['nodeId'],
  'DOM.getBoxModel': ['nodeId', 'backendNodeId'],
  'DOM.getNodeForLocation': ['x', 'y', 'includeUserAgentShadowDOM', 'ignorePointerEventsNone'],
  'DOM.scrollIntoViewIfNeeded': ['nodeId', 'backendNodeId'],
  'DOM.focus': ['nodeId', 'backendNodeId'],
  // DOMSnapshot et Accessibility : lecture de la page.
  'DOMSnapshot.captureSnapshot': ['computedStyles'],
  'Accessibility.enable': [],
  'Accessibility.getFullAXTree': ['depth'],
  'Accessibility.getPartialAXTree': ['nodeId', 'backendNodeId', 'fetchRelatives'],
  'Accessibility.queryAXTree': ['nodeId', 'backendNodeId', 'accessibleName', 'role'],
  // Input : clic, frappe, défilement (le garde d'écriture s'applique avant l'envoi).
  'Input.dispatchMouseEvent': ['type', 'x', 'y', 'button', 'buttons', 'clickCount', 'deltaX', 'deltaY', 'modifiers'],
  'Input.dispatchKeyEvent': ['type', 'key', 'code', 'text', 'modifiers', 'windowsVirtualKeyCode'],
  'Input.insertText': ['text'],
  // Network en lecture seule : événements de réponse (statut, en-têtes) de la navigation, rien d'autre.
  'Network.enable': [],
  'Network.disable': [],
});

/** Événements CDP lus par l'extension (lecture seule, jamais envoyés) : statut et en-têtes du document de navigation. */
export const CDP_ALLOWED_EVENTS: readonly string[] = Object.freeze(['Network.responseReceived']);

/** Domaines CDP dont aucune méthode n'est jamais permise. */
export const CDP_FORBIDDEN_DOMAINS = Object.freeze(['Runtime', 'Emulation', 'Debugger', 'Target', 'Fetch', 'Storage', 'Browser', 'ServiceWorker', 'Security', 'Overlay', 'IO', 'Profiler', 'HeapProfiler']);

/** Noms de paramètres qui transportent du code : refusés partout, même pour une méthode permise. */
const CODE_PARAMS = new Set(['expression', 'functionDeclaration', 'source', 'scriptSource', 'script', 'arguments', 'objectId', 'executionContextId']);

export function isCdpMethodAllowed(method: string): boolean {
  return Object.hasOwn(CDP_ALLOWLIST, method);
}

export type CdpCommandVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Chaîne qui ressemble à du code ou à un lien exécutable (`javascript:`, `data:text/html`…). */
export function looksLikeCode(value: string): boolean {
  return /^\s*(javascript|vbscript|data)\s*:/i.test(value) || /\bfunction\s*\(|=>|\beval\s*\(|new\s+Function\s*\(|<script\b/i.test(value);
}

/**
 * Contrôle d'une commande CDP avant envoi : méthode dans la liste, paramètres permis seulement, valeurs scalaires
 * bornées (sélecteurs, texte, URL), aucune chaîne de code. Les contrôles de domaine (URL de `Page.navigate`) et
 * d'écriture (clic, touche Entrée) sont faits par l'exécuteur qui connaît le domaine et `allow_write_actions`.
 */
export function checkCdpCommand(method: unknown, params: unknown): CdpCommandVerdict {
  if (typeof method !== 'string' || !isCdpMethodAllowed(method)) return { ok: false, reason: 'méthode CDP hors liste' };
  if (params === undefined) return { ok: true };
  if (!isRecord(params)) return { ok: false, reason: 'paramètres : objet attendu' };
  const allowed = CDP_ALLOWLIST[method] ?? [];
  for (const [key, value] of Object.entries(params)) {
    if (CODE_PARAMS.has(key) || !allowed.includes(key)) return { ok: false, reason: `paramètre non permis : ${key}` };
    if (typeof value === 'string') {
      if (value.length > 4096) return { ok: false, reason: `paramètre trop long : ${key}` };
      // `Input.insertText` / `dispatchKeyEvent` portent du texte saisi, jamais exécuté ; tout autre texte est vérifié.
      if (key !== 'text' && looksLikeCode(value)) return { ok: false, reason: `chaîne de code refusée : ${key}` };
    } else if (!(typeof value === 'number' && Number.isFinite(value)) && typeof value !== 'boolean') {
      return { ok: false, reason: `paramètre non scalaire : ${key}` };
    }
  }
  if (method === 'Page.setWebLifecycleState' && params['state'] !== 'active') return { ok: false, reason: 'seul l’état active est permis' };
  return { ok: true };
}
