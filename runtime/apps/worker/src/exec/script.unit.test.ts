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
    blockedHosts: () => [],
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
  test('avant le premier evaluate : requêtes du site ignorées ; après : violation à la première', () => {
    const seen: SandboxViolation[] = [];
    const w = hostViolationWatch();
    w.watch((v) => seen.push(v));
    w.report('zz_test_analytics.example');
    expect(seen).toEqual([]);
    w.arm();
    w.report('zz_test_internal.example');
    expect(seen).toEqual([{ reason: 'domain_not_allowed', detail: 'zz_test_internal.example' }]);
  });
});
