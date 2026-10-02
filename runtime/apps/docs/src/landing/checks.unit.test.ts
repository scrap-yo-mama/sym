// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles de la landing hors CI de PR (22 § 2.9, 22b § 5) : verdict de la sonde, bloquants du GO, liens externes, étoiles. Sans réseau.
import { describe, expect, test } from 'vitest';
import { loadClaims } from './claims.ts';
import { checkExternalLinks, evaluateProbes, goBlockers, isRealTestIn, parseStars, probeReport } from './checks.ts';
import type { PageProbe } from './probe.ts';

const clean: PageProbe = { url: 'https://x.example/sym/', requests: ['https://x.example/sym/'], thirdPartyRequests: [], trackerRequests: [], documentCookie: '', contextCookies: [], setCookieHeaders: [], storageWritesBeforeAction: [], cspViolations: [], consoleErrors: [], cspMeta: "default-src 'none'; script-src 'self'", formCount: 0, html: '' };

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
  const registry = loadClaims();
  const base = { registry, displayed: ['license', 'hero.sub'], legalSources: [], isRealTest: () => true, version: '1.0.0' };

  test('tout est livré : aucun bloquant, mais la relecture humaine reste à faire', () => {
    const { blockers, manual } = goBlockers(base);
    expect(blockers).toEqual([]);
    expect(manual.join('\n')).toMatch(/relecture humaine/);
    expect(manual.join('\n')).toMatch(/2\.3, 2\.12/);
  });

  test('une preuve qui n\'est qu\'un test.todo bloque ; un champ juridique à fournir bloque ; l\'absence de version est à confirmer', () => {
    const { blockers, manual } = goBlockers({ ...base, isRealTest: (name) => name !== 'assert_step_patch_bounded', legalSources: [{ file: 'notice.md', text: 'a [À compléter avant la mise en ligne : nom] b' }], version: null });
    expect(blockers.join('\n')).toMatch(/assert_step_patch_bounded n'est pas encore un vrai test/);
    expect(blockers.join('\n')).toMatch(/champ à fournir/);
    expect(manual.join('\n')).toMatch(/aucune version publiée/);
  });

  test('une entrée à relire ou bloquée affichée bloque', () => {
    const { blockers } = goBlockers({ ...base, displayed: ['responsible.user-agent', 'absente'] });
    expect(blockers.join('\n')).toMatch(/statut « bloqué »/);
    expect(blockers.join('\n')).toMatch(/absente du registre/);
  });

  test('un test est « réel » s\'il figure dans un fichier de test sans y être seulement en test.todo', () => {
    expect(isRealTestIn([{ file: 'a', text: 'test.todo("assert_x")' }], 'assert_x')).toBe(false);
    expect(isRealTestIn([{ file: 'a', text: 'test.todo("assert_x")' }, { file: 'b', text: "describe('assert_x : ...', () => {})" }], 'assert_x')).toBe(true);
    expect(isRealTestIn([{ file: 'a', text: '// assert_x est livré ailleurs' }], 'assert_x')).toBe(false);
    expect(isRealTestIn([{ file: 'a', text: 'rien' }], 'assert_x')).toBe(false);
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
  });
});
