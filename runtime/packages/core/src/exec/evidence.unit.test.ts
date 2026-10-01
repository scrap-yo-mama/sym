// SPDX-License-Identifier: AGPL-3.0-only
// Preuves remises à l'agent de réparation (tâche 1.7, revue ; 04 §5 « journaux masqués, diff de forme » ; 17 §6) :
// la forme de la page, jamais ses valeurs. Squelette HTML (balises, id, class), squelette JSON (clés, types), texte
// libre masqué par le registre du run ; en-têtes réduits, URL sans requête.
import { describe, expect, it } from 'vitest';
import { PersonalValueRegistry } from '../privacy/mask.js';
import { minimizeEvidence, type HttpExchange } from './index.js';

const registry = (): PersonalValueRegistry => {
  const r = new PersonalValueRegistry();
  r.add('Jeanne Zztest');
  return r;
};

const exchange = (body: string, contentType: string, extra: Record<string, string> = {}): HttpExchange => ({
  status: 200,
  headers: { 'content-type': contentType, 'set-cookie': 'zz_test_session=secret', 'x-request-id': 'zz_test_req_1', ...extra },
  body,
  url: 'http://zz_test_dom.localhost/clients/jeanne?email=jeanne%40example.invalid#top',
});

describe('assert_no_personal_data_in_logs : preuves minimisées avant tout prompt de réparation', () => {
  it('HTML : squelette (balises, id, class, role) sans texte, sans liens ni données ; script, style et commentaires retirés', () => {
    const body =
      '<!doctype html><html><head><title>Fiche de Jeanne Zztest</title><style>.x{}</style><script>var t="jeanne@example.invalid";</script></head>' +
      '<body><!-- client 42 --><ul class="items"><li class="item" data-id="7"><a href="/clients/jeanne-zztest" class="item-title">Jeanne Zztest</a>' +
      '<span class="item-email">jeanne@example.invalid</span><span class="item-phone">+33 6 12 34 56 78</span></li></ul>' +
      '<div id="user-Jeanne Zztest" role="main">Bonjour</div></body></html>';
    const out = minimizeEvidence(exchange(body, 'text/html; charset=utf-8'), registry());
    expect(typeof out).toBe('object');
    if (typeof out === 'string') return;
    for (const value of ['Jeanne', 'Zztest', 'jeanne', 'example.invalid', '+33', 'Bonjour', 'client 42', 'data-id', '/clients', 'zz_test_session', 'zz_test_req_1']) {
      expect(JSON.stringify({ body: out.body, headers: out.headers }), value).not.toContain(value);
    }
    expect(out.body).toContain('<ul class="items">');
    expect(out.body).toContain('<li class="item">');
    expect(out.body).toContain('<a class="item-title">');
    expect(out.body).toContain('<span class="item-email">');
    expect(out.body).toContain('role="main"');
    expect(out.headers).toEqual({ 'content-type': 'text/html; charset=utf-8' });
    // URL : chemin gardé (réparation d'un not_found), requête et fragment retirés, valeurs connues masquées.
    expect(out.url).toBe('http://zz_test_dom.localhost/clients/jeanne');
    expect(minimizeEvidence({ ...exchange('', 'text/html'), url: 'http://zz_test_dom.localhost/p/Jeanne%20Zztest' }, registry())).toMatchObject({ url: 'http://zz_test_dom.localhost/p/[PERSONAL]' });
    expect(out.status).toBe(200);
  });

  it('JSON : clés et types gardés, valeurs retirées ; clé personnelle masquée', () => {
    const body = JSON.stringify({ items: [{ name: 'Jeanne Zztest', email: 'jeanne@example.invalid', age: 41, vip: true, tags: ['a', 'b'], note: null }], 'jeanne@example.invalid': 1 });
    const out = minimizeEvidence(exchange(body, 'application/json'), registry());
    if (typeof out === 'string') throw new Error('échange attendu');
    expect(JSON.parse(out.body)).toEqual({ items: [{ name: '', email: '', age: 0, vip: false, tags: [''], note: null }], '[PERSONAL]': 0 });
  });

  it('texte brut : jamais rendu (taille seulement) ; texte libre (journal, instantané) masqué par le registre du run', () => {
    const out = minimizeEvidence(exchange('Client : Jeanne Zztest, jeanne@example.invalid', 'text/plain'), registry());
    if (typeof out === 'string') throw new Error('échange attendu');
    expect(out.body).not.toMatch(/Jeanne|jeanne/);
    const text = minimizeEvidence('listitem "Jeanne Zztest" text "jeanne@example.invalid" button "Suivant"', registry());
    expect(text).toBe('listitem "[PERSONAL]" text "[PERSONAL]" button "Suivant"');
  });

  it('corps hostile (256 Kio de balises non fermées) : minimisé en temps linéaire', () => {
    const t = performance.now();
    minimizeEvidence(exchange('<a class='.repeat(29_000), 'text/html'), registry());
    minimizeEvidence(exchange('<!--'.repeat(65_000), 'text/html'), registry());
    minimizeEvidence(exchange('['.repeat(100_000), 'application/json'), registry());
    expect(performance.now() - t).toBeLessThan(200);
  });
});
