// SPDX-License-Identifier: AGPL-3.0-only
// Banc réel R05 (passage 2) : une réponse JSON a plusieurs tableaux liés par identifiant (offres, équipes) ; `team` valait
// l'identifiant, `department` et le lien de l'offre manquaient. Jointure déclarative entre deux tableaux de la MÊME réponse
// (égalité de clés, aucun code) et URL construite par un modèle fermé sur un hôte de `allowed_hosts`.
import { describe, expect, it } from 'vitest';
import { extractRecords } from './extract.js';
import { compileOperators, applyOperators } from './operators.js';
import { validateDeclarativeSpec, type DeclarativeSpec } from './spec.js';

const HOST = 'jobs.zz_test_ats.localhost';
const SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' }, team: { type: 'string' }, department: { type: 'string' }, url: { type: 'string' } },
  additionalProperties: false,
};

const RESPONSE = JSON.stringify({
  data: {
    board: {
      teams: [
        { id: 'T-tech', name: 'Tech', parentTeamId: null },
        { id: 'T-se', name: 'Software Engineering', parentTeamId: 'T-tech' },
        { id: 'T-design', name: 'Design', parentTeamId: 'T-tech' },
      ],
      postings: [
        { id: '11111111-aaaa', title: 'Engineering Manager', teamId: 'T-se' },
        { id: '22222222-bbbb', title: 'Product Designer', teamId: 'T-design' },
        { id: '33333333-cccc', title: 'CTO', teamId: 'T-tech' },
        { id: '44444444-dddd', title: 'Sans équipe', teamId: 'T-inconnue' },
      ],
    },
  },
});

const specOf = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}): DeclarativeSpec => {
  const check = validateDeclarativeSpec(
    {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'POST', url: `https://${HOST}/api/graphql`, allowed_hosts: [HOST], headers: { 'content-type': 'application/json' }, body: { json: { query: 'q' } } },
      sources: [{ id: 'api', from: 'response', format: 'json', records: '$.data.board.postings[*]' }],
      fields,
      ...extra,
    },
    { outputSchema: SCHEMA },
  );
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
};

const TEAMS = { from: '$.data.board.teams[*]', on: '$.teamId', key: '$.id' };

describe('jointure déclarative entre deux tableaux de la même réponse', () => {
  const fields = {
    title: { path: '$.title', type: 'string', required: true },
    team: { join: { ...TEAMS, take: '$.name' }, type: 'string' },
    department: { join: { ...TEAMS, take: '$.name', parent: '$.parentTeamId' }, type: 'string' },
  };

  it('l’équipe est le nom de l’équipe liée par son identifiant ; le département est le nom de son parent', () => {
    const out = extractRecords(specOf(fields), { body: RESPONSE }, { outputSchema: SCHEMA });
    expect(out.ok).toBe(true);
    expect(out.records).toEqual([
      { title: 'Engineering Manager', team: 'Software Engineering', department: 'Tech' },
      { title: 'Product Designer', team: 'Design', department: 'Tech' },
      // Équipe de premier niveau : pas de parent, donc pas de département ; équipe inconnue : ni l'un ni l'autre.
      { title: 'CTO', team: 'Tech' },
      { title: 'Sans équipe' },
    ]);
  });

  it('un identifiant jamais l’identifiant brut : sans correspondance, le champ reste absent (pas de repli sur la clé)', () => {
    const out = extractRecords(specOf(fields), { body: RESPONSE }, { outputSchema: SCHEMA });
    expect(JSON.stringify(out.records)).not.toContain('T-se');
  });

  it('refus à l’enregistrement : source HTML, chemins invalides, champ sans join ni path', () => {
    const base = { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: `https://${HOST}/x`, allowed_hosts: [HOST] }, fields: { title: { path: '$.title', type: 'string' }, team: { join: { ...TEAMS, take: '$.name' }, type: 'string' } } };
    expect(validateDeclarativeSpec({ ...base, sources: [{ id: 's', from: 'html', records: 'article' }], fields: { team: { css: 'h1', join: { ...TEAMS, take: '$.name' }, type: 'string' } } }).ok).toBe(false);
    expect(validateDeclarativeSpec({ ...base, sources: [{ id: 'api', from: 'response', format: 'json', records: '$.a[*]' }], fields: { team: { join: { ...TEAMS, from: '$$bad', take: '$.name' }, type: 'string' } } }).ok).toBe(false);
    expect(validateDeclarativeSpec({ ...base, sources: [{ id: 'api', from: 'response', format: 'json', records: '$.a[*]' }], fields: { team: { join: { from: '$.t[*]', on: '$.x', key: '$.id' }, type: 'string' } } }).ok).toBe(false);
    expect(validateDeclarativeSpec({ ...base, sources: [{ id: 'api', from: 'response', format: 'json', records: '$.a[*]' }] }).ok).toBe(true);
  });

  it('plusieurs correspondances : la première (l’ordre du tableau) ; tableau joint absent : champ absent, pas d’erreur', () => {
    const body = JSON.stringify({ data: { board: { teams: [{ id: 'A', name: 'Premier' }, { id: 'A', name: 'Second' }], postings: [{ id: '1', title: 'x', teamId: 'A' }] } } });
    expect(extractRecords(specOf(fields), { body }, { outputSchema: SCHEMA }).records[0]).toMatchObject({ team: 'Premier' });
    const none = JSON.stringify({ data: { board: { postings: [{ id: '1', title: 'x', teamId: 'A' }] } } });
    const out = extractRecords(specOf(fields), { body: none }, { outputSchema: SCHEMA });
    expect(out.ok).toBe(true);
    expect(out.records[0]).toEqual({ title: 'x' });
  });
});

describe('url_template : URL de la fiche construite à partir d’un modèle et d’un identifiant', () => {
  const field = { path: '$.id', type: 'string', ops: [{ op: 'url_template', template: `https://${HOST}/zzboard/{value}` }] };

  it('construit l’URL ; l’identifiant est encodé (jamais de changement d’hôte ni de chemin)', () => {
    expect(applyOperators(compileOperators([{ op: 'url_template', template: `https://${HOST}/zzboard/{value}` }]), '11111111-aaaa')).toBe(`https://${HOST}/zzboard/11111111-aaaa`);
    expect(applyOperators(compileOperators([{ op: 'url_template', template: `https://${HOST}/zzboard/{value}` }]), '../../evil.test/x?y#z')).toBe(`https://${HOST}/zzboard/..%2F..%2Fevil.test%2Fx%3Fy%23z`);
    const out = extractRecords(specOf({ title: { path: '$.title', type: 'string', required: true }, url: field }), { body: RESPONSE }, { outputSchema: SCHEMA });
    expect(out.records[0]).toMatchObject({ url: `https://${HOST}/zzboard/11111111-aaaa` });
  });

  it('refus : hôte hors allowed_hosts, {value} dans l’hôte, deux {value}, schéma non http, identifiants dans l’URL', () => {
    const bad = (template: string) => validateDeclarativeSpec({ ...specOf({ title: { path: '$.title', type: 'string' } }), fields: { title: { path: '$.title', type: 'string' }, url: { path: '$.id', type: 'string', ops: [{ op: 'url_template', template }] } } }, { outputSchema: SCHEMA }).ok;
    expect(bad(`https://${HOST}/zz/{value}`)).toBe(true);
    expect(bad('https://evil.zz_test.localhost/zz/{value}')).toBe(false);
    expect(bad('https://{value}.zz_test.localhost/')).toBe(false);
    expect(bad(`https://${HOST}/{value}/{value}`)).toBe(false);
    expect(bad(`ftp://${HOST}/{value}`)).toBe(false);
    expect(bad(`https://user:pw@${HOST}/{value}`)).toBe(false);
    expect(bad(`https://${HOST}/zz/`)).toBe(false);
  });
});
