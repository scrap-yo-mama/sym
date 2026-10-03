// SPDX-License-Identifier: AGPL-3.0-only
// Briques pures de l'API REST (tâche 3.1) : cellules CSV neutralisées (assert_csv_formula_neutralized, 08b § 2),
// projection des items (`fields`, `omit`), curseurs (items, flux SSE) qui refusent toute valeur forgée.
import { EventEmitter, getEventListeners } from 'node:events';
import { describe, expect, test } from 'vitest';
import { abortableSleep, decodeFeedCursor, waitDrain } from './events.js';
import { csvCell, csvLine, projectItem } from './export.js';
import { decodeItemsCursor, itemsCursor } from './runs.js';
import { reasonMessage, responsibleUseMessage } from './shared.js';
import { apiSummary, type ApiRow } from './apis.js';

describe('assert_csv_formula_neutralized : cellules CSV (08b § 2)', () => {
  test.each([
    ['=cmd', "'=cmd"],
    ['+1', "'+1"],
    ['-2+3', "'-2+3"],
    ['@x', "'@x"],
    ['\tTAB', "'\tTAB"],
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['\rCR', `"'\rCR"`],
  ])('%j → %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  test('un nombre n’est jamais une formule ; texte ordinaire, booléens, objets et vides', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(3.5)).toBe('3.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell({ k: '=x' })).toBe('"{""k"":""=x""}"');
    expect(csvCell(['-1'])).toBe('"[""-1""]"');
    expect(csvLine(['=a', 1, 'b'])).toBe("'=a,1,b\r\n");
  });

  // Excel en locale française ou allemande (séparateur de liste `;`) découpe un .csv sur `;` et ignore un guillemet placé au
  // milieu d'un champ : un déclencheur juste APRÈS un séparateur possible (`;`, `,`, tabulation, fin de ligne) ouvre une
  // cellule autonome, donc une formule ou un appel DDE. Il est neutralisé comme en tête de cellule.
  test.each([
    ["x;=cmd|' /C calc'!A0;", "x;'=cmd|' /C calc'!A0;"],
    ['a;+1', "a;'+1"],
    ['a; -2', "a; '-2"],
    ['a;@SUM(A1)', "a;'@SUM(A1)"],
    ['a,=1', `"a,'=1"`],
    ['a\t=1', "a\t'=1"],
    ['l1\n=1', `"l1\n'=1"`],
    ['=a;=b', "'=a;'=b"],
    ['prix ; 3 € ; ok', 'prix ; 3 € ; ok'],
  ])('séparateur interne %j → %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  test('colonne non initiale et nom de colonne : aucune cellule `;=…` ne sort telle quelle', () => {
    const line = csvLine(['ok', "x;=cmd|' /C calc'!A0;", 'k;=HYPERLINK("http://x")']);
    expect(line).not.toMatch(/;=/);
    expect(line.split(';').filter((cell) => /^\s*[=+\-@]/.test(cell))).toEqual([]);
  });
});

describe('projection des items', () => {
  test('fields garde, omit retire, champs absents ignorés', () => {
    const item = { a: 1, b: 2, c: 3 };
    expect(projectItem(item, ['a', 'c', 'zz'])).toEqual({ a: 1, c: 3 });
    expect(projectItem(item, undefined, ['b'])).toEqual({ a: 1, c: 3 });
    expect(projectItem(item, ['a', 'b'], ['b'])).toEqual({ a: 1 });
    expect(projectItem(item)).toBe(item);
  });
});

describe('curseurs opaques', () => {
  test('curseur d’items : aller-retour ; forgé ou illisible → null ; absent → undefined', () => {
    expect(decodeItemsCursor(itemsCursor(41))).toBe(41);
    expect(decodeItemsCursor(undefined)).toBeUndefined();
    expect(decodeItemsCursor('zz')).toBeNull();
    expect(decodeItemsCursor(Buffer.from(JSON.stringify({ s: 'drop table' })).toString('base64url'))).toBeNull();
    expect(decodeItemsCursor(Buffer.from(JSON.stringify({ s: 1.5 })).toString('base64url'))).toBeNull();
  });

  test('Last-Event-ID du flux multiplexé : seuls les curseurs complets et bien formés sont repris', () => {
    const good = { v: 1, i: ['2026-10-01 10:00:00.123456+00', '00000000-0000-4000-8000-000000000001', 3], s: '42', r: ['2026-10-01 10:00:00+00', '00000000-0000-4000-8000-000000000002'] };
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(decodeFeedCursor(enc(good))).toEqual({ i: good.i, s: '42', r: good.r });
    expect(decodeFeedCursor(undefined)).toBeNull();
    expect(decodeFeedCursor('2')).toBeNull();
    expect(decodeFeedCursor(enc({ ...good, s: '1; DROP TABLE runs' }))).toBeNull();
    expect(decodeFeedCursor(enc({ ...good, i: ["now()'); --", good.i[1], 3] }))).toBeNull();
    expect(decodeFeedCursor(enc({ ...good, r: [good.r[0], 'pas-un-uuid'] }))).toBeNull();
    expect(decodeFeedCursor(enc({ ...good, v: 2 }))).toBeNull();
    expect(decodeFeedCursor('x'.repeat(2000))).toBeNull();
  });
});

describe('codes de raison', () => {
  test('un code stable devient un ReasonMessage ; une phrase ou un texte du site, jamais', () => {
    expect(reasonMessage('version_rollback')).toEqual({ code: 'version_rollback', params: {} });
    expect(reasonMessage('Le site a dit non')).toBeNull();
    expect(reasonMessage(null)).toBeNull();
    expect(reasonMessage(`a${'b'.repeat(80)}`)).toBeNull();
  });
});

describe('flux SSE : attentes sans fuite d’écouteurs (un tour toutes les pollMs pendant des heures)', () => {
  test('abortableSleep retire son écouteur abort quand le délai expire, et rend la main tout de suite à l’abandon', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 25; i++) await abortableSleep(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const started = Date.now();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('waitDrain retire ses écouteurs (drain et abort) quelle que soit l’issue', async () => {
    const controller = new AbortController();
    const out = new EventEmitter();
    for (let i = 0; i < 25; i++) {
      const pending = waitDrain(out, controller.signal);
      out.emit('drain');
      await pending;
    }
    expect(out.listenerCount('drain')).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const pending = waitDrain(out, controller.signal);
    controller.abort();
    await pending;
    expect(out.listenerCount('drain')).toBe(0);
  });
});

describe('assert_catalog_summary_domain : la ligne du catalogue porte le domaine de la page enquêtée (20 § 5.2, « nom et domaine »)', () => {
  const row = (startUrl: string | null) =>
    ({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'zz-livres-abc123',
      description: 'zz_test livres',
      status: 'sain',
      status_reason: null,
      stale: false,
      execution: 'fetch',
      network: 'direct',
      requires: {},
      avg_cost_usd: null,
      last_run_at: null,
      runs_30d: 0,
      succeeded_30d: 0,
      visibility: 'private',
      owner_id: '00000000-0000-4000-8000-000000000002',
      pinned: false,
      mcp_exposed: true,
      start_url: startUrl,
    }) as unknown as ApiRow;

  test('hôte de l’URL de départ, en minuscules, sans port ni chemin ; null sans URL connue ou illisible', () => {
    expect(apiSummary(row('https://Livres.ZZ-Test.example:8443/catalogue?page=2')).domain).toBe('livres.zz-test.example');
    expect(apiSummary(row(null)).domain).toBeNull();
    expect(apiSummary(row('pas une url')).domain).toBeNull();
  });
});

describe('responsible_use_ack_required : le message nomme les champs x-personal (UX-19)', () => {
  test('schéma connu : champs nommés, et la correction qui retire la marque ne suffit pas', () => {
    const proposed = { type: 'array', items: { type: 'object', properties: { author: { type: 'string', 'x-personal': 'identifier' }, text: { type: 'string' } } } };
    const message = responsibleUseMessage(proposed);
    expect(message).toContain('[].author');
    expect(message).toMatch(/x-personal/);
    expect(message).toMatch(/proposé/);
    expect(message).not.toContain('text');
  });

  test('schéma pas encore connu (auto_validate) : message sans champ', () => {
    expect(responsibleUseMessage(true)).toMatch(/Usage responsable/);
    expect(responsibleUseMessage(true)).not.toMatch(/champ/);
  });
});
