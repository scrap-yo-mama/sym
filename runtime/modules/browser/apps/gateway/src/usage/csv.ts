// SPDX-License-Identifier: AGPL-3.0-only
// Export CSV de l'usage (cdc/sym-browser 04d § 4.3, D11) : mêmes lignes que `GET /v1/usage`, colonnes
// `period, api_key_prefix, sessions, billed_seconds, bytes_in, bytes_out` (+ `session_id` quand groupé par session).
// RFC 4180 (CRLF, guillemets doublés) ; une cellule commençant par `=`, `+`, `-`, `@`, tabulation ou retour chariot est
// préfixée d'une apostrophe (injection de formule dans un tableur, OWASP CSV Injection).

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CsvUsageItem = { apiKeyPrefix: string; day?: string | undefined; sessionId?: string; sessions: number; billedSeconds: number; bytesIn: number; bytesOut: number };

export const USAGE_CSV_COLUMNS = ['period', 'api_key_prefix', 'sessions', 'billed_seconds', 'bytes_in', 'bytes_out'] as const;

/** Une ligne par ligne de l'API ; `period` = jour (groupé par jour) sinon `from/to`. */
export function usageCsv(input: { period: { from: string; to: string }; items: readonly CsvUsageItem[]; bySession: boolean }): string {
  const header = [...USAGE_CSV_COLUMNS, ...(input.bySession ? ['session_id'] : [])];
  const lines = input.items.map((item) => [
    csvCell(item.day ?? `${input.period.from}/${input.period.to}`),
    csvCell(item.apiKeyPrefix),
    csvCell(item.sessions),
    csvCell(item.billedSeconds),
    csvCell(item.bytesIn),
    csvCell(item.bytesOut),
    ...(input.bySession ? [csvCell(item.sessionId ?? '')] : []),
  ]);
  return [header, ...lines].map((cells) => `${cells.join(',')}\r\n`).join('');
}

/** Lecture RFC 4180 (tests et outils) : cellules entre guillemets, guillemets doublés, CRLF ou LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
