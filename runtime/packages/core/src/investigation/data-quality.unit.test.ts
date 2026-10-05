// SPDX-License-Identifier: AGPL-3.0-only
// U1.11 : qualité VISIBLE des données (UX-22, UX-25, UX-26, UX-27), logique pure.
// - UX-22 : un champ `format: uri` vide ou qui n'est pas une URL est un défaut de fidélité ; le texte visible donne les liens ;
// - UX-25 : le schéma précédent est l'ancre de la nouvelle proposition, tout changement est signalé ;
// - UX-26 : une pagination demandée dans la description (« 3 premières pages ») est lue par le code ;
// - UX-27 : une valeur coupée par « ... » est détectée.
import { describe, expect, test } from 'vitest';
import { htmlToVisibleText } from '../agent/page-text.js';
import { fidelityCheck, fidelityDiff } from './fidelity.js';
import { minimalContentCheck } from '../quality/minimal.js';
import { buildInputSchema } from '../schema/input-schema.js';
import { requestedPageLimit, schemaAnchorChanges } from './data-quality.js';

const schemaOf = (props: Record<string, unknown>) => ({ type: 'object', properties: props });

describe('UX-27 : valeurs tronquées « ... »', () => {
  const schema = schemaOf({ title: { type: 'string' }, price: { type: 'number' } });
  test('titres terminés par « ... » ou « … » sur plus de 20 % des éléments : défaut `truncated`', () => {
    const records = [{ title: 'A Light in the ...', price: 1 }, { title: 'Tipping the Velvet', price: 2 }, { title: 'Soumission e...', price: 3 }, { title: 'Sharp Objects', price: 4 }];
    const check = fidelityCheck({ records, outputSchema: schema });
    expect(check.ok).toBe(false);
    expect(check.issues).toContainEqual({ field: 'title', code: 'truncated', share: 0.5 });
    expect(fidelityDiff(check.issues)).toContain('cut with "..."');
  });
  test('un seul titre se terminant par des points de suspension sur dix : pas de défaut', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ title: i === 0 ? 'Et caetera...' : `Titre complet ${i}`, price: i }));
    expect(fidelityCheck({ records, outputSchema: schema }).ok).toBe(true);
  });
  test('les champs non texte et les valeurs très courtes ne comptent pas', () => {
    const records = Array.from({ length: 4 }, () => ({ title: '...', price: 3 }));
    expect(fidelityCheck({ records, outputSchema: schema }).ok).toBe(true);
  });
});

describe('UX-22 : champ `format: uri`', () => {
  const schema = schemaOf({ title: { type: 'string' }, apply: { type: 'string', format: 'uri' } });
  test('champ uri qui ne reçoit pas des URLs : `not_a_url` (même sans nom évocateur)', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ title: `Offre ${i}`, apply: 'Postuler maintenant' }));
    expect(fidelityCheck({ records, outputSchema: schema }).issues).toContainEqual({ field: 'apply', code: 'not_a_url', share: 1 });
  });
  test('champ uri rempli d’URLs absolues : conforme', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ title: `Offre ${i}`, apply: `https://jobs.zz-test.example/qonto/${i}` }));
    expect(fidelityCheck({ records, outputSchema: schema }).ok).toBe(true);
  });
  test('champ uri vide sur toutes les offres alors que la page montre des liens : `empty`', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ title: `Offre ${i}`, apply: null }));
    expect(fidelityCheck({ records, outputSchema: schema, pageShowsLinks: true }).issues).toContainEqual({ field: 'apply', code: 'empty', share: 1 });
    expect(fidelityCheck({ records, outputSchema: schema }).ok).toBe(true);
  });
});

describe('UX-22 : le texte visible donne les liens (origine et chemin, jamais de jeton)', () => {
  const html = '<ul><li><a href="/qonto/abc-123?session=zz-secret-token#apply">Designer produit</a></li><li><a href="https://autre.zz-test.example/x">Autre site</a></li><li><a href="javascript:void(0)">Rien</a></li><li><a href="#top">Haut</a></li><li><a href="mailto:rh@zz-test.example">Écrire</a></li></ul>';
  test('sans base : aucun lien (comportement historique)', () => {
    expect(htmlToVisibleText(html, 5_000).text).not.toMatch(/https?:/);
  });
  test('avec base : « texte (URL absolue) », requête et fragment retirés', () => {
    const { text } = htmlToVisibleText(html, 5_000, { linksBase: 'https://jobs.zz-test.example/qonto' });
    expect(text).toContain('Designer produit (https://jobs.zz-test.example/qonto/abc-123)');
    expect(text).toContain('Autre site (https://autre.zz-test.example/x)');
    expect(text).not.toMatch(/zz-secret-token|javascript|mailto|#top|#apply/);
  });
  test('un lien sans texte visible (icône) garde son URL', () => {
    const { text } = htmlToVisibleText('<div><a href="/p/1"><svg></svg></a></div>', 1_000, { linksBase: 'https://zz-test.example/' });
    expect(text).toBe('(https://zz-test.example/p/1)');
  });
});

describe('UX-25 : le schéma précédent est l’ancre', () => {
  const prev = schemaOf({ title: { type: 'string' }, price: { type: 'number' }, availability: { type: 'string' }, rating: { type: 'integer' } });
  test('aucun changement : rien à signaler', () => {
    expect(schemaAnchorChanges(prev, prev)).toEqual({ dropped: [], added: [], retyped: [], renamed: [] });
  });
  test('champ renommé (même type, nom différent) : signalé comme renommage probable, jamais en silence', () => {
    const next = schemaOf({ job_title: { type: 'string' }, price_gbp: { type: 'number' }, in_stock: { type: 'string' }, rating: { type: 'integer' } });
    const changes = schemaAnchorChanges(prev, next);
    expect([...changes.dropped].sort()).toEqual(['availability', 'price', 'title']);
    expect([...changes.added].sort()).toEqual(['in_stock', 'job_title', 'price_gbp']);
    expect(changes.renamed).toEqual(expect.arrayContaining([{ from: 'price', to: 'price_gbp' }]));
  });
  test('type changé : signalé', () => {
    const next = schemaOf({ title: { type: 'string' }, price: { type: 'string' }, availability: { type: 'string' }, rating: { type: 'integer' } });
    expect(schemaAnchorChanges(prev, next).retyped).toEqual(['price']);
  });
  test('champ ajouté seulement : signalé en ajout, pas en renommage', () => {
    const next = schemaOf({ ...(prev.properties as object), agency: { type: 'string' } });
    expect(schemaAnchorChanges(prev, next)).toEqual({ dropped: [], added: ['agency'], retyped: [], renamed: [] });
  });
  test('sans schéma précédent exploitable : aucun changement', () => {
    expect(schemaAnchorChanges({}, prev)).toEqual({ dropped: [], added: [], retyped: [], renamed: [] });
    expect(schemaAnchorChanges(null, prev)).toEqual({ dropped: [], added: [], retyped: [], renamed: [] });
  });
});

describe('UX-26 : pagination demandée dans la description', () => {
  test.each([
    ['Les 3 premières pages de la catégorie', 3],
    ['les trois premières pages', 3],
    ['first 5 pages of the catalogue', 5],
    ['the first two pages', 2],
    ['sur 4 pages', 4],
    ['seulement la première page', 1],
    ['page 1 seulement', 1],
    ['only the first page', 1],
  ])('« %s » → %d', (text, expected) => {
    expect(requestedPageLimit(text)).toBe(expected);
  });
  test.each(['toutes les pages', 'all pages of the catalogue', 'liste des offres', 'prix des livres, 20 par page', 'les 50 premiers livres', ''])('« %s » → aucune limite de pages', (text) => {
    expect(requestedPageLimit(text)).toBeNull();
  });
  test('au-delà de 100 pages : ignoré (borne)', () => {
    expect(requestedPageLimit('les 500 premières pages')).toBeNull();
  });
});


describe('UX-22 : champ lien vide alors que la page montre des liens', () => {
  const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string' }, url: { type: 'string' }, apply: { type: 'string', format: 'uri' } } };
  const outputs = [[{ title: 'a', url: null, apply: null }, { title: 'b', url: null, apply: null }]];
  test('sans lien sur la page : aucun défaut (le champ facultatif est légitimement vide)', () => {
    expect(minimalContentCheck(outputs, schema).ok).toBe(true);
  });
  test('avec liens sur la page : le champ lien vide partout est nommé (champ et raison)', () => {
    expect(minimalContentCheck(outputs, schema, { pageShowsLinks: true })).toMatchObject({ ok: false, detail: 'minimal_content', field: 'url', reason: 'sentinel' });
  });
  test('champ lien rempli sur au moins un élément : conforme', () => {
    expect(minimalContentCheck([[{ title: 'a', url: 'https://zz.example/1', apply: 'https://zz.example/a' }, { title: 'b', url: null, apply: null }]], schema, { pageShowsLinks: true }).ok).toBe(true);
  });
});

describe('UX-26 : max_pages porte la demande d’origine', () => {
  test('pages demandées : défaut annoncé, borné par le plafond', () => {
    const schema = buildInputSchema({ paginated: true, maxPages: 50, requestedPages: 3 }) as { properties: { max_pages: { default?: number; description: string } } };
    expect(schema.properties.max_pages.default).toBe(3);
    expect(schema.properties.max_pages.description).toContain('en voulait 3');
    const capped = buildInputSchema({ paginated: true, maxPages: 2, requestedPages: 9 }) as { properties: { max_pages: { default?: number } } };
    expect(capped.properties.max_pages.default).toBe(2);
  });
  test('sans demande : aucun défaut ; stratégie qui ne pagine pas : pas de max_pages', () => {
    expect((buildInputSchema({ paginated: true }) as { properties: { max_pages: { default?: number } } }).properties.max_pages.default).toBeUndefined();
    expect((buildInputSchema({ paginated: false, requestedPages: 3 }) as { properties: Record<string, unknown> }).properties['max_pages']).toBeUndefined();
  });
});
