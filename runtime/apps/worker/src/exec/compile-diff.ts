// SPDX-License-Identifier: AGPL-3.0-only
// Différentiel par champ d'une compilation html refusée, tel qu'il est publié dans l'événement `strategy.compiled` (U1.12,
// UX-37) : par champ, valeurs comparées, nombre d'écarts et deux exemples attendu/obtenu au plus. Les exemples sont des
// valeurs du site (DONNÉES NON FIABLES, éventuellement personnelles) : champ `x-personal` du schéma → aucun exemple ; sinon
// e-mails, téléphones et valeurs personnelles connues du run masqués, texte tronqué. Un champ sans écart n'est pas publié.
import { maskPersonalText, type PersonalValueRegistry } from '@runtime/core';
import type { HtmlDiff } from '@runtime/core/investigation';

/** Champs publiés au plus, et longueur d'une valeur d'exemple. */
const MAX_FIELDS = 12;
const MAX_VALUE_CHARS = 80;

export type PublishedFieldDiff = {
  readonly field: string;
  readonly compared: number;
  readonly mismatched: number;
  readonly examples: readonly { readonly expected: string | null; readonly got: string | null }[];
  /** Vrai si le champ est personnel : le nombre d'écarts seul est publié. */
  readonly masked?: true;
};

/** `x-personal` : `true` ou un mode (`content`) ; absent ou `false` : champ ordinaire. */
const isPersonal = (flag: unknown): boolean => flag !== undefined && flag !== null && flag !== false;

function exampleValue(value: unknown, registry: PersonalValueRegistry): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const masked = maskPersonalText(text, registry);
  return masked.length > MAX_VALUE_CHARS ? `${masked.slice(0, MAX_VALUE_CHARS)}…` : masked;
}

export function publishedFieldDiff(diff: HtmlDiff, outputSchema: unknown, registry: PersonalValueRegistry): PublishedFieldDiff[] {
  const props = (outputSchema as { properties?: Record<string, { 'x-personal'?: unknown } | undefined> } | null)?.properties ?? {};
  return diff.fields
    .filter((f) => f.mismatched > 0)
    .slice(0, MAX_FIELDS)
    .map((f) => {
      if (isPersonal(props[f.field]?.['x-personal'])) return { field: f.field, compared: f.compared, mismatched: f.mismatched, examples: [], masked: true as const };
      return {
        field: f.field,
        compared: f.compared,
        mismatched: f.mismatched,
        examples: f.examples.slice(0, 2).map((e) => ({ expected: exampleValue(e.expected, registry), got: exampleValue(e.got, registry) })),
      };
    });
}
