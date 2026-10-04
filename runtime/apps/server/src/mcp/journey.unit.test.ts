// SPDX-License-Identifier: AGPL-3.0-only
// Parcours « du premier coup » (lot A du CDC UX) : les fonctions pures du bloc de résultat et des textes, en fr et en.
import { describe, expect, test } from 'vitest';
import { slugBase } from '../rest/apis.js';
import { journeyTexts } from './journey-texts.js';
import { displayName, milestoneText, previewTable, progressLabel, questionOf, stepOf } from './result-block.js';

describe('slugBase (UX-08) : court, « objet-domaine »', () => {
  test('les mots utiles de la demande puis le domaine, sans mot vide ni www, 32 caractères au plus', () => {
    expect(slugBase('Récupère toutes les maisons à vendre', 'https://www.janssens-immobilier.example/biens/')).toBe('maisons-janssens-immobilier');
    expect(slugBase('Les livres du catalogue, avec titre et prix', 'https://zz-test-books.example/catalogue')).toBe('livres-catalogue-zz-test-books');
    expect(slugBase('x', 'https://www.exemple.test/liste').length).toBeLessThanOrEqual(32);
  });

  test('un nom donné court seul le slug ; sans mot ni domaine lisible, un repli ASCII', () => {
    expect(slugBase('peu importe', 'https://exemple.test/', 'Biens Janssens à Liège')).toBe('biens-janssens-liege');
    expect(slugBase('é', 'https://127.0.0.1/')).toMatch(/^[a-z0-9]/);
    expect(slugBase('', 'pas une url')).toMatch(/^api-|^[a-z0-9]/);
  });
});

describe('jalons du parcours (03 § 5)', () => {
  test('stepOf : le jalon courant de chaque phase de l’enquête, comme la frise de la console', () => {
    expect(stepOf(null)).toEqual({ step: 1, phase: 'describe' });
    expect(stepOf('access_check')).toEqual({ step: 2, phase: 'recognize' });
    expect(stepOf('reconnaissance')).toEqual({ step: 2, phase: 'recognize' });
    expect(stepOf('awaiting_schema_validation')).toEqual({ step: 3, phase: 'validate_schema' });
    expect(stepOf('testing')).toEqual({ step: 4, phase: 'extract' });
    expect(stepOf('done')).toEqual({ step: 4, phase: 'extract' });
  });

  test('libellés dans la langue du compte : le catalogue commun du noyau', () => {
    expect(progressLabel(2, 'fr')).toBe('2/4 Reconnaître');
    expect(milestoneText(3, 'en')).toBe('Validate the schema');
    expect(journeyTexts('fr').heartbeat(2, 'Reconnaître', 12)).toBe('2/4 Reconnaître · 12 s');
  });
});

describe('aperçu et nom (03 § 2)', () => {
  test('tableau Markdown : colonnes dans l’ordre du schéma, 6 au plus, cellules sur une ligne, `|` neutralisé, tronquées', () => {
    const rows = [{ b: 'x|y', a: 1, c: 'ligne\nbrisée', long: 'z'.repeat(100), d: 4, e: 5, f: 6, g: 7 }];
    const table = previewTable(rows, ['a', 'b', 'c', 'long', 'd', 'e', 'f', 'g']);
    const lines = table.split('\n');
    expect(lines[0]).toBe('| a | b | c | long | d | e |');
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- | --- |');
    expect(lines[2]).toContain('x\\|y');
    expect(lines[2]).toContain('ligne brisée');
    expect(lines[2]).toContain('…');
    expect(previewTable([], ['a'])).toBe('');
  });

  test('nom : celui de la personne, sinon tiré du slug sans son aléa', () => {
    expect(displayName('biens-janssens-immobilier-ab12cd', null)).toBe('Biens Janssens Immobilier');
    expect(displayName('biens-janssens-immobilier-ab12cd', 'Mes biens')).toBe('Mes biens');
  });
});

describe('question unique et fermée (03 § 4 et § 9)', () => {
  const gate = (reasons: unknown[]) => ({ reasons, estimate_usd: null, confirm_above_usd: 0.1 }) as never;

  test('aucune porte, aucune question', () => {
    expect(questionOf(null, 'fr')).toBeNull();
    expect(questionOf(gate([]), 'fr')).toBeNull();
  });

  test('une seule question même si plusieurs raisons sont levées : la plus prioritaire, « continuer » règle les autres', () => {
    const q = questionOf(gate([{ reason: 'cost_above_cap', estimate_usd: 0.6, compile_usd: 0.3 }, { reason: 'multiple_lists', chosen: { id: 'c1', items: 519 }, other: { id: 'c2', items: 48 } }]), 'fr')!;
    expect(q.reason).toBe('multiple_lists');
    expect(q.options.map((o) => o.id)).toEqual(['continue', 'other_list']);
    expect(q.options.map((o) => o.expected_items)).toEqual([519, 48]);
    expect(q.text).toContain('J’ai trouvé deux listes. Laquelle ?');
    expect(q.text).toContain('1) La liste proposée (519 éléments)');
    expect(q.text).toContain('2) L’autre liste (48 éléments)');
  });

  test('chaque raison a sa question fr et en, des options numérotées et l’identifiant « continue » en tête', () => {
    const reasons: [unknown, string[]][] = [
      [{ reason: 'requested_field_missing', fields: ['surface'] }, ['continue', 'look_details']],
      [{ reason: 'example_mismatch', fields: ['agence'] }, ['continue', 'other']],
      [{ reason: 'cost_above_cap', estimate_usd: 0.6, compile_usd: 0.3 }, ['continue', 'cancel']],
    ];
    for (const locale of ['fr', 'en'] as const) {
      for (const [reason, ids] of reasons) {
        const q = questionOf(gate([reason]), locale)!;
        expect(q.options.map((o) => o.id)).toEqual(ids);
        expect(q.text).toMatch(/1\) .*2\) /);
      }
    }
    expect(questionOf(gate([{ reason: 'cost_above_cap', estimate_usd: 0.6, compile_usd: 0.3 }]), 'fr')!.text).toContain('0,6 $');
    expect(questionOf(gate([{ reason: 'cost_above_cap', estimate_usd: 0.6, compile_usd: 0.3 }]), 'en')!.text).toContain('$0.6');
  });

  test('succès chiffré : signature, total et coût d’un rejeu (08 § 2)', () => {
    expect(journeyTexts('fr').done(519, 0)).toBe('SYM 👻 : C’est fait. 519 éléments, 0 $ par rejeu.');
    expect(journeyTexts('en').done(519, 0)).toBe('SYM 👻: Done. 519 items, $0 per replay.');
  });
});
