// SPDX-License-Identifier: AGPL-3.0-only
// Classifieur d'échec (tâche 1.7, 04 §7) : garde de classification sur l'échange (code HTTP, en-têtes de protection,
// page de défi servie en 200, redirection vers la connexion ou de pays). Fonctions pures, sans réseau.
// assert_no_circumvention (INV6), volet U1 : un 401 ou un 403 n'est jamais `network`, un défi en 200 est un refus.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { challengeInText, classifyExchange, detectChallengePage, protectionSignal, type HttpExchange } from './index.js';

const URL0 = 'http://zz_test_x.localhost/liste';
const ex = (status: number, body = '', headers: Record<string, string> = {}, url = URL0): HttpExchange => ({ status, headers, body, url });
const html = (title: string, body: string, head = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const HTML = { 'content-type': 'text/html; charset=utf-8' };

/** Page interstitielle générique (même forme que la fixture `challenge_200`, sans son marqueur `zz-test`). */
const GENERIC_CHALLENGE = html(
  'Security check',
  '<main><h1>Security check</h1><p>Please verify you are human to continue.</p><label><input type="checkbox" disabled> I am not a robot</label><noscript>Enable JavaScript and cookies to continue.</noscript></main>',
);
const CATALOGUE = html(
  'Catalogue',
  `<ul>${Array.from({ length: 40 }, (_, i) => `<li class="item"><span class="t">Produit ${i}</span> <span class="p">${i},00 €</span></li>`).join('')}</ul>`,
);

describe('assert_no_circumvention : garde de classification (U1)', () => {
  it('défi servi en HTTP 200, détecté par le corps seul → blocked_by_protection (challenge_page)', () => {
    expect(classifyExchange(ex(200, GENERIC_CHALLENGE, HTML))).toMatchObject({ failure_class: 'blocked_by_protection', retryable: false, detail: 'challenge_page', status: 200 });
  });

  it('défi en 200 sans titre parlant : phrase de vérification sur une page courte', () => {
    const body = html('Bienvenue', '<p>Merci de patienter.</p><p>Vérifiez que vous êtes humain pour continuer.</p>');
    expect(classifyExchange(ex(200, body, HTML))?.failure_class).toBe('blocked_by_protection');
  });

  it('en-tête de défi connu (cf-mitigated: challenge, 04 §5) → blocked_by_protection, quel que soit le statut', () => {
    for (const status of [200, 403, 429, 503]) {
      expect(classifyExchange(ex(status, '{}', { 'cf-mitigated': 'challenge' })), String(status)).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'challenge_header' });
    }
  });

  it('éditeur fictif des fixtures (x-zz-test-shield) reconnu comme les éditeurs documentés', () => {
    expect(classifyExchange(ex(200, '{}', { 'x-zz-test-shield': 'challenge' }))?.failure_class).toBe('blocked_by_protection');
    expect(classifyExchange(ex(403, 'x', { 'x-zz-test-shield-sig': 'zz_test_sig_00' }))).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'protection_signature' });
  });

  it('403 signé par un éditeur → blocked_by_protection ; 403 nu → forbidden ; 403 avec page de défi → blocked_by_protection', () => {
    expect(classifyExchange(ex(403, 'denied', { 'x-datadome': 'protected' }))?.failure_class).toBe('blocked_by_protection');
    expect(classifyExchange(ex(403, html('Forbidden', '<h1>403 Forbidden</h1>'), HTML))).toMatchObject({ failure_class: 'forbidden', detail: 'http_403', status: 403 });
    expect(classifyExchange(ex(403, GENERIC_CHALLENGE, HTML))).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'challenge_page' });
  });

  it('401 → auth_required, 402 → payment_required, 429 → rate_limited, 451 → network, 404/410 → not_found, 5xx → transient', () => {
    expect(classifyExchange(ex(401, '{"error":"auth_required"}'))).toMatchObject({ failure_class: 'auth_required', status: 401 });
    expect(classifyExchange(ex(402, '{}', { 'crawler-price': 'USD 0.01' }))?.failure_class).toBe('payment_required');
    expect(classifyExchange(ex(429, '{}', { 'retry-after': '30' }))).toMatchObject({ failure_class: 'rate_limited', retryable: true });
    expect(classifyExchange(ex(451, 'legal'))).toMatchObject({ failure_class: 'network', detail: 'geo_restriction' });
    expect(classifyExchange(ex(404, ''))?.failure_class).toBe('not_found');
    expect(classifyExchange(ex(410, ''))?.failure_class).toBe('not_found');
    expect(classifyExchange(ex(503, 'Service Unavailable'))).toMatchObject({ failure_class: 'transient', retryable: true });
  });

  it('page de défi en 503 (interstitiel) → blocked_by_protection, pas transient (aucun réessai sur un défi)', () => {
    expect(classifyExchange(ex(503, GENERIC_CHALLENGE, HTML))?.failure_class).toBe('blocked_by_protection');
  });

  it('redirection vers la page de connexion (cookie absent ou expiré) → auth_required (login_redirect)', () => {
    const login = html('Connexion', '<form method="post" action="/login"><input name="username"><input name="password" type="password"></form>');
    const out = classifyExchange(ex(200, login, HTML, 'http://zz_test_x.localhost/login?expired=1'), { requestUrl: 'http://zz_test_x.localhost/account' });
    expect(out).toMatchObject({ failure_class: 'auth_required', detail: 'login_redirect' });
    // Sans redirection (la stratégie vise elle-même /login), rien n'est déduit de l'URL.
    expect(classifyExchange(ex(200, login, HTML, 'http://zz_test_x.localhost/login'), { requestUrl: 'http://zz_test_x.localhost/login' })).toBeNull();
    // 3xx non suivi vers la connexion.
    expect(classifyExchange(ex(302, '', { location: '/users/sign_in' }), { requestUrl: 'http://zz_test_x.localhost/account' })?.failure_class).toBe('auth_required');
  });

  it('redirection de pays (géo-restriction) → network (geo_redirect)', () => {
    const out = classifyExchange(ex(200, html('Indisponible', '<h1>Indisponible</h1>'), HTML, 'http://zz_test_x.localhost/unavailable-in-your-country'), { requestUrl: URL0 });
    expect(out).toMatchObject({ failure_class: 'network', detail: 'geo_redirect' });
  });

  it('pas de faux positif : catalogue, JSON, formulaire de contact avec widget de vérification dans une grande page', () => {
    expect(classifyExchange(ex(200, CATALOGUE, HTML))).toBeNull();
    expect(classifyExchange(ex(200, JSON.stringify({ items: [{ name: 'verify you are human' }] }), { 'content-type': 'application/json' }))).toBeNull();
    const contact = html('Contact', `${'<p>Texte du site, horaires, adresse et plan d’accès.</p>'.repeat(80)}<form><div class="g-recaptcha"></div></form>`);
    expect(classifyExchange(ex(200, contact, HTML))).toBeNull();
    // Une page de produit peut parler de « Security check-list » sans être un défi.
    expect(classifyExchange(ex(200, html('Security checklist for your home', `${'<p>Contenu.</p>'.repeat(50)}`), HTML))).toBeNull();
  });

  it('pas de faux positif sur un 2xx : un titre ou une phrase seuls ne suffisent pas sur une page de contenu', () => {
    const prose = '<p>Voici un texte ordinaire du site, avec des conseils, des exemples et des liens vers les autres rubriques.</p>'.repeat(12);
    // Titres d'interstitiels employés par des pages de contenu longues.
    expect(classifyExchange(ex(200, html('Security check: 10 tips for your home', prose), HTML))).toBeNull();
    expect(classifyExchange(ex(200, html('One more step to finish your order', `${prose}<form><input name="address"></form>`), HTML))).toBeNull();
    expect(classifyExchange(ex(200, html('Just a moment with our founder', prose), HTML))).toBeNull();
    // Courte FAQ ou article qui cite une phrase de vérification.
    const faq = html(
      'FAQ',
      '<h1>Questions fréquentes</h1><p>Pourquoi Google affiche-t-il « unusual traffic from your computer network » ? Ce message apparaît quand votre réseau envoie beaucoup de requêtes automatiques ; redémarrez votre box ou contactez votre fournisseur.</p><p>Que veut dire la case « je ne suis pas un robot » sur certains formulaires ? Elle sert à filtrer les envois automatiques de spam.</p><p>Comment nous contacter ? Écrivez-nous depuis la page Contact, nous répondons sous 48 heures ouvrées.</p>',
    );
    expect(classifyExchange(ex(200, faq, HTML))).toBeNull();
    const article = html('Actualités', `<article><h1>Les captchas en 2026</h1><p>La case « I am not a robot » reste répandue.</p>${prose}</article>`);
    expect(classifyExchange(ex(200, article, HTML))).toBeNull();
    // Le même titre sur un refus (403) reste un défi : seule une réponse 2xx exige un second signal.
    expect(classifyExchange(ex(403, html('Just a moment...', prose), HTML))?.failure_class).toBe('blocked_by_protection');
  });

  it('un 2xx reste un défi avec un titre d’interstitiel sur une page quasi vide, ou deux signaux', () => {
    expect(classifyExchange(ex(200, html('Just a moment...', '<p>Checking the site connection.</p>'), HTML))?.failure_class).toBe('blocked_by_protection');
    expect(classifyExchange(ex(200, html('Bienvenue', '<div id="challenge-form"></div><p>Verify you are human.</p>'), HTML))?.failure_class).toBe('blocked_by_protection');
  });

  it('défi sur un autre 4xx (400, 404, 405, 406, 409, 418, 499) → blocked_by_protection, jamais extraction ni not_found', () => {
    const page = html('Just a moment...', '<p>Verify you are human by completing the action below.</p>');
    for (const status of [400, 402, 404, 405, 406, 409, 410, 418, 499]) {
      expect(classifyExchange(ex(status, page, HTML)), String(status)).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'challenge_page', status });
    }
    // Signature d'éditeur (en-tête seul, sans page de défi) : un « 403 signé » seulement (04 §7). Ailleurs, l'en-tête
    // d'un éditeur accompagne aussi les réponses ordinaires du site protégé : le statut décide.
    expect(classifyExchange(ex(404, '{}', { 'x-datadome': 'protected' }))?.failure_class).toBe('not_found');
    expect(classifyExchange(ex(429, '{}', { 'x-datadome': 'protected', 'retry-after': '5' }))?.failure_class).toBe('rate_limited');
    expect(classifyExchange(ex(503, '{}', { 'x-dd-b': '1' }))?.failure_class).toBe('transient');
    expect(classifyExchange(ex(400, '{}', { 'x-datadome': 'protected' }))?.failure_class).toBe('extraction');
    // 401 reste une connexion requise, même avec une page de défi.
    expect(classifyExchange(ex(401, page, HTML))?.failure_class).toBe('auth_required');
    // Un 404 ordinaire reste not_found, un 400 ordinaire reste extraction.
    expect(classifyExchange(ex(404, html('Page introuvable', '<h1>404</h1>'), HTML))?.failure_class).toBe('not_found');
    expect(classifyExchange(ex(400, '{"error":"bad_request"}', { 'content-type': 'application/json' }))?.failure_class).toBe('extraction');
  });

  it('AWS WAF (x-amzn-waf-action: challenge|captcha, tout statut, 202 compris ; conteneur challenge-container) → blocked_by_protection', () => {
    // Échanges enregistrés (forme documentée de l'éditeur, valeurs zz_test) : la table des en-têtes a sa fixture ici.
    const container = html('', '<div id="challenge-container"></div><script src="/zz_test_challenge.js"></script>');
    expect(classifyExchange(ex(202, container, { ...HTML, 'x-amzn-waf-action': 'challenge' }))).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'challenge_header', status: 202 });
    expect(classifyExchange(ex(405, '<html></html>', { ...HTML, 'x-amzn-waf-action': 'captcha' }))).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'challenge_header', status: 405 });
    expect(classifyExchange(ex(200, '{}', { 'x-amzn-waf-action': 'Challenge' }))?.failure_class).toBe('blocked_by_protection');
    // Sans l'en-tête : le conteneur de défi seul, sur une page quasi vide, suffit.
    expect(classifyExchange(ex(202, container, HTML))).toMatchObject({ failure_class: 'blocked_by_protection', detail: 'challenge_page' });
    // Valeur sans défi (journal de l'éditeur) : rien sur un 200.
    expect(classifyExchange(ex(200, '{"items":[]}', { 'x-amzn-waf-action': 'allow' }))).toBeNull();
  });

  it('un très gros corps n’est lu que par son titre (borne de lecture) : pas de faux positif dans le contenu', () => {
    const big = html('Catalogue', `${'<p>x</p>'.repeat(60_000)}<p>verify you are human</p>`);
    expect(big.length).toBeGreaterThan(300_000);
    expect(detectChallengePage(big, HTML)).toBeNull();
  });

  it('jamais `network` pour un 401, un 403 ou un 429, quels que soient corps, en-têtes et URL (propriété)', () => {
    const headerArb = fc.dictionary(fc.constantFrom('cf-mitigated', 'x-datadome', 'location', 'retry-after', 'content-type', 'x-zz-test-shield', 'x-other'), fc.string({ maxLength: 20 }), { maxKeys: 4 });
    const pathArb = fc.constantFrom('/', '/login', '/unavailable-in-your-country', '/geo-blocked', '/api/items', '/signin');
    fc.assert(
      fc.property(fc.constantFrom(401, 403, 429), fc.string({ maxLength: 200 }), headerArb, pathArb, pathArb, (status, body, headers, finalPath, reqPath) => {
        const out = classifyExchange(ex(status, body, headers, `http://zz_test_x.localhost${finalPath}`), { requestUrl: `http://zz_test_x.localhost${reqPath}` });
        return out !== null && out.failure_class !== 'network' && out.retryable === (out.failure_class === 'rate_limited');
      }),
      { numRuns: 400 },
    );
  });
});

describe('détecteurs de protection', () => {
  it('protectionSignal : en-tête de défi seul, valeurs insensibles à la casse', () => {
    expect(protectionSignal({ 'cf-mitigated': 'Challenge' })).toMatchObject({ code: 'challenge_header' });
    expect(protectionSignal({ 'content-type': 'text/html' })).toBeNull();
  });

  it('challengeInText : texte d’un instantané (arbre d’accessibilité) ou HTML brut', () => {
    expect(challengeInText('heading "Security check"\ntext "Please verify you are human to continue."')).toBe(true);
    expect(challengeInText(GENERIC_CHALLENGE)).toBe(true);
    expect(challengeInText('list "Produits"\nlistitem "Produit 1 - 12,00 €"')).toBe(false);
  });
});

describe('détection en temps linéaire (disponibilité du worker) : un corps hostile ≤ 256 Kio ne bloque pas la boucle', () => {
  /** Meilleur de trois mesures (ms) : la borne vise le coût de l'algorithme, pas une pause du ramasse-miettes. */
  const bestOf = (fn: () => unknown): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      fn();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  it.each([
    ['commentaires non fermés', '<!--'.repeat(65_000)],
    ['scripts non fermés', '<script>'.repeat(32_000)],
    ['styles non fermés', '<style>'.repeat(37_000)],
    ['chevrons sans fermeture', '<'.repeat(262_000)],
    ['attributs class sans valeur fermée', '<a class='.repeat(29_000)],
    ['attributs nus répétés', 'class='.repeat(43_000)],
  ])('%s : detectChallengePage (strict et non strict) et challengeInText en moins de 50 ms', (_name, body) => {
    expect(body.length).toBeLessThanOrEqual(262_144);
    expect(bestOf(() => detectChallengePage(body, HTML, { strict: true }))).toBeLessThan(50);
    expect(bestOf(() => detectChallengePage(body, HTML))).toBeLessThan(50);
    expect(bestOf(() => challengeInText(body))).toBeLessThan(50);
  });

  it('le balayage linéaire garde la détection : script, style et commentaire retirés du texte visible, fermeture absente coupée', () => {
    const hidden = html('Accueil', '<p>Bienvenue</p><script>var t = "verify you are human";</script><style>.x{}</style><!-- verify you are human -->');
    expect(detectChallengePage(hidden, HTML)).toBeNull();
    expect(detectChallengePage(html('Accueil', '<p>Please verify you are human.</p><SCRIPT type="x">a</SCRIPT >'), HTML)).toMatchObject({ source: 'phrase' });
    expect(detectChallengePage(html('Accueil', '<p>Bienvenue</p><script>verify you are human'), HTML)).toBeNull();
    expect(detectChallengePage(html('Accueil', '<p>Please verify you are human.</p><!-- reste'), HTML)).toMatchObject({ source: 'phrase' });
  });
});
