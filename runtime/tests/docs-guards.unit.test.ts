// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.8 : garde-fous entre le site de doc (apps/docs) et ce que le code livre vraiment.
// - assert_docs_availability_declared : une page qui décrit une fonction pas encore livrée le dit dans un encadré
//   « Disponibilité » qui nomme la fonction et la tâche qui la livrera ; le signal « livré » vient du code (test.todo
//   remplacé, table écrite par le serveur…), jamais d'une liste tenue à la main ;
// - assert_responsible_use_ack_pending : 17 § 11 (4.8), critères 2 et 3. La case « j'ai lu » (responsible_use_acks),
//   son affichage au premier lancement et le refus d'une API à champ `x-personal` sans elle ne sont PAS livrés par 4.8 : la
//   création d'API n'existe pas encore (POST /api/apis, tâche 3.1). Ce test échoue dès que 3.1 livre la création d'API sans
//   la case ; voir le test.todo assert_responsible_use_ack. La confirmation d'un site à compte (critère 3) est livrée par la
//   console (3.5, assert_account_site_warning) : son texte est vérifié ici ;
// - assert_docker_image_excludes_docs : l'image ne construit pas le site de doc (un lien mort dans la doc ne doit pas casser
//   l'image ni la release, et la doc n'est pas copiée dans l'image d'exécution).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ROUTES } from '../apps/server/src/routes/registry.js';

const runtimeDir = new URL('..', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(runtimeDir, path), 'utf8');
const page = (path: string): string => read(`apps/docs/content/${path}.md`);

/** Sources livrées (hors tests) d'un dossier. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(runtimeDir, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'generated', 'testing'].includes(entry.name)) out.push(...sources(path));
    } else if (/\.(ts|vue)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}
const codeMentions = (dirs: string[], pattern: RegExp): boolean => dirs.some((dir) => sources(dir).some((file) => pattern.test(read(file))));

const todos = read('tests/invariants.todo.test.ts');
/** Un test nommé encore en test.todo : la fonction qu'il garde n'est pas livrée. */
const stillTodo = (name: string): boolean => todos.includes(`test.todo("${name}")`) || todos.includes(`test.todo("${name} `);

/** Encadrés « Disponibilité » d'une page (VitePress : `::: info Disponibilité` … `:::`). */
const availabilityBoxes = (markdown: string): string[] => [...markdown.matchAll(/^::: (?:info|warning|tip|details) Disponibilité\n([\s\S]*?)\n:::$/gm)].map((m) => m[1] ?? '');

/** La création d'une API est livrée par le serveur. */
const apiCreationDelivered = (): boolean => ROUTES.some((r) => r.method === 'POST' && r.url === '/api/apis');
/** Le serveur enregistre la case « j'ai lu ». */
const ackDelivered = (): boolean => codeMentions(['apps/server/src'], /responsible_use_acks|responsibleUseAcks/);

type PendingFeature = { pages: string[]; feature: string; mention: RegExp; task: string | null; delivered: () => boolean };

const PENDING: PendingFeature[] = [
  {
    pages: ['explications/robot', 'explications/usage-responsable'],
    feature: 'rapport d\'accès et User-Agent réel du moteur, identification de l\'instance en option (module d\'accès)',
    mention: /rapport d'accès/,
    task: '1.11',
    delivered: () => !stillTodo('assert_access_report_first') && !stillTodo('assert_user_agent_engine_real'),
  },
  {
    pages: ['explications/usage-responsable'],
    feature: 'case « j\'ai lu » et refus d\'une API à champ x-personal sans elle',
    mention: /j'ai lu/,
    task: '3.1',
    delivered: ackDelivered,
  },
  {
    pages: ['explications/usage-responsable'],
    feature: 'fiche de traitement (17 § 7), spécifiée sans tâche planifiée',
    mention: /fiche de traitement/,
    task: null,
    delivered: () => codeMentions(['apps/server/src', 'packages/core/src', 'packages/db/src'], /fiche de traitement|processing[_-]?record/i),
  },
];

describe('assert_docs_availability_declared : la doc ne présente pas comme livré ce qui ne l\'est pas', () => {
  for (const item of PENDING) {
    for (const path of item.pages) {
      test(`${path} : ${item.feature}`, () => {
        if (item.delivered()) return;
        const boxes = availabilityBoxes(page(path));
        expect(boxes.length, `${path} : encadré « Disponibilité » absent`).toBeGreaterThan(0);
        const box = boxes.find((text) => item.mention.test(text)) ?? '';
        expect(box, `${path} : l'encadré « Disponibilité » doit citer ${String(item.mention)}`).not.toBe('');
        if (item.task) expect(box, `${path} : l'encadré doit nommer la tâche ${item.task}`).toContain(item.task);
      });
    }
  }

  test('le repérage des encadrés et des test.todo fonctionne', () => {
    expect(availabilityBoxes(page('guides/proxys')).length).toBeGreaterThan(0);
    expect(stillTodo('assert_cheapest_first_logged') || !todos.includes('assert_cheapest_first_logged')).toBe(true);
  });
});

describe('assert_responsible_use_ack_pending : 17 § 11, critères 2 et 3 de la page « Usage responsable »', () => {
  test('tant que la case « j\'ai lu » n\'est pas enregistrée par le serveur, la création d\'API n\'est pas livrée (reprise : 3.1)', () => {
    if (ackDelivered()) return;
    expect(
      apiCreationDelivered(),
      'POST /api/apis est livrée (3.1) sans la case « j\'ai lu » : enregistrer responsible_use_acks, afficher la page au premier lancement, refuser un schéma x-personal sans la case (17 § 11), puis remplacer le test.todo assert_responsible_use_ack',
    ).toBe(false);
    expect(stillTodo('assert_responsible_use_ack'), 'le test.todo assert_responsible_use_ack déclare l\'attente').toBe(true);
  });

  test('la confirmation d\'un site à compte (console, 3.5) cite conditions, RGPD et responsabilité, dans chaque langue', () => {
    const warning = (locale: string): string => (JSON.parse(read(`packages/i18n/locales/${locale}.json`)) as { newApi: { account: { warning: string } } }).newApi.account.warning;
    expect(warning('fr')).toMatch(/conditions d'utilisation/);
    expect(warning('fr')).toMatch(/RGPD/);
    expect(warning('fr')).toMatch(/responsable/);
    expect(warning('en')).toMatch(/terms of use/);
    expect(warning('en')).toMatch(/GDPR/);
    expect(warning('en')).toMatch(/responsible/);
  });
});

describe('assert_docker_image_excludes_docs : l\'image ne construit pas le site de doc', () => {
  const dockerfile = read('deploy/Dockerfile');
  const buildStage = dockerfile.slice(dockerfile.indexOf(' AS build'), dockerfile.indexOf(' AS runtime'));

  test('l\'étape de build de l\'image exclut @runtime/docs de `pnpm -r build`', () => {
    const builds = buildStage.split('\n').filter((line) => /pnpm (-r|--recursive)\b.*\bbuild\b/.test(line));
    expect(builds.length).toBeGreaterThan(0);
    for (const line of builds) expect(line).toMatch(/--filter\s+['"]?!@runtime\/docs['"]?/);
    expect(read('apps/docs/package.json')).toContain('"name": "@runtime/docs"');
  });

  test('l\'image d\'exécution ne copie rien de apps/docs', () => {
    expect(dockerfile).not.toMatch(/COPY .*apps\/docs/);
  });
});
