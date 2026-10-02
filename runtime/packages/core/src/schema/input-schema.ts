// SPDX-License-Identifier: AGPL-3.0-only
// Schéma d'ENTRÉE d'une API (04 §1, §4 étape G, tâche 2.2) : c'est ce que l'IA de l'utilisateur lit pour appeler l'API
// (`inputSchema` de l'outil MCP, formulaire « Lancer » de la console). Chaque champ y porte donc une description (500
// caractères au plus) ; un schéma d'entrée dont un champ n'en a pas est refusé. La description d'un champ est un texte
// lu par un LLM : elle est bornée et jamais interprétée par le code.
import { DRAFT_2020_12, SchemaError, assertSchemaAcceptable, compileSchema } from './validator.js';

/** Longueur maximale de la description d'un champ du schéma d'entrée (04 §1). */
export const INPUT_DESCRIPTION_MAX = 500;
/** Plafond de pages proposé par défaut (`hard_max_pages` des stratégies proposées par l'enquête, 04b §2). */
export const INPUT_MAX_PAGES_DEFAULT = 50;

export type InputSchemaIssue = {
  /** Pointeur JSON du champ fautif dans le schéma d'entrée. */
  readonly path: string;
  readonly code: 'missing_description' | 'description_too_long';
  readonly message: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const escapePointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** Longueur en caractères (points de code), pas en unités UTF-16, du texte tel qu'il sera stocké (non rogné). */
const characters = (text: string): number => [...text].length;

/** Vérifie la description d'un champ (un schéma qui en déclare un) ; `at` est son pointeur JSON. */
function checkDescription(field: unknown, at: string, issues: InputSchemaIssue[]): void {
  const description = isRecord(field) ? field['description'] : undefined;
  if (typeof description !== 'string' || description.trim() === '') {
    issues.push({ path: at, code: 'missing_description', message: `champ sans description (chaîne non vide, ${INPUT_DESCRIPTION_MAX} caractères au plus) : ${at}` });
  } else if (characters(description) > INPUT_DESCRIPTION_MAX) {
    issues.push({ path: at, code: 'description_too_long', message: `description de plus de ${INPUT_DESCRIPTION_MAX} caractères : ${at}` });
  }
}

/** Mots-clés dont la valeur est UN sous-schéma qui ne déclare pas de champ lui-même (éléments, condition, négation). */
const SUBSCHEMA_KEYWORDS = ['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema'] as const;
/** Mots-clés dont la valeur est une liste de sous-schémas (variantes). */
const SUBSCHEMA_LISTS = ['anyOf', 'oneOf', 'allOf'] as const;
/** Mots-clés dont la valeur est une table de sous-schémas (définitions atteintes par `$ref`, schémas conditionnels). */
const SUBSCHEMA_MAPS = ['$defs', 'definitions', 'dependentSchemas'] as const;

/**
 * Écarts de description d'un schéma d'entrée. Un champ est une valeur de `properties` ou de `patternProperties`, un schéma
 * de `additionalProperties` ou un élément de `prefixItems` : chacun porte sa description. Tous les autres sous-schémas
 * (`items`, `anyOf`/`oneOf`/`allOf`, `$defs`/`definitions`, `not`, `if`/`then`/`else`…) sont parcourus : les champs qu'ils
 * déclarent sont décrits aussi.
 */
function walkSchema(node: unknown, path: string, issues: InputSchemaIssue[], depth = 0): void {
  if (!isRecord(node) || depth > 64) return;
  const fields = (map: unknown, keyword: string): void => {
    if (!isRecord(map)) return;
    for (const [name, sub] of Object.entries(map)) {
      const at = `${path}/${keyword}/${escapePointer(name)}`;
      checkDescription(sub, at, issues);
      walkSchema(sub, at, issues, depth + 1);
    }
  };
  fields(node['properties'], 'properties');
  fields(node['patternProperties'], 'patternProperties');
  const additional = node['additionalProperties'];
  if (isRecord(additional)) {
    checkDescription(additional, `${path}/additionalProperties`, issues);
    walkSchema(additional, `${path}/additionalProperties`, issues, depth + 1);
  }
  const prefix = node['prefixItems'];
  if (Array.isArray(prefix)) {
    prefix.forEach((sub, i) => {
      checkDescription(sub, `${path}/prefixItems/${i}`, issues);
      walkSchema(sub, `${path}/prefixItems/${i}`, issues, depth + 1);
    });
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) walkSchema(node[keyword], `${path}/${keyword}`, issues, depth + 1);
  for (const keyword of SUBSCHEMA_LISTS) {
    const list = node[keyword];
    if (Array.isArray(list)) list.forEach((sub, i) => walkSchema(sub, `${path}/${keyword}/${i}`, issues, depth + 1));
  }
  for (const keyword of SUBSCHEMA_MAPS) {
    const map = node[keyword];
    if (isRecord(map)) for (const [name, sub] of Object.entries(map)) walkSchema(sub, `${path}/${keyword}/${escapePointer(name)}`, issues, depth + 1);
  }
}

/** Champs du schéma d'entrée sans description (ou avec une description trop longue), dans l'ordre du document. */
export function inputSchemaIssues(schema: unknown): InputSchemaIssue[] {
  const issues: InputSchemaIssue[] = [];
  walkSchema(schema, '', issues);
  return issues;
}

/**
 * Refuse un schéma d'entrée inacceptable (`SchemaError`) : forme et `$ref` distant (validateur de 1.1a), racine objet
 * (les entrées sont nommées), compilable, et chaque champ décrit (`missing_description`, `description_too_long`).
 */
export function assertInputSchema(schema: unknown): void {
  assertSchemaAcceptable(schema);
  if (!isRecord(schema) || schema['type'] !== 'object') throw new SchemaError('invalid_schema', "schéma d'entrée refusé : un objet (type: object) est attendu");
  const [first] = inputSchemaIssues(schema);
  if (first !== undefined) throw new SchemaError(first.code, `schéma d'entrée refusé : ${first.message}`);
  compileSchema(schema);
}

export type ProposedInput = {
  readonly name: string;
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly description: string;
  readonly required?: boolean;
};

const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Schéma d'entrée proposé après l'enquête (04 §4, étape G), construit par le code : `max_pages` (1 à `maxPages`) quand la
 * stratégie pagine (le plafond que la boucle de pagination lit, `limits.max_pages_input`), plus les entrées nommées
 * `inputs` (nom, type, description). Le schéma rendu passe toujours `assertInputSchema` : une entrée sans description lève.
 */
export function buildInputSchema(options: { readonly paginated: boolean; readonly maxPages?: number; readonly inputs?: readonly ProposedInput[] }): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const set = (name: string, value: unknown): void => {
    Object.defineProperty(properties, name, { value, enumerable: true, writable: true, configurable: true });
  };
  const required: string[] = [];
  for (const input of options.inputs ?? []) {
    if (!INPUT_NAME.test(input.name) || FORBIDDEN_NAMES.has(input.name) || (options.paginated && input.name === 'max_pages') || Object.hasOwn(properties, input.name)) {
      throw new SchemaError('invalid_schema', `schéma d'entrée refusé : nom d'entrée invalide ou en double (${input.name.slice(0, 40)})`);
    }
    set(input.name, { type: input.type, description: input.description.trim() });
    if (input.required === true) required.push(input.name);
  }
  if (options.paginated) {
    const max = options.maxPages ?? INPUT_MAX_PAGES_DEFAULT;
    set('max_pages', {
      type: 'integer',
      minimum: 1,
      maximum: max,
      description: `Nombre maximal de pages lues par run (1 à ${max}) ; la liste peut finir avant. Sans valeur, la lecture va jusqu'à la fin de la liste, dans la limite de ${max} pages.`,
    });
  }
  const schema = { $schema: DRAFT_2020_12, type: 'object', properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
  assertInputSchema(schema);
  return schema;
}
