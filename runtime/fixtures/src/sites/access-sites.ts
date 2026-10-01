// SPDX-License-Identifier: AGPL-3.0-only
// Accès (O8) : robots.txt (Disallow, 4xx, 5xx, redirection, gros fichier, Crawl-delay, Content-Signal) et réponse 402.
// Chaque site sert un contenu JSON sur tout chemin hors robots.txt : le compteur de GET /__stats dit si un chemin a été visité.
import { ControlError, type FxRequest, type FxResponse, type Site, type SiteFactory } from '../core.ts';
import { html, json, page, redirect, sleep, text } from '../res.ts';

const robotsText = (body: string, headers: Record<string, string> = {}): FxResponse => text(200, body, headers);

const content = (req: FxRequest, headers: Record<string, string> = {}): FxResponse =>
  json(200, { host: req.host, path: req.path, items: [{ id: 'zz_test_item_1' }, { id: 'zz_test_item_2' }] }, headers);

function base(id: string, description: string, smoke: Site['smoke']): Omit<Site, 'handle'> {
  return { id, lot: 'o8', description, hosts: [`zz_test_${id}.localhost`], smoke, ownsRobots: true };
}

/** Code d'un worker qui ouvre un WebSocket vers `path` de son origine (ws pour http, wss pour https). */
const wsFromWorker = (path: string): string => `try { new WebSocket(location.origin.replace(/^http/, 'ws') + '${path}'); } catch (e) {}`;

/** Règles de spéculation immédiates : un prefetch et un prerender. */
const speculationRules = (prefetch: string, prerender: string): string =>
  JSON.stringify({ prefetch: [{ source: 'list', urls: [prefetch], eagerness: 'immediate' }], prerender: [{ source: 'list', urls: [prerender], eagerness: 'immediate' }] });

/**
 * Redirections d'un chemin permis vers un chemin interdit (INV11 à chaque saut, Chromium compris) : `/depart` → 302
 * `/prive/x` ; `/prive` → 301 `/prive/` (barre oblique finale) ; `/vers-autre` → 302 vers `/prive/x` d'un second hôte
 * (`robots_redirect`, qui interdit /prive/) ; `/vers-injoignable` → 302 vers l'hôte `robots_5xx` (robots.txt en 503) ;
 * `/page-fetch` : page dont le script demande au chargement `/prive/page-fetch` et `/depart` (→ 302 `/prive/x`) ;
 * `/page-ws` : page qui ouvre un WebSocket vers `/prive/ws` ; `/page-ws-worker` : workers dédiés (blob, http, module) qui en
 * ouvrent un ; `/page-cadre-ws` : cadre du second hôte dont les workers en ouvrent un (`/cadre-ws-worker`) ; `/page-spec` :
 * règles de spéculation (prefetch, prerender) vers `/prive/`, dans la page et par l'en-tête ;
 * `/page-cadre` : page avec un cadre d'un autre site (`robots_redirect`) dont une image passe par `/depart` → 302
 * `/prive/x` ; `/page-sw` : page qui crée un SharedWorker (`/sw.js`) dont le code demande `/prive/sw` directement et
 * `/depart` (→ 302 `/prive/x`).
 */
const robotsDisallow: SiteFactory = (env) => ({
  ...base('robots', 'robots.txt : Disallow: /prive/ avec Allow: /prive/ouvert (règle la plus longue) ; redirections d\'un chemin permis vers /prive/ (même hôte, barre oblique finale, second hôte) ; tout chemin visité est compté', { path: '/robots.txt', status: 200 }),
  handle(req) {
    switch (req.path) {
      case '/robots.txt':
        return robotsText('User-agent: *\nDisallow: /prive/\nAllow: /prive/ouvert\n');
      case '/depart':
        return redirect(302, '/prive/x');
      case '/prive':
        return redirect(301, '/prive/');
      case '/vers-autre':
        return redirect(302, env.urlFor('zz_test_robots_redirect.localhost', '/prive/x'));
      case '/vers-injoignable':
        return redirect(302, env.urlFor('zz_test_robots_5xx.localhost', '/liste'));
      case '/page-cadre':
        return html(200, page('cadre', `<p id="cadre">cadre</p><iframe src="${env.urlFor('zz_test_robots_redirect.localhost', '/cadre')}"></iframe>`));
      case '/page-cadre-ws':
        // Cadre d'un autre site dont les workers (blob, http) ouvrent un WebSocket vers /prive/ (revue de 1.11).
        return html(200, page('cadre-ws', `<p id="cadre-ws">cadre-ws</p><iframe src="${env.urlFor('zz_test_robots_redirect.localhost', '/cadre-ws-worker')}"></iframe>`));
      case '/page-sw':
        return html(200, page('sw', '<p id="sw">sw</p>', `<script>try { new SharedWorker('/sw.js'); } catch (e) {}</script>`));
      case '/sw.js':
        return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: "fetch('/prive/sw').catch(() => 0); fetch('/depart').catch(() => 0);" };
      case '/page-fetch':
        // Requêtes de données lancées par la page (sous-ressources) vers /prive/, directe et redirigée (exécuteurs agentiques, INV11).
        return html(
          200,
          page('fetch', '<h1>zz_test_page_fetch</h1><p id="fetch">Identifiant : zz_test_item_1</p>', "<script>fetch('/prive/page-fetch').catch(() => 0); fetch('/depart').catch(() => 0);</script>"),
        );
      case '/page-ws':
        return html(200, page('ws', '<p id="ws">ws</p>', `<script>try { new WebSocket('ws://' + location.host + '/prive/ws'); } catch (e) {}</script>`));
      case '/page-ws-worker':
        // Workers dédiés du site (blob, http classique, module) : chacun ouvre un WebSocket vers /prive/ (revue de 1.11).
        return html(
          200,
          page(
            'ws-worker',
            '<p id="wsw">wsw</p>',
            `<script>${[`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(wsFromWorker('/prive/ws-worker-blob'))}], { type: 'text/javascript' })))`, "new Worker('/ws-worker.js')", "new Worker('/ws-worker-module.js', { type: 'module' })"].map((c) => `try { ${c}; } catch (e) {}`).join(' ')}</script>`,
          ),
        );
      case '/ws-worker.js':
        return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: `${wsFromWorker('/prive/ws-worker-http')} fetch('/temoin-worker').catch(() => 0);` };
      case '/ws-worker-module.js':
        return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: `${wsFromWorker('/prive/ws-worker-module')} fetch('/temoin-worker-module').catch(() => 0);` };
      case '/page-spec':
        // Règles de spéculation (revue de 1.11) : prefetch et prerender immédiats vers /prive/, dans la page et par l'en-tête
        // Speculation-Rules ; l'image lente retarde l'événement load (le préchargement a le temps de partir).
        return html(
          200,
          page('spec', '<p id="spec">spec</p><img src="/lent" alt="">', `<script type="speculationrules">${speculationRules('/prive/spec-prefetch', '/prive/spec-prerender')}</script>`),
          { 'speculation-rules': '"/spec-rules.json"' },
        );
      case '/spec-rules.json':
        return { status: 200, headers: { 'content-type': 'application/speculationrules+json' }, body: speculationRules('/prive/spec-header-prefetch', '/prive/spec-header-prerender') };
      case '/lent':
        return sleep(1500).then(() => text(200, 'lent'));
      default:
        return content(req);
    }
  },
});

const robots4xx: SiteFactory = () => {
  let status = 404;
  const allowed = [400, 401, 403, 404, 410, 429];
  return {
    ...base('robots_4xx', 'robots.txt en 4xx (404 par défaut ; 400/401/403/410/429 sur commande) : aucune règle, tout est autorisé', { path: '/robots.txt', status: 404 }),
    handle: (req) => (req.path === '/robots.txt' ? text(status, 'no robots here') : content(req)),
    control(args) {
      if (typeof args['status'] !== 'number' || !allowed.includes(args['status'])) throw new ControlError(`status attendu parmi : ${allowed.join(', ')}`);
      status = args['status'];
      return { status };
    },
  };
};

const robots5xx: SiteFactory = () => {
  let mode: 500 | 502 | 503 | 'drop' = 503;
  return {
    ...base('robots_5xx', 'robots.txt en 5xx persistant (503 par défaut ; 500, 502 ou connexion coupée sur commande) : interdiction totale attendue', { path: '/robots.txt', status: 503 }),
    handle(req) {
      if (req.path !== '/robots.txt') return content(req);
      return mode === 'drop' ? { status: 0, destroy: true } : text(mode, 'server error');
    },
    control(args) {
      const next = args['mode'];
      if (next !== 500 && next !== 502 && next !== 503 && next !== 'drop') throw new ControlError('mode attendu : 500, 502, 503 ou "drop"');
      mode = next;
      return { mode };
    },
  };
};

const robotsRedirect: SiteFactory = (env) => {
  let hops = 2;
  let loop = false;
  /** robots.txt redirigé vers celui d'un AUTRE hôte (`robots` : Disallow /prive/) : RFC 9309 suit quel que soit l'hôte. */
  let cross = false;
  return {
    ...base('robots_redirect', 'robots.txt derrière une chaîne de redirections 301 (2 sauts par défaut, réglable ; boucle ou renvoi vers le robots.txt de l\'hôte robots sur commande) menant à Disallow: /prive/', { path: '/robots.txt', status: 301 }),
    handle(req) {
      const hop = /^\/robots-hop-(\d+)\.txt$/.exec(req.path);
      if (req.path === '/robots.txt' && cross) return redirect(301, env.urlFor('zz_test_robots.localhost', '/robots.txt'));
      if (req.path === '/robots.txt' || hop) {
        if (loop) return redirect(301, '/robots.txt');
        const index = hop ? Number(hop[1]) : 0;
        if (index >= hops) return robotsText('User-agent: *\nDisallow: /prive/\n');
        return redirect(301, index + 1 >= hops ? '/robots-final.txt' : `/robots-hop-${index + 1}.txt`);
      }
      if (req.path === '/robots-final.txt') return robotsText('User-agent: *\nDisallow: /prive/\n');
      // Cadre d'un autre site (`robots` → `/page-cadre`) : image redirigée vers un chemin interdit.
      if (req.path === '/cadre') return html(200, page('cadre', '<img src="/depart" alt="">'));
      // Cadre dont les workers dédiés (blob, http) ouvrent un WebSocket vers /prive/ (revue de 1.11).
      if (req.path === '/cadre-ws-worker')
        return html(
          200,
          page(
            'cadre-ws-worker',
            '<p>cadre</p>',
            `<script>${[`new Worker(URL.createObjectURL(new Blob([${JSON.stringify(wsFromWorker('/prive/cadre-ws-worker-blob'))}])))`, "new Worker('/cadre-ws-worker.js')"].map((c) => `try { ${c}; } catch (e) {}`).join(' ')}</script>`,
          ),
        );
      if (req.path === '/cadre-ws-worker.js')
        return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: `${wsFromWorker('/prive/cadre-ws-worker-http')} fetch('/temoin-cadre-worker').catch(() => 0);` };
      if (req.path === '/depart') return redirect(302, '/prive/x');
      return content(req);
    },
    control(args) {
      if (typeof args['hops'] === 'number') {
        if (!Number.isInteger(args['hops']) || args['hops'] < 0 || args['hops'] > 20) throw new ControlError('hops attendu : entier de 0 à 20');
        hops = args['hops'];
      }
      if (typeof args['loop'] === 'boolean') loop = args['loop'];
      if (typeof args['cross'] === 'boolean') cross = args['cross'];
      return { hops, loop, cross };
    },
  };
};


const robotsBig: SiteFactory = () => {
  let cached: string | undefined;
  const build = (): string => {
    const filler = `# zz_test_filler ${'x'.repeat(62)}\n`;
    let out = `User-agent: *\nDisallow: /early/\n`;
    while (out.length < 600 * 1024) out += filler;
    return `${out}Disallow: /late/\n`;
  };
  return {
    ...base('robots_big', 'robots.txt de plus de 500 Kio : Disallow /early/ dans les 500 premiers Kio, Disallow /late/ au-delà (ignoré par un lecteur borné)', { path: '/robots.txt', status: 200 }),
    handle(req) {
      if (req.path !== '/robots.txt') return content(req);
      cached ??= build();
      return robotsText(cached);
    },
  };
};

const robotsCrawlDelay: SiteFactory = () => {
  let delay = 5;
  return {
    ...base('robots_crawl_delay', 'robots.txt avec Crawl-delay (5 s par défaut, réglable) ; GET /__stats?log=1 donne l\'horodatage des requêtes', { path: '/robots.txt', status: 200 }),
    handle: (req) => (req.path === '/robots.txt' ? robotsText(`User-agent: *\nCrawl-delay: ${delay}\nAllow: /\n`) : content(req)),
    control(args) {
      if (typeof args['delay'] !== 'number' || args['delay'] < 0) throw new ControlError('delay attendu : nombre de secondes >= 0');
      delay = args['delay'];
      return { delay };
    },
  };
};

const contentSignal: SiteFactory = () => {
  const signal = 'ai-train=no, search=yes, ai-input=no';
  return {
    ...base('content_signal', 'Signaux d\'accès : Content-Signal (robots.txt et en-tête), Content-Usage (AIPREF), tdm-reservation (TDMRep) ; ne bloquent rien', { path: '/liste', status: 200 }),
    handle: (req) =>
      req.path === '/robots.txt'
        ? robotsText(`User-agent: *\nContent-Signal: ${signal}\nAllow: /\n`)
        : content(req, { 'content-signal': signal, 'content-usage': 'train-ai=n', 'tdm-reservation': '1' }),
  };
};

const payment402: SiteFactory = () => {
  let price = '0.01';
  return {
    ...base('payment_402', 'Réponse 402 Payment Required avec en-tête crawler-price (USD 0.01 par défaut) ; /free répond 200 ; robots.txt permissif', { path: '/', status: 402 }),
    handle(req) {
      if (req.path === '/robots.txt') return robotsText('User-agent: *\nAllow: /\n');
      if (req.path === '/free') return content(req);
      return json(402, { error: 'payment_required', price: { amount: price, currency: 'USD' } }, { 'crawler-price': `USD ${price}` });
    },
    control(args) {
      if (typeof args['price'] !== 'string' || !/^\d+(\.\d+)?$/.test(args['price'])) throw new ControlError('price attendu : chaîne décimale');
      price = args['price'];
      return { price };
    },
  };
};

export const ACCESS_SITES: SiteFactory[] = [
  robotsDisallow,
  robots4xx,
  robots5xx,
  robotsRedirect,
  robotsBig,
  robotsCrawlDelay,
  contentSignal,
  payment402,
];
