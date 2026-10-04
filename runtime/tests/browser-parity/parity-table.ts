// SPDX-License-Identifier: AGPL-3.0-only
// Tableau de parité à trois fournisseurs (tâche 4.4 ; cdc/sym-browser 04g §5, 04e §5.1) : liste des tests, capacité requise par
// test, règle de comparaison et rendu `test | local | sym-browser | cdp`. Pur : aucun navigateur ici.
import type { ProviderCapabilities } from '../../packages/contracts/src/browser/index.ts';

export const PROVIDERS = ['local', 'sym-browser', 'cdp'] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type Verdict = 'PASS' | 'FAIL' | 'absente déclarée';
export type ParityResults = Record<string, Partial<Record<ProviderName, Verdict>>>;

/** Liste de 04e §5.1 puis les deux tests de 04g §4, avec la capacité requise (`null` : aucune) de 04g §5. */
export const PARITY_TESTS: readonly { readonly name: string; readonly capability: keyof ProviderCapabilities | null }[] = [
  { name: 'assert_chromium_sandboxed', capability: 'sandboxProbe' },
  { name: 'assert_chromium_idle_silent', capability: 'launchArgs' },
  { name: 'assert_browser_egress_chained', capability: 'egressPolicy' },
  { name: 'assert_run_cost_capped', capability: 'egressPolicy' },
  { name: 'assert_user_agent_engine_real', capability: 'engineUserAgent' },
  { name: 'assert_agent_browser_in_pool_slot', capability: null },
  { name: 'assert_all_browser_contexts_guarded', capability: null },
  { name: 'assert_write_action_blocked', capability: null },
  { name: 'assert_robots_not_gating', capability: null },
  { name: 'request_guard_blocks_offsite_redirect', capability: null },
  { name: 'websocketstream_neutralized_by_init_script', capability: null },
];

/**
 * Écarts à 04g §5 (liste vide : conforme). `local` et `sym-browser` rendent PASS partout ; pour `cdp`, chaque test sans capacité
 * requise rend PASS et chaque autre « absente déclarée », en accord exact avec `capabilities`.
 */
export function compareParity(results: ParityResults, capabilities: Record<ProviderName, ProviderCapabilities>): string[] {
  const gaps: string[] = [];
  for (const test of PARITY_TESTS) {
    for (const provider of PROVIDERS) {
      const declaredAbsent = test.capability !== null && !capabilities[provider][test.capability];
      if (provider !== 'cdp' && declaredAbsent) {
        gaps.push(`${test.name} : ${provider} déclare ${String(test.capability)} absente, attendu PASS`);
        continue;
      }
      const expected: Verdict = declaredAbsent ? 'absente déclarée' : 'PASS';
      const got = results[test.name]?.[provider];
      if (got !== expected) gaps.push(`${test.name} : ${provider} = ${got ?? '(non joué)'}, attendu ${expected}`);
    }
  }
  return gaps;
}

export function renderParityTable(results: ParityResults): string {
  const rows = PARITY_TESTS.map((t) => `| ${t.name} | ${PROVIDERS.map((p) => results[t.name]?.[p] ?? '(non joué)').join(' | ')} |`);
  return ['| test | local | sym-browser | cdp |', '|---|---|---|---|', ...rows].join('\n');
}
