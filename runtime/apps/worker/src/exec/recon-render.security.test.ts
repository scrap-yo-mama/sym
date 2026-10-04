// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, correctif B (R05, R10) : reconnaissance par Chromium d'une application rendue en JavaScript dont le
// code vient d'un CDN tiers (Ashby : `jobs.ashbyhq.com` charge `cdn.ashbyprd.com/…/index.js`, puis appelle son API
// GraphQL en POST sur son propre hôte) et d'une page à défilement infini nourrie par XHR (`/api/quotes?page=N`). Vrai
// Chromium du pool, proxy de lancement fermé, proxy d'egress de la passe (garde SSRF), verrou de domaines :
// - les scripts, feuilles de style, polices et préchargements d'un hôte tiers sont chargés (GET, bornés en hôtes et en requêtes) pour que la page
//   se rende ; tout le reste vers un tiers (XHR, fetch, image, pixel) reste coupé, sans connexion ;
// - la réponse JSON que la page charge elle-même (POST GraphQL) est capturée et proposée comme gisement « API JSON » ;
//   le DOM rendu donne aussi son bloc répété ;
// - la réponse XHR d'un défilement infini (`?page=1`) est capturée et proposée.
import { analyzeCapture } from '@runtime/core/investigation';
import * as net from '@runtime/core/net';
import { createStaticAssetAllowance, openBrowserEgress, startEgressProxy, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { fixtureGuard } from '../../../../tests/helpers/fixture-net.ts';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { startMiniSite, type MiniResponse, type MiniSite } from '../testing/mini-site.testkit.js';
import { runReconnaissancePass } from './browser-executors.js';

const APP = 'zz_test_jsapp.localhost';
const CDN = 'zz_test_cdnassets.localhost';
const EVIL = 'zz_test_evilcollect.localhost';
const QUOTES = 'zz_test_quotesscroll.localhost';
const HOSTS = [APP, CDN, EVIL, QUOTES];
const JOBS = 30;

let site: MiniSite;
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
const signal = new AbortController().signal;

const appJs = (evil: string) => `
(function(){
  fetch(${JSON.stringify(`${evil}/collect`)}).catch(function(){});
  var px = new Image(); px.src = ${JSON.stringify(`${evil}/pixel.gif`)};
  fetch('/api/non-user-graphql?op=Board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'Board', variables: { org: 'zz' }, query: 'query Board($org: String!) { jobBoard(org: $org) { jobPostings { id title locationName } } }' }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var root = document.getElementById('root');
      d.data.jobBoard.jobPostings.forEach(function(j, i){
        var card = document.createElement('div'); card.className = 'job-card';
        var a = document.createElement('a'); a.className = 'job-link'; a.href = '/zz/' + j.id;
        var h = document.createElement('h3'); h.className = 'job-title'; h.textContent = j.title; a.appendChild(h);
        card.appendChild(a);
        var s = document.createElement('span'); s.className = 'job-loc'; s.textContent = j.locationName + ' • Tech ' + (i % 3); card.appendChild(s);
        root.appendChild(card);
      });
    });
})();`;

beforeAll(async () => {
  site = await startMiniSite(async (req): Promise<MiniResponse | undefined> => {
    switch (req.host) {
      case APP:
        if (req.path === '/zz') {
          return {
            // Comme Ashby (constat du 2026-10-04) : manifeste Vite préchargé (`preload as=fetch`, type `other`), police préchargée,
            // feuille de style, puis le chargeur en ligne lit le manifeste et injecte le module du CDN.
            body: `<!doctype html><html><head><link id="vite-preload" rel="preload" as="fetch" href="${site.url(CDN, '/.vite/manifest.json')}" crossorigin><link rel="preload" as="font" type="font/woff2" crossorigin="anonymous" href="${site.url(CDN, '/fonts/zz.woff2')}"><link rel="stylesheet" href="${site.url(CDN, '/assets/app.css')}"></head><body><div id="root"></div><img alt="" src="${site.url(EVIL, '/img.gif')}"><script>fetch(document.getElementById('vite-preload').href,{mode:'cors'}).then(function(r){return r.json()}).then(function(m){var s=document.createElement('script');s.type='module';s.crossOrigin='anonymous';s.src=${JSON.stringify(`http://${CDN}:`)}+location.port+'/'+m.entry;document.head.appendChild(s)});</script></body></html>`,
          };
        }
        if (req.path === '/api/non-user-graphql' && req.method === 'POST') {
          const postings = Array.from({ length: JOBS }, (_, i) => ({ id: `zz-job-${i + 1}`, title: `Poste Zztest numéro ${i + 1}`, locationName: 'Paris' }));
          return { headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ data: { jobBoard: { jobPostings: postings } } }) };
        }
        return undefined;
      case CDN:
        if (req.path === '/.vite/manifest.json') return { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ entry: 'assets/app.js' }) };
        if (req.path === '/fonts/zz.woff2') return { headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' }, body: 'zz' };
        if (req.path === '/assets/app.js') return { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: appJs(`http://${EVIL}:${site.port}`) };
        if (req.path === '/assets/app.css') return { headers: { 'content-type': 'text/css' }, body: '.job-link{display:block}' };
        return undefined;
      case EVIL:
        return { body: 'zz' };
      case QUOTES:
        if (req.path === '/scroll') {
          return {
            body: `<!doctype html><html><body><div class="quotes"></div><script>fetch('/api/quotes?page=1').then(function(r){return r.json()}).then(function(d){var q=document.querySelector('.quotes');d.quotes.forEach(function(x){var e=document.createElement('div');e.className='quote';e.textContent=x.text;q.appendChild(e)})});</script></body></html>`,
          };
        }
        if (req.path === '/api/quotes') {
          const page = Number(req.query.get('page') ?? '1');
          const quotes = Array.from({ length: 10 }, (_, i) => ({ text: `Citation Zztest ${(page - 1) * 10 + i + 1}`, author: { name: 'Zztest' }, tags: ['zz', 'test'] }));
          return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ has_next: page < 10, page, quotes }) };
        }
        return undefined;
      default:
        return undefined;
    }
  });
  guard = fixtureGuard(site.port, HOSTS, net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await site?.close();
});

beforeEach(() => site.reset());

/** Comme `browserRecon` (investigation-executor.ts) : une allocation de sous-ressources statiques partagée par l'egress et la passe. */
async function recon(host: string, path: string, staticAssets = createStaticAssetAllowance()) {
  const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard, allowedHosts: [host], allowedHostSuffixes: [host], staticAssets });
  try {
    const pass = await runReconnaissancePass({ pool, egress, guard, url: site.url(host, path), allowedHosts: [host], allowedHostSuffixes: [host], staticAssets, signal, renderWaitMs: 5_000 });
    return { ...pass, domainBlocked: egress.domainBlockedCount() };
  } finally {
    await egress.close();
  }
}

describe('reconnaissance d’une application rendue en JavaScript (R05)', () => {
  test('assert_recon_renders_with_cdn_scripts — scripts du CDN chargés, POST GraphQL capturé et proposé, DOM rendu lu ; aucun XHR ni pixel tiers', async () => {
    const { result, capture } = await recon(APP, '/zz');
    expect(result.ok, JSON.stringify(result.ok ? {} : result.failure)).toBe(true);
    // Le code de la page vient du CDN tiers : chargé (script et feuille de style).
    expect(site.hits.some((h) => h.host === CDN && h.path === '/assets/app.js')).toBe(true);
    expect(site.hits.some((h) => h.host === CDN && h.path === '/assets/app.css')).toBe(true);
    // Rien d'autre vers un tiers : ni fetch, ni image, ni pixel.
    expect(site.hits.filter((h) => h.host === EVIL)).toEqual([]);
    const post = capture.exchanges.find((e) => e.method === 'POST' && e.url.includes('/api/non-user-graphql'));
    expect(post, JSON.stringify(capture.exchanges.map((e) => e.url))).toBeDefined();
    const candidates = analyzeCapture(capture, [APP]);
    const api = candidates.find((c) => c.from === 'response');
    expect(api).toMatchObject({ request: { method: 'POST' }, records: '$.data.jobBoard.jobPostings[*]', count: JOBS });
    expect(api?.request.body_json).toMatchObject({ operationName: 'Board' });
    // Le bloc répété du DOM rendu (absent du document servi) est proposé aussi, après l'API JSON (04b §2).
    const dom = candidates.find((c) => c.from === 'dom');
    expect(dom).toMatchObject({ count: JOBS, dom: { rendered: true } });
    expect(candidates.indexOf(api!)).toBeLessThan(candidates.indexOf(dom!));
    expect(site.hits.some((h) => h.host === CDN && h.path === '/.vite/manifest.json')).toBe(true);
    expect(capture.assets?.hosts).toBe(1);
    // Récit : réponses de données du site vues et capturées (codes seulement).
    expect(capture.data).toMatchObject({ seen: 1, captured: 1 });
  }, 90_000);

  test('assert_recon_static_assets_bounded — plafond d’hôtes tiers atteint : le code du CDN n’est plus chargé, aucune connexion', async () => {
    const { capture } = await recon(APP, '/zz', createStaticAssetAllowance({ maxHosts: 0 }));
    expect(site.hits.filter((h) => h.host === CDN || h.host === EVIL)).toEqual([]);
    expect(capture.exchanges).toEqual([]);
  }, 90_000);
});

describe('reconnaissance d’un défilement infini (R10)', () => {
  test('assert_recon_captures_scroll_xhr — HTML initial vide, réponse XHR `?page=1` capturée et proposée (pagination de l’API)', async () => {
    const { result, capture } = await recon(QUOTES, '/scroll');
    expect(result.ok).toBe(true);
    const candidates = analyzeCapture(capture, [QUOTES]);
    const api = candidates.find((c) => c.from === 'response');
    expect(api).toMatchObject({ records: '$.quotes[*]', count: 10 });
    expect(new URL(api!.request.url).searchParams.get('page')).toBe('1');
    expect(api!.skeleton).toMatchObject({ '$.text': 'string', '$.tags': 'array' });
  }, 90_000);
});
