// SPDX-License-Identifier: AGPL-3.0-only
// assert_milestones_same_labels (I1, 20b § 3.3, 3.17) : les quatre jalons d'une enquête (Décrire, Reconnaître, Valider le schéma,
// Essayer) ont les mêmes clés, le même ordre et les mêmes libellés dans la frise de la console, le récit MCP et les journaux.
// La source est `packages/core/src/investigation/milestones.ts` ; la console en garde une copie de lecture
// (`apps/web/src/lib/milestones.ts`, son build ne dépend pas du serveur) et ses libellés dans ses catalogues
// `investigation.milestones.*` : ce fichier les compare. Les journaux réels (run_logs, événement `milestone` écrit par le
// worker avec `milestoneLogEntry`) sont lus par apps/worker/src/exec/investigation.integration.test.ts. Le récit MCP n’existe
// pas encore (3.2, 3.19) : `test.todo` explicite ci-dessous.
import { describe, expect, test } from 'vitest';
import en from '../apps/web/src/i18n/locales/en.json' with { type: 'json' };
import fr from '../apps/web/src/i18n/locales/fr.json' with { type: 'json' };
import * as consoleSide from '../apps/web/src/lib/milestones.ts';
import * as core from '../packages/core/src/investigation/milestones.ts';

const catalogs = { en, fr } as const;
const PHASES = ['access_check', 'reconnaissance', 'awaiting_schema_validation', 'testing', 'done'] as const;
const STATES = ['todo', 'current', 'done', 'stopped'] as const;

describe('assert_milestones_same_labels : une seule définition des quatre jalons pour la console, le récit MCP et les journaux', () => {
  test('mêmes clés, dans le même ordre : décrire, reconnaître, valider le schéma, essayer', () => {
    expect([...core.INVESTIGATION_MILESTONES]).toEqual(['describe', 'reconnaissance', 'schema', 'trials']);
    expect([...consoleSide.INVESTIGATION_MILESTONES]).toEqual([...core.INVESTIGATION_MILESTONES]);
  });

  test.each(['en', 'fr'] as const)('%s : les libellés de la frise de la console sont ceux du récit MCP et des journaux', (locale) => {
    for (const key of core.INVESTIGATION_MILESTONES) {
      expect(catalogs[locale].investigation.milestones[key], `${locale}:${key}`).toBe(core.MILESTONE_LABELS[locale][key]);
    }
  });

  test('l’intitulé de récit « n/4 Libellé » suit l’ordre des jalons, dans les deux langues', () => {
    expect(core.milestoneHeading('describe', 'fr')).toBe('1/4 Décrire');
    expect(core.milestoneHeading('trials', 'fr')).toBe('4/4 Essayer');
    expect(core.milestoneHeading('schema', 'en')).toBe('3/4 Validate the schema');
  });

  test('chaque sous-état du serveur mène au même jalon dans la console et dans le noyau, à tous les états', () => {
    expect(consoleSide.MILESTONE_OF_PHASE).toEqual(core.MILESTONE_OF_PHASE);
    for (const phase of [null, ...PHASES]) {
      for (const created of [false, true]) {
        for (const outcome of ['running', 'completed', 'stopped'] as const) {
          expect(consoleSide.milestoneStates({ phase, created, outcome }), `${phase}/${created}/${outcome}`).toEqual(core.milestoneStates({ phase, created, outcome }));
        }
      }
    }
  });

  test('les quatre états d’un jalon ont un libellé dans les deux langues (jamais la couleur seule)', () => {
    for (const locale of ['en', 'fr'] as const) {
      for (const state of STATES) expect(catalogs[locale].investigation.milestones.state[state].length, `${locale}:${state}`).toBeGreaterThan(0);
    }
  });

  test('un arrêt marque le jalon où l’enquête s’est arrêtée « arrêté », jamais « fait », et ne propose aucune suite', () => {
    const states = core.milestoneStates({ phase: 'awaiting_schema_validation', created: true, outcome: 'stopped' });
    expect(states).toEqual({ describe: 'done', reconnaissance: 'done', schema: 'stopped', trials: 'todo' });
  });

  test('journaux : l’entrée « milestone » d’un run porte la clé et l’intitulé du noyau (écrite par le worker, lue dans run_logs par apps/worker/src/exec/investigation.integration.test.ts)', () => {
    for (const key of core.INVESTIGATION_MILESTONES) {
      expect(core.milestoneLogEntry(key)).toEqual({ milestone: key, heading: core.milestoneHeading(key, 'en'), labels: { en: core.MILESTONE_LABELS.en[key], fr: core.MILESTONE_LABELS.fr[key] } });
    }
  });

  // Le récit MCP (« 1/4 Décrire … », tâches 3.2 et 3.19) n'est pas encore livré : aucun code ne le produit. Dès qu'il existe,
  // ce test compare ses lignes de jalon à `milestoneHeading` (mêmes clés, même ordre, mêmes libellés), comme la frise et les journaux.
  test.todo('assert_milestones_same_labels (récit MCP) : les lignes de jalon du récit de create_api sont celles de milestoneHeading, en fr et en en');
});
