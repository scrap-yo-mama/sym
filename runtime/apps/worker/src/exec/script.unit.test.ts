// SPDX-License-Identifier: AGPL-3.0-only
// Pont `ctx.page.*` (tâche 1.6, D-29) sans navigateur : liste fermée, validation des demandes, imputation des requêtes
// coupées. Le comportement sur un vrai Chromium est dans tests/browser/executors.security.test.ts.
import type { SandboxViolation } from '@runtime/core';
import { SsrfGuard, createSsrfPolicy } from '@runtime/core/net';
import { describe, expect, test } from 'vitest';
import { createPageBridge, hostViolationWatch, PAGE_OPERATIONS } from './script.js';

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
    w.report('zz_test_analytics.example');
    expect(seen).toEqual([]);
    w.beginEvaluate();
    w.report('zz_test_internal.example');
    expect(seen).toEqual([{ reason: 'domain_not_allowed', detail: 'zz_test_internal.example' }]);
    expect(w.imputed()).toBe(1);
    expect(w.lastImputed()).toEqual({ reason: 'domain_not_allowed', detail: 'zz_test_internal.example' });
  });

  test('ligne de base : un tiers du site (avant evaluate, ou pendant une navigation de l’hôte) n’est jamais imputé au script', () => {
    const { w, seen } = setup();
    // Chargement de la page de départ : mesure d'audience et CDN du site.
    w.beginHostOp();
    w.report('zz_test_cdn.example');
    w.endHostOp();
    w.report('ZZ_TEST_ANALYTICS.example.');
    w.beginEvaluate();
    w.endEvaluate();
    // Après evaluate : minuterie de mesure d'audience, image chargée au défilement sur le même CDN.
    w.report('zz_test_analytics.example');
    w.report('zz_test_cdn.example');
    // ctx.page.goto / click : sous-ressources tierces de la nouvelle page, nouveau document (guet désarmé).
    w.beginHostOp();
    w.report('zz_test_other_cdn.example');
    w.documentLoaded();
    w.endHostOp();
    w.report('zz_test_late_tag.example');
    expect(seen).toEqual([]);
    expect(w.imputed()).toBe(0);
    // Le code du script entre à nouveau : un hôte inconnu du site est imputé, même après le retour d'evaluate.
    w.beginEvaluate();
    w.endEvaluate();
    w.report('zz_test_internal.example');
    expect(seen).toEqual([{ reason: 'domain_not_allowed', detail: 'zz_test_internal.example' }]);
  });

  test('assert_write_action_blocked (imputation) : un evaluate en vol pendant une navigation de l’hôte garde le verdict ; soumission coupée imputée dès qu’un code ou un clic du script est en jeu', () => {
    const { w, seen } = setup();
    w.report('zz_test_site_form.example', 'write_action_blocked');
    expect(seen).toEqual([]);
    w.beginHostOp();
    w.report('zz_test_site_form.example', 'write_action_blocked');
    w.endHostOp();
    w.beginEvaluate();
    w.beginHostOp();
    w.report('zz_test_internal.example');
    w.endHostOp();
    w.documentLoaded();
    w.endEvaluate();
    expect(seen).toEqual([
      { reason: 'write_action_blocked', detail: 'zz_test_site_form.example' },
      { reason: 'domain_not_allowed', detail: 'zz_test_internal.example' },
    ]);
  });
});
