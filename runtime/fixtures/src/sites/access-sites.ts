// Accès (O8) : robots.txt (Disallow, 4xx, 5xx, redirection, gros fichier, Crawl-delay, Content-Signal) et réponse 402.
// Chaque site sert un contenu JSON sur tout chemin hors robots.txt : le compteur de GET /__stats dit si un chemin a été visité.
import { ControlError, type FxRequest, type FxResponse, type Site, type SiteFactory } from '../core.ts';
import { json, redirect, text } from '../res.ts';

const robotsText = (body: string, headers: Record<string, string> = {}): FxResponse => text(200, body, headers);

const content = (req: FxRequest, headers: Record<string, string> = {}): FxResponse =>
  json(200, { host: req.host, path: req.path, items: [{ id: 'zz_test_item_1' }, { id: 'zz_test_item_2' }] }, headers);

function base(id: string, description: string, smoke: Site['smoke']): Omit<Site, 'handle'> {
  return { id, lot: 'o8', description, hosts: [`zz_test_${id}.localhost`], smoke, ownsRobots: true };
}

const robotsDisallow: SiteFactory = () => ({
  ...base('robots', 'robots.txt : Disallow: /prive/ avec Allow: /prive/ouvert (règle la plus longue) ; tout chemin visité est compté', { path: '/robots.txt', status: 200 }),
  handle: (req) =>
    req.path === '/robots.txt' ? robotsText('User-agent: *\nDisallow: /prive/\nAllow: /prive/ouvert\n') : content(req),
});

const robots4xx: SiteFactory = () => {
  let status = 404;
  const allowed = [400, 401, 403, 404, 410];
  return {
    ...base('robots_4xx', 'robots.txt en 4xx (404 par défaut ; 400/401/403/410 sur commande) : aucune règle, tout est autorisé', { path: '/robots.txt', status: 404 }),
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

const robotsRedirect: SiteFactory = () => {
  let hops = 2;
  let loop = false;
  return {
    ...base('robots_redirect', 'robots.txt derrière une chaîne de redirections 301 (2 sauts par défaut, réglable ; boucle sur commande) menant à Disallow: /prive/', { path: '/robots.txt', status: 301 }),
    handle(req) {
      const hop = /^\/robots-hop-(\d+)\.txt$/.exec(req.path);
      if (req.path === '/robots.txt' || hop) {
        if (loop) return redirect(301, '/robots.txt');
        const index = hop ? Number(hop[1]) : 0;
        if (index >= hops) return robotsText('User-agent: *\nDisallow: /prive/\n');
        return redirect(301, index + 1 >= hops ? '/robots-final.txt' : `/robots-hop-${index + 1}.txt`);
      }
      if (req.path === '/robots-final.txt') return robotsText('User-agent: *\nDisallow: /prive/\n');
      return content(req);
    },
    control(args) {
      if (typeof args['hops'] === 'number') {
        if (!Number.isInteger(args['hops']) || args['hops'] < 0 || args['hops'] > 20) throw new ControlError('hops attendu : entier de 0 à 20');
        hops = args['hops'];
      }
      if (typeof args['loop'] === 'boolean') loop = args['loop'];
      return { hops, loop };
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
