// SPDX-License-Identifier: AGPL-3.0-only
// Workflows de la landing (22 § 2.9 et § 2.10, 22b § 1 et § 5) : ce qui tourne avant la mise en ligne (pages.yml, ⚠️ GO), à la
// release et chaque semaine après (landing-production.yml, traffic-archive.yml). Lecture des fichiers seulement : rien n'est lancé.
// - assert_landing_stars_build_time : étoiles et version écrites AU BUILD de la mise en ligne, avant la porte du GO et le site ;
// - assert_landing_links_resolve : le volet « liens externes en 200 » tourne avant le déploiement et à la release (déclencheur
//   « PR et release » de 22b § 4 : la PR joue le volet interne, sans connexion sortante) ;
// - identité : PUBLIC_REPOSITORY égale le dépôt qui publie (22b § 1) ;
// - le droit d'écrire des issues n'appartient qu'au job « report », séparé du job qui lance du code tiers ;
// - release.yml : liens externes dans un job sans droit d'écriture ; pages.yml : l'origine Pages n'est partagée avec aucun autre site ;
// - l'archivage hebdomadaire du trafic GitHub existe, désactivé jusqu'au GO comme la sonde de production.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const workflowsDir = new URL('../../../../../.github/workflows/', import.meta.url);
type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string>; if?: string; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; if?: string; environment?: unknown; env?: Record<string, string>; steps: Step[]; permissions?: Record<string, string> };
type Workflow = { on: Record<string, unknown> | null; jobs: Record<string, Job>; permissions?: Record<string, string> };
const source = (file: string): string => readFileSync(new URL(file, workflowsDir), 'utf8');
const workflow = (file: string): Workflow => parse(source(file)) as Workflow;
/** Index de la première étape dont le script contient `needle` (-1 si aucune). */
const stepIndex = (job: Job, needle: RegExp): number => job.steps.findIndex((step) => needle.test(step.run ?? ''));

describe('assert_landing_stars_build_time : étoiles et version écrites au build de la mise en ligne', () => {
  test('pages.yml lance landing:stars avant la porte du GO et avant la construction du site publié', () => {
    const build = workflow('pages.yml').jobs['build'];
    expect(build).toBeDefined();
    if (!build) return;
    const stars = stepIndex(build, /landing:stars/);
    expect(stars, 'landing:stars absent de pages.yml').toBeGreaterThanOrEqual(0);
    expect(stars).toBeLessThan(stepIndex(build, /check:landing-go/));
    expect(stars).toBeLessThan(stepIndex(build, /docs:build/));
    // Lecture publique de l'API GitHub : le jeton du workflow, en lecture seule, évite la limite anonyme.
    expect(build.steps[stars]?.env?.['GITHUB_TOKEN']).toBe('${{ github.token }}');
  });
});

describe('assert_landing_links_resolve : liens externes en 200 avant la mise en ligne et à la release', () => {
  test('pages.yml vérifie les liens externes du site construit, avant le téléversement et le déploiement', () => {
    const wf = workflow('pages.yml');
    const build = wf.jobs['build'];
    expect(build).toBeDefined();
    if (!build) return;
    const links = stepIndex(build, /landing:links/);
    expect(links, 'landing:links absent de pages.yml').toBeGreaterThanOrEqual(0);
    expect(links).toBeGreaterThan(stepIndex(build, /docs:build/));
    expect(links).toBeLessThan(build.steps.findIndex((step) => (step.uses ?? '').startsWith('actions/upload-pages-artifact')));
    expect(wf.jobs['deploy']?.needs).toBe('build');
  });

  test('release.yml vérifie les liens externes de la landing dans un job à part, sans droit d\'écriture, dont dépend la release', () => {
    const wf = workflow('release.yml');
    const links = wf.jobs['landing-links'];
    const release = wf.jobs['release'];
    expect(links, 'job landing-links absent de release.yml').toBeDefined();
    expect(release).toBeDefined();
    if (!links || !release) return;
    // Le build VitePress (binaire natif de Pagefind) et les connexions sortantes ne tournent pas dans le job qui signe et publie.
    expect(links.permissions).toEqual({ contents: 'read' });
    expect(links.environment).toBeUndefined();
    const build = stepIndex(links, /docs:build/);
    const check = stepIndex(links, /landing:links/);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThanOrEqual(build);
    if (check === build) expect((links.steps[check]?.run ?? '').indexOf('docs:build')).toBeLessThan((links.steps[check]?.run ?? '').indexOf('landing:links'));
    expect([release.needs ?? []].flat()).toContain('landing-links');
    expect(stepIndex(release, /landing:links|docs:build/), 'le job release ne construit plus le site').toBe(-1);
  });

  test('le commentaire du job vitrine de ci.yml dit où tourne le volet externe, sans promesse fausse', () => {
    const ci = source('ci.yml');
    const vitrine = ci.slice(ci.indexOf('  vitrine:'), ci.indexOf('  unit:'));
    expect(vitrine).toMatch(/pages\.yml/);
    expect(vitrine).toMatch(/release\.yml/);
  });
});

describe('identité : PUBLIC_REPOSITORY égale le dépôt qui publie (22b § 1)', () => {
  test('pages.yml échoue avant toute construction si la variable est vide ou désigne un autre dépôt', () => {
    const build = workflow('pages.yml').jobs['build'];
    expect(build).toBeDefined();
    if (!build) return;
    const guard = build.steps.findIndex((step) => /PUBLIC_REPOSITORY/.test(step.run ?? '') && /exit 1/.test(step.run ?? ''));
    expect(guard, 'garde d\'identité absente').toBeGreaterThanOrEqual(0);
    const script = build.steps[guard]?.run ?? '';
    expect(script).toMatch(/-z "\$PUBLIC_REPOSITORY"/);
    expect(script).toMatch(/"\$PUBLIC_REPOSITORY" != "\$GITHUB_REPOSITORY"/);
    expect(guard).toBeLessThan(stepIndex(build, /^pnpm install/));
  });
});

describe('landing-production.yml : le droit d\'écrire des issues n\'appartient qu\'à un job « report » qui ne lance aucun code tiers', () => {
  test('le job production reste en lecture seule ; le job report (needs production, if failure()) a seul issues: write et ne fait que créer l\'issue', () => {
    const wf = workflow('landing-production.yml');
    const production = wf.jobs['production'];
    const report = wf.jobs['report'];
    expect(production).toBeDefined();
    expect(report, 'job report absent').toBeDefined();
    if (!production || !report) return;
    expect(production.permissions).toEqual({ contents: 'read' });
    expect(production.steps.some((step) => step.env?.['GH_TOKEN'] !== undefined || /gh issue/.test(step.run ?? ''))).toBe(false);
    expect(report.needs).toBe('production');
    expect(report.if).toBe('failure()');
    expect(report.permissions).toEqual({ issues: 'write' });
    // Aucun checkout, aucune installation, aucune action tierce : une seule commande gh, la seule à recevoir le jeton.
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]?.uses).toBeUndefined();
    expect(report.steps[0]?.run).toMatch(/^gh issue create /);
    expect(report.steps[0]?.env?.['GH_TOKEN']).toBe('${{ github.token }}');
  });

  test('le commentaire ne promet plus une isolation à l\'étape près', () => {
    expect(source('landing-production.yml')).not.toMatch(/n'est visible que de cette étape/);
    expect(source('landing-production.yml')).toMatch(/job « report »/);
  });
});

describe('assert_landing_csp_strict : \'self\' = l\'origine <propriétaire>.github.io, partagée par tous les sites Pages du propriétaire', () => {
  test('pages.yml refuse la mise en ligne si un autre dépôt du propriétaire publie un site Pages, avant le téléversement', () => {
    const build = workflow('pages.yml').jobs['build'];
    expect(build).toBeDefined();
    if (!build) return;
    const guard = stepIndex(build, /landing:pages-origin/);
    expect(guard, 'landing:pages-origin absent de pages.yml').toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(build.steps.findIndex((step) => (step.uses ?? '').startsWith('actions/upload-pages-artifact')));
    expect(build.steps[guard]?.env?.['GITHUB_TOKEN']).toBe('${{ github.token }}');
  });

  test('la sonde hebdomadaire de production le revérifie (un autre dépôt peut activer Pages après la mise en ligne)', () => {
    const production = workflow('landing-production.yml').jobs['production'];
    expect(production && stepIndex(production, /landing:pages-origin/)).toBeGreaterThanOrEqual(0);
  });
});

describe('archivage hebdomadaire du trafic GitHub (22 § 2.10, 22b § 5) : créé, désactivé jusqu\'au GO', () => {
  test('traffic-archive.yml lit les agrégats de l\'API de trafic et les archive en artefact ; déclencheur manuel seul', () => {
    expect(existsSync(new URL('traffic-archive.yml', workflowsDir))).toBe(true);
    const wf = workflow('traffic-archive.yml');
    expect(Object.keys(wf.on ?? {})).toEqual(['workflow_dispatch']);
    expect(source('traffic-archive.yml')).toMatch(/#\s+schedule:/);
    const steps = Object.values(wf.jobs).flatMap((job) => job.steps);
    const script = steps.map((step) => step.run ?? '').join('\n');
    for (const endpoint of ['traffic/views', 'traffic/clones', 'traffic/popular/referrers', 'traffic/popular/paths']) expect(script).toContain(endpoint);
    expect(steps.some((step) => (step.uses ?? '').startsWith('actions/upload-artifact@'))).toBe(true);
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  test('le commentaire dit que l\'archive est publique (tout compte connecté la télécharge) et ne parle pas de comptes que l\'API ne renvoie pas', () => {
    const comment = source('traffic-archive.yml').split('\nname:')[0] ?? '';
    expect(comment).toMatch(/artefact PUBLIC/);
    expect(comment).toMatch(/tout compte GitHub connecté/);
    expect(comment).toMatch(/Confidentialité/);
    expect(comment).not.toMatch(/des comptes/);
  });
});

describe('workflows de la landing : YAML valide (un nom d\'étape avec « : » casse tout le fichier)', () => {
  test('chaque workflow du dépôt se lit en YAML strict', () => {
    for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) expect(() => parse(source(file)), file).not.toThrow();
  });
});

describe('job vitrine (critère de 4.11 : « tous les assert_landing_* verts dans le job vitrine »)', () => {
  // Les tests de contenu et du site construit (vitest, projets unit et contract) ET le volet Chromium tournent dans le même job.
  const landingVitest = /vitest run --project unit --project contract apps\/docs\/src\/landing|landing:test/;

  test('ci.yml : le job vitrine lance les tests vitest de la landing, en plus du volet Chromium et de la sonde', () => {
    const vitrine = workflow('ci.yml').jobs['vitrine'];
    expect(vitrine).toBeDefined();
    if (!vitrine) return;
    expect(stepIndex(vitrine, landingVitest), 'vitest de la landing absent du job vitrine').toBeGreaterThanOrEqual(0);
    expect(stepIndex(vitrine, /test:e2e/)).toBeGreaterThanOrEqual(0);
    const ci = source('ci.yml');
    expect(ci.slice(ci.indexOf('  vitrine:'), ci.indexOf('  unit:')), 'le commentaire ne renvoie plus ces tests au seul job docs').not.toMatch(/tournent aussi dans le job\s*#?\s*docs/);
  });

  test('ci:local rejoue la même étape dans son job vitrine', () => {
    const local = readFileSync(new URL('../../../../scripts/ci-local.ts', import.meta.url), 'utf8');
    const steps = local.split('\n').filter((line) => line.includes("job: 'vitrine'"));
    expect(steps.some((line) => /'vitest', 'run', '--project', 'unit', '--project', 'contract', 'apps\/docs\/src\/landing'|'landing:test'/.test(line)), steps.join('\n')).toBe(true);
  });
});
