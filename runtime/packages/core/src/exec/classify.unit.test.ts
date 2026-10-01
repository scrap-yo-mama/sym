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
