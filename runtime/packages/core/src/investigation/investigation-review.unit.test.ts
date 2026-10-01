// SPDX-License-Identifier: AGPL-3.0-only
// Enquête (tâche 2.1, correctifs de revue), logique pure :
// - 429 pendant les essais : on ralentit, on ne monte jamais en E (ni en N) : les essais s'arrêtent (X4, 04 §7) ;
// - portée de site : `www.` n'est retiré que s'il reste un domaine enregistrable (jamais `gov.uk`, `com.au`, `github.io`) ;
// - URL d'action dans un script en ligne (`/logout`, `/unsubscribe`…) : jamais rejouée par la reconnaissance en tunnel.
import { describe, expect, test } from 'vitest';
import { orderTrials, pruneAfter, type TrialPair } from './plan.js';
import { discoverScriptEndpoints, isActionUrl, siteScope, withinSiteScope } from './recon.js';
import { runTrials, type PairOutcome, type TrialExecution, type TrialPorts } from './trials.js';

const pair = (execution: TrialPair['execution'], network: TrialPair['network'], est: number | null, source = 'c1'): TrialPair => ({ execution, network, source, est_cost_usd: est });
const okRun = (): TrialExecution => ({ ok: true, failure_class: null, detail: null, records: 10, pages: 1, stop: 'no_pagination', cost_usd: 0.0001, ms: 5 });
const failRun = (cls: TrialExecution['failure_class']): TrialExecution => ({ ok: false, failure_class: cls, detail: 'x', records: 0, pages: 0, stop: null, cost_usd: 0.0001, ms: 5 });
const budget = { maxUsd: 1, spentUsd: 0, deadlineMs: 1_000_000, maxAttempts: 12, maxCostPerRunUsd: 0.5 };

function ports(script: (p: TrialPair) => TrialExecution): TrialPorts & { calls: string[]; finishedLog: PairOutcome[] } {
  const calls: string[] = [];
  const finishedLog: PairOutcome[] = [];
  return {
    calls,
    finishedLog,
    now: () => 0,
    execute: async (p, i) => {
      calls.push(`${p.execution}/${p.network}#${i}`);
      return script(p);
    },
    finished: async (o) => {
      finishedLog.push(o);
    },
    pruned: async () => undefined,
  };
}

describe('429 pendant les essais : ralentir, jamais monter en E ni en N', () => {
  test('pruneAfter(rate_limited) arrête les essais (aucun couple plus cher sur le même domaine)', () => {
    const a = pair('fetch', 'direct', 0.1);
    const rest = [pair('fetch_in_page', 'direct', 0.2), pair('agent_fetch', 'direct', 0.3), pair('fetch', 'dc_proxy', 0.4)];
    expect(pruneAfter('rate_limited', a, rest)).toEqual({ next: 'stop', pruned: rest });
  });

  test('runTrials : un 429 sur E1 ne déclenche ni E2 ni E4 ; issue `stopped` avec la classe rate_limited', async () => {
    const plan = orderTrials([pair('fetch', 'direct', 0.00005), pair('fetch_in_page', 'direct', 0.00025), pair('agent_fetch', 'direct', 0.002, 'page')]);
    const p = ports((q) => (q.execution === 'fetch' ? failRun('rate_limited') : okRun()));
    const out = await runTrials(plan, p, budget);
    expect(out.kind).toBe('stopped');
    expect(p.calls).toEqual(['fetch/direct#0']);
    expect(p.finishedLog.map((o) => o.result)).toEqual(['rate_limited']);
  });
});

describe('portée de site : jamais un suffixe public', () => {
  test('www.<suffixe public à deux niveaux> garde l’hôte exact', () => {
    for (const host of ['www.gov.uk', 'www.co.uk', 'www.com.au', 'www.github.io', 'www.co.jp', 'www.com.br', 'www.netlify.app']) {
      expect(siteScope(host), host).toBe(host);
    }
    // Un autre site du même suffixe n'est jamais dans la portée.
    expect(withinSiteScope('hmrc.gov.uk', siteScope('www.gov.uk'))).toBe(false);
    expect(withinSiteScope('other.github.io', siteScope('www.github.io'))).toBe(false);
  });

  test('www.<domaine enregistrable> est retiré comme avant', () => {
    expect(siteScope('www.exemple.test')).toBe('exemple.test');
    expect(siteScope('www.exemple.co.uk')).toBe('exemple.co.uk');
    expect(siteScope('www.service.gov.uk')).toBe('service.gov.uk');
    expect(siteScope('www.zz_test_sib.localhost')).toBe('zz_test_sib.localhost');
  });
});

describe('URL d’action dans un script en ligne', () => {
  test('logout, signout, delete, remove, unsubscribe, cancel, clear, confirm… : URL d’action', () => {
    for (const path of ['/logout', '/api/auth/signout', '/account/sign-out', '/cart/clear', '/unsubscribe?list=1', '/api/items/42/delete', '/orders/cancel', '/email/confirm', '/session/destroy', '/api/remove-item'])
      expect(isActionUrl(`https://shop.test${path}`), path).toBe(true);
    for (const path of ['/api/items', '/v1/products?page=2', '/graphql', '/api/catalog/search', '/api/clearance-items'])
      expect(isActionUrl(`https://shop.test${path}`), path).toBe(false);
  });

  test('discoverScriptEndpoints trouve toujours l’URL (le filtre est appliqué par la reconnaissance en tunnel)', () => {
    const html = '<html><body><script>document.querySelector("#x").onclick = () => fetch("/logout"); fetch("/api/items")</script></body></html>';
    expect(discoverScriptEndpoints(html, 'https://shop.test/', 5)).toEqual(['https://shop.test/logout', 'https://shop.test/api/items']);
  });
});
