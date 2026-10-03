// SPDX-License-Identifier: AGPL-3.0-only
// Export CSV de l'usage (cdc/sym-browser 04d § 4.3, D11) : colonnes fixes, RFC 4180, injection de formule neutralisée.
import { describe, expect, test } from 'vitest';
import { csvCell, parseCsv, usageCsv } from './csv.js';

describe('csvCell', () => {
  test('cellules commençant par =, +, -, @ (ou tabulation, retour chariot) : apostrophe en tête', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+33')).toBe("'+33");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('symb_ab')).toBe('symb_ab');
  });

  test('virgule, guillemet, saut de ligne : cellule entre guillemets, guillemets doublés', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
    expect(csvCell(42)).toBe('42');
  });
});

describe('usageCsv', () => {
  const items = [
    { apiKeyId: 'k1', apiKeyPrefix: 'symb_1', day: '2026-10-01', sessions: 2, billedSeconds: 3, bytesIn: 10, bytesOut: 1 },
    { apiKeyId: 'k2', apiKeyPrefix: '=evil', day: '2026-10-02', sessions: 1, billedSeconds: 60, bytesIn: 5, bytesOut: 0 },
  ];

  test('en-tête de 04d § 4.3, période = jour quand groupé par jour, sinon from/to ; relu à l’identique', () => {
    const text = usageCsv({ period: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }, items, bySession: false });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(parseCsv(text)).toEqual([
      ['period', 'api_key_prefix', 'sessions', 'billed_seconds', 'bytes_in', 'bytes_out'],
      ['2026-10-01', 'symb_1', '2', '3', '10', '1'],
      ['2026-10-02', "'=evil", '1', '60', '5', '0'],
    ]);
    const flat = usageCsv({ period: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }, items: [{ ...items[0]!, day: undefined }], bySession: false });
    expect(parseCsv(flat)[1]?.[0]).toBe('2026-10-01T00:00:00.000Z/2026-11-01T00:00:00.000Z');
  });

  test('groupé par session : colonne session_id ajoutée en fin', () => {
    const text = usageCsv({ period: { from: 'f', to: 't' }, items: [{ ...items[0]!, sessionId: 's1' }], bySession: true });
    expect(parseCsv(text)).toEqual([
      ['period', 'api_key_prefix', 'sessions', 'billed_seconds', 'bytes_in', 'bytes_out', 'session_id'],
      ['2026-10-01', 'symb_1', '2', '3', '10', '1', 's1'],
    ]);
  });
});
