// SPDX-License-Identifier: AGPL-3.0-only
// Extraction SANS LLM d'une stratégie E5 compilée (tâche 2.4, 04 §3.1 « rejouée sans LLM ») : la page finale est vue
// comme du texte rendu (lignes « libellé : valeur ») et ses titres, jamais par ses classes ni ses identifiants (DOM
// instable). Opérateurs en liste fermée du DSL (04b §2), aucune expression libre. L'induction cherche, pour chaque champ
// d'une sortie d'agent VALIDÉE, une localisation qui reproduit exactement la valeur ; elle échoue plutôt que de deviner.
import { DslError } from '../dsl/errors.js';
import { applyOperators, compileOperators } from '../dsl/operators.js';
import type { FieldLocator } from './specs.js';

/** Page finale telle que lue (bornée) dans le navigateur : texte rendu et titres. */
export type PageView = {
  readonly text: string;
  readonly headings: readonly { readonly level: number; readonly text: string }[];
};

export type LabelExtraction =
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly field: string; readonly reason: 'not_found' | 'ambiguous' | 'operator' };

const SEPARATOR = /^(.{1,80}?)\s*(?:[:：—–]|\s-)\s*(\S.*)$/u;

const normalize = (s: string): string => s.replace(/[\s\u00a0\u202f]+/gu, ' ').trim();

/** Lignes non vides du texte rendu, espaces normalisés. */
export function pageLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(normalize)
    .filter((l) => l !== '');
}

/** Lignes « libellé : valeur » (le premier séparateur coupe). */
export function labelledLines(text: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const line of pageLines(text)) {
    const m = SEPARATOR.exec(line);
    if (m !== null) out.push({ label: normalize(m[1] ?? ''), value: normalize(m[2] ?? '') });
  }
  return out;
}

function rawOf(view: PageView, locator: FieldLocator, labelled: readonly { label: string; value: string }[]): { raw: string } | { error: 'not_found' | 'ambiguous' } {
  if ('label' in locator) {
    const hits = labelled.filter((l) => l.label === normalize(locator.label));
    if (hits.length === 0) return { error: 'not_found' };
    if (hits.length > 1) return { error: 'ambiguous' };
    return { raw: hits[0]!.value };
  }
  const heading = view.headings.find((h) => h.level === locator.heading);
  return heading === undefined || normalize(heading.text) === '' ? { error: 'not_found' } : { raw: normalize(heading.text) };
}

/** Applique une extraction par libellés : un enregistrement, ou le premier champ introuvable. */
export function extractByLabels(view: PageView, fields: Readonly<Record<string, FieldLocator>>): LabelExtraction {
  const labelled = labelledLines(view.text);
  const record: Record<string, unknown> = {};
  for (const [name, locator] of Object.entries(fields)) {
    const raw = rawOf(view, locator, labelled);
    if ('error' in raw) return { ok: false, field: name, reason: raw.error };
    try {
      record[name] = applyOperators(compileOperators(locator.ops), raw.raw);
    } catch (error) {
      if (error instanceof DslError) return { ok: false, field: name, reason: 'operator' };
      throw error;
    }
  }
  return { ok: true, record };
}

/** Chaînes d'opérateurs essayées, dans l'ordre, selon le type attendu (liste fermée du DSL). */
function operatorCandidates(value: unknown): unknown[][] {
  if (typeof value === 'string') return [[], ['collapse_spaces']];
  if (typeof value === 'boolean') return [['to_boolean']];
  if (typeof value === 'number') {
    const chains: unknown[][] = [
      [{ op: 'to_number', decimal: ',' }],
      [{ op: 'to_number', decimal: '.' }],
      [{ op: 'regex_extract', pattern: '-?[0-9]+([.,][0-9]+)?' }, { op: 'to_number', decimal: ',' }],
      [{ op: 'regex_extract', pattern: '-?[0-9]+([.,][0-9]+)?' }, { op: 'to_number', decimal: '.' }],
    ];
    if (Number.isInteger(value)) chains.push([{ op: 'regex_extract', pattern: '-?[0-9]+' }, 'to_integer']);
    return chains;
  }
  return [];
}

function matches(raw: string, ops: unknown[], expected: unknown): boolean {
  try {
    return applyOperators(compileOperators(ops), raw) === expected;
  } catch {
    return false;
  }
}

/**
 * Induit une extraction par libellés qui reproduit EXACTEMENT `expected` sur `view`. Chaque libellé retenu est unique
 * dans la page et sert un seul champ ; un titre ne sert qu'un champ texte. `null` si un champ n'a pas de localisation
 * sûre (valeur nulle, objet, tableau, libellé ambigu) : la compilation échoue alors, l'E6 reste la stratégie.
 */
export function induceLabelExtraction(view: PageView, expected: Readonly<Record<string, unknown>>): Record<string, FieldLocator> | null {
  const labelled = labelledLines(view.text);
  const counts = new Map<string, number>();
  for (const l of labelled) counts.set(l.label, (counts.get(l.label) ?? 0) + 1);
  const unique = labelled.filter((l) => counts.get(l.label) === 1);
  const used = new Set<string>();
  const fields: Record<string, FieldLocator> = {};
  for (const [name, value] of Object.entries(expected)) {
    let found: FieldLocator | undefined;
    for (const ops of operatorCandidates(value)) {
      const hit = unique.find((l) => !used.has(`label:${l.label}`) && matches(l.value, ops, value));
      if (hit !== undefined) {
        used.add(`label:${hit.label}`);
        found = { label: hit.label, ops };
        break;
      }
      if (typeof value === 'string') {
        const heading = [1, 2, 3, 4, 5, 6].find((level) => {
          const h = view.headings.find((x) => x.level === level);
          return h !== undefined && !used.has(`heading:${level}`) && matches(normalize(h.text), ops, value);
        });
        if (heading !== undefined) {
          used.add(`heading:${heading}`);
          found = { heading: heading as 1 | 2 | 3 | 4 | 5 | 6, ops };
          break;
        }
      }
    }
    if (found === undefined) return null;
    fields[name] = found;
  }
  const check = extractByLabels(view, fields);
  if (!check.ok) return null;
  for (const [name, value] of Object.entries(expected)) if (check.record[name] !== value) return null;
  return fields;
}
