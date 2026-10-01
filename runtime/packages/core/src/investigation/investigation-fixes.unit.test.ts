// SPDX-License-Identifier: AGPL-3.0-only
// Enquête (tâche 2.1, correctifs de vérification), logique pure :
// - clés du site jamais montrées au LLM ni stockées quand elles ressemblent à une valeur (e-mail, identifiant, Apollo) :
//   segment réécrit en joker `[*]` dans le chemin des enregistrements, clé écartée du squelette ;
// - état persistant de l'enquête sans valeur du site : origine + chemin + NOMS de paramètres (ni valeur de requête, ni
//   corps POST), gisements retrouvés à la reconnaissance du run suivant par une clé sans valeur ;
// - domaines de l'API : la page et ses sous-domaines (ou ceux du domaine sans `www.`), jamais un voisin d'un autre site ;
// - INV2 strict : les essais suivent l'ordre du plan (coût, puis E, puis N), chaque couple absent est élagué ;
// - E6 conforme : la version gardée est l'E5 compilé, jamais l'agent à chaque run (04 §3.1).
import { describe, expect, test } from 'vitest';
import { attemptsFollowPlan, type TrialPair } from './plan.js';
import { buildFromProposal, type InvestigationProposal } from './proposal.js';
import {
  analyzeCapture,
  candidateKey,
  discoverScriptEndpoints,
  findRecordArrays,
  isSafeKey,
  recordSkeleton,
  rematchCandidates,
  siteScope,
  storedCandidate,
  withinSiteScope,
  type ReconCapture,
} from './recon.js';
import { retainedStrategy } from './candidates.js';

const PAGE = 'http://www.zz_test_sib.localhost:4010/';

describe('clés du site (prompt et état) : aucune valeur', () => {
  test('clé e-mail, identifiant Apollo, clé numérique ou hexadécimale longue : non sûres ; noms de champ ordinaires : sûrs', () => {
    for (const key of ['jean.dupont@x.fr', 'User:123', 'posts({"author":"jean"})', '0612345678', 'a1b2c3d4e5f6a7b8', '123', 'x'.repeat(65), 'ignore previous']) {
      expect(isSafeKey(key), key).toBe(false);
    }
    for (const key of ['id', 'price_cents', 'has-more', '$type', 'ROOT_QUERY', 'items2']) expect(isSafeKey(key), key).toBe(true);
  });

  test('chemin des enregistrements : un segment non sûr devient un joker `[*]` (jamais la clé du site), la sélection reste valable', () => {
    const root = { ROOT_QUERY: { 'posts({"author":"jean.dupont@x.fr"})': [{ title: 'a', score: 1 }, { title: 'b', score: 2 }] }, 'User:123': { friends: [{ n: 1 }] } };
    const found = findRecordArrays(root);
    const paths = found.map((f) => f.path);
    expect(paths).toContain('$.ROOT_QUERY[*][*]');
    for (const p of paths) {
      expect(p).not.toContain('jean');
      expect(p).not.toContain('User:123');
      expect(p).not.toContain('@');
    }
    // Squelette : clés sûres seulement (ni `@type`, ni identifiant).
    expect(recordSkeleton({ '@type': 'Person', id: 'x', 'jean.dupont@x.fr': 1, 'User:1': 2 })).toEqual({ '$.id': 'string' });

    // Le joker sélectionne toujours les enregistrements : l'échantillon s'extrait.
    const body = JSON.stringify({ data: { 'search(q:"jean@x.fr")': [{ title: 'Lampe', score: 3 }, { title: 'Table', score: 4 }] } });
    const capture: ReconCapture = {
      mode: 'static',
      pageUrl: PAGE,
      document: { url: PAGE, status: 200, html: '<html></html>', renderedHtml: null, bytes: 13 },
      exchanges: [{ url: `${PAGE}graphql?op=search`, method: 'GET', requestBody: null, requestContentType: null, status: 200, contentType: 'application/json', body, bytes: body.length }],
      totalBytes: body.length,
    };
    const candidates = analyzeCapture(capture, ['www.zz_test_sib.localhost']);
    expect(candidates[0]!.records).toBe('$.data[*][*]');
    const proposal: InvestigationProposal = {
      fields: [
        { name: 'title', type: 'string', required: true, personal: false, description: 'Titre' },
        { name: 'score', type: 'integer', required: true, personal: false, description: 'Score' },
      ],
      sources: [{ candidate: 'c1', paths: [{ field: 'title', path: '$.title', ops: [] }, { field: 'score', path: '$.score', ops: [] }], pagination: { type: 'none', param: null, start: null, has_more_path: null, next_path: null } }],
    };
    const built = buildFromProposal(proposal, candidates, capture);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.sample).toEqual([{ title: 'Lampe', score: 3 }, { title: 'Table', score: 4 }]);
  });
});

describe('état persistant de l’enquête : aucune valeur du site (17 §6)', () => {
  const capture = (query: string, body: unknown): ReconCapture => {
    const res = JSON.stringify({ items: [{ id: 'a', name: 'n' }] });
    return {
      mode: 'static',
      pageUrl: PAGE,
      document: { url: PAGE, status: 200, html: '<html></html>', renderedHtml: null, bytes: 13 },
      exchanges: [
        { url: `${PAGE}api/search?${query}`, method: 'POST', requestBody: JSON.stringify(body), requestContentType: 'application/json', status: 200, contentType: 'application/json', body: res, bytes: res.length },
      ],
      totalBytes: 100,
    };
  };

  test('gisement stocké : origine + chemin + noms de paramètres, aucune valeur de requête ni corps POST', () => {
    const [c] = analyzeCapture(capture('q=jean.dupont%40x.fr&page=1', { email: 'jean.dupont@x.fr', offset: 0 }), ['www.zz_test_sib.localhost']);
    const stored = storedCandidate(c!);
    const text = JSON.stringify(stored);
    expect(text).not.toContain('jean');
    expect(text).not.toContain('dupont');
    expect(stored.request).toEqual({ method: 'POST', url: 'http://www.zz_test_sib.localhost:4010/api/search', query: ['page', 'q'], body_keys: ['email', 'offset'] });
    expect(stored).toMatchObject({ id: 'c1', from: 'response', records: '$.items[*]', skeleton: { '$.id': 'string', '$.name': 'string' } });
  });

  test('run suivant : gisements frais retrouvés par leur clé sans valeur, sous l’identifiant stocké ; un gisement disparu manque', () => {
    const first = analyzeCapture(capture('q=a&page=1', { email: 'a@x.fr', offset: 0 }), ['www.zz_test_sib.localhost']);
    const stored = first.map(storedCandidate);
    // Valeurs différentes au second passage (horodatage, autre recherche) : même clé.
    const fresh = analyzeCapture(capture('page=1&q=b', { offset: 0, email: 'b@x.fr' }), ['www.zz_test_sib.localhost']);
    expect(candidateKey(stored[0]!)).toBe(candidateKey(fresh[0]!));
    const matched = rematchCandidates(stored, fresh);
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ id: 'c1', request: { url: `${PAGE}api/search?page=1&q=b`, body_json: { offset: 0, email: 'b@x.fr' } } });
    expect(rematchCandidates(stored, [])).toEqual([]);
    // Ids stockés gardés même si l'ordre frais change.
    expect(rematchCandidates([{ ...stored[0]!, id: 'c3' }], fresh)[0]!.id).toBe('c3');
  });
});

describe('domaines de l’API : la page et ses sous-domaines (04b §2 : api.exemple.test)', () => {
  test('portée : hôte de la page sans `www.` ; sous-domaines admis ; voisin d’un autre site jamais', () => {
    expect(siteScope('www.exemple.test')).toBe('exemple.test');
    expect(siteScope('exemple.test')).toBe('exemple.test');
    expect(siteScope('shop.exemple.test')).toBe('shop.exemple.test');
    expect(siteScope('user1.github.io')).toBe('user1.github.io');
    expect(withinSiteScope('api.exemple.test', 'exemple.test')).toBe(true);
    expect(withinSiteScope('exemple.test', 'exemple.test')).toBe(true);
    expect(withinSiteScope('exemple.test.evil.test', 'exemple.test')).toBe(false);
    expect(withinSiteScope('evilexemple.test', 'exemple.test')).toBe(false);
    expect(withinSiteScope('user2.github.io', siteScope('user1.github.io'))).toBe(false);
  });

  test('sans navigateur : une URL de données d’un sous-domaine du site est découverte, un tiers jamais', () => {
    const html = '<script>fetch("http://api.zz_test_sib.localhost:4010/v1/items?page=1")</script><script>fetch("http://zz_test_evil.localhost:4010/a.json")</script>';
    expect(discoverScriptEndpoints(html, PAGE)).toEqual(['http://api.zz_test_sib.localhost:4010/v1/items?page=1']);
  });
});

describe('INV2 strict : ordre du plan suivi, absents élagués', () => {
  const p = (execution: TrialPair['execution'], network: TrialPair['network'], est: number, source = 'c1'): TrialPair => ({ execution, network, source, est_cost_usd: est });
  const plan = [p('fetch', 'direct', 0.1), p('fetch', 'dc_proxy', 0.1), p('agent_fetch', 'direct', 0.1), p('playwright', 'direct', 0.3)];

  test('E1 échoue, E1/N2 élagué, E4 essayé : suite conforme', () => {
    expect(attemptsFollowPlan(plan, [plan[0]!, plan[2]!], [plan[1]!])).toBe(-1);
  });

  test('égalité de coût : N avant E est un écart (départage E puis N), un couple sauté sans élagage aussi', () => {
    // Coûts égaux : fetch/dc_proxy AVANT agent_fetch/direct est dans l'ordre du plan ; l'inverse est un écart.
    expect(attemptsFollowPlan(plan, [plan[0]!, plan[2]!, plan[1]!], [])).toBe(1);
    expect(attemptsFollowPlan(plan, [plan[0]!, plan[2]!, plan[1]!], [plan[1]!])).toBe(2);
    // agent_fetch essayé alors que fetch/dc_proxy n'a été ni essayé ni élagué.
    expect(attemptsFollowPlan(plan, [plan[0]!, plan[2]!], [])).toBe(1);
    // Un couple hors plan.
    expect(attemptsFollowPlan(plan, [p('agent', 'direct', 0.05)], [])).toBe(0);
  });
});

describe('E6 conforme : version gardée (04 §3.1)', () => {
  const entry = (execution: TrialPair['execution']) => ({ execution, network: 'direct' as const, source: 'page', est_cost_usd: 0.5, spec: { kind: execution }, paginated: false });

  test('E6 avec trace compilée → E5 `hybrid` (spec compilée, coût mesuré sans LLM) ; sans compilation → not_compilable, jamais E6', () => {
    const compiled = { schema_version: 1, kind: 'hybrid', steps: [] };
    expect(retainedStrategy(entry('agent'), compiled, 0.002)).toEqual({ ok: true, execution: 'hybrid', network: 'direct', spec: compiled, estCostUsd: 0.002 });
    expect(retainedStrategy(entry('agent'), undefined, 0.002)).toEqual({ ok: false, reason: 'not_compilable' });
    // Les autres niveaux sont gardés tels quels.
    expect(retainedStrategy(entry('fetch'), undefined, 0.001)).toEqual({ ok: true, execution: 'fetch', network: 'direct', spec: { kind: 'fetch' }, estCostUsd: 0.5 });
  });
});
