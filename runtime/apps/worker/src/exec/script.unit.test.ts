// SPDX-License-Identifier: AGPL-3.0-only
// Pont `ctx.page.*` (tâche 1.6, D-29) sans navigateur : liste fermée, validation des demandes, imputation des requêtes
// coupées. Le comportement sur un vrai Chromium est dans tests/browser/executors.security.test.ts.
import type { SandboxViolation } from '@runtime/core';
import { SsrfGuard, createSsrfPolicy } from '@runtime/core/net';
import { describe, expect, test } from 'vitest';
import { createPageBridge, hostViolationWatch, issuedForWatch, PAGE_OPERATIONS } from './script.js';

const guard = new SsrfGuard({ policy: createSsrfPolicy({}) });

describe('ctx.page : pont de l’hôte', () => {
  const bridge = createPageBridge({
    page: undefined as never,
    guard,
    allowedHosts: ['zz_test_api.example'],
    maxResponseBytes: 1000,
    maxItems: 5,
    timeoutMs: 1000,
    watch: hostViolationWatch(),
    allowWriteActions: false,
  });

  test('liste fermée figée', () => {
    expect(PAGE_OPERATIONS).toEqual(['goto', 'url', 'waitForSelector', 'content', 'textAll', 'attrAll', 'click', 'evaluate']);
    expect(Object.isFrozen(PAGE_OPERATIONS)).toBe(true);
  });

  test.each([
    ['opération inconnue', { op: 'route', args: {} }],
    ['opération héritée', { op: 'constructor', args: {} }],
    ['arguments absents', { op: 'url' }],
    ['schéma file:', { op: 'goto', args: { url: 'file:///etc/passwd' } }],
    ['identifiants dans l’url', { op: 'goto', args: { url: 'https://u:p@zz_test_api.example/' } }],
    ['sélecteur vide', { op: 'textAll', args: { selector: '' } }],
    ['attribut invalide', { op: 'attrAll', args: { selector: 'a', name: 'on click' } }],
  ])('%s → invalid_bridge_call (violation)', async (_name, request) => {
    await expect(bridge(JSON.stringify(request))).rejects.toMatchObject({ code: 'invalid_bridge_call', violation: true });
  });

  test('JSON invalide ou non-chaîne → invalid_bridge_call', async () => {
    await expect(bridge('{')).rejects.toMatchObject({ code: 'invalid_bridge_call', violation: true });
    await expect(bridge({ op: 'url', args: {} })).rejects.toMatchObject({ code: 'invalid_bridge_call', violation: true });
  });

  test('goto hors des domaines de l’API → domain_not_allowed (violation), avant toute navigation', async () => {
    await expect(bridge(JSON.stringify({ op: 'goto', args: { url: 'https://zz_test_evil.example/x' } }))).rejects.toMatchObject({
      code: 'domain_not_allowed',
      violation: true,
      detail: 'zz_test_evil.example',
    });
  });
});

describe('imputation des requêtes coupées (hostViolationWatch)', () => {
  const setup = () => {
    const seen: SandboxViolation[] = [];
    const w = hostViolationWatch();
    w.watch((v) => seen.push(v));
    return { w, seen };
  };

  test('avant le premier evaluate : requêtes du site ignorées ; pendant evaluate : violation à la première', () => {
    const { w, seen } = setup();
    w.report('zz_test_analytics.example', 'domain_not_allowed', false);
    expect(seen).toEqual([]);
    w.beginEvaluate();
    expect(w.armed()).toBe(true);
    w.report('zz_test_internal.example', 'domain_not_allowed', true);
    expect(seen).toEqual([{ reason: 'domain_not_allowed', detail: 'zz_test_internal.example' }]);
    expect(w.imputed()).toBe(1);
    expect(w.lastImputed()).toEqual({ reason: 'domain_not_allowed', detail: 'zz_test_internal.example' });
  });

  test('ligne de base : un tiers du site (requête émise guet désarmé) n’est jamais imputé au script', () => {
    const { w, seen } = setup();
    // Chargement de la page de départ : mesure d'audience et CDN du site, émis guet désarmé.
    w.beginHostOp();
    w.report('zz_test_cdn.example', 'domain_not_allowed', false);
    w.endHostOp();
    w.report('ZZ_TEST_ANALYTICS.example.', 'domain_not_allowed', false);
    w.beginEvaluate();
    w.endEvaluate();
    // Après evaluate : minuterie de mesure d'audience, image chargée au défilement sur le même CDN (émises guet armé).
    w.report('zz_test_analytics.example', 'domain_not_allowed', true);
    w.report('zz_test_cdn.example', 'domain_not_allowed', true);
    // Nouveau document validé : guet désarmé, sous-ressources tierces de la nouvelle page apprises.
    w.beginHostOp();
    w.documentCommitted();
    expect(w.armed()).toBe(false);
    w.report('zz_test_other_cdn.example', 'domain_not_allowed', false);
    w.endHostOp();
    w.report('zz_test_late_tag.example', 'domain_not_allowed', false);
    // Refus sans requête Chromium (proxy d'egress) guet désarmé : ignoré, jamais appris.
    w.report('zz_test_unlearned.example');
    expect(seen).toEqual([]);
    expect(w.imputed()).toBe(0);
    // Le code du script entre à nouveau : un hôte inconnu du site est imputé, même après le retour d'evaluate.
    w.beginEvaluate();
    w.endEvaluate();
    w.report('zz_test_other_cdn.example', 'domain_not_allowed', true);
    expect(seen).toEqual([]);
    w.report('zz_test_unlearned.example');
    expect(seen).toEqual([{ reason: 'domain_not_allowed', detail: 'zz_test_unlearned.example' }]);
  });

  test('assert_sandbox (blanchiment) : un hôte contacté par le code injecté pendant un clic ou une navigation de l’hôte n’entre jamais dans la ligne de base', () => {
    const { w, seen } = setup();
    w.beginEvaluate();
    w.endEvaluate();
    // Clic de l'hôte (sélecteur absent) : le code injecté contacte l'hôte d'exfiltration pendant l'attente.
    w.beginHostOp();
    w.report('zz_test_exfil.example', 'domain_not_allowed', true);
    w.endHostOp();
    expect(seen).toEqual([{ reason: 'domain_not_allowed', detail: 'zz_test_exfil.example' }]);
    // Navigation de l'hôte : l'ancien document vit jusqu'à la validation du nouveau ; une requête émise avant, reçue
    // après la validation, reste imputée (état relevé à l'émission).
    w.beginHostOp();
    w.documentCommitted();
    w.endHostOp();
    w.report('zz_test_exfil2.example', 'domain_not_allowed', true);
    expect(seen).toHaveLength(2);
    // Navigation dans le document (pushState) ou restauration du cache : jamais de documentCommitted, le guet reste armé.
    w.beginEvaluate();
    w.endEvaluate();
    w.report('zz_test_exfil3.example');
    expect(seen).toHaveLength(3);
  });

  test('assert_sandbox (blanchiment) : un saut de redirection, une requête de la stratégie (ctx.page.goto, clic) ou une navigation du cadre principal émis guet désarmé n’entrent jamais dans la ligne de base', () => {
    const { w, seen } = setup();
    const none = { redirectHop: false, strategy: false, mainNavigation: false };
    // Avant tout evaluate : ctx.page.goto vers une redirection ouverte (saut hors API), navigation d'un clic du script.
    w.report('zz_test_hop.example', 'domain_not_allowed', issuedForWatch(false, { redirectHop: true, strategy: true, mainNavigation: true }));
    w.report('zz_test_strategy.example', 'domain_not_allowed', issuedForWatch(false, { ...none, strategy: true }));
    w.report('zz_test_nav.example', 'domain_not_allowed', issuedForWatch(false, { ...none, mainNavigation: true }));
    w.report('zz_test_site_hop.example', 'domain_not_allowed', issuedForWatch(false, { ...none, redirectHop: true }));
    // Témoin : sous-ressource tierce du site, émise guet désarmé, apprise.
    w.report('zz_test_cdn.example', 'domain_not_allowed', issuedForWatch(false, none));
    expect(seen).toEqual([]);
    // Le code du script entre dans la page puis exfiltre vers chacun : seul le tiers du site reste hors verdict.
    w.beginEvaluate();
    w.endEvaluate();
    for (const h of ['zz_test_hop.example', 'zz_test_strategy.example', 'zz_test_nav.example', 'zz_test_site_hop.example', 'zz_test_cdn.example']) {
      w.report(h, 'domain_not_allowed', issuedForWatch(true, none));
    }
    expect(seen.map((v) => v.detail)).toEqual(['zz_test_hop.example', 'zz_test_strategy.example', 'zz_test_nav.example', 'zz_test_site_hop.example']);
    // Émis guet armé ou sans état relevé : inchangé.
    expect(issuedForWatch(true, { redirectHop: true, strategy: true, mainNavigation: true })).toBe(true);
    expect(issuedForWatch(undefined, none)).toBeUndefined();
  });

  test('assert_write_action_blocked (imputation) : un evaluate en vol pendant une navigation de l’hôte garde le verdict ; soumission coupée imputée dès qu’un code ou un clic du script est en jeu', () => {
    const { w, seen } = setup();
    w.report('zz_test_site_form.example', 'write_action_blocked', false);
    expect(seen).toEqual([]);
    w.beginHostOp();
    w.report('zz_test_site_form.example', 'write_action_blocked', false);
    w.endHostOp();
    w.beginEvaluate();
    w.beginHostOp();
    w.report('zz_test_internal.example', 'domain_not_allowed', true);
    w.endHostOp();
    w.documentCommitted();
    expect(w.armed()).toBe(true);
    w.endEvaluate();
    expect(seen).toEqual([
      { reason: 'write_action_blocked', detail: 'zz_test_site_form.example' },
      { reason: 'domain_not_allowed', detail: 'zz_test_internal.example' },
    ]);
  });
});

// Revue de 1.7 (INV6, X3) : seule la navigation demandée par l'hôte (`ctx.page.goto`, dispatch d'un clic du script) est
// acceptée. Une navigation du cadre principal qui chevauche un `ctx.page.evaluate` ou l'attente du sélecteur d'un clic
// peut venir de la page elle-même (défi muet qui pose son cookie puis recharge) : attendre ne franchit jamais un défi.
describe('assert_no_circumvention (navigations du cadre principal en E3 script)', () => {
  test('pendant un evaluate, sans navigation attendue : refusée ; seule la navigation attendue est acceptée, une fois', () => {
    const w = hostViolationWatch();
    w.beginEvaluate();
    expect(w.claimNavigation()).toBe(false);
    w.expectNavigation();
    expect(w.claimNavigation()).toBe(true);
    expect(w.claimNavigation()).toBe(false);
    w.endEvaluate();
    expect(w.claimNavigation()).toBe(false);
  });

  test('clic : navigation lancée par la page pendant l’attente du sélecteur → refusée ; seule celle du dispatch du clic est acceptée', async () => {
    const w = hostViolationWatch();
    const claims: [string, boolean][] = [];
    /** La page se recharge d'elle-même pendant une attente (défi muet). */
    const reload = () => void claims.push(['attente', w.claimNavigation()]);
    /** Le clic part : sa navigation est émise. */
    const dispatch = () => void claims.push(['clic', w.claimNavigation()]);
    const handle = {
      evaluate: async () => false,
      click: async (o: { trial?: boolean }) => (o.trial === true ? reload() : dispatch()),
      dispose: async () => undefined,
    };
    const page = {
      url: () => 'https://zz_test_api.example/',
      locator: () => ({ first: () => ({ evaluate: async () => false }) }),
      waitForSelector: async () => {
        reload();
        return handle;
      },
      // Attente de l'élément et clic en un seul appel.
      click: async () => {
        reload();
        dispatch();
      },
    };
    const bridge = createPageBridge({ page: page as never, guard, allowedHosts: ['zz_test_api.example'], maxResponseBytes: 1000, maxItems: 5, timeoutMs: 1000, watch: w, allowWriteActions: false });
    await bridge(JSON.stringify({ op: 'click', args: { selector: 'a.next', timeoutMs: 3000 } }));
    expect(claims.filter(([k]) => k === 'attente').every(([, ok]) => !ok)).toBe(true);
    expect(claims.filter(([k]) => k === 'clic')).toEqual([['clic', true]]);
    expect(w.claimNavigation()).toBe(false);
  });
});
