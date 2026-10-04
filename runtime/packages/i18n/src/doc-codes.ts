// SPDX-License-Identifier: AGPL-3.0-only
// Page des statuts et codes de raison de la doc (21 § 8, M17) : GÉNÉRÉE depuis `reason.*` (`reasons.<code>` et
// `reasonLabel.<code>`), dans chaque langue livrée. Les pages bilingues de la doc relèvent des tâches 4.8 et 4.11 ; ce module
// ne fait que produire la table, pour qu'aucune phrase de la doc ne soit recopiée à la main.
import { flatten, type Catalog } from './catalog.js';
import { SOURCE_LOCALE } from './registry.js';
import { SPEC_REASON_CODES } from './reason-codes.js';

export type ReasonRow = { readonly code: string; readonly label: string; readonly message: string };

/** Une ligne par code de 06 § 4.2 : libellé court et phrase, dans la langue (repli `en`). */
export function reasonRows(catalogs: Readonly<Record<string, Catalog>>, locale: string): ReasonRow[] {
  const english = flatten(catalogs[SOURCE_LOCALE] ?? {});
  const own = flatten(catalogs[locale] ?? {});
  const pick = (key: string): string => own.get(key) ?? english.get(key) ?? '';
  return SPEC_REASON_CODES.map((code) => ({ code, label: pick(`reasonLabel.${code}`), message: pick(`reasons.${code}`) }));
}

/** Table Markdown des codes de raison ; les barres verticales des messages sont échappées. */
export function reasonCodesMarkdown(rows: readonly ReasonRow[], heading: { code: string; label: string; message: string }): string {
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`| ${heading.code} | ${heading.label} | ${heading.message} |`, '|---|---|---|'];
  for (const row of rows) lines.push(`| \`${row.code}\` | ${cell(row.label)} | ${cell(row.message)} |`);
  return `${lines.join('\n')}\n`;
}
