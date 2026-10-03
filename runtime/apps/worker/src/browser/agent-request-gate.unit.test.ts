// SPDX-License-Identifier: AGPL-3.0-only
// Garde de requêtes de l'agent (règle des deux, 19 §7, r6 R4 ; PA-01) : `agentRequestPolicy` branchée sur le crochet
// `checkRequest` du navigateur agentique. Navigation du cadre principal : URL venue de la page, du départ ou d'un gabarit ;
// écriture : refusée sans `allow_write_actions` ; toute requête : aucune valeur sensible. Le journal ne garde que des codes.
import { describe, expect, test } from 'vitest';
import type { BrowserRequestCheck } from './request-guard.js';
import { createAgentRequestGate } from './agent-request-gate.js';

const HOST = 'shop.zz-test.example';
const hop = (over: Partial<BrowserRequestCheck> & { url: string }): BrowserRequestCheck => ({ redirect: false, rootUrl: over.url, resourceType: 'Document', mainFrame: true, method: 'GET', ...over });
const gate = (over: Partial<Parameters<typeof createAgentRequestGate>[0]> = {}) =>
  createAgentRequestGate({
    phase: 'e5_e6',
    allowedHosts: [HOST],
    startUrl: `https://${HOST}/`,
    allowWriteActions: false,
    sensitiveValues: () => ['ZZ-SECRET-HEADER-VALUE'],
    domUrls: async () => [`https://${HOST}/produits?page=2`],
    ...over,
  });

describe('assert_agent_request_policy : garde du navigateur agentique', () => {
  test('navigation vers le départ, une URL du DOM : permise ; URL inconnue de la page : refusée et journalisée par code', async () => {
    const g = gate();
    expect(await g.check(hop({ url: `https://${HOST}/` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/produits?page=2` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/collect?d=abc` }))).toBe(false);
    expect(g.summary()).toEqual({ blocked: 1, reasons: ['url_not_from_page'] });
  });

  test('valeur sensible dans l’URL, même d’une sous-ressource : refusée ; sous-ressource ordinaire : permise', async () => {
    const g = gate();
    expect(await g.check(hop({ url: `https://${HOST}/static/app.js`, resourceType: 'Script', mainFrame: false }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/api/items?page=1`, resourceType: 'XHR', mainFrame: false }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/echo?h=ZZ-SECRET-HEADER-VALUE`, resourceType: 'Fetch', mainFrame: false }))).toBe(false);
    expect(g.summary().reasons).toEqual(['sensitive_value']);
  });

  test('écriture : refusée sans allow_write_actions (method_not_allowed), avec : seule la valeur sensible reste refusée', async () => {
    const closed = gate();
    expect(await closed.check(hop({ url: `https://${HOST}/submit`, method: 'POST', mainFrame: true }))).toBe(false);
    expect(await closed.check(hop({ url: `https://${HOST}/api/save`, method: 'POST', resourceType: 'XHR', mainFrame: false }))).toBe(false);
    expect(closed.summary()).toEqual({ blocked: 2, reasons: ['method_not_allowed', 'method_not_allowed'] });
    const open = gate({ allowWriteActions: true });
    expect(await open.check(hop({ url: `https://${HOST}/api/save`, method: 'POST', resourceType: 'XHR', mainFrame: false }))).toBe(true);
    expect(await open.check(hop({ url: `https://${HOST}/api/save?k=ZZ-SECRET-HEADER-VALUE`, method: 'POST', resourceType: 'XHR', mainFrame: false }))).toBe(false);
  });

  test('DOM illisible (échec fermé) : une navigation hors départ est refusée ; le journal ne contient ni URL ni valeur', async () => {
    const g = gate({ domUrls: async () => { throw new Error('page fermée'); } });
    expect(await g.check(hop({ url: `https://${HOST}/produits?page=2` }))).toBe(false);
    const dump = JSON.stringify(g.summary());
    expect(dump).not.toContain(HOST);
    expect(dump).not.toContain('ZZ-SECRET');
  });

  test('saut de redirection : seul le contrôle des valeurs sensibles et de la méthode s’applique (le verrou de domaines coupe les autres hôtes)', async () => {
    const g = gate();
    expect(await g.check(hop({ url: `https://${HOST}/produits/42`, redirect: true, rootUrl: `https://${HOST}/produits?page=2` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/x?d=ZZ-SECRET-HEADER-VALUE`, redirect: true, rootUrl: `https://${HOST}/produits?page=2` }))).toBe(false);
  });
});
