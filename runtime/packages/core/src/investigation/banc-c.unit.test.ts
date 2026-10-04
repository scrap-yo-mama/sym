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
