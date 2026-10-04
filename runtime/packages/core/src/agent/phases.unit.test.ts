// SPDX-License-Identifier: AGPL-3.0-only
// Règle des deux par phase (tâche 2.12, 19 §7, r6 R1, R3 à R6) : registre d'outils construit par le code et politique
// de requêtes de l'agent, en tests unitaires (la partie « agent » se rejoue en 2.13 et 4.3).
import { describe, expect, test } from 'vitest';
import { AGENT_PHASES, agentRequestPolicy, bodyHasSensitiveValue, legsOf, phaseAllowsTool, toolRegistryForPhase, type AgentRequestContext } from './phases.js';

describe('assert_rule_of_two_by_phase', () => {
  test('aucune phase ne réunit A, B et C complets ; aucune n’a de pont MCP en V1', () => {
    for (const phase of AGENT_PHASES) {
      for (const ctx of [{}, { session: true }, { tunnel: true }]) {
        const reg = toolRegistryForPhase(phase, ctx);
        const legs = legsOf(reg);
        expect([legs.A, legs.B, legs.C].filter(Boolean).length, `${phase} ${JSON.stringify(ctx)}`).toBeLessThanOrEqual(2);
        expect(reg.mcp).toBe(false);
        expect(Object.isFrozen(reg.tools)).toBe(true);
      }
    }
  });

  test('table de 19 §7 : rejeu sans LLM ni mémoire ; agent instruit et session : mémoire structurelle ou absente ; juge sans outil', () => {
    expect(toolRegistryForPhase('replay')).toMatchObject({ llm: false, memory: 'none', tools: [] });
    expect(toolRegistryForPhase('investigation')).toMatchObject({ llm: true, memory: 'filtered', output: 'bounded' });
    expect(toolRegistryForPhase('instructed')).toMatchObject({ memory: 'structural' });
    expect(toolRegistryForPhase('e5_e6', { session: true })).toMatchObject({ private: 'full', output: 'bounded', memory: 'structural' });
    expect(toolRegistryForPhase('judge')).toMatchObject({ tools: [], output: 'none' });
    expect(toolRegistryForPhase('reflect')).toMatchObject({ tools: [], output: 'none' });
    expect(toolRegistryForPhase('recompile')).toMatchObject({ memory: 'filtered', output: 'bounded' });
    // Une phase inconnue n'existe pas : jamais de registre par défaut.
    expect(() => toolRegistryForPhase('mcp_research' as never)).toThrow();
  });

  test('assert_e4_no_tools — E4 extraction : aucun outil, LLM en quarantaine', () => {
    const reg = toolRegistryForPhase('e4_extract');
    expect(reg.tools).toEqual([]);
    expect(reg).toMatchObject({ output: 'none', private: 'none', memory: 'none' });
  });
});

describe('assert_agent_request_policy (politique en test unitaire ; corpus sur l’agent : 2.13, 4.3, recette 12h)', () => {
  const ctx = (over: Partial<AgentRequestContext> = {}): AgentRequestContext => ({
    targetHosts: ['shop.a.fr'],
    targetSuffixes: ['a.fr'],
    domUrls: ['https://shop.a.fr/produits?page=2', 'https://evil.example/collect'],
    trafficUrls: ['https://shop.a.fr/api/items?page=1'],
    templates: ['https://shop.a.fr/api/items?page={page}'],
    runInputs: { query: 'chaise' },
    sensitiveValues: ['ZZ-MEMORY-VALUE', 'zz.person@example.test'],
    ...over,
  });

  test('URL venue du DOM, du trafic ou d’un gabarit déclaré, sur le domaine cible : permise', () => {
    expect(agentRequestPolicy({ method: 'GET', url: 'https://shop.a.fr/produits?page=2' }, ctx())).toEqual({ allowed: true });
    expect(agentRequestPolicy({ method: 'GET', url: 'https://shop.a.fr/api/items?page=1' }, ctx())).toEqual({ allowed: true });
    expect(agentRequestPolicy({ method: 'GET', url: 'https://shop.a.fr/api/items?page=7' }, ctx())).toEqual({ allowed: true });
    // Une entrée du run vers le domaine cible : permise.
    expect(agentRequestPolicy({ method: 'GET', url: 'https://shop.a.fr/api/items?page=1&q=chaise' }, ctx({ templates: ['https://shop.a.fr/api/items?page={page}&q={q}'] }))).toEqual({ allowed: true });
  });

  test('une page qui demande de joindre une valeur à une URL : refus agent_request_blocked, 0 requête', () => {
    const blocked = (url: string, over: Partial<AgentRequestContext> = {}, method = 'GET', body?: string) => agentRequestPolicy({ method, url, ...(body === undefined ? {} : { body }) }, ctx(over));
    expect(blocked('https://evil.example/collect?d=ZZ-MEMORY-VALUE')).toEqual({ allowed: false, code: 'agent_request_blocked', reason: 'host_not_allowed' });
    expect(blocked('https://shop.a.fr/produits?page=2&x=ZZ-MEMORY-VALUE')).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(blocked('https://shop.a.fr/produits/zz.person%40example.test')).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(blocked('https://shop.a.fr/inconnue?a=1')).toMatchObject({ allowed: false, reason: 'url_not_from_page' });
    expect(blocked('https://shop.a.fr/api/items?page=1', {}, 'POST', 'q=ZZ-MEMORY-VALUE')).toMatchObject({ allowed: false });
    expect(blocked(`https://shop.a.fr/api/items?page=${'9'.repeat(300)}`)).toMatchObject({ allowed: false, reason: 'param_too_long' });
    const many = Array.from({ length: 12 }, (_, i) => `p${i}=1`).join('&');
    expect(blocked(`https://shop.a.fr/api/items?page=1&${many}`, { templates: [] , trafficUrls: [`https://shop.a.fr/api/items?page=1&${many}`] })).toMatchObject({ allowed: false, reason: 'too_many_params' });
    expect(blocked('javascript:alert(1)')).toMatchObject({ allowed: false });
  });
});

describe('assert_agent_request_policy : valeurs des paramètres (PA-09) et outil hors phase (PA-01)', () => {
  const ctx = (over: Partial<AgentRequestContext> = {}): AgentRequestContext => ({
    targetHosts: ['shop.a.fr'],
    targetSuffixes: ['a.fr'],
    domUrls: ['https://shop.a.fr/search?q=chaise&page=1'],
    trafficUrls: [],
    templates: [],
    runInputs: { query: 'table' },
    sensitiveValues: [],
    ...over,
  });
  const decide = (url: string, over: Partial<AgentRequestContext> = {}) => agentRequestPolicy({ method: 'GET', url }, ctx(over));

  test('mêmes clés que l’URL connue mais valeur libre : refusée (param_value_untrusted)', () => {
    expect(decide('https://shop.a.fr/search?q=un-item-d-un-autre-domaine&page=1')).toEqual({ allowed: false, code: 'agent_request_blocked', reason: 'param_value_untrusted' });
  });

  test('valeur identique à l’URL connue, entrée du run, nombre (pagination) ou texte de la consigne du propriétaire : permise', () => {
    expect(decide('https://shop.a.fr/search?q=chaise&page=1')).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=chaise&page=12')).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=table&page=1')).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=fauteuil&page=1')).toMatchObject({ allowed: false, reason: 'param_value_untrusted' });
    expect(decide('https://shop.a.fr/search?q=fauteuil&page=1', { trustedValues: ['fauteuil'] })).toEqual({ allowed: true });
  });
});

describe('assert_rule_of_two_by_phase : outil hors phase refusé', () => {
  test('un outil hors du registre de la phase est refusé, y compris pour les phases sans outil', () => {
    expect(phaseAllowsTool(toolRegistryForPhase('e5_e6'), 'navigate')).toBe(true);
    expect(phaseAllowsTool(toolRegistryForPhase('e5_e6'), 'shell')).toBe(false);
    for (const phase of ['replay', 'e4_extract', 'investigation', 'recompile', 'judge', 'reflect'] as const) {
      expect(phaseAllowsTool(toolRegistryForPhase(phase), 'navigate')).toBe(false);
      expect(phaseAllowsTool(toolRegistryForPhase(phase), 'click')).toBe(false);
    }
  });
});

describe('assert_agent_request_policy : gabarits, URL de départ et valeurs sensibles normalisées (fix-pa01, points 6, 9, 11)', () => {
  const ctx = (over: Partial<AgentRequestContext> = {}): AgentRequestContext => ({
    targetHosts: ['shop.a.fr'],
    targetSuffixes: [],
    domUrls: [],
    trafficUrls: [],
    templates: [],
    runInputs: { query: 'chaise' },
    sensitiveValues: [],
    ...over,
  });
  const decide = (url: string, over: Partial<AgentRequestContext> = {}) => agentRequestPolicy({ method: 'GET', url }, ctx(over));

  test('URL de départ à paramètres connue (pas un gabarit) : une valeur libre sur ses clés est refusée, la pagination reste permise', () => {
    const known = { trafficUrls: ['https://shop.a.fr/search?q=chaise&page=1'] };
    expect(decide('https://shop.a.fr/search?q=chaise&page=1', known)).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=chaise&page=2', known)).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=item-d-une-autre-api', known)).toMatchObject({ allowed: false, reason: 'param_value_untrusted' });
  });

  test('vrai gabarit {param} : la valeur substituée doit être une entrée du run ou un nombre (clé, segment de chemin)', () => {
    const q = { templates: ['https://shop.a.fr/search?q={q}&sort=price'] };
    expect(decide('https://shop.a.fr/search?q=item-d-une-autre-api', q)).toMatchObject({ allowed: false, reason: 'param_value_untrusted' });
    expect(decide('https://shop.a.fr/search?q=chaise', q)).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=12', q)).toEqual({ allowed: true });
    // Clé non variable du gabarit : sa valeur littérale seulement (point 6).
    expect(decide('https://shop.a.fr/search?q=chaise&sort=price', q)).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/search?q=chaise&sort=donnee-hors-liste', q)).toMatchObject({ allowed: false, reason: 'param_value_untrusted' });
    const path = { templates: ['https://shop.a.fr/produit/{id}'] };
    expect(decide('https://shop.a.fr/produit/42', path)).toEqual({ allowed: true });
    expect(decide('https://shop.a.fr/produit/item-d-une-autre-api', path)).toMatchObject({ allowed: false, reason: 'param_value_untrusted' });
  });

  test('valeur sensible multi-mots (+ en espace), téléphone écrit à la française, secret découpé entre deux paramètres : refusés', () => {
    const base = { domUrls: ['https://shop.a.fr/search?q=a'], sensitiveValues: ['jean dupont', '+33612345678', 'zz-secret-7731'] };
    expect(decide('https://shop.a.fr/search?q=jean+dupont', base)).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(decide('https://shop.a.fr/search?q=0612345678', base)).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(decide('https://shop.a.fr/search?q=06.12.34.56.78', base)).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(decide('https://shop.a.fr/search?q=a&r=zz-sec&s=ret-7731', { ...base, domUrls: ['https://shop.a.fr/search?q=a&r=zz-sec&s=ret-7731'] })).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(decide('https://shop.a.fr/search?q=a', base)).toEqual({ allowed: true });
  });

  test('corps d’une écriture : les mêmes valeurs sensibles sont repérées (form-urlencoded, JSON)', () => {
    const sensitive = ['jean dupont', 'zz-secret-7731'];
    expect(bodyHasSensitiveValue('nom=jean+dupont&x=1', sensitive, {})).toBe(true);
    expect(bodyHasSensitiveValue('{"k":"ZZ-SECRET-7731"}', sensitive, {})).toBe(true);
    expect(bodyHasSensitiveValue('nom=martin', sensitive, {})).toBe(false);
  });
});

// Recette 2026-10-04 (UX-33, équipe Janssens, enquête f63aed70) : la 1re exécution E4 rend 57 membres, dont des « Janssens »
// (nom marqué x-personal, inscrit au registre du run) ; la 2e exécution, même URL de départ, est refusée en 10 ms
// (`sensitive_value`) parce que « janssens » figure dans l'hôte ET dans le chemin de l'URL déclarée. Aucune donnée ne sortait :
// l'hôte est fixé par `allowed_hosts` et l'URL déclarée était connue avant que la valeur ne soit vue.
describe('assert_agent_request_policy : valeur vue pendant le run, présente dans l’hôte ou l’URL déclarée (UX-33)', () => {
  const START = 'https://www.janssens-immobilier.com/le-groupe-janssens-immobilier/';
  const ctx = (over: Partial<AgentRequestContext> = {}): AgentRequestContext => ({
    targetHosts: ['www.janssens-immobilier.com'],
    targetSuffixes: [],
    domUrls: [START, 'https://www.janssens-immobilier.com/contact/', 'https://www.janssens-immobilier.com/equipe/julie-janssens/'],
    trafficUrls: [],
    templates: [],
    runInputs: {},
    sensitiveValues: ['ZZ-TEST-SESSION-SECRET-7731'],
    declaredUrls: [START],
    seenValues: ['Janssens', 'Julie Janssens', 'Rudi'],
    ...over,
  });
  const decide = (url: string, over: Partial<AgentRequestContext> = {}) => agentRequestPolicy({ method: 'GET', url }, ctx(over));

  test('hôte exact de l’API : jamais lu comme une fuite (une valeur y figure sans que l’agent l’y ait mise)', () => {
    expect(decide('https://www.janssens-immobilier.com/contact/')).toEqual({ allowed: true });
    // Même règle pour une valeur sensible au sens strict : l'hôte exact ne porte aucune donnée choisie par l'agent.
    expect(decide('https://www.janssens-immobilier.com/contact/', { sensitiveValues: ['Janssens'], seenValues: [] })).toEqual({ allowed: true });
  });

  test('URL déclarée identique (départ) : admise malgré une valeur vue pendant le run', () => {
    expect(decide(START)).toEqual({ allowed: true });
  });

  test('sans affaiblir la garde : une valeur vue reste refusée dans toute URL composée, et un secret même dans l’URL déclarée', () => {
    expect(decide(`${START}?q=janssens`, { domUrls: [START, `${START}?q=rudi`] })).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    expect(decide('https://www.janssens-immobilier.com/equipe/julie-janssens/')).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    const declaredSecret = `${START}?d=ZZ-TEST-SESSION-SECRET-7731`;
    expect(decide(declaredSecret, { declaredUrls: [declaredSecret], domUrls: [declaredSecret] })).toMatchObject({ allowed: false, reason: 'sensitive_value' });
    // Hôte admis par suffixe (sous-domaine libre) : le sous-domaine peut porter une donnée, il reste contrôlé.
    expect(decide('https://janssens.immo.example/x', { targetHosts: [], targetSuffixes: ['immo.example'], domUrls: ['https://janssens.immo.example/x'] })).toMatchObject({ allowed: false, reason: 'sensitive_value' });
  });
});
