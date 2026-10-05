// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, R13 (Barnes, constat du 2026-10-05) : la page de résultats sert les 24 premières cartes ; le bouton
// « Annonces suivantes » (`javascript:annonces_suivantes()`) charge les 24 suivantes en XHR GET
// (`/views/viewAjax.php?…&begin=24`), fragment HTML, QUI EXIGE la session posée par la page (sans cookie : « Session timed
// out »). Vrai Chromium du pool, proxy de lancement fermé, proxy d'egress de la passe (garde SSRF), verrou de domaines :
// - la reconnaissance clique UNE fois le bouton (contrôle sans URL, hors formulaire), capture le fragment HTML et en déduit
//   la pagination par décalage (`begin`, pas de 24) vers l'URL du fragment ; le compteur « 100 annonces » est lu ;
// - E2 (`fetch_in_page`, cookies du site) lit toute la liste avec cette stratégie : 100 biens ;
// - un bouton d'envoi de formulaire n'est jamais cliqué.
import { analyzeCapture, buildFromProposal, type InvestigationProposal } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import { createStaticAssetAllowance, openBrowserEgress, startEgressProxy, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { BrowserPool } from '../browser/pool.js';
import { createLocalProvider } from '../browser/provider-local.js';
import { startMiniSite, type MiniResponse, type MiniSite } from '../testing/mini-site.testkit.js';
import { runFetchInPageExecutor, runReconnaissancePass } from './browser-executors.js';

const PRESTIGE = 'zz_test_prestige.localhost';
const FORMONLY = 'zz_test_formonly.localhost';
const HOSTS = [PRESTIGE, FORMONLY];
const TOTAL = 100;
const SESSION = 'zzsess0001';

let site: MiniSite;
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
const signal = new AbortController().signal;

const card = (i: number) =>
  `<article class="col-xl-6 mb-4" id="property-APM-${87300000 + i}"><div class="glide--carousel" data-carousel="carousel-APM-${87300000 + i}"><a href="/fr/vente/france/zz-${i}/ref-APM-${87300000 + i}.html" title="À vendre Maison | Zzville ${i % 7}" class="bc-015-carousel-link"><img src="/img/${i}.jpg" alt=""></a></div>` +
  `<div class="bc-015-content"><a href="/fr/vente/france/zz-${i}/ref-APM-${87300000 + i}.html" class="bc-015-content-link"><div class="fw-bold">À vendre Maison | Zzville ${i % 7}</div><p class="mb-2">Zzville ${i % 7}</p>` +
  `<p class="bc-015-criteria"><span>${2 + (i % 5)} Chambres</span> <span>${80 + i} m²</span></p><p class="bc-015-prix"><strong>${500000 + i * 1000} €</strong></p></a></div></article>`;
const cards = (from: number, n: number) => Array.from({ length: n }, (_, k) => card(from + k + 1)).join('\n');

const page = () => `<!doctype html><html lang="fr"><body><header><nav><a href="/">Accueil</a></nav></header><main>
<p id="nbr-listings-found">${TOTAL} annonces</p><section id="list-results"><div class="row" id="content_annonces">${cards(0, 24)}</div>
<input type="hidden" id="listing_begin" value="24"><div class="text-center"><a href="javascript:annonces_suivantes()" class="btn btn-primary" id="button_annonces_suivantes">Annonces suivantes</a></div></section></main>
<script>function annonces_suivantes(){var b=parseInt(document.getElementById('listing_begin').value,10);var x=new XMLHttpRequest();x.open('GET','/views/viewAjax.php?view=viewListing_annonces&ajax=y&action=annonces_suivantes&begin='+b+'&type_moteur=listing');x.onload=function(){if(x.responseText!=='nodata'){document.getElementById('content_annonces').insertAdjacentHTML('beforeend',x.responseText);document.getElementById('listing_begin').value=String(b+24);}};x.send();}</script></body></html>`;

beforeAll(async () => {
  site = await startMiniSite(async (req): Promise<MiniResponse | undefined> => {
    switch (req.host) {
      case PRESTIGE:
        if (req.path === '/' || req.path === '/fr/vente/france.html') return { headers: { 'set-cookie': `PHPSESSID=${SESSION}; Path=/` }, body: req.path === '/' ? '<html><body><h1>Accueil Zztest</h1></body></html>' : page() };
        if (req.path === '/views/viewAjax.php') {
          if (!(req.cookie ?? '').includes(`PHPSESSID=${SESSION}`)) return { body: "Session timed out<br><a href='/'>Refresh this page.</a>" };
          const begin = Number(req.query.get('begin') ?? '0');
          return { body: begin === 0 || begin >= TOTAL ? 'nodata' : cards(begin, Math.min(24, TOTAL - begin)) };
        }
        return undefined;
      case FORMONLY:
        return { body: `<!doctype html><html><body><main><ul>${Array.from({ length: 8 }, (_, k) => `<li class="it"><a href="/i/${k}">Article Zztest numéro ${k}</a> <span>${k} €</span></li>`).join('')}</ul><form action="/search" method="post"><button>Voir plus</button></form></main></body></html>` };
      default:
        return undefined;
    }
  });
  guard = fixtureGuard(site.port, HOSTS, net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }).launchShared, recycleAfterRuns: 100 });
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await site?.close();
});

beforeEach(() => site.reset());

async function recon(host: string, path: string) {
  const staticAssets = createStaticAssetAllowance();
  const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard, allowedHosts: [host], allowedHostSuffixes: [host], staticAssets });
  try {
    return await runReconnaissancePass({ pool, egress, guard, url: site.url(host, path), allowedHosts: [host], allowedHostSuffixes: [host], staticAssets, signal, renderWaitMs: 5_000 });
  } finally {
    await egress.close();
  }
}

describe('reconnaissance d’une liste à bouton « charger plus » en XHR (R13)', () => {
  test('assert_recon_clicks_load_more — un clic, fragment HTML capturé, pagination par décalage vers l’URL du XHR, compteur lu ; E2 lit les 100 biens', async () => {
    const { result, capture } = await recon(PRESTIGE, '/fr/vente/france.html');
    expect(result.ok, JSON.stringify(result.ok ? {} : result.failure)).toBe(true);
    expect(capture.loadMore).toEqual({ clicked: true, selector: '#button_annonces_suivantes' });
    expect(site.hits.filter((h) => h.path === '/views/viewAjax.php')).toHaveLength(1);
    const fragment = capture.exchanges.find((e) => e.url.includes('/views/viewAjax.php'));
    expect(fragment?.contentType).toMatch(/text\/html/);
    const candidates = analyzeCapture(capture, [PRESTIGE]);
    const dom = candidates.find((c) => c.from === 'dom');
    expect(dom).toMatchObject({ count: 24, counter: TOTAL, dom: { pagination: { type: 'offset', param: 'url.query.begin', step: 24, start: 0 } } });
    expect(candidates.some((c) => c.from === 'response')).toBe(false);

    const link = dom!.dom!.slots.find((s) => s.attr === 'href')!;
    const proposal = {
      fields: [{ name: 'listing_url', type: 'string', required: true, personal: false, description: 'Listing URL' }],
      sources: [{ candidate: dom!.id, paths: [{ field: 'listing_url', path: `$.${link.name}`, ops: [] }], pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }],
    } as unknown as InvestigationProposal;
    const built = buildFromProposal(proposal, candidates, capture);
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    const spec = built.strategies[0]!.spec;
    expect(spec.pagination?.next_url).toContain('/views/viewAjax.php');

    // E2 : navigateur ouvert sur le site (cookie de session posé), fetch dans la page : toute la liste.
    const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard, allowedHosts: [PRESTIGE] });
    try {
      const run = await runFetchInPageExecutor({ pool, egress, guard, spec, input: { max_pages: 20 }, signal, outputSchema: built.outputSchema });
      expect(run.ok, JSON.stringify(run.ok ? {} : run.failure)).toBe(true);
      if (run.ok) expect({ records: run.records.length, distinct: new Set(run.records.map((r) => r['listing_url'])).size, stop: run.stop }).toEqual({ records: TOTAL, distinct: TOTAL, stop: 'records_empty' });
    } finally {
      await egress.close();
    }
  }, 120_000);

  test('un bouton d’envoi de formulaire (« Voir plus » dans un <form>) n’est jamais cliqué', async () => {
    const { result, capture } = await recon(FORMONLY, '/');
    expect(result.ok).toBe(true);
    expect(capture.loadMore).toBeUndefined();
    expect(site.hits.filter((h) => h.path === '/search')).toEqual([]);
  }, 90_000);
});
