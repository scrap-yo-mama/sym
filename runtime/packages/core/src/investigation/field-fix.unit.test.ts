// SPDX-License-Identifier: AGPL-3.0-only
// Banc réel R09 (passage 2) : le contrôle de fidélité refuse `start_date` (l'organisateur à la place de la date) et SYM
// bascule aussitôt vers les stratégies à LLM, qui épuisent le budget. Avant toute escalade, une nouvelle tentative bon marché
// de la voie JSON : le CODE corrige l'affectation du champ refusé d'après le différentiel (date : champ ISO de la réponse
// comme `start_at` ; libellé : chemin joint), vérifiée sur les données déjà capturées, sans aucun appel au LLM.
import { describe, expect, it } from 'vitest';
import { extractRecords } from '../dsl/extract.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import { fidelityCheck } from './fidelity.js';
import { fixFieldMapping } from './field-fix.js';
import { analyzeCapture, type ReconCapture } from './recon.js';

const HOST = 'api.zz_test_events.localhost';
const URL_ = `https://${HOST}/discover/get-paginated-events?place=zz`;
const SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' }, start_date: { type: 'string' }, url: { type: 'string' }, organizer: { type: 'string' } },
  additionalProperties: false,
};
const entries = Array.from({ length: 12 }, (_, i) => ({
  api_id: `evt-zz${i}`,
  calendar: { name: `Organisateur Zztest ${i % 3}` },
  event: { name: `Événement Zztest ${i}`, start_at: `2026-10-0${(i % 9) + 1}T0${i % 10}:30:00.000Z`, end_at: `2026-10-0${(i % 9) + 1}T1${i % 10}:30:00.000Z`, created_at: '2025-01-01T00:00:00.000Z', url: `https://events.zz_test.localhost/zz-evt-${i}` },
  tags: [],
}));
const body = JSON.stringify({ entries, has_more: false });
const capture: ReconCapture = {
  mode: 'browser',
  pageUrl: `https://${HOST}/paris`,
  document: null,
  exchanges: [{ url: URL_, method: 'GET', requestBody: null, requestContentType: null, status: 200, contentType: 'application/json', body, bytes: body.length }],
  totalBytes: body.length,
};

const specOf = (fields: Record<string, unknown>): DeclarativeSpec => {
  const check = validateDeclarativeSpec(
    { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: URL_, allowed_hosts: [HOST] }, sources: [{ id: 'api', from: 'response', format: 'json', records: '$.entries[*]' }], fields },
    { outputSchema: SCHEMA },
  );
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
};

describe('R09 : correction bon marché de l’affectation d’un champ refusé par le contrôle de fidélité', () => {
  const candidate = analyzeCapture(capture, [HOST]).find((c) => c.records === '$.entries[*]')!;
  const wrong = specOf({
    name: { path: '$.event.name', type: 'string', required: true },
    start_date: { path: '$.calendar.name', type: 'string', ops: [{ op: 'regex_extract', pattern: '(.*)', group: 1 }] },
    url: { path: '$.event.url', type: 'string' },
  });
  const records = (spec: DeclarativeSpec) => extractRecords(spec, { body }, { outputSchema: SCHEMA }).records;

  it('le contrôle refuse bien la date qui reçoit l’organisateur', () => {
    const check = fidelityCheck({ records: records(wrong), outputSchema: SCHEMA, spec: wrong, candidate });
    expect(check.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'start_date', code: 'not_a_date' })]));
  });

  it('start_date est relu dans le champ ISO de début de la réponse (jamais la fin ni la création), sans LLM', () => {
    const issues = fidelityCheck({ records: records(wrong), outputSchema: SCHEMA, spec: wrong, candidate }).issues;
    const fix = fixFieldMapping({ spec: wrong, candidate, issues, outputSchema: SCHEMA, body });
    expect(fix).not.toBeNull();
    expect(fix!.changes).toEqual([{ field: 'start_date', path: '$.event.start_at' }]);
    const fixed = records(fix!.spec);
    expect(fixed[0]).toMatchObject({ start_date: entries[0]!.event.start_at });
    expect(fidelityCheck({ records: fixed, outputSchema: SCHEMA, spec: fix!.spec, candidate }).ok).toBe(true);
  });

  it('aucun champ de la réponse ne ressemble à une date : pas de correction (la voie suivante décide)', () => {
    const noDates = JSON.stringify({ entries: entries.map((e) => ({ api_id: e.api_id, calendar: e.calendar, event: { name: e.event.name, url: e.event.url } })) });
    const cap = { ...capture, exchanges: [{ ...capture.exchanges[0]!, body: noDates }] };
    const c = analyzeCapture(cap, [HOST]).find((x) => x.records === '$.entries[*]')!;
    const issues = [{ field: 'start_date', code: 'not_a_date' as const, share: 1 }];
    expect(fixFieldMapping({ spec: wrong, candidate: c, issues, outputSchema: SCHEMA, body: noDates })).toBeNull();
  });

  it('un problème que le code ne sait pas corriger (champ vide, doublon) : pas de correction', () => {
    expect(fixFieldMapping({ spec: wrong, candidate, issues: [{ field: 'name', code: 'empty', share: 1 }], outputSchema: SCHEMA, body })).toBeNull();
  });
});
