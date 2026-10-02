// SPDX-License-Identifier: AGPL-3.0-only
// Workflows de la landing (22 § 2.9 et § 2.10, 22b § 1 et § 5) : ce qui tourne avant la mise en ligne (pages.yml, ⚠️ GO), à la
// release et chaque semaine après (landing-production.yml, traffic-archive.yml). Lecture des fichiers seulement : rien n'est lancé.
// - assert_landing_stars_build_time : étoiles et version écrites AU BUILD de la mise en ligne, avant la porte du GO et le site ;
// - assert_landing_links_resolve : le volet « liens externes en 200 » tourne avant le déploiement et à la release (déclencheur
//   « PR et release » de 22b § 4 : la PR joue le volet interne, sans connexion sortante) ;
// - identité : PUBLIC_REPOSITORY égale le dépôt qui publie (22b § 1) ;
// - le jeton d'écriture d'issues n'est visible que de l'étape qui crée l'issue ;
// - l'archivage hebdomadaire du trafic GitHub existe, désactivé jusqu'au GO comme la sonde de production.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const workflowsDir = new URL('../../../../../.github/workflows/', import.meta.url);
type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string>; if?: string; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; env?: Record<string, string>; steps: Step[]; permissions?: Record<string, string> };
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

  test('release.yml vérifie les liens externes de la landing avant toute publication', () => {
    const release = workflow('release.yml').jobs['release'];
    expect(release).toBeDefined();
    if (!release) return;
    const links = stepIndex(release, /landing:links/);
    expect(links, 'landing:links absent de release.yml').toBeGreaterThanOrEqual(0);
    // Le site est construit avant, dans une étape antérieure ou plus haut dans la même étape.
    const build = stepIndex(release, /docs:build/);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(build < links || (release.steps[links]?.run ?? '').indexOf('docs:build') < (release.steps[links]?.run ?? '').indexOf('landing:links')).toBe(true);
    expect(links).toBeLessThan(release.steps.findIndex((step) => (step.uses ?? '').startsWith('docker/login-action')));
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

describe('landing-production.yml : le jeton d\'issues n\'est visible que de l\'étape qui crée l\'issue', () => {
  test('aucun GH_TOKEN au niveau du job ; seule l\'étape « gh issue create » le reçoit', () => {
    const job = workflow('landing-production.yml').jobs['production'];
    expect(job).toBeDefined();
    if (!job) return;
    expect(job.env?.['GH_TOKEN']).toBeUndefined();
    const withToken = job.steps.filter((step) => step.env?.['GH_TOKEN'] !== undefined);
    expect(withToken).toHaveLength(1);
    expect(withToken[0]?.run).toMatch(/gh issue create/);
    expect(withToken[0]?.if).toBe('failure()');
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
});

describe('workflows de la landing : YAML valide (un nom d\'étape avec « : » casse tout le fichier)', () => {
  test('chaque workflow du dépôt se lit en YAML strict', () => {
    for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) expect(() => parse(source(file)), file).not.toThrow();
  });
});
