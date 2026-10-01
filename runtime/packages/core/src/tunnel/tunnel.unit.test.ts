// SPDX-License-Identifier: AGPL-3.0-only
// Tunnel WSS, noyau pur (tâche 2.7, 07 § 3, § 5, § 6, § 8) : schéma strict des messages, découpage ≤ 1 Mio et
// réassemblage (assert_ws_chunking_maxpayload), liste blanche CDP et refus du code distant (assert_cdp_allowlist,
// assert_no_remote_logic), détection de défi (07 § 5), garde d'écriture (write_action_blocked).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CDP_ALLOWLIST,
  CDP_FORBIDDEN_DOMAINS,
  checkCdpCommand,
  chunkResult,
  commandUrl,
  detectChallenge,
  detectResponseChallenge,
  htmlTitle,
  isActivationKey,
  isReplayableFetch,
  isSubmitKey,
  isWriteElement,
  isWriteTarget,
  parseExtensionFrame,
  parseFetchArgs,
  parseServerFrame,
  parseTunnelResult,
  ResultAssembler,
  TUNNEL_MAX_PAYLOAD,
} from './index.js';

const JOB = '4f3c8a0e-1b2c-4d5e-8f90-123456789abc';
const RUN = '0e1d2c3b-4a59-4687-9123-abcdefabcdef';

describe('messages : schéma strict', () => {
  test('hello, ping, result valides ; tout champ en plus ou type inconnu refusé', () => {
    expect(parseExtensionFrame(JSON.stringify({ type: 'hello', token: 'sy_ext_x', version: '0.1.0' }))).toEqual({ type: 'hello', token: 'sy_ext_x', version: '0.1.0' });
    expect(parseExtensionFrame('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(parseExtensionFrame(JSON.stringify({ type: 'result', job_id: JOB, seq: 0, last: true, data: '{}' }))).not.toBeNull();
    for (const bad of [
      { type: 'hello', token: 't', version: '1', owner_id: 'x' },
      { type: 'ping', extra: 1 },
      { type: 'result', job_id: 'pas-un-uuid', seq: 0, last: true, data: '' },
      { type: 'result', job_id: JOB, seq: -1, last: true, data: '' },
      { type: 'eval', code: '1+1' },
    ]) {
      expect(parseExtensionFrame(JSON.stringify(bad))).toBeNull();
    }
    expect(parseExtensionFrame('pas du json')).toBeNull();
  });

  test('commande : jeu fermé de quatre commandes, délai borné', () => {
    const cmd = { type: 'cmd', job_id: JOB, run_id: RUN, cmd: 'page_fetch', domain: 'monsite.com', args: { url: 'https://monsite.com/' }, timeout_ms: 30000, allow_write_actions: false };
    expect(parseServerFrame(JSON.stringify(cmd))).toMatchObject({ cmd: 'page_fetch' });
    expect(parseServerFrame(JSON.stringify({ ...cmd, cmd: 'eval' }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ ...cmd, timeout_ms: 10 ** 9 }))).toBeNull();
  });

  test('réponse : succès sans erreur, échec avec une erreur du jeu fermé', () => {
    expect(parseTunnelResult(JSON.stringify({ ok: true, error: null, ms: 3, snapshot_id: null, body: { a: 1 } }))).toMatchObject({ ok: true });
    expect(parseTunnelResult(JSON.stringify({ ok: false, error: 'challenge_in_tunnel', ms: 3, snapshot_id: null, body: null }))).toMatchObject({ error: 'challenge_in_tunnel' });
    expect(parseTunnelResult(JSON.stringify({ ok: true, error: 'stale_ref', ms: 3, snapshot_id: null, body: null }))).toBeNull();
    expect(parseTunnelResult(JSON.stringify({ ok: false, error: 'pwned', ms: 3, snapshot_id: null, body: null }))).toBeNull();
  });
});

describe('assert_ws_chunking_maxpayload : découpage ≤ 1 Mio, réassemblage exact', () => {
  test('réponse de page de 3 Mio (multioctets, échappements) : morceaux ≤ maxPayload, ordre strict, contenu identique', () => {
    const unit = 'é€😀"\\\n<div class="x">zz_test</div>\u0001';
    const page = unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length));
    const json = JSON.stringify({ ok: true, error: null, ms: 1, snapshot_id: null, body: { status: 200, headers: {}, body: page, url: 'https://monsite.com/' } });
    expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(3 * 1024 * 1024);
    const frames = chunkResult(JOB, json);
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const f of frames) expect(new TextEncoder().encode(f).byteLength).toBeLessThanOrEqual(TUNNEL_MAX_PAYLOAD);
    const assembler = new ResultAssembler();
    let out: ReturnType<ResultAssembler['push']> = { done: false };
    for (const f of frames) {
      const parsed = parseExtensionFrame(f);
      expect(parsed?.type).toBe('result');
      if (parsed?.type === 'result') out = assembler.push(parsed);
    }
    expect(out).toEqual({ done: true, text: json });
    expect(parseTunnelResult((out as { text: string }).text)?.body).toMatchObject({ body: page });
  });

  test('morceau hors d’ordre ou réponse trop grosse : refus', () => {
    const frames = chunkResult(JOB, 'x'.repeat(3000), 1024).map((f) => parseExtensionFrame(f)!) as { seq: number; last: boolean; data: string }[];
    const a = new ResultAssembler();
    expect(a.push(frames[1]!)).toEqual({ done: true, error: 'protocol' });
    const b = new ResultAssembler(100);
    expect(b.push(frames[0]!)).toEqual({ done: true, error: 'too_large' });
  });

  test('réponse vide : un seul message `last`', () => {
    const frames = chunkResult(JOB, '');
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toMatchObject({ seq: 0, last: true, data: '' });
  });
});

describe('assert_cdp_allowlist / assert_no_remote_logic : liste blanche CDP', () => {
  test('aucune méthode des domaines interdits ; Runtime.evaluate, callFunctionOn et Emulation absents', () => {
    for (const method of Object.keys(CDP_ALLOWLIST)) {
      const domain = method.split('.')[0]!;
      expect(['Page', 'Input', 'DOM', 'DOMSnapshot', 'Accessibility', 'Network']).toContain(domain);
      expect(CDP_FORBIDDEN_DOMAINS).not.toContain(domain);
    }
    for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Emulation.setUserAgentOverride', 'Page.addScriptToEvaluateOnNewDocument', 'Network.getCookies', 'Network.setCookie', 'DOM.setOuterHTML', 'Fetch.enable', 'Target.createTarget']) {
      expect(checkCdpCommand(method, {})).toMatchObject({ ok: false });
    }
  });

  test('page_script avec une chaîne de code ou un paramètre non permis : refus, rien n’est évalué', () => {
    expect(checkCdpCommand('Page.navigate', { url: 'javascript:alert(1)' })).toMatchObject({ ok: false });
    expect(checkCdpCommand('Page.navigate', { url: 'https://monsite.com/', expression: 'document.cookie' })).toMatchObject({ ok: false });
    expect(checkCdpCommand('DOM.querySelector', { nodeId: 1, selector: 'a', functionDeclaration: 'function(){}' })).toMatchObject({ ok: false });
    expect(checkCdpCommand('DOM.querySelector', { nodeId: 1, selector: { nested: true } })).toMatchObject({ ok: false });
    expect(checkCdpCommand('Page.setWebLifecycleState', { state: 'frozen' })).toMatchObject({ ok: false });
    expect(checkCdpCommand('Page.navigate', { url: 'https://monsite.com/page' })).toEqual({ ok: true });
    expect(checkCdpCommand('Input.insertText', { text: 'function() { return 1 }' })).toEqual({ ok: true }); // texte saisi, jamais exécuté
  });
});

describe('arguments de fetch : domaine, écriture, en-têtes d’identité', () => {
  test('URL hors domaine, schéma non web, identifiants : refus', () => {
    expect(commandUrl('https://evil.example/', 'monsite.com')).toBeNull();
    expect(commandUrl('https://monsite.com.evil.example/', 'monsite.com')).toBeNull();
    expect(commandUrl('file:///etc/passwd', 'monsite.com')).toBeNull();
    expect(commandUrl('https://u:p@monsite.com/', 'monsite.com')).toBeNull();
    expect(commandUrl('https://api.monsite.com/x', 'monsite.com')?.hostname).toBe('api.monsite.com');
  });

  test('écriture sans allow_write_actions, en-têtes Cookie/Origin/User-Agent : refus', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(parseFetchArgs({ url: 'https://monsite.com/x', method, body: '{}' }, 'monsite.com', false), method).toMatchObject({ ok: false, error: 'write_action_blocked' });
      expect(parseFetchArgs({ url: 'https://monsite.com/x', method, body: '{}' }, 'monsite.com', true), method).toMatchObject({ ok: true });
    }
    for (const name of ['Cookie', 'origin', 'User-Agent', 'Referer', 'sec-ch-ua']) {
      expect(parseFetchArgs({ url: 'https://monsite.com/x', headers: { [name]: 'v' } }, 'monsite.com', false)).toMatchObject({ ok: false });
    }
    expect(parseFetchArgs({ url: 'https://evil.example/x' }, 'monsite.com', false)).toMatchObject({ ok: false, error: 'domain_not_allowed' });
  });

  test('correctif 1 : POST déclaratif (recherche, GraphQL, 04b l.66) accepté sans allow_write_actions, jamais rejoué', () => {
    const search = parseFetchArgs({ url: 'https://api.monsite.com/search', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"x","offset":0}' }, 'monsite.com', false);
    expect(search).toMatchObject({ ok: true, args: { method: 'POST' } });
    expect(isReplayableFetch({ method: 'POST' })).toBe(false);
    expect(isReplayableFetch({ method: 'OPTIONS' })).toBe(false);
    expect(isReplayableFetch({ method: 'GET' })).toBe(true);
    expect(isReplayableFetch({ method: 'HEAD' })).toBe(true);
  });
});

describe('défi dans le tunnel (07 § 5)', () => {
  const fixture =
    '<!doctype html><html><head><title>Security check</title><meta name="zz-test-challenge" content="generic-interstitial"></head><body><main id="zz-test-challenge"><h1>Security check</h1><p>Please verify you are human to continue.</p><label><input type="checkbox" disabled> I am not a robot</label></main></body></html>';

  test('page de défi simulée (titre, phrase), en-tête cf-mitigated, widget connu : détectés', () => {
    expect(detectChallenge({ status: 403, title: htmlTitle(fixture), text: fixture })).toBe(true);
    expect(detectChallenge({ status: 200, text: fixture })).toBe(true);
    expect(detectChallenge({ status: 403, headers: { 'cf-mitigated': 'challenge' } })).toBe(true);
    expect(detectChallenge({ status: 200, text: '<script src="https://www.google.com/recaptcha/api.js"></script><div class="g-recaptcha"></div>' })).toBe(true);
    expect(detectChallenge({ status: 200, text: '- RootWebArea "Just a moment..."', title: 'Just a moment...' })).toBe(true);
  });

  test('page ordinaire, 403 sans défi, site protégé sans défi : non détectés', () => {
    expect(detectChallenge({ status: 200, title: 'Catalogue', text: '<html><body><article class="product">x</article></body></html>' })).toBe(false);
    expect(detectChallenge({ status: 403, title: 'Forbidden', text: '<h1>403 Forbidden</h1>' })).toBe(false);
    expect(detectChallenge({ status: 200, headers: { 'x-datadome': 'protected' }, text: '<p>ok</p>' })).toBe(false);
  });

  test('correctif 3 : défi rendu en JSON (XHR DataDome, 403 + captcha-delivery.com) détecté ; JSON ordinaire non', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/zz_test_datadome_xhr_403.json', import.meta.url), 'utf8')) as { status: number; headers: Record<string, string>; body: string; url: string };
    expect(detectResponseChallenge(fixture)).toBe(true);
    // Corps seul (en-tête retiré par un intermédiaire) ou en-tête seul sur un 403 : toujours un défi.
    expect(detectResponseChallenge({ ...fixture, headers: { 'content-type': 'application/json' } })).toBe(true);
    expect(detectResponseChallenge({ ...fixture, body: '{}' })).toBe(true);
    expect(detectResponseChallenge({ status: 429, headers: { 'content-type': 'application/json' }, body: '{"captcha":"https://www.google.com/recaptcha/api.js"}', url: fixture.url })).toBe(true);
    expect(detectResponseChallenge({ status: 200, headers: { 'content-type': 'application/json', 'x-datadome': 'protected' }, body: '{"ads":[]}', url: fixture.url })).toBe(false);
    expect(detectResponseChallenge({ status: 403, headers: { 'content-type': 'application/json' }, body: '{"error":"forbidden"}', url: fixture.url })).toBe(false);
  });
});

describe('garde d’écriture (write_action_blocked)', () => {
  test('boutons d’envoi, d’achat, de suppression (fr, en) : écriture ; navigation : lecture', () => {
    for (const name of ['Submit', 'Envoyer', 'Buy now', 'Acheter', 'Supprimer le compte', 'Place order', 'Publier', 'Add to cart']) {
      expect(isWriteTarget({ role: 'button', name }), name).toBe(true);
    }
    for (const name of ['Next page', 'Page suivante', 'Load more', 'Voir plus', 'Books', 'Search']) {
      expect(isWriteTarget({ role: 'button', name }), name).toBe(false);
    }
    expect(isWriteTarget({ role: 'heading', name: 'Submit your idea' })).toBe(false);
    expect(isWriteTarget({ role: 'button', name: 'Go', submit: true })).toBe(true);
    expect(isSubmitKey('Enter')).toBe(true);
    expect(isSubmitKey('a', 'KeyA')).toBe(false);
  });

  test('correctifs 7 et 13 : touches qui activent un bouton ou envoient un formulaire (Entrée, Espace, \\r, \\n, 13, 32)', () => {
    for (const p of [
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyDown', code: 'NumpadEnter' },
      { type: 'char', text: '\r' },
      { type: 'char', text: '\n' },
      { type: 'keyDown', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'rawKeyDown', windowsVirtualKeyCode: 13 },
      { type: 'keyDown', key: ' ', code: 'Space' },
      { type: 'keyUp', key: ' ' },
      { type: 'char', text: ' ' },
      { type: 'keyDown', windowsVirtualKeyCode: 32 },
      { type: 'keyDown', key: 'Spacebar' },
    ]) {
      expect(isActivationKey(p), JSON.stringify(p)).toBe(true);
    }
    for (const p of [{ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }, { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown' }, { type: 'keyDown', key: 'Tab', code: 'Tab' }]) {
      expect(isActivationKey(p), JSON.stringify(p)).toBe(false);
    }
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: [] })).toBe(true);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['type', 'submit'] })).toBe(true);
    expect(isWriteElement({ nodeName: 'INPUT', attributes: ['type', 'image'] })).toBe(true);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['type', 'button'] })).toBe(false);
    expect(isWriteElement({ nodeName: 'INPUT', attributes: ['type', 'text'] })).toBe(false);
    expect(isWriteElement({ nodeName: 'A', attributes: ['href', '/next'] })).toBe(false);
    // Bouton sans type (ou au type invalide, qui vaut submit en HTML) : il n'envoie que le formulaire qui le possède.
    // Contexte inconnu = dans un formulaire (fermé) ; hors de tout formulaire et sans attribut `form` : lecture.
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: [] }, { inForm: true })).toBe(true);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['type', 'zz'] }, { inForm: true })).toBe(true);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['class', 'more'] }, { inForm: false })).toBe(false);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['type', 'zz'] }, { inForm: false })).toBe(false);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['form', 'checkout'] }, { inForm: false })).toBe(true);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['type', 'submit'] }, { inForm: false })).toBe(true);
    expect(isWriteElement({ nodeName: 'BUTTON', attributes: ['type', 'reset'] }, { inForm: true })).toBe(false);
  });
});
