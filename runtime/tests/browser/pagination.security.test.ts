// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.2 (10-taches), volet Chromium : « `max_pages = 3` → exactement 3 pages. Règle d'arrêt vérifiée sur la dernière
// page. » pour `infinite_scroll` (flux de la fixture `scroll` : 10 éléments dans le HTML, 10 de plus à chaque
// défilement jusqu'au bout du flux) et `next_link` en E3 (liens rel=next lus dans le DOM rendu). Étage S : vrai Chromium
// lancé par le pool du worker, proxy d'egress par essai (garde SSRF), contexte de run gardé (robots.txt à chaque requête,
// navigations de la page coupées). Chaque défilement est une requête pour la cadence et le contrôle d'accès.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { BrowserPool, playwrightLauncher } from '../../apps/worker/src/browser/pool.ts';
import { runPlaywrightExecutor } from '../../apps/worker/src/exec/browser-executors.ts';
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
import { validateDeclarativeSpec, type DeclarativeSpec } from '@runtime/core';
import type { AccessCheck, DeclarativeRunResult, RequestPacer } from '@runtime/core/exec';
import * as net from '@runtime/core/net';
import { openBrowserEgress, startEgressProxy, type BrowserEgress, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { fixtureGuard, ssrSpecInput } from '../helpers/fixture-net.ts';
import { allowAllRobots } from '../helpers/robots-allow.ts';

const SCROLL = 'zz_test_scroll.localhost';
const SSR = 'zz_test_ssr.localhost';
const HOSTS = [SCROLL, SSR];

let client: Client;
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
let base: (host: string) => string;
const signal = new AbortController().signal;

beforeAll(async () => {
  client = await startClient();
  base = (host) => `http://${host}:${client.server.port}`;
  guard = fixtureGuard(client.server.port, HOSTS, net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
}, 120_000);
afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await client?.close();
});
beforeEach(async () => {
  await client.reset();
});

function valid(raw: Record<string, unknown>): DeclarativeSpec {
  const check = validateDeclarativeSpec(raw);
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

async function withEgress<T>(fn: (egress: BrowserEgress) => Promise<T>): Promise<T> {
  const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard });
  try {
    return await fn(egress);
  } finally {
    await egress.close();
  }
}

const feedSpec = (): DeclarativeSpec =>
  valid({
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: `${base(SCROLL)}/`, allowed_hosts: [SCROLL] },
    sources: [{ id: 'dom', from: 'html', records: 'div.feed-item' }],
    fields: { id: { attr: 'data-id', type: 'string', required: true }, title: { attr: 'text', type: 'string', required: true } },
    pagination: { type: 'infinite_scroll', stop: [{ when: 'records_empty' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: 50 } },
  });

const run = (spec: DeclarativeSpec, input: unknown, extra: { access?: AccessCheck; pacer?: RequestPacer } = {}): Promise<DeclarativeRunResult> =>
  withEgress((egress) => runPlaywrightExecutor({ access: allowAllRobots, pool, egress, guard, spec, input, signal, renderWaitMs: 4_000, scrollWaitMs: 1_500, ...extra }));

describe('infinite_scroll en E3 (Chromium)', () => {
  test('assert_infinite_scroll_paginated — max_pages = 3 : chargement initial + 2 défilements = exactement 3 pages, 30 éléments distincts, le serveur ne voit que 2 lots', async () => {
    const out = await run(feedSpec(), { max_pages: 3 });
    expect(out, JSON.stringify(out.ok ? {} : out.failure)).toMatchObject({ ok: true, pages: 3, requests: 3, stop: 'max_pages_input', truncated: false });
    if (!out.ok) return;
    expect(out.records).toHaveLength(30);
    expect(new Set(out.records.map((r) => r['id'])).size).toBe(30);
    expect((await client.stats()).hosts[SCROLL]?.paths['/api/feed']).toBe(2);
  }, 60_000);

  test('assert_infinite_scroll_paginated — règle d’arrêt sur la dernière page : le flux de 60 éléments finit, un défilement sans nouvel élément clôt (records_empty), 60 éléments, aucun doublon', async () => {
    const out = await run(feedSpec(), {});
    expect(out, JSON.stringify(out.ok ? {} : out.failure)).toMatchObject({ ok: true, pages: 7, stop: 'records_empty', truncated: false });
    if (!out.ok) return;
    expect(out.records).toHaveLength(60);
    expect(new Set(out.records.map((r) => r['id'])).size).toBe(60);
    // 5 lots demandés par le site (les éléments 11 à 60), pas un de plus : le défilement final n'a rien déclenché.
    expect((await client.stats()).hosts[SCROLL]?.paths['/api/feed']).toBe(5);
  }, 60_000);

  test('chaque défilement passe par le contrôle d’accès et la cadence, comme une requête de la stratégie', async () => {
    const checked: string[] = [];
    const slots: string[] = [];
    const access: AccessCheck = async (url) => {
      checked.push(url);
      return { allowed: true, crawlDelayMs: null };
    };
    const pacer: RequestPacer = {
      acquire: async (url) => {
        slots.push(url);
        return { granted: true };
      },
      report: async () => undefined,
    };
    const out = await run(feedSpec(), { max_pages: 3 }, { access, pacer });
    expect(out).toMatchObject({ ok: true, pages: 3, requests: 3 });
    // Une réservation de créneau par page (chargement + 2 défilements) ; robots.txt contrôlé pour la page (et ses sous-requêtes).
    expect(slots).toHaveLength(3);
    expect(checked.filter((u) => u === `${base(SCROLL)}/`).length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  test('une limite de requêtes par run tronque le défilement : sortie partielle livrée, signalée tronquée', async () => {
    const out = await withEgress((egress) => runPlaywrightExecutor({ access: allowAllRobots, pool, egress, guard, spec: feedSpec(), input: {}, signal, maxRequests: 2, renderWaitMs: 4_000, scrollWaitMs: 1_500 }));
    expect(out).toMatchObject({ ok: true, pages: 2, stop: 'max_requests_per_run', truncated: true });
    if (out.ok) expect(out.records).toHaveLength(20);
  }, 60_000);
});

describe('next_link en E3 (Chromium)', () => {
  test('assert_pagination_max_pages_exact (E3) — max_pages = 3 : 3 navigations, 60 produits ; sans plafond, rel=next absent de la page 5 clôt (no_next)', async () => {
    const spec = valid({
      ...ssrSpecInput(base(SSR), SSR),
      pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: 10 } },
    });
    const three = await run(spec, { max_pages: 3 });
    expect(three, JSON.stringify(three.ok ? {} : three.failure)).toMatchObject({ ok: true, pages: 3, requests: 3, stop: 'max_pages_input' });
    if (three.ok) expect(three.records).toHaveLength(60);
    const all = await run(spec, {});
    expect(all).toMatchObject({ ok: true, pages: 5, requests: 5, stop: 'no_next' });
    if (all.ok) expect(all.records).toHaveLength(100);
  }, 120_000);
});
