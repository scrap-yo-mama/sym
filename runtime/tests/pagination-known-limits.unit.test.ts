// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.2 (correctifs de vérification) : les limites connues de la pagination sont consignées dans la table des
// invariants, pour ne pas être redécouvertes comme des défauts (le CDC n'est pas modifié par les tâches).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ScrollTracker } from '../packages/core/src/dsl/pagination.js';

const table = JSON.parse(readFileSync(join(new URL('..', import.meta.url).pathname, 'tests/invariants.json'), 'utf8')) as { test: string; note?: string }[];
const noteOf = (name: string): string => table.find((row) => row.test === name)?.note ?? '';

describe('pagination : limites connues consignées', () => {
  // Rattachée à la tâche 2.7 (passerelle tunnel et commandes, 10-taches) : le tunnel n'a pas de ScrollTransport. Le cas
  // LinkedIn de _exclusions.md (tunnel forcé) peut en dépendre. Devient un vrai test quand l'extension expose le défilement.
  test.todo('2.7 — infinite_scroll en tunnel : un ScrollTransport par les commandes du tunnel livre 3 pages pour max_pages = 3 (aujourd’hui : page 1 puis unsupported, sortie tronquée)');

  test('assert_pagination_known_limits_recorded — le défilement en tunnel est rattaché à la tâche 2.7 (10-taches), le test.todo ci-dessus en est le témoin', () => {
    const note = noteOf('assert_infinite_scroll_paginated');
    expect(note).toMatch(/tâche 2\.7/);
    expect(note).toMatch(/test\.todo/);
  });

  test('assert_pagination_known_limits_recorded — liste plus longue que le plafond dur : verified=false, écart au CDC 04 §4 tracé', () => {
    const note = noteOf('assert_pagination_stop_rule_last_page');
    expect(note).toMatch(/Limite connue/);
    expect(note).toMatch(/hard_max_pages/);
    expect(note).toMatch(/04 § ?4/);
    expect(note).toMatch(/décision à inscrire au CDC|D-xx/);
  });

  test('assert_pagination_known_limits_recorded — infinite_scroll : pas de défilement en tunnel (E3 par l’extension), reporté aux tâches de l’extension', () => {
    const note = noteOf('assert_infinite_scroll_paginated');
    expect(note).toMatch(/Limites connues/);
    expect(note).toMatch(/tunnel/);
    expect(note).toMatch(/unsupported/);
    expect(note).toMatch(/pagination_page2/);
  });

  test('assert_pagination_known_limits_recorded — infinite_scroll : l’identité d’un enregistrement est son contenu (liste glissante)', () => {
    const note = noteOf('assert_infinite_scroll_paginated');
    expect(note).toMatch(/contenu/);
    expect(note).toMatch(/liste (glissante|virtualisée)/);
  });

  test('limite épinglée : sur une liste glissante, un nouvel enregistrement de contenu identique à un enregistrement déjà vu est écarté', () => {
    const tracker = new ScrollTracker();
    expect(tracker.fresh([{ t: 'a' }, { t: 'b' }])).toEqual([{ t: 'a' }, { t: 'b' }]);
    // « a » sort de la fenêtre, un autre « a » légitime entre : indiscernable du premier, il n'est pas livré.
    expect(tracker.fresh([{ t: 'b' }, { t: 'c' }, { t: 'a' }])).toEqual([{ t: 'c' }]);
  });
});
