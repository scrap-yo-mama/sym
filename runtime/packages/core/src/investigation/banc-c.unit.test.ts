// SPDX-License-Identifier: AGPL-3.0-only
// Banc de cas réels, correctif C (cdc/scrapyomama-runtime/.executed/banc-reel.md, passage 2), pages FICTIVES :
// - R02 : la surface des programmes neufs (4 m²) venait d'un nombre lu dans un texte qui n'est pas une surface.
import { describe, expect, it } from 'vitest';
import { parseHtml } from '../dsl/css.js';
import { extractRecords } from '../dsl/extract.js';
import { DEFAULT_DSL_LIMITS } from '../dsl/limits.js';
import { buildFromProposal, type InvestigationProposal, type ProposalField } from './proposal.js';
import { analyzeCapture, type DataCandidate, type ReconCapture } from './recon.js';

void parseHtml;
void DEFAULT_DSL_LIMITS;
const capture = (url: string, html: string): ReconCapture => ({ mode: 'static', pageUrl: url, document: { url, status: 200, html, renderedHtml: null, bytes: html.length }, exchanges: [], totalBytes: html.length });
const NONE = { type: 'none', param: null, start: null, has_more_path: null, next_path: null } as const;
const field = (name: string, type: ProposalField['type'], required = false): ProposalField => ({ name, type, required, personal: false, description: `Field ${name}` });
const slotOf = (c: DataCandidate, pred: (key: string, description: string) => boolean): string => {
  const hit = Object.entries(c.skeleton).find(([k, d]) => pred(k, d));
  if (hit === undefined) throw new Error(`aucun emplacement : ${JSON.stringify(c.skeleton)}`);
  return hit[0];
};

const HOST = 'www.zz_test_agence.localhost';
const URL_ = `https://${HOST}/achat/40`;
const card = (i: number, neuf: boolean): string =>
  `<div class="col-12 property-item"><div class="card"><h2 class="c-card__name">Achat Zztest ${i}</h2><p class="c-card__area">${neuf ? 'Du studio au 4 pièces' : `${100 + i} m²`}</p><a href="${neuf ? `https://neuf.zz_test_agence.localhost/prog/${i}` : `/maison-zz-v${1000 + i}`}" class="card-stretched-link">Voir</a></div></div>`;

describe('R02 : la surface n’est lue que dans un texte qui porte son unité', () => {
  it('« Du studio au 4 pièces » (programme neuf) ne donne plus 4 m² ; « 105 m² » reste lu', () => {
    const page1 = `<html><body><main><div class="row">${Array.from({ length: 16 }, (_, k) => card(k + 1, false)).join('')}</div></main></body></html>`;
    const candidates = analyzeCapture(capture(URL_, page1), [HOST]);
    const dom = candidates.find((c) => c.from === 'dom')!;
    const proposal: InvestigationProposal = {
      fields: [field('title', 'string', true), field('surface_m2', 'number', false), field('url', 'string', true)],
      sources: [{ candidate: dom.id, paths: [{ field: 'title', path: slotOf(dom, (k) => k.startsWith('$.h2')), ops: [] }, { field: 'surface_m2', path: slotOf(dom, (_k, d) => d.includes('shape=area')), ops: [] }, { field: 'url', path: slotOf(dom, (_k, d) => d.startsWith('link')), ops: [] }], pagination: NONE }],
    };
    const built = buildFromProposal(proposal, candidates, capture(URL_, page1));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const spec = built.strategies[0]!.spec;
    const classic = extractRecords(spec, { body: page1 }, { outputSchema: built.outputSchema });
    expect(classic.records[0]).toMatchObject({ surface_m2: 101 });
    const page17 = `<html><body><main><div class="row">${Array.from({ length: 16 }, (_, k) => card(300 + (k % 12), true)).join('')}</div></main></body></html>`;
    const neuf = extractRecords(spec, { body: page17 }, { outputSchema: built.outputSchema });
    expect(neuf.ok).toBe(true);
    for (const r of neuf.records) expect(r['surface_m2']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------- R05
const ATS = 'jobs.zz_test_ats.localhost';
const BOARD = `https://${ATS}/zzboard`;
const teams = [
  { id: 'T-tech', name: 'Tech', parentTeamId: null },
  { id: 'T-se', name: 'Software Engineering', parentTeamId: 'T-tech' },
  { id: 'T-prod', name: 'Product Design', parentTeamId: 'T-tech' },
];
const postings = Array.from({ length: 12 }, (_, i) => ({ id: `0000${i}-aaaa-bbbb`, title: `Offre Zztest ${i}`, teamId: i % 2 === 0 ? 'T-se' : 'T-prod', locationName: `Ville${i % 3}` }));
const graphql = JSON.stringify({ data: { jobBoard: { teams, jobPostings: postings } } });
const boardHtml = `<html><body><main>${postings.map((p) => `<a class="_container_x" href="/zzboard/${p.id}"><h3>${p.title}</h3></a>`).join('')}</main></body></html>`;
const atsCapture = (links: boolean): ReconCapture => ({
  mode: 'browser',
  pageUrl: BOARD,
  document: { url: BOARD, status: 200, html: '<html><body><div id="root"></div></body></html>', renderedHtml: links ? boardHtml : '<html><body></body></html>', bytes: 200 },
  exchanges: [{ url: `https://${ATS}/api/non-user-graphql?op=Board`, method: 'POST', requestBody: JSON.stringify({ operationName: 'Board', variables: { org: 'zz' } }), requestContentType: 'application/json', status: 200, contentType: 'application/json', body: graphql, bytes: graphql.length }],
  totalBytes: graphql.length,
});

describe('R05 : jointure entre les offres et les équipes de la même réponse, URL de l’offre déduite des liens de la page', () => {
  it('le squelette montre la jointure (équipe, parent) et l’URL, sans valeur du site', () => {
    const candidates = analyzeCapture(atsCapture(true), [ATS]);
    const postingsCandidate = candidates.find((c) => c.records.endsWith('jobPostings[*]'))!;
    expect(postingsCandidate.skeleton).toMatchObject({ '$.teamId~name': 'string', '$.teamId~parent~name': 'string', '$.id^url': 'string' });
    expect(postingsCandidate.urls).toEqual([{ local: '$.id', template: `https://${ATS}/zzboard/{value}` }]);
    expect(JSON.stringify(postingsCandidate.skeleton)).not.toContain('Software Engineering');
    // Le tableau des équipes n'a pas de lien de liaison : aucune jointure.
    expect(candidates.find((c) => c.records.endsWith('teams[*]'))!.joins).toBeUndefined();
  });

  it('proposition : équipe, département, lieu et lien lus par le code ; chaque offre livrée complète', () => {
    const cap = atsCapture(true);
    const candidates = analyzeCapture(cap, [ATS]);
    const c = candidates.find((x) => x.records.endsWith('jobPostings[*]'))!;
    const proposal: InvestigationProposal = {
      fields: [field('title', 'string', true), field('team', 'string'), field('department', 'string'), field('location', 'string'), field('url', 'string', true)],
      sources: [
        {
          candidate: c.id,
          paths: [
            { field: 'title', path: '$.title', ops: [] },
            { field: 'team', path: '$.teamId~name', ops: [] },
            { field: 'department', path: '$.teamId~parent~name', ops: [] },
            { field: 'location', path: '$.locationName', ops: [] },
            { field: 'url', path: '$.id^url', ops: [] },
          ],
          pagination: NONE,
        },
      ],
    };
    const built = buildFromProposal(proposal, candidates, cap);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.sample[0]).toEqual({ title: 'Offre Zztest 0', team: 'Software Engineering', department: 'Tech', location: 'Ville0', url: `https://${ATS}/zzboard/00000-aaaa-bbbb` });
    expect(built.strategies[0]!.spec.request.allowed_hosts).toEqual([ATS]);
  });

  it('aucun lien de la page ne porte les identifiants : pas de chemin d’URL proposé (jamais un lien inventé)', () => {
    const candidates = analyzeCapture(atsCapture(false), [ATS]);
    const c = candidates.find((x) => x.records.endsWith('jobPostings[*]'))!;
    expect(c.urls).toBeUndefined();
    expect(Object.keys(c.skeleton)).not.toContain('$.id^url');
  });

  it('un lien vers un autre hôte n’est jamais un modèle d’URL (hôtes autorisés seulement)', () => {
    const cap = atsCapture(true);
    const other = { ...cap, document: { ...cap.document!, renderedHtml: boardHtml.replaceAll('href="/zzboard/', `href="https://evil.zz_test.localhost/zzboard/`) } };
    const c = analyzeCapture(other, [ATS]).find((x) => x.records.endsWith('jobPostings[*]'))!;
    expect(c.urls).toBeUndefined();
  });
});

describe('R05 : le contrôle de fidélité voit un identifiant à la place d’un libellé', () => {
  it('« team » rempli d’UUID : refusé, avec un différentiel en code ; un champ identifiant, lui, reste libre', async () => {
    const { fidelityCheck, fidelityDiff } = await import('./fidelity.js');
    const records = Array.from({ length: 10 }, (_, i) => ({ title: `Offre ${i}`, team: `7c1b3a52-5e9d-4f0a-9c1e-00000000000${i}`, team_id: `7c1b3a52-5e9d-4f0a-9c1e-00000000000${i}`, phone: '0612345678' }));
    const schema = { type: 'object', properties: { title: { type: 'string' }, team: { type: 'string' }, team_id: { type: 'string' }, phone: { type: 'string' } } };
    const check = fidelityCheck({ records, outputSchema: schema });
    expect(check.issues).toEqual(expect.arrayContaining([{ field: 'team', code: 'looks_like_id', share: 1 }]));
    expect(check.issues.some((i) => i.field === 'team_id' && i.code === 'looks_like_id')).toBe(false);
    expect(check.issues.some((i) => i.field === 'phone')).toBe(false);
    expect(fidelityDiff(check.issues)).toContain('opaque identifiers');
  });
});
