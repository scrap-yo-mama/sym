// SPDX-License-Identifier: AGPL-3.0-only
// Formulaire « Lancer » généré depuis `input_schema` (06 § 4.1) : string, number, integer, boolean, enum, array de
// scalaires. Les autres types (objet, tableau d'objets, `oneOf`…) passent par l'éditeur JSON. La validation reste celle
// du serveur (400 `invalid_input`, aucun run créé) : ici on ne fait que construire les champs et lire les saisies.

type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array';

type FormField = {
  name: string;
  kind: FieldKind;
  required: boolean;
  description: string | null;
  /** Valeurs permises (kind `enum`, ou éléments d'un tableau d'énumérations). */
  options: string[];
  /** Type des éléments d'un tableau : `string`, `number` ou `integer`. */
  itemKind: 'string' | 'number' | 'integer';
  defaultValue: unknown;
};

export type FormModel = {
  fields: FormField[];
  /** Vrai quand le schéma contient un champ que le formulaire ne sait pas porter : l'éditeur JSON est alors proposé. */
  needsJsonEditor: boolean;
};

type JsonSchema = { [key: string]: unknown };

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarKind(schema: JsonSchema): 'string' | 'number' | 'integer' | 'boolean' | null {
  const type = schema.type;
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' ? type : null;
}

function field(name: string, schema: JsonSchema, required: boolean): FormField | null {
  const description = typeof schema.description === 'string' ? schema.description : null;
  const base = { name, required, description, options: [] as string[], itemKind: 'string' as const, defaultValue: schema.default };
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === 'string')) {
    return { ...base, kind: 'enum', options: schema.enum as string[] };
  }
  const scalar = scalarKind(schema);
  if (scalar === 'string') return { ...base, kind: 'string' };
  if (scalar === 'number' || scalar === 'integer') return { ...base, kind: scalar };
  if (scalar === 'boolean') return { ...base, kind: 'boolean' };
  if (schema.type === 'array' && isRecord(schema.items)) {
    const item = schema.items;
    if (Array.isArray(item.enum) && item.enum.every((value) => typeof value === 'string')) return { ...base, kind: 'array', options: item.enum as string[] };
    const itemScalar = scalarKind(item);
    if (itemScalar === 'string' || itemScalar === 'number' || itemScalar === 'integer') return { ...base, kind: 'array', itemKind: itemScalar };
  }
  return null;
}

/** Champs du formulaire pour un `input_schema` objet. Un schéma absent ou sans propriétés donne un formulaire vide. */
export function buildFormModel(schema: unknown): FormModel {
  if (!isRecord(schema) || !isRecord(schema.properties)) return { fields: [], needsJsonEditor: isRecord(schema) && schema.type !== undefined && schema.type !== 'object' };
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : []);
  const fields: FormField[] = [];
  let needsJsonEditor = false;
  for (const [name, property] of Object.entries(schema.properties)) {
    const built = isRecord(property) ? field(name, property, required.has(name)) : null;
    if (built) fields.push(built);
    else needsJsonEditor = true;
  }
  return { fields, needsJsonEditor };
}

/** Saisies brutes du formulaire : texte pour les champs libres et les tableaux (valeurs séparées par des virgules), booléen pour une case. */
export type FormValues = Record<string, string | boolean>;

export function initialValues(model: FormModel): FormValues {
  const values: FormValues = {};
  for (const item of model.fields) {
    if (item.kind === 'boolean') values[item.name] = item.defaultValue === true;
    else if (item.kind === 'array') values[item.name] = Array.isArray(item.defaultValue) ? item.defaultValue.map(String).join(', ') : '';
    else values[item.name] = item.defaultValue === undefined || item.defaultValue === null ? '' : String(item.defaultValue);
  }
  return values;
}

function parseNumber(text: string, integer: boolean): number | string {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) return text;
  return value;
}

/**
 * Entrée du run construite des saisies. Un champ vide et facultatif est omis ; une saisie non numérique reste du texte
 * (le serveur répond alors 400 `invalid_input`, et le formulaire affiche l'erreur).
 */
export function toInput(model: FormModel, values: FormValues): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const item of model.fields) {
    const raw = values[item.name];
    if (item.kind === 'boolean') {
      input[item.name] = raw === true;
    } else if (item.kind === 'array') {
      const list = typeof raw === 'string' ? raw.split(',').map((part) => part.trim()).filter((part) => part !== '') : [];
      if (list.length > 0 || item.required) input[item.name] = item.itemKind === 'string' || item.options.length > 0 ? list : list.map((entry) => parseNumber(entry, item.itemKind === 'integer'));
    } else if (typeof raw === 'string' && (raw.trim() !== '' || item.required)) {
      input[item.name] = item.kind === 'number' ? parseNumber(raw, false) : item.kind === 'integer' ? parseNumber(raw, true) : raw;
    }
  }
  return input;
}

/** Entrée d'exemple pour les exemples d'appel (MCP et REST) : les champs obligatoires, avec une valeur de remplacement par type. */
export function exampleInput(model: FormModel): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const item of model.fields) {
    if (!item.required && item.defaultValue === undefined) continue;
    if (item.defaultValue !== undefined) input[item.name] = item.defaultValue;
    else if (item.kind === 'boolean') input[item.name] = false;
    else if (item.kind === 'number' || item.kind === 'integer') input[item.name] = 1;
    else if (item.kind === 'enum') input[item.name] = item.options[0] ?? '';
    else if (item.kind === 'array') input[item.name] = [];
    else input[item.name] = '…';
  }
  return input;
}
