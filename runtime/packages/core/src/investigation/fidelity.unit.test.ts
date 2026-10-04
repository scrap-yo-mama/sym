// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle de fidélité (banc réel, passage 1) : une stratégie conforme au schéma mais aux champs vides ou mal affectés est
// refusée avant d'être retenue. Pages et valeurs FICTIVES qui reproduisent R03 (nom vide alors que la carte le montre), R04
// (équipe = mode de travail), R09 (date de début = organisateur), R10 (étiquettes absentes alors que la réponse les porte).
import { describe, expect, it } from 'vitest';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { fidelityCheck, fidelityDiff, fidelitySamples, looksLikeDate } from './fidelity.js';
import type { DataCandidate } from './recon.js';

const schema = (fields: Record<string, string>, required: string[] = []) => ({
  type: 'object',
  required,
  properties: Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, t === 'array' ? { type: 'array', items: { type: 'string' } } : { type: t }])),
  additionalProperties: false,
});

const domCandidate = (slots: { name: string; css: string; attr?: string; present: number; up?: number }[], count: number): DataCandidate => ({
  id: 'c1',
  from: 'dom',
  request: { method: 'GET', url: 'https://zz_test_equipe.localhost/about' },
  host: 'zz_test_equipe.localhost',
  records: 'div.card',
  count,
  bytes: 1000,
  skeleton: Object.fromEntries(slots.map((s) => [`$.${s.name}`, `text;shape=text;present=${s.present}/${count}`])),
  dom: { slots: slots.map((s) => ({ name: s.name, css: s.css, attr: s.attr ?? 'text', shape: 'text', present: s.present, prefix: null, suffix: null, decimal: '.' as const, ...(s.up === undefined ? {} : { up: s.up }) })), pagination: null, rendered: false },
});

const htmlSpec = (fields: Record<string, { css: string; up?: number }>, records = 'div.card'): DeclarativeSpec => {
  const out = validateDeclarativeSpec({
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: 'https://zz_test_equipe.localhost/about', allowed_hosts: ['zz_test_equipe.localhost'] },
    sources: [{ id: 'page', from: 'html', records }],
    fields: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { css: f.css, attr: 'text', type: 'string', ...(f.up === undefined ? {} : { up: f.up }) }])),
  });
  if (!out.ok) throw new Error(JSON.stringify(out.errors));
  return out.spec;
};

describe('contrôle déterministe (a)', () => {
  it('R03 : nom vide sur tous les éléments alors que l’emplacement relié est présent sur chaque carte → refus « empty »', () => {
    const records = Array.from({ length: 10 }, (_, k) => ({ job_title: `Poste ${k}`, location: 'Villezz' }));
    const candidate = domCandidate([{ name: 'h3', css: '.name', present: 10 }, { name: 'p', css: '.job', present: 10 }], 10);
    const spec = htmlSpec({ name: { css: '.name' }, job_title: { css: '.job' } });
    const out = fidelityCheck({ records, outputSchema: schema({ name: 'string', job_title: 'string', location: 'string' }), spec, candidate });
    expect(out.ok).toBe(false);
    expect(out.issues).toEqual([{ field: 'name', code: 'empty', share: 1 }]);
  });

  it('champ vide sur moins de 20 % des éléments, ou que la page ne montre pas (salaire absent partout) : accepté', () => {
    const records = Array.from({ length: 10 }, (_, k) => ({ title: `Offre ${k}`, ...(k < 9 ? { surface: 100 + k } : {}) }));
    expect(fidelityCheck({ records, outputSchema: schema({ title: 'string', surface: 'number', salary: 'string' }) }).ok).toBe(true);
  });

  it('R04 : équipe et mode de travail aux mêmes valeurs → refus « duplicate » sur les deux champs ; deux liens identiques admis', () => {
    const records = Array.from({ length: 8 }, (_, k) => ({ title: `Offre ${k}`, team: 'Hybrid —', work_mode: 'Hybrid —', url: `https://zz.localhost/o/${k}`, apply_url: `https://zz.localhost/o/${k}` }));
    const out = fidelityCheck({ records, outputSchema: schema({ title: 'string', team: 'string', work_mode: 'string', url: 'string', apply_url: 'string' }) });
    expect(out.issues.map((i) => `${i.field}:${i.code}:${i.other}`).sort()).toEqual(['team:duplicate:work_mode', 'work_mode:duplicate:team']);
  });

  it('R09 : date de début qui ne ressemble pas à une date → refus « not_a_date » ; formes de dates admises', () => {
    const records = Array.from({ length: 6 }, (_, k) => ({ name: `Evenement ${k}`, start_date: `By Organisateur Zztest ${k}` }));
    expect(fidelityCheck({ records, outputSchema: schema({ name: 'string', start_date: 'string' }) }).issues).toEqual([{ field: 'start_date', code: 'not_a_date', share: 1 }]);
    for (const ok of ['2026-10-04T06:30:00.000Z', '06/02/2026', 'June 2026', '4 oct. 2026', '18:30']) expect(looksLikeDate(ok)).toBe(true);
    expect(looksLikeDate('By Zztest')).toBe(false);
  });

  it('R10 : étiquettes absentes alors que le gisement JSON porte une clé « tags » non lue → refus « empty »', () => {
    const candidate: DataCandidate = { id: 'c1', from: 'response', request: { method: 'GET', url: 'https://zz_test_quotes.localhost/api/quotes?page=1' }, host: 'zz_test_quotes.localhost', records: '$.quotes[*]', count: 10, bytes: 100, skeleton: { '$.text': 'string', '$.author.name': 'string', '$.tags': 'array' } };
    const records = Array.from({ length: 10 }, (_, k) => ({ text: `Citation ${k}`, author: `Auteur ${k}` }));
    const out = fidelityCheck({ records, outputSchema: schema({ text: 'string', author: 'string', tags: 'array' }), candidate });
    expect(out.issues).toEqual([{ field: 'tags', code: 'empty', share: 1 }]);
  });

  it('différentiel : codes et parts seulement, jamais une valeur', () => {
    const text = fidelityDiff([{ field: 'team', code: 'duplicate', share: 1, other: 'work_mode' }, { field: 'start_date', code: 'not_a_date', share: 1 }]);
    expect(text).toContain('field "team": same values as "work_mode" on 100% of records');
    expect(text).toContain('field "start_date": 100% of values do not look like a date');
    expect(text).not.toContain('Hybrid');
  });
});

describe('échantillon du juge (b)', () => {
  it('HTML : premier, milieu, dernier bloc, fragment épuré du bloc et titre du groupe', () => {
    const groups = ['Equipe A', 'Equipe B'].map((g, n) => `<section class="grp"><h4 class="grp-title">${g}</h4>${[0, 1, 2].map((k) => `<div class="card"><h3 class="name" onclick="evil()">Personne ${n * 3 + k}</h3><p class="job" style="x">Poste</p><script>alert(1)</script></div>`).join('')}</section>`).join('');
    const html = `<html><body>${groups}</body></html>`;
    const spec = htmlSpec({ name: { css: '.name' }, team: { css: '.grp-title', up: 1 } });
    const samples = fidelitySamples(spec, html, schema({ name: 'string', team: 'string' }));
    expect(samples.map((s) => s.record)).toEqual([{ name: 'Personne 0', team: 'Equipe A' }, { name: 'Personne 2', team: 'Equipe A' }, { name: 'Personne 5', team: 'Equipe B' }]);
    expect(samples[0]!.kind).toBe('html');
    expect(samples[0]!.fragment).toBe('<group_heading><h4 class="grp-title">Equipe A</h4></group_heading><div class="card"><h3 class="name">Personne 0</h3><p class="job">Poste</p></div>');
  });

  it('JSON : fragment = objet de l’enregistrement, borné', () => {
    const out = validateDeclarativeSpec({ schema_version: 1, kind: 'declarative', request: { method: 'GET', url: 'https://zz_test_quotes.localhost/api', allowed_hosts: ['zz_test_quotes.localhost'] }, sources: [{ id: 'api', from: 'response', format: 'json', records: '$.quotes[*]' }], fields: { text: { path: '$.text', type: 'string' } } });
    if (!out.ok) throw new Error('spec');
    const body = JSON.stringify({ quotes: Array.from({ length: 5 }, (_, k) => ({ text: `Citation ${k}`, tags: ['a', 'b'] })) });
    const samples = fidelitySamples(out.spec, body, schema({ text: 'string' }));
    expect(samples.map((s) => s.fragment)).toEqual(['{"text":"Citation 0","tags":["a","b"]}', '{"text":"Citation 2","tags":["a","b"]}', '{"text":"Citation 4","tags":["a","b"]}']);
  });
});

describe('localisateur up (titre de groupe)', () => {
  it('refusé sur une source JSON ; exige un sélecteur css', () => {
    const base = { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: 'https://zz.localhost/a', allowed_hosts: ['zz.localhost'] } };
    const json = validateDeclarativeSpec({ ...base, sources: [{ id: 'api', from: 'response', format: 'json', records: '$[*]' }], fields: { team: { path: '$.t', up: 1, type: 'string' } } });
    expect(json.ok).toBe(false);
    const noCss = validateDeclarativeSpec({ ...base, sources: [{ id: 'page', from: 'html', records: 'div' }], fields: { team: { attr: 'text', up: 1, type: 'string' } } });
    expect(noCss.ok).toBe(false);
    const tooHigh = validateDeclarativeSpec({ ...base, sources: [{ id: 'page', from: 'html', records: 'div' }], fields: { team: { css: 'h4', up: 4, type: 'string' } } });
    expect(tooHigh.ok).toBe(false);
  });
});
