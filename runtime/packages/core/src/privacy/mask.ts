// Masquage des données personnelles dans les puits de journaux (`run_logs`, `error_detail`) : « identifiants
// techniques uniquement » (17 § 6). Complète `redact` (secrets) : motifs d'e-mail et de téléphone, plus les valeurs
// `x-personal` vues pendant l'exécution (noms compris) inscrites au registre du processus.
import { redact, REDACTED, secretValues, type SecretValueRegistry } from '../crypto/redact.js';
import { extractPersonalValues, normalizeSubjectValue } from './subject.js';

export const PERSONAL_MASK = '[PERSONAL]';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// International (+33 6 12 34 56 78), français (06 12 34 56 78), nord-américain (415-555-2671) ; pas de simple suite de chiffres.
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s.()-]*\d(?:[\s.()-]?\d){6,13}|0\d(?:[\s.-]?\d{2}){4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
const MIN_VALUE_LENGTH = 3;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valeurs de sujets connues du processus : balayage insensible à la casse et aux espaces multiples. */
export class PersonalValueRegistry {
  readonly #values = new Set<string>();
  #pattern: RegExp | undefined;

  add(value: string): void {
    const norm = normalizeSubjectValue(value);
    if (norm.length < MIN_VALUE_LENGTH || this.#values.has(norm)) return;
    this.#values.add(norm);
    const alts = [...this.#values].sort((a, b) => b.length - a.length).map((v) => escapeRegExp(v).replace(/ /g, '\\s+'));
    this.#pattern = new RegExp(alts.join('|'), 'gi');
  }
  /** Inscrit les valeurs `x-personal` d'un item (schéma de sortie de l'API). */
  addFromItem(outputSchema: unknown, item: unknown): void {
    for (const v of extractPersonalValues(outputSchema, item)) this.add(v);
  }
  clear(): void {
    this.#values.clear();
    this.#pattern = undefined;
  }
  get size(): number {
    return this.#values.size;
  }
  maskText(text: string): string {
    return this.#pattern ? text.replace(this.#pattern, PERSONAL_MASK) : text;
  }
}

/** Registre du processus, alimenté par l'exécuteur au fil des items extraits. */
export const personalValues = new PersonalValueRegistry();

/** Masque e-mails, téléphones et valeurs connues d'un texte libre. */
export function maskPersonalText(text: string, registry: PersonalValueRegistry = personalValues): string {
  return registry.maskText(text).replace(EMAIL, PERSONAL_MASK).replace(PHONE, PERSONAL_MASK);
}

function scrub(value: unknown, registry: PersonalValueRegistry): unknown {
  if (typeof value === 'string') return value === REDACTED ? value : maskPersonalText(value, registry);
  if (Array.isArray(value)) return value.map((v) => scrub(v, registry));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskPersonalText(k, registry), scrub(v, registry)]));
}

/** Copie profonde d'une donnée de journal : secrets (`redact`) puis données personnelles, clés comprises. */
export function maskPersonal<T>(
  value: T,
  registry: PersonalValueRegistry = personalValues,
  secrets: SecretValueRegistry = secretValues,
): T {
  return scrub(redact(value, secrets), registry) as T;
}

export const ERROR_DETAIL_MAX_CHARS = 1000;

/** `error_detail` : masqué (secrets et données personnelles) puis tronqué. `undefined`/`null` restent `null`. */
export function boundErrorDetail(
  detail: string | null | undefined,
  registry: PersonalValueRegistry = personalValues,
  secrets: SecretValueRegistry = secretValues,
  max = ERROR_DETAIL_MAX_CHARS,
): string | null {
  if (detail === null || detail === undefined) return null;
  const masked = maskPersonalText(secrets.redactText(detail), registry);
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}
