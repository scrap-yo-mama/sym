// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.4 (cdc/sym-browser 04g §5) : règle de comparaison du tableau de parité `test | local | sym-browser | cdp`.
import type { ProviderCapabilities } from '../../packages/contracts/src/browser/index.ts';
import { describe, expect, test } from 'vitest';
import { compareParity, PARITY_TESTS, renderParityTable, type ParityResults } from './parity-table.ts';

const ALL: ProviderCapabilities = { egressPolicy: true, launchArgs: true, freshContextPerRun: true, killBeforeDetach: true, sandboxProbe: true, engineUserAgent: true, privateLatency: true };
const NONE: ProviderCapabilities = { egressPolicy: false, launchArgs: false, freshContextPerRun: false, killBeforeDetach: false, sandboxProbe: false, engineUserAgent: false, privateLatency: false };
const caps = { local: ALL, 'sym-browser': ALL, cdp: NONE };

function conform(): ParityResults {
  const out: ParityResults = {};
  for (const t of PARITY_TESTS) out[t.name] = { local: 'PASS', 'sym-browser': 'PASS', cdp: t.capability === null ? 'PASS' : 'absente déclarée' };
  return out;
}

describe('assert_provider_parity : règle de comparaison (04g §5)', () => {
  test('la liste est celle de 04e §5.1 et des deux tests de 04g §4 (11 tests), capacités de 04g §5', () => {
    expect(PARITY_TESTS.map((t) => `${t.name}:${String(t.capability)}`)).toEqual([
      'assert_chromium_sandboxed:sandboxProbe',
      'assert_chromium_idle_silent:launchArgs',
      'assert_browser_egress_chained:egressPolicy',
      'assert_run_cost_capped:egressPolicy',
      'assert_user_agent_engine_real:engineUserAgent',
      'assert_agent_browser_in_pool_slot:null',
      'assert_all_browser_contexts_guarded:null',
      'assert_write_action_blocked:null',
      'assert_robots_not_gating:null',
      'request_guard_blocks_offsite_redirect:null',
      'websocketstream_neutralized_by_init_script:null',
    ]);
  });

  test('tableau conforme : aucun écart', () => {
    expect(compareParity(conform(), caps)).toEqual([]);
  });

  test('un FAIL en local ou sym-browser est un écart', () => {
    const r = conform();
    r['assert_write_action_blocked']!['sym-browser'] = 'FAIL';
    expect(compareParity(r, caps)).toEqual(['assert_write_action_blocked : sym-browser = FAIL, attendu PASS']);
  });

  test('cdp : un test sans capacité requise qui ne rend pas PASS est un écart', () => {
    const r = conform();
    r['request_guard_blocks_offsite_redirect']!['cdp'] = 'FAIL';
    expect(compareParity(r, caps)).toEqual(['request_guard_blocks_offsite_redirect : cdp = FAIL, attendu PASS']);
  });

  test('cdp : un test à capacité qui rend PASS alors que la capacité est déclarée absente est un écart (accord exact avec capabilities)', () => {
    const r = conform();
    r['assert_chromium_sandboxed']!['cdp'] = 'PASS';
    expect(compareParity(r, caps)).toEqual(['assert_chromium_sandboxed : cdp = PASS, attendu absente déclarée']);
  });

  test('cdp : « absente déclarée » alors que la capacité est déclarée présente est un écart', () => {
    expect(compareParity(conform(), { ...caps, cdp: ALL })).toContain('assert_chromium_sandboxed : cdp = absente déclarée, attendu PASS');
  });

  test('local ou sym-browser qui déclare une capacité absente est un écart', () => {
    expect(compareParity(conform(), { ...caps, local: { ...ALL, sandboxProbe: false } })).toContain('assert_chromium_sandboxed : local déclare sandboxProbe absente, attendu PASS');
  });

  test('résultat manquant : écart', () => {
    const r = conform();
    delete r['assert_robots_not_gating']!['cdp'];
    expect(compareParity(r, caps)).toEqual(['assert_robots_not_gating : cdp = (non joué), attendu PASS']);
  });

  test('le tableau rendu a la forme test | local | sym-browser | cdp', () => {
    const lines = renderParityTable(conform()).split('\n');
    expect(lines[0]).toBe('| test | local | sym-browser | cdp |');
    expect(lines).toHaveLength(2 + PARITY_TESTS.length);
    expect(lines[2]).toBe('| assert_chromium_sandboxed | PASS | PASS | absente déclarée |');
  });
});
