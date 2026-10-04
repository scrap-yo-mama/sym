// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle de fidélité, PLAUSIBILITÉ (banc réel R13, liste de biens de prestige) : une stratégie dont chaque valeur est
// conforme au schéma mais invraisemblable est refusée. La page FICTIVE reproduit la structure constatée (24 cartes : chambres,
// m² habitables, salles de bains, « Surfaces extérieures », prix, ville, type, badge « Nouveauté », conteneur photo
// `data-carousel="carousel-<réf>"`, aucun nombre de pièces) ; aucune donnée réelle. Affectations fautives constatées :
// pièces et chambres lues dans d'autres nombres de la carte, surface du terrain prise pour la surface habitable, référence
// préfixée par l'identifiant du carrousel, type de bien = badge ; au 2e essai, ville et type inversés.
import { describe, expect, it } from 'vitest';
import { extractRecords } from '../dsl/extract.js';
import { validateDeclarativeSpec, type DeclarativeSpec, type FieldSpec } from '../dsl/spec.js';
import { fidelityCheck, fidelityDiff, type FidelityIssue } from './fidelity.js';

const HOST = 'zz_test_prestige.localhost';
const PAGE = `https://${HOST}/fr/vente/zz-france.html`;
const TYPES = ['Propriété', 'Appartement', 'Villa', 'Maison', 'Hôtel particulier', 'Chalet'];
const CITIES = ['Zzville', 'Testbourg-sur-Mer', 'Fixtureville', 'Saint-Zztest', 'Mockbourg', 'Zzcity Les Pins'];
const BADGES = ['Nouveauté', 'Nouveauté', 'Nouveauté', 'Exclusivité'];
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Bien n°k (0 à 23), déterministe ; les appartements n’ont pas de surface extérieure ; un domaine sur cinq dépasse 10 ha. */
function prestigeCard(k: number) {
  const type = TYPES[k % TYPES.length]!;
  return {
    code: `ZZM-${87_334_950 + k * 7_919}`,
    type,
    city: CITIES[(k * 5) % CITIES.length]!,
    bedrooms: 3 + ((k * 5) % 13),
    bathrooms: 2 + ((k * 3) % 7),
    area: 120 + ((k * 137) % 1_600),
    land: type === 'Appartement' ? null : k % 5 === 0 ? 102_212 + k * 1_000 : 500 + ((k * 7_919) % 60_000),
    // Prix de luxe étalés de 300 000 à 50 000 000 (échelle logarithmique) : aucun n'est une aberration.
    price: Math.round((300_000 * (50_000_000 / 300_000) ** (k / 23)) / 10_000) * 10_000,
    badge: k % 12 === 11 ? null : BADGES[k % BADGES.length]!,
  };
}

function prestigePage(): string {
  const cards = Array.from({ length: 24 }, (_, k) => {
    const c = prestigeCard(k);
    const slug = `${c.type.toLowerCase().replace(/[^a-z]+/g, '-')}-${c.code.toLowerCase()}`;
    return `<article class="zz-card">
<div class="zz-photos" data-carousel="carousel-${c.code}"><img src="/media/${k}.jpg" width="2000" height="1100" alt=""></div>
${c.badge === null ? '' : `<span class="zz-badge">${c.badge}</span>`}
<a class="zz-link" href="/fr/vente/${slug}.html"><h3 class="zz-type">${c.type}</h3></a>
<p class="zz-city">${c.city}</p>
<p class="zz-price">${thousands(c.price)} €</p>
<ul class="zz-features"><li class="zz-bed">${c.bedrooms} Chambres</li><li class="zz-area">${thousands(c.area)} m²</li><li class="zz-bath">${c.bathrooms} salles de bains</li>${c.land === null ? '' : `<li class="zz-ext">Surfaces extérieures ${thousands(c.land)} m²</li>`}</ul>
</article>`;
  }).join('\n');
  return `<html><body><main class="zz-list">${cards}</main></body></html>`;
}

const NUMBER = (type: 'integer' | 'number'): FieldSpec['ops'] => ['collapse_spaces', { op: 'regex_extract', pattern: '[0-9][0-9  .,]*', group: 0 }, 'trim', { op: type === 'integer' ? 'to_integer' : 'to_number', decimal: ',' }];

type Slot = { css: string; attr?: string; type?: 'string' | 'integer' | 'number'; ops?: FieldSpec['ops'] };
const SLOTS = {
  bed: { css: '.zz-bed', type: 'integer', ops: NUMBER('integer') },
  bath: { css: '.zz-bath', type: 'integer', ops: NUMBER('integer') },
  area: { css: '.zz-area', type: 'number', ops: NUMBER('number') },
  ext: { css: '.zz-ext', type: 'number', ops: NUMBER('number') },
  price: { css: '.zz-price', type: 'number', ops: NUMBER('number') },
  imgWidth: { css: 'img', attr: 'width', type: 'integer', ops: NUMBER('integer') },
  imgHeight: { css: 'img', attr: 'height', type: 'integer', ops: NUMBER('integer') },
  city: { css: '.zz-city' },
  type: { css: '.zz-type' },
  badge: { css: '.zz-badge' },
  carousel: { css: '.zz-photos', attr: 'data-carousel' },
  ref: { css: '.zz-photos', attr: 'data-carousel', ops: [{ op: 'regex_extract', pattern: '[A-Z]{3}-[0-9]+', group: 0 }] },
  url: { css: 'a.zz-link', attr: 'href', ops: [{ op: 'abs_url', base: PAGE }] },
} satisfies Record<string, Slot>;

const DESCRIPTIONS: Record<string, string> = {
  url: 'Link to the listing page',
  reference: 'Listing reference',
  property_type: 'Type of property (apartment, house, villa...)',
  location: 'City where the property is located',
  price: 'Asking price in euros',
  rooms: 'Number of rooms',
  bedrooms: 'Number of bedrooms',
  bathrooms: 'Number of bathrooms',
  surface: 'Living area in square meters',
  land_surface: 'Land or outdoor area in square meters',
};

function strategy(map: Record<string, Slot>): { spec: DeclarativeSpec; schema: Record<string, unknown> } {
  const fields = Object.fromEntries(
    Object.entries(map).map(([name, s]) => [name, { css: s.css, attr: s.attr ?? 'text', type: s.type ?? 'string', ops: s.ops ?? ['collapse_spaces', 'trim'] }]),
  );
  const out = validateDeclarativeSpec({
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: PAGE, allowed_hosts: [HOST] },
    sources: [{ id: 'page', from: 'html', records: 'article.zz-card' }],
    fields,
  });
  if (!out.ok) throw new Error(JSON.stringify(out.errors));
  const schema = {
    type: 'object',
    required: ['url'],
    properties: Object.fromEntries(Object.entries(map).map(([name, s]) => [name, { type: [s.type ?? 'string', 'null'], description: DESCRIPTIONS[name] ?? `Field ${name}` }])),
    additionalProperties: false,
  };
  return { spec: out.spec, schema };
}

function check(map: Record<string, Slot>) {
  const { spec, schema } = strategy(map);
  const out = extractRecords(spec, { body: prestigePage() }, { outputSchema: schema, itemPolicy: 'quarantine' });
  expect(out.records).toHaveLength(24);
  return fidelityCheck({ records: out.records, outputSchema: schema, spec });
}

const codes = (issues: readonly FidelityIssue[]) => issues.map((i) => `${i.field}:${i.code}${i.other === undefined ? '' : `:${i.other}`}`).sort();

const GOOD = { url: SLOTS.url, reference: SLOTS.ref, property_type: SLOTS.type, location: SLOTS.city, price: SLOTS.price, bedrooms: SLOTS.bed, bathrooms: SLOTS.bath, surface: SLOTS.area, land_surface: SLOTS.ext };

describe('plausibilité : cartes de biens de prestige (R13)', () => {
  it('bonne affectation (chambres, m² habitables, surfaces extérieures, référence nue, type, ville) → acceptée', () => {
    const out = check(GOOD);
    expect(out.issues).toEqual([]);
    expect(out.ok).toBe(true);
  });

  it('1er essai constaté : pièces et chambres lues dans d’autres nombres, terrain pris pour la surface habitable, référence du carrousel, type = badge → refus', () => {
    const out = check({ ...GOOD, rooms: SLOTS.imgWidth, bedrooms: SLOTS.imgHeight, surface: SLOTS.ext, reference: SLOTS.carousel, property_type: SLOTS.badge });
    expect(out.ok).toBe(false);
    const got = codes(out.issues);
    expect(got).toEqual(expect.arrayContaining(['rooms:implausible', 'bedrooms:implausible', 'surface:inconsistent:land_surface', 'reference:technical_prefix', 'property_type:marketing_label']));
    // Les champs justes ne sont pas mis en cause.
    expect(got.filter((c) => /^(url|price|location|bathrooms):/.test(c))).toEqual([]);
  });

  it('pièces = nombre de salles de bains : plus de chambres que de pièces sur la plupart des cartes → refus « inconsistent »', () => {
    const out = check({ ...GOOD, rooms: SLOTS.bath });
    expect(out.ok).toBe(false);
    expect(codes(out.issues)).toContain('bedrooms:inconsistent:rooms');
  });

  it('2e essai constaté : ville et type de bien inversés → refus « swapped » sur les deux champs', () => {
    const out = check({ ...GOOD, location: SLOTS.type, property_type: SLOTS.city });
    expect(out.ok).toBe(false);
    expect(codes(out.issues)).toEqual(['location:swapped:property_type', 'property_type:swapped:location']);
  });

  it('surface habitable lue dans la surface extérieure sans champ de terrain : valeurs hors bornes ou aberrantes → refus', () => {
    const { land_surface: _land, ...rest } = GOOD;
    const out = check({ ...rest, surface: SLOTS.ext });
    expect(out.ok).toBe(false);
    expect(codes(out.issues).some((c) => c === 'surface:implausible' || c === 'surface:outlier')).toBe(true);
  });

  it('différentiel des nouveaux codes : codes, parts et autre champ seulement, jamais une valeur du site', () => {
    const out = check({ ...GOOD, rooms: SLOTS.imgWidth, bedrooms: SLOTS.imgHeight, surface: SLOTS.ext, reference: SLOTS.carousel, property_type: SLOTS.badge, location: SLOTS.type });
    expect(codes(out.issues)).toEqual(expect.arrayContaining(['location:swapped', 'property_type:marketing_label']));
    const text = fidelityDiff(out.issues);
    for (const line of ['field "rooms"', 'field "reference"', 'field "property_type"', 'field "surface"']) expect(text).toContain(line);
    for (const value of ['carousel-ZZM', 'ZZM-', 'Nouveauté', 'Exclusivité', '2000', '1100', 'Zzville', 'Propriété', 'Appartement']) expect(text).not.toContain(value);
  });
});

// ---------------------------------------------------------------------------------------------------- règles génériques
const schemaOf = (fields: Record<string, { type: string; description?: string }>) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { type: f.type, ...(f.description === undefined ? {} : { description: f.description }) }])),
});
const rows = (n: number, make: (k: number) => Record<string, unknown>) => Array.from({ length: n }, (_, k) => make(k));

describe('plausibilité : bornes génériques par nom et description du champ (fr et en)', () => {
  it('compte de pièces / chambres / salles de bains : entier de 0 à 100 ; nom français reconnu', () => {
    const out = fidelityCheck({ records: rows(20, (k) => ({ nb_pieces: 3 + (k % 5), chambres: k < 4 ? 250 : 2, salles_de_bain: 1 })), outputSchema: schemaOf({ nb_pieces: { type: 'integer' }, chambres: { type: 'integer' }, salles_de_bain: { type: 'integer' } }) });
    expect(out.issues).toEqual([{ field: 'chambres', code: 'implausible', share: 0.2, kind: 'bedrooms' }]);
  });

  it('une seule valeur hors bornes sur 24 (moins de 5 %) : acceptée', () => {
    expect(fidelityCheck({ records: rows(24, (k) => ({ bedrooms: k === 0 ? 400 : 3 })), outputSchema: schemaOf({ bedrooms: { type: 'integer' } }) }).ok).toBe(true);
  });

  it('prix négatif, année hors de 1000 à l’an prochain + 10, pourcentage hors de 0 à 100, note hors échelle → « implausible »', () => {
    const year = new Date().getFullYear();
    const records = rows(10, (k) => ({ price: k < 2 ? -5 : 1_000, year_built: k < 2 ? year + 50 : 1990, discount_percent: k < 2 ? 140 : 20, rating: k < 2 ? 450 : 4 }));
    const out = fidelityCheck({ records, outputSchema: schemaOf({ price: { type: 'number' }, year_built: { type: 'integer' }, discount_percent: { type: 'number' }, rating: { type: 'number' } }) });
    expect(codes(out.issues)).toEqual(['discount_percent:implausible', 'price:implausible', 'rating:implausible', 'year_built:implausible']);
  });

  it('description seule : un champ « value » décrit comme « Number of bedrooms » est borné', () => {
    const out = fidelityCheck({ records: rows(10, () => ({ value: 1100 })), outputSchema: schemaOf({ value: { type: 'integer', description: 'Number of bedrooms' } }) });
    expect(out.issues).toEqual([{ field: 'value', code: 'implausible', share: 1, kind: 'bedrooms' }]);
  });

  it('pas de faux positif : pièces d’un jeu de construction, chambres d’un hôtel, superficie en km², variation en %, ville « Studio »', () => {
    const records = rows(12, (k) => ({ pieces: 1_500 + k * 300, hotel_rooms: 250 + k, area_km2: 0.4 + k, change_percent: -12 + k, city: k === 0 ? 'Studio' : `Zzville ${k}`, surface_m2: 60 + k }));
    const out = fidelityCheck({
      records,
      outputSchema: schemaOf({
        pieces: { type: 'integer', description: 'Number of pieces in the set' },
        hotel_rooms: { type: 'integer', description: 'Number of rooms of the hotel' },
        area_km2: { type: 'number', description: 'Area of the commune in km²' },
        change_percent: { type: 'number', description: 'Price change over a day, in percent' },
        city: { type: 'string' },
        surface_m2: { type: 'number' },
      }),
    });
    expect(out.issues).toEqual([]);
  });

  it('surface habitable égale à la surface du terrain sur toutes les fiches → « inconsistent » ; un terrain plus grand que la maison est la norme', () => {
    const same = fidelityCheck({ records: rows(10, (k) => ({ living_area: 2_000 + k, land_area: 2_000 + k })), outputSchema: schemaOf({ living_area: { type: 'number' }, land_area: { type: 'number' } }) });
    expect(same.issues).toEqual([{ field: 'living_area', code: 'inconsistent', share: 1, other: 'land_area', kind: 'living_area' }]);
    const normal = fidelityCheck({ records: rows(10, (k) => ({ living_area: 100 + k * 30, land_area: 300 + k * 900 })), outputSchema: schemaOf({ living_area: { type: 'number' }, land_area: { type: 'number' } }) });
    expect(normal.ok).toBe(true);
  });
});

describe('plausibilité : aberrations statistiques (échelle log, écart interquartile)', () => {
  it('prix de luxe de 300 000 à 50 000 000 : aucune aberration', () => {
    const records = rows(30, (k) => ({ price: Math.round(300_000 * (50_000_000 / 300_000) ** (k / 29)) }));
    expect(fidelityCheck({ records, outputSchema: schemaOf({ price: { type: 'number' } }) }).ok).toBe(true);
  });

  it('deux valeurs sur 24 à plus de deux ordres de grandeur de la médiane → « outlier » ; une seule (moins de 5 %) : acceptée', () => {
    const two = rows(24, (k) => ({ weight_kg: k < 2 ? 85_000 : 60 + k }));
    expect(fidelityCheck({ records: two, outputSchema: schemaOf({ weight_kg: { type: 'number' } }) }).issues).toEqual([{ field: 'weight_kg', code: 'outlier', share: 0.08 }]);
    const one = rows(24, (k) => ({ weight_kg: k < 1 ? 85_000 : 60 + k }));
    expect(fidelityCheck({ records: one, outputSchema: schemaOf({ weight_kg: { type: 'number' } }) }).ok).toBe(true);
  });

  it('identifiants, codes et coordonnées ne sont jamais jugés en aberration', () => {
    const records = rows(24, (k) => ({ listing_id: k < 3 ? 7 + k : 9_000_000 + k, longitude: k < 3 ? 0.004 : 2.35 }));
    expect(fidelityCheck({ records, outputSchema: schemaOf({ listing_id: { type: 'integer' }, longitude: { type: 'number' } }) }).ok).toBe(true);
  });
});

describe('plausibilité : champs inversés, badge, préfixe technique', () => {
  it('type de bien qui reprend les valeurs d’un autre champ de localisation → « swapped »', () => {
    const records = rows(10, (k) => ({ property_type: `Zzville${k % 4}`, address: `${k} rue Zztest, 99000 Zzville${k % 4}` }));
    expect(codes(fidelityCheck({ records, outputSchema: schemaOf({ property_type: { type: 'string' }, address: { type: 'string' } }) }).issues)).toEqual(['property_type:swapped:address']);
  });

  it('badge marketing en anglais sur la majorité des éléments → « marketing_label »', () => {
    const records = rows(10, (k) => ({ category: k < 7 ? 'New' : 'House' }));
    expect(fidelityCheck({ records, outputSchema: schemaOf({ category: { type: 'string' } }) }).issues).toEqual([{ field: 'category', code: 'marketing_label', share: 0.7 }]);
  });

  it('référence préfixée dont le code est dans l’URL → « technical_prefix » ; référence égale au segment de l’URL : acceptée', () => {
    const bad = rows(10, (k) => ({ reference: `slide-AB${100 + k}`, url: `https://zz.localhost/bien/ab${100 + k}` }));
    expect(fidelityCheck({ records: bad, outputSchema: schemaOf({ reference: { type: 'string' }, url: { type: 'string' } }) }).issues).toEqual([{ field: 'reference', code: 'technical_prefix', share: 1 }]);
    const ok = rows(10, (k) => ({ reference: `property-${100 + k}`, url: `https://zz.localhost/property-${100 + k}` }));
    expect(fidelityCheck({ records: ok, outputSchema: schemaOf({ reference: { type: 'string' }, url: { type: 'string' } }) }).ok).toBe(true);
  });
});
