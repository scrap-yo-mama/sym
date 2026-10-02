// SPDX-License-Identifier: AGPL-3.0-only
// Briques pures de l'API REST (tâche 3.1) : cellules CSV neutralisées (assert_csv_formula_neutralized, 08b § 2),
// projection des items (`fields`, `omit`), curseurs (items, flux SSE) qui refusent toute valeur forgée.
import { describe, expect, test } from 'vitest';
import { decodeFeedCursor } from './events.js';
import { csvCell, csvLine, projectItem } from './export.js';
import { decodeItemsCursor, itemsCursor } from './runs.js';
import { reasonMessage } from './shared.js';

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
