// SPDX-License-Identifier: AGPL-3.0-only
// Garde de la passerelle avant émission (tâche 2.7, 07 § 3 et § 5), sans base : domaine et URL (assert_ssrf_guard),
// liste blanche CDP (assert_cdp_allowlist, assert_no_remote_logic), E6 et moteurs tiers refusés à la passerelle
// (assert_e6_not_in_tunnel_mode, assert_third_party_engine_not_via_tunnel : seul `agent_step` traverse), Origin.
import { describe, expect, test } from 'vitest';
import { guardCommand, tunnelOriginAllowed } from './gateway.js';

const SHOP = 'zz-test-shop.example';
const base = { domain: SHOP, allowWriteActions: false, execution: 'fetch' as string | null };

describe('garde de la passerelle', () => {
  test('assert_ssrf_guard : domaine ou URL privés, internes ou hors domaine → domain_not_allowed', () => {
    for (const [domain, url] of [
      [SHOP, 'https://evil.example/'],
      ['169.254.169.254', 'http://169.254.169.254/'],
      ['localhost', 'http://localhost/'],
      ['192.168.0.10', 'http://192.168.0.10/'],
      ['Zz-Test-Shop.example', 'https://zz-test-shop.example/'],
    ] as const) {
      expect(guardCommand({ ...base, domain, cmd: 'page_fetch', args: { url } })).toMatchObject({ ok: false, error: 'domain_not_allowed' });
    }
    expect(guardCommand({ ...base, cmd: 'page_fetch', args: { url: `https://${SHOP}/api` } })).toEqual({ ok: true });
  });

  test('assert_cdp_allowlist / assert_no_remote_logic : méthode hors liste, code en argument → method_not_allowed', () => {
    expect(guardCommand({ ...base, cmd: 'page_script', args: { method: 'Runtime.evaluate', params: { expression: '1' } } })).toMatchObject({ error: 'method_not_allowed' });
    expect(guardCommand({ ...base, cmd: 'page_script', args: { method: 'DOM.getDocument', params: {}, code: 'x' } })).toMatchObject({ error: 'method_not_allowed' });
    expect(guardCommand({ ...base, cmd: 'page_script', args: { method: 'Page.navigate', params: { url: 'https://evil.example/' } } })).toMatchObject({ error: 'domain_not_allowed' });
    expect(guardCommand({ ...base, cmd: 'agent_step', args: { action: 'navigate', url: 'http://10.0.0.1/' } })).toMatchObject({ error: 'domain_not_allowed' });
    expect(guardCommand({ ...base, cmd: 'agent_step', args: { action: 'read', script: 'alert(1)' } })).toMatchObject({ error: 'method_not_allowed' });
    expect(guardCommand({ ...base, cmd: 'page_script', args: { method: 'DOM.getDocument', params: { depth: 1 } } })).toEqual({ ok: true });
  });

  test('assert_e6_not_in_tunnel_mode / assert_third_party_engine_not_via_tunnel : E6 refusé à la passerelle, seul agent_step traverse', () => {
    expect(guardCommand({ ...base, execution: 'agent', cmd: 'agent_step', args: { action: 'read' } })).toMatchObject({ ok: false, error: 'method_not_allowed' });
    expect(guardCommand({ ...base, execution: 'hybrid', cmd: 'agent_step', args: { action: 'read' } })).toEqual({ ok: true });
  });

  test('écriture sans allow_write_actions (PUT, PATCH, DELETE) : write_action_blocked ; POST déclaratif accepté (correctif 1)', () => {
    expect(guardCommand({ ...base, cmd: 'page_fetch', args: { url: `https://${SHOP}/order`, method: 'DELETE' } })).toMatchObject({ error: 'write_action_blocked' });
    expect(guardCommand({ ...base, cmd: 'page_fetch', args: { url: `https://${SHOP}/order`, method: 'PUT', body: '{}' } })).toMatchObject({ error: 'write_action_blocked' });
    expect(guardCommand({ ...base, cmd: 'page_fetch', args: { url: `https://${SHOP}/api/search`, method: 'POST', body: '{"q":"x"}' } })).toEqual({ ok: true });
  });

  test('assert_ws_origin_checked : seule une origine d’extension de la liste ; toute extension en mode développement explicite (correctif 17)', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    expect(tunnelOriginAllowed(`chrome-extension://${id}`, { ids: [id], allowAny: false })).toBe(true);
    expect(tunnelOriginAllowed(`chrome-extension://${id}`, { ids: ['ponmlkjihgfedcbaponmlkjihgfedcba'], allowAny: false })).toBe(false);
    // Liste vide hors mode développement : aucune extension (une autre extension installée ne passe pas).
    expect(tunnelOriginAllowed(`chrome-extension://${id}`, { ids: [], allowAny: false })).toBe(false);
    expect(tunnelOriginAllowed(`chrome-extension://${id}`, { ids: [], allowAny: true })).toBe(true);
    expect(tunnelOriginAllowed('https://evil.example', { ids: [], allowAny: true })).toBe(false);
    expect(tunnelOriginAllowed(undefined, { ids: [], allowAny: true })).toBe(false);
  });
});
