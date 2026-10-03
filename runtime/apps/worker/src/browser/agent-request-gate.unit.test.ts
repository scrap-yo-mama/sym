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

describe('assert_agent_request_policy : trafic de la page, E4/E5 sans agent, formulaires, départ à paramètres (fix-pa01)', () => {
  const many = Array.from({ length: 12 }, (_, i) => `p${i}=1`).join('&');

  test('point 2 : le XHR propre de la page (plus de 10 paramètres, paramètre long) n’est ni coupé ni compté ; seule une valeur sensible l’est', async () => {
    const g = gate();
    expect(await g.check(hop({ url: `https://${HOST}/graphql?${many}`, resourceType: 'XHR', mainFrame: false }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/graphql?variables=${'a'.repeat(400)}`, resourceType: 'Fetch', mainFrame: false }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/api/items?page=2`, redirect: true, rootUrl: `https://${HOST}/api/items?page=1`, resourceType: 'XHR', mainFrame: false }))).toBe(true);
    expect(g.summary()).toEqual({ blocked: 0, reasons: [] });
    expect(await g.check(hop({ url: `https://${HOST}/m?d=ZZ-SECRET-HEADER-VALUE`, resourceType: 'XHR', mainFrame: false }))).toBe(false);
    expect(g.summary().reasons).toEqual(['sensitive_value']);
  });

  test('point 2 : sans geste d’agent (E4 par navigateur, étapes code de E5), la navigation et l’écriture de la page ne changent pas de régime', async () => {
    const g = gate({ phase: 'e4_extract', agentActive: false, allowWriteActions: true });
    expect(await g.check(hop({ url: `https://${HOST}/liste?x=1` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/api/save`, method: 'POST', resourceType: 'XHR', mainFrame: false }))).toBe(true);
    expect(g.summary().blocked).toBe(0);
    const act = gate({ agentActive: false });
    expect(act.isAgentActive()).toBe(false);
    expect(await act.check(hop({ url: `https://${HOST}/hors-page` }))).toBe(true);
    act.setAgentActive(true);
    expect(await act.check(hop({ url: `https://${HOST}/hors-page-2` }))).toBe(false);
    expect(act.summary().reasons).toEqual(['url_not_from_page']);
  });

  test('point 3 : un document de cadre enfant (formulaire target=iframe) subit la politique complète ; une valeur tapée hors liste est refusée', async () => {
    const g = gate({ domUrls: async () => [`https://${HOST}/search?q=`] });
    expect(await g.check(hop({ url: `https://${HOST}/search?q=donnee-hors-liste-42x`, mainFrame: false }))).toBe(false);
    expect(g.summary().reasons).toEqual(['param_value_untrusted']);
    expect(await g.check(hop({ url: `https://${HOST}/search?q=`, mainFrame: false }))).toBe(true);
  });

  test('point 9 : URL de départ à paramètres = URL connue ; une valeur libre sur ses clés par goto est refusée, la pagination reste permise', async () => {
    const g = gate({ startUrl: `https://${HOST}/search?q=chaise&page=1`, domUrls: async () => [] });
    expect(await g.check(hop({ url: `https://${HOST}/search?q=chaise&page=1` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/search?q=chaise&page=2` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/search?q=item-d-une-autre-api` }))).toBe(false);
    expect(g.summary().reasons).toEqual(['param_value_untrusted']);
  });

  test('points 9 et 6 : goto littéral = URL connue ; vrai gabarit {param} = valeurs contrôlées (entrée du run ou nombre)', async () => {
    const g = gate({ startUrl: `https://${HOST}/`, domUrls: async () => [], templates: [`https://${HOST}/fiche?id=7`, `https://${HOST}/search?q={q}`], runInputs: { q: 'chaise' } });
    expect(await g.check(hop({ url: `https://${HOST}/fiche?id=7` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/fiche?id=autre-valeur` }))).toBe(false);
    expect(await g.check(hop({ url: `https://${HOST}/search?q=chaise` }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/search?q=item-d-une-autre-api` }))).toBe(false);
  });

  test('point 10 : le corps d’une écriture autorisée est contrôlé (valeur sensible refusée, corps ordinaire permis)', async () => {
    const g = gate({ allowWriteActions: true });
    expect(await g.check(hop({ url: `https://${HOST}/api/save`, method: 'POST', resourceType: 'XHR', mainFrame: false, body: 'a=1&b=ok' }))).toBe(true);
    expect(await g.check(hop({ url: `https://${HOST}/api/save`, method: 'POST', resourceType: 'XHR', mainFrame: false, body: '{"k":"ZZ-SECRET-HEADER-VALUE"}' }))).toBe(false);
    expect(g.summary().reasons).toEqual(['sensitive_value']);
  });

  test('point 1 : le journal porte au moins autant de refus d’écriture que la barrière en a vu, sans double compte', async () => {
    const g = gate();
    g.ensureWriteRefusals(1);
    expect(g.summary()).toEqual({ blocked: 1, reasons: ['method_not_allowed'] });
    g.ensureWriteRefusals(1);
    expect(g.summary().blocked).toBe(1);
    expect(await g.check(hop({ url: `https://${HOST}/submit`, method: 'POST' }))).toBe(false);
    g.ensureWriteRefusals(2);
    expect(g.summary()).toEqual({ blocked: 2, reasons: ['method_not_allowed', 'method_not_allowed'] });
  });
});
