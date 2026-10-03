// SPDX-License-Identifier: AGPL-3.0-only
// Sujet de données : valeurs `x-personal` du schéma de sortie, normalisation et empreinte HMAC (17 § 6, D-25).
// La clé HMAC est une clé d'instance aléatoire et stable (32 octets), stockée chiffrée comme un secret d'instance et
// ré-enveloppée par `rekey` (`loadSubjectKey`, paquet db) : une rotation de MASTER_KEY ne change aucune empreinte, et
// sans la clé un dictionnaire d'e-mails ou de téléphones ne dit pas qui figure dans `subject_exclusions`.
//
// Deux usages distincts des valeurs `x-personal` :
//  - `extractPersonalValues` : toutes les chaînes sous un nœud `x-personal` (identifiant ou contenu), pour masquer les
//    journaux (sur-masquer est sans conséquence) ;
//  - `extractSubjectIdentifiers` : les seules chaînes **identifiantes** (`x-personal: identifier` ou `true`, jamais
//    `content`), filtrées par `isUsableSubjectValue` : ni booléen, ni nombre, ni date, ni texte court. Ce sont elles
//    qui désignent une personne (effacement, liste d'exclusion) ; une égalité exacte sur ces champs décide.
import { createHmac } from 'node:crypto';
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from 'libphonenumber-js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const COMBINATORS = ['allOf', 'anyOf', 'oneOf'] as const;
const MAX_DEPTH = 64;

type PersonalKind = 'identifier' | 'content';

/** `x-personal` actif : `true` (identifiant par défaut), `identifier` ou `content`. */
function personalKind(node: Record<string, unknown>): PersonalKind | null {
  const flag = node['x-personal'];
  if (flag === true) return 'identifier';
  if (typeof flag !== 'string' || flag === '' || flag === 'false') return null;
  return flag === 'content' ? 'content' : 'identifier';
}

/** Feuilles **textuelles** seulement : un booléen ou un nombre ne désigne personne (`verified: true`). */
function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out, depth + 1);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) stringLeaves(v, out, depth + 1);
  }
}

function walk(schema: unknown, value: unknown, out: string[], depth: number, accept: (k: PersonalKind) => boolean): void {
  if (depth > MAX_DEPTH || !isRecord(schema) || value === undefined || value === null) return;
  const kind = personalKind(schema);
  if (kind !== null && accept(kind)) {
    stringLeaves(value, out);
    return;
  }
  for (const key of COMBINATORS) {
    const subs = schema[key];
    if (Array.isArray(subs)) for (const s of subs) walk(s, value, out, depth + 1, accept);
  }
  if (isRecord(value) && isRecord(schema['properties'])) {
    for (const [name, sub] of Object.entries(schema['properties'])) walk(sub, value[name], out, depth + 1, accept);
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    for (const v of value) walk(schema['items'], v, out, depth + 1, accept);
  }
}

/** Chaînes d'un item situées sous un nœud `x-personal` (identifiant ou contenu) : masquage des journaux. */
export function extractPersonalValues(outputSchema: unknown, item: unknown): string[] {
  const out: string[] = [];
  walk(outputSchema, item, out, 0, () => true);
  return out;
}

/**
 * Valeurs identifiantes d'un item (`x-personal: identifier` ou `true`), chaînes seulement, réduites à celles qui
 * désignent une personne (`isUsableSubjectValue`). Point de départ d'une demande et clé de la liste d'exclusion.
 */
export function extractSubjectIdentifiers(outputSchema: unknown, item: unknown): string[] {
  const out: string[] = [];
  walk(outputSchema, item, out, 0, (k) => k === 'identifier');
  return [...new Set(out)].filter(isUsableSubjectValue);
}

/** Champs nommés au plus dans un message (le reste est compté). */
const MAX_NAMED_FIELDS = 20;

/**
 * Chemins des champs `x-personal` d'un schéma de sortie, dans l'ordre du schéma : `email`, `author.name`, `phones[]`,
 * `[].author` (items d'un tableau racine). Pour dire à l'appelant QUEL champ demande la case « Usage responsable » (UX-19).
 */
export function personalFieldPaths(schema: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_NAMED_FIELDS || !isRecord(node)) return;
    if (personalKind(node) !== null && path !== '') {
      out.push(path);
      return;
    }
    const properties = node['properties'];
    if (isRecord(properties)) for (const [name, child] of Object.entries(properties)) visit(child, path === '' ? name : `${path}.${name}`, depth + 1);
    const items = node['items'];
    if (isRecord(items)) visit(items, `${path}[]`, depth + 1);
    for (const key of COMBINATORS) {
      const list = node[key];
      if (Array.isArray(list)) for (const child of list) visit(child, path, depth + 1);
    }
  };
  visit(schema, '', 0);
  return [...new Set(out)];
}

/** Le schéma déclare-t-il au moins un champ `x-personal` ? */
export function schemaHasPersonalFields(schema: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(schema)) return schema.some((s) => schemaHasPersonalFields(s, depth + 1));
  if (!isRecord(schema)) return false;
  if (personalKind(schema) !== null) return true;
  return Object.values(schema).some((s) => schemaHasPersonalFields(s, depth + 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Téléphones : E.164 (libphonenumber-js), région par défaut de l'instance
// ---------------------------------------------------------------------------------------------------------------
export const DEFAULT_PHONE_REGION: CountryCode = 'FR';
let phoneRegion: CountryCode | undefined;

/** Région des numéros nationaux (`06 12…`) : `PHONE_DEFAULT_REGION` (ISO 3166-1 alpha-2), lue une fois ; défaut FR. */
export function subjectPhoneRegion(env: NodeJS.ProcessEnv = process.env): CountryCode {
  if (phoneRegion) return phoneRegion;
  const raw = (env['PHONE_DEFAULT_REGION'] ?? '').trim().toUpperCase();
  if (raw !== '' && !isSupportedCountry(raw)) throw new Error(`PHONE_DEFAULT_REGION invalide : ${raw} (code pays ISO 3166-1 alpha-2 attendu).`);
  phoneRegion = raw === '' ? DEFAULT_PHONE_REGION : (raw as CountryCode);
  return phoneRegion;
}

const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const LOCAL_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Numéro de téléphone plausible (forme nationale ou internationale), sinon `null`. Jamais une date. */
export function parseSubjectPhone(value: string): PhoneNumber | null {
  const v = value.normalize('NFKC').trim();
  if (!PHONE_LIKE.test(v) || ISO_DATE.test(v) || LOCAL_DATE.test(v)) return null;
  const parsed = parsePhoneNumberFromString(v, subjectPhoneRegion());
  return parsed?.isPossible() ? parsed : null;
}

export type SubjectValueKind = 'email' | 'phone' | 'date' | 'text';

export function subjectValueKind(value: string): SubjectValueKind {
  const v = value.normalize('NFKC').trim();
  if (EMAIL.test(v)) return 'email';
  if (ISO_DATE.test(v) || LOCAL_DATE.test(v)) return 'date';
  if (parseSubjectPhone(v)) return 'phone';
  return 'text';
}

/** Texte libre (nom…) : au moins 8 caractères dont une lettre ; « Anne » seul désignerait trop de monde. */
export const MIN_SUBJECT_TEXT_LENGTH = 8;
const NON_IDENTIFYING = new Set(['true', 'false', 'null', 'undefined', 'yes', 'no', 'oui', 'non']);

/** La valeur désigne-t-elle une personne ? E-mail ou téléphone : oui ; date, nombre, booléen, texte court : non. */
export function isUsableSubjectValue(value: string): boolean {
  const kind = subjectValueKind(value);
  if (kind === 'email' || kind === 'phone') return true;
  if (kind === 'date') return false;
  const norm = normalizeSubjectValue(value);
  if (NON_IDENTIFYING.has(norm) || !/\p{L}/u.test(norm)) return false;
  return norm.length >= MIN_SUBJECT_TEXT_LENGTH;
}

/**
 * Forme canonique d'une valeur de sujet : NFKC, minuscules, espaces repliés ; un téléphone est mis en E.164
 * (`06 12 34 56 78`, `+33 6 12 34 56 78` et `0033 6…` donnent `+33612345678`).
 */
export function normalizeSubjectValue(value: string): string {
  const phone = parseSubjectPhone(value);
  if (phone) return phone.number;
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** HMAC-SHA256 (hex) de la forme canonique. `key` : clé des sujets de l'instance (`loadSubjectKey`). */
export function subjectHash(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(normalizeSubjectValue(value)).digest('hex');
}

/** Empreintes distinctes d'une liste de valeurs (valeurs vides ignorées). */
export function subjectHashes(key: Buffer, values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => normalizeSubjectValue(v) !== '').map((v) => subjectHash(key, v)))];
}

/**
 * `dedup_keys.key_hash` (tâches 1.6/1.7) : HMAC de la clé de déduplication normalisée, sous la clé des sujets. Une clé
 * de déduplication qui porte un identifiant (e-mail, téléphone) est ainsi retrouvable par `erase_subject`.
 */
export function dedupKeyHash(key: Buffer, dedupKey: string): string {
  return createHmac('sha256', key).update(`dedup\u0000${normalizeSubjectValue(dedupKey)}`).digest('hex');
}

/** Un item est exclu si l'une de ses valeurs identifiantes a une empreinte présente dans `excluded`. */
export function isItemExcluded(key: Buffer, excluded: ReadonlySet<string>, outputSchema: unknown, item: unknown): boolean {
  if (excluded.size === 0) return false;
  return extractSubjectIdentifiers(outputSchema, item).some((v) => excluded.has(subjectHash(key, v)));
}

/** Retire des `items` ceux qui concernent un sujet exclu (à appeler avant collecte et avant écriture du dataset). */
export function filterExcludedItems<T>(
  key: Buffer,
  excluded: ReadonlySet<string>,
  outputSchema: unknown,
  items: readonly T[],
): { kept: T[]; dropped: number } {
  const kept = items.filter((it) => !isItemExcluded(key, excluded, outputSchema, it));
  return { kept, dropped: items.length - kept.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Motifs de recherche (syntaxe commune aux RegExp JavaScript et aux ARE de PostgreSQL), bornés aux limites de mot
// ---------------------------------------------------------------------------------------------------------------
const WORD = '[\\w\\u00C0-\\u024F]';
const SEP = '[\\s.()/-]*';
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);
const digitsPattern = (digits: string) => [...digits].join(SEP);

/**
 * Motifs recherchés pour une valeur : texte et e-mail entre deux limites de mot (« Anne Martin » ne trouve ni
 * « Jeanne Martinez » ni « annexe »), sous leurs formes saisie, échappée JSON et normalisée ; un téléphone sous ses
 * formes internationale (`+33`, `0033`, `33…`) et nationale (`06…`), séparateurs libres, jamais collé à d'autres chiffres.
 */
export function subjectSearchPatterns(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const raw of values) {
    const v = raw.normalize('NFKC').trim();
    if (v === '') continue;
    const phone = parseSubjectPhone(v);
    if (phone) {
      const cc = phone.countryCallingCode;
      const nsn = phone.nationalNumber;
      const national = phone.formatNational().replace(/\D/g, '');
      forms.add(`(?<![0-9+])(?:\\+|00)?${SEP}${digitsPattern(cc)}${SEP}(?:\\(0\\)${SEP})?${digitsPattern(nsn)}(?![0-9])`);
      if (national !== '' && national !== cc + nsn) forms.add(`(?<![0-9+])${digitsPattern(national)}(?![0-9])`);
      continue;
    }
    for (const f of new Set([v, jsonEscape(v), normalizeSubjectValue(v)])) {
      forms.add(`(?<!${WORD})${reEscape(f).replace(/ /g, '\\s+')}(?!${WORD})`);
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Motif unique (alternance) ; `null` sans valeur exploitable. */
export function subjectSearchRegex(values: readonly string[]): string | null {
  const forms = subjectSearchPatterns(values);
  return forms.length ? forms.join('|') : null;
}
