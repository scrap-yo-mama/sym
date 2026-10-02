// SPDX-License-Identifier: AGPL-3.0-only
// Audit de sécurité 5.3 (cdc/sym-browser 06, 04f § 4 ; docs/audit-securite.md) : réécritures du relais du nœud.
// - S01 (BINV1, assert_session_isolation) : le protocole Playwright n'ouvre pas de CDP brut (`newCDPSession`,
//   `newBrowserCDPSession`) qui contournerait le refus 409 des sessions shared et toutes les réécritures CDP ;
//   ni lancement, ni connexion sortante du serveur Playwright (`launch*`, `connect*`).
// - S02 (BINV1/BINV3) : aucun fichier du nœud hors de `sessions/{id}/uploads/` n'est posé dans un champ fichier
//   (`DOM.setFileInputFiles`, `localPaths`/`localDirectory` du protocole Playwright).
// - S03 (BINV2, assert_session_egress_enforced) : navigation pilotée seulement vers http(s), about:, data: et blob: (ni
//   `file://`, ni `chrome://`, ni `devtools://`), en CDP comme en Playwright.
// - S04 (BINV3) : comportement de téléchargement figé sur le dossier de la session, événements actifs (plafonds tenus).
// - S05 : méthodes CDP sans usage client et dangereuses refusées (`Tethering.*`, `Target.exposeDevToolsProtocol`, crash).
import { describe, expect, test } from 'vitest';
import { rewriteCdpMessage, rewritePlaywrightMessage, type RewriteContext, type RewriteResult } from './rewrite.js';

const ROOT = '/data/sessions/3f1c2a10-0000-4000-8000-000000000001';
const ctx: RewriteContext = { egressProxyUrl: 'http://127.0.0.1:41000', downloadsDir: `${ROOT}/downloads` };
const cdp = (method: string, params: Record<string, unknown> = {}): RewriteResult => rewriteCdpMessage(JSON.stringify({ id: 7, method, params }), ctx);
const pw = (method: string, params: Record<string, unknown> = {}): RewriteResult => rewritePlaywrightMessage(JSON.stringify({ id: 9, guid: 'browser@1', method, params }), ctx);
const forwarded = (result: RewriteResult): Record<string, unknown> => {
  expect(result.kind).toBe('forward');
  return JSON.parse((result as { text: string }).text) as Record<string, unknown>;
};
const refused = (result: RewriteResult): void => {
  expect(result.kind).toBe('reply');
  const body = JSON.parse((result as { text: string }).text) as { error?: unknown; result?: unknown };
  expect(body.error).toBeDefined();
  expect(body.result).toBeUndefined();
};

describe('audit 5.3 S01 : assert_session_isolation, pas de CDP brut ni de lancement par le protocole Playwright', () => {
  test.each(['newCDPSession', 'newBrowserCDPSession', 'launch', 'launchPersistentContext', 'launchServer', 'connectOverCDP', 'connect'])('%s : refusé, rien transmis', (method) => {
    refused(pw(method, { page: { guid: 'page@1' } }));
  });
  test('les autres méthodes Playwright restent transmises (newPage, evaluateExpression)', () => {
    expect(forwarded(pw('newPage')).method).toBe('newPage');
    expect(forwarded(pw('evaluateExpression', { expression: '1+1' })).method).toBe('evaluateExpression');
  });
});

describe('audit 5.3 S02 : aucun fichier du nœud hors des envois de la session', () => {
  test('DOM.setFileInputFiles : chemins sous sessions/{id}/uploads/ transmis tels quels', () => {
    const files = [`${ROOT}/uploads/0b8f6a3c-1111-4000-8000-000000000002`];
    expect((forwarded(cdp('DOM.setFileInputFiles', { nodeId: 3, files })).params as { files: string[] }).files).toEqual(files);
  });
  test.each([
    ['/etc/passwd'],
    [`${ROOT}/uploads/../../3f1c2a10-0000-4000-8000-000000000009/profile/Cookies`],
    ['/data/sessions/3f1c2a10-0000-4000-8000-000000000009/uploads/x'],
    [`${ROOT}/uploads`],
    [`${ROOT}/profile/Cookies`],
    ['uploads/relatif'],
  ])('DOM.setFileInputFiles vers %s : refusé', (path) => {
    refused(cdp('DOM.setFileInputFiles', { nodeId: 3, files: [`${ROOT}/uploads/ok`, path] }));
  });
  test('DOM.setFileInputFiles sans dossier de session connu : refusé (fermé par défaut)', () => {
    refused(rewriteCdpMessage(JSON.stringify({ id: 1, method: 'DOM.setFileInputFiles', params: { files: ['/x'] } }), { egressProxyUrl: null, downloadsDir: null }));
  });
  test.each(['localPaths', 'localDirectory'])('Playwright setInputFiles avec %s : refusé', (key) => {
    refused(pw('setInputFiles', { selector: 'input', [key]: key === 'localPaths' ? ['/etc/passwd'] : '/etc' }));
  });
  test('Playwright setInputFiles avec payloads (cas normal d’un client distant) : transmis', () => {
    expect(forwarded(pw('setInputFiles', { selector: 'input', payloads: [{ name: 'a.txt', buffer: 'YQ==' }] })).method).toBe('setInputFiles');
  });
});

describe('audit 5.3 S03 : assert_session_egress_enforced, schémas de navigation pilotée', () => {
  test.each(['https://fixtures.local/', 'http://site-a.test:8080/x', 'about:blank', 'data:text/html,<p>x</p>'])('Page.navigate, Target.createTarget, goto vers %s : transmis', (url) => {
    expect(forwarded(cdp('Page.navigate', { url })).method).toBe('Page.navigate');
    expect(forwarded(cdp('Target.createTarget', { url })).method).toBe('Target.createTarget');
    expect(forwarded(pw('goto', { url })).method).toBe('goto');
  });
  test.each(['file:///etc/passwd', 'FILE:///etc/hostname', 'chrome://settings', 'devtools://devtools/bundled/inspector.html', 'view-source:file:///etc/passwd', 'chrome-untrusted://x', 'pas une url'])('vers %s : refusé en CDP et en Playwright', (url) => {
    refused(cdp('Page.navigate', { url }));
    refused(cdp('Target.createTarget', { url }));
    refused(pw('goto', { url }));
  });
});

describe('audit 5.3 S04 : téléchargements figés sur le dossier de la session', () => {
  test.each(['allow', 'allowAndName', 'default'])('Browser.setDownloadBehavior %s, eventsEnabled false : allowAndName, dossier de la session, événements actifs', (behavior) => {
    const params = forwarded(cdp('Browser.setDownloadBehavior', { behavior, downloadPath: '/tmp/ailleurs', eventsEnabled: false, browserContextId: 'C1' })).params;
    expect(params).toEqual({ behavior: 'allowAndName', downloadPath: `${ROOT}/downloads`, eventsEnabled: true, browserContextId: 'C1' });
  });
  test('Page.setDownloadBehavior default ou allow : allow vers le dossier de la session', () => {
    for (const behavior of ['default', 'allow']) expect(forwarded(cdp('Page.setDownloadBehavior', { behavior })).params).toEqual({ behavior: 'allow', downloadPath: `${ROOT}/downloads` });
  });
  test('deny : transmis tel quel', () => {
    expect(forwarded(cdp('Browser.setDownloadBehavior', { behavior: 'deny' })).params).toEqual({ behavior: 'deny' });
  });
});

describe('audit 5.3 : refus en session aplatie', () => {
  test('la réponse d’erreur reprend le sessionId de la commande (sinon le client CDP attend indéfiniment)', () => {
    const result = rewriteCdpMessage(JSON.stringify({ id: 4, sessionId: 'S1', method: 'Page.navigate', params: { url: 'file:///etc/passwd' } }), ctx);
    expect(result.kind).toBe('reply');
    expect(JSON.parse((result as { text: string }).text)).toMatchObject({ id: 4, sessionId: 'S1', error: { code: -32000 } });
  });
});

describe('audit 5.3 S05 : méthodes CDP dangereuses refusées', () => {
  test.each(['Tethering.bind', 'Tethering.unbind', 'Target.exposeDevToolsProtocol', 'Browser.crash', 'Browser.crashGpuProcess'])('%s : refusé', (method) => {
    refused(cdp(method, { port: 9222 }));
  });
});
