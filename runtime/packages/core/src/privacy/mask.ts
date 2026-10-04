// SPDX-License-Identifier: AGPL-3.0-only
// Masquage des données personnelles dans les puits de journaux (`run_logs`, `error_detail`) : « identifiants
// techniques uniquement » (17 § 6). Complète `redact` (secrets) : motifs d'e-mail (y compris encodé `%40` dans une URL)
// et de téléphone, plus les valeurs `x-personal` vues pendant **un** run (noms compris), inscrites au registre de ce run.
//
// Registre par run (revue de 1.8) : le worker en crée un par run (`RunContext.personal`), l'exécuteur l'alimente au fil
// des items extraits (`addFromItem`), `appendRunLog` et `finishRun` l'appliquent, et il est vidé à la fin du run. Taille
// plafonnée (les valeurs les plus anciennes sortent) ; le motif est reconstruit à la lecture, pas à chaque ajout.
import { redact, REDACTED, secretValues, type SecretValueRegistry } from '../crypto/redact.js';
import { extractPersonalValues, normalizeSubjectValue } from './subject.js';

export const PERSONAL_MASK = '[PERSONAL]';
const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;
// International (+33 6 12 34 56 78), français (06 12 34 56 78), nord-américain (415-555-2671) ; pas de simple suite de chiffres.
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s.()-]*\d(?:[\s.()-]?\d){6,13}|0\d(?:[\s.-]?\d{2}){4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?!\w)/g;
const MIN_VALUE_LENGTH = 3;
export const PERSONAL_REGISTRY_MAX_VALUES = 5000;
const PATTERN_CHUNK = 500;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valeurs de sujets vues pendant un run : balayage insensible à la casse et aux espaces multiples. */
export class PersonalValueRegistry {
  readonly #values = new Set<string>();
  readonly #max: number;
  /** Motifs (alternances de `PATTERN_CHUNK` valeurs, les plus longues d'abord) ; `undefined` : à reconstruire. */
  #patterns: RegExp[] | undefined = [];

  constructor(options: { maxValues?: number } = {}) {
    this.#max = Math.max(1, options.maxValues ?? PERSONAL_REGISTRY_MAX_VALUES);
  }

  add(value: string): void {
    if (typeof value !== 'string') return;
    const norm = normalizeSubjectValue(value);
    if (norm.length < MIN_VALUE_LENGTH || this.#values.has(norm)) return;
    this.#values.add(norm);
    if (this.#values.size > this.#max) this.#values.delete(this.#values.values().next().value as string);
    this.#patterns = undefined; // reconstruit à la prochaine lecture
  }
  /** Inscrit les valeurs `x-personal` d'un item (schéma de sortie de l'API). */
  addFromItem(outputSchema: unknown, item: unknown): void {
    for (const v of extractPersonalValues(outputSchema, item)) this.add(v);
  }
  clear(): void {
    this.#values.clear();
    this.#patterns = [];
  }
  get size(): number {
    return this.#values.size;
  }
  /** Valeurs normalisées vues pendant le run (politique de requêtes de l'agent : jamais dans une URL, PA-01). */
  values(): string[] {
    return [...this.#values];
  }
  #regexes(): RegExp[] {
    if (this.#patterns === undefined) {
      // Une seule alternance géante coûte des secondes à compiler (V8) : des paquets bornés gardent un coût linéaire.
      const alts = [...this.#values].sort((a, b) => b.length - a.length).map((v) => escapeRegExp(v).replace(/ /g, '\\s+'));
      this.#patterns = [];
      for (let i = 0; i < alts.length; i += PATTERN_CHUNK) this.#patterns.push(new RegExp(alts.slice(i, i + PATTERN_CHUNK).join('|'), 'gi'));
    }
    return this.#patterns;
  }
  maskText(text: string): string {
    return this.#regexes().reduce((t, re) => t.replace(re, PERSONAL_MASK), text);
  }
}

/** Masque e-mails, téléphones et (avec un registre de run) les valeurs connues d'un texte libre. */
export function maskPersonalText(text: string, registry?: PersonalValueRegistry): string {
  return (registry ? registry.maskText(text) : text).replace(EMAIL, PERSONAL_MASK).replace(PHONE, PERSONAL_MASK);
}

function scrub(value: unknown, registry: PersonalValueRegistry | undefined): unknown {
  if (typeof value === 'string') return value === REDACTED ? value : maskPersonalText(value, registry);
  if (Array.isArray(value)) return value.map((v) => scrub(v, registry));
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskPersonalText(k, registry), scrub(v, registry)]));
}

/** Copie profonde d'une donnée de journal : secrets (`redact`) puis données personnelles, clés comprises. */
export function maskPersonal<T>(value: T, registry?: PersonalValueRegistry, secrets: SecretValueRegistry = secretValues): T {
  return scrub(redact(value, secrets), registry) as T;
}

export const ERROR_DETAIL_MAX_CHARS = 1000;

/** `error_detail` : masqué (secrets et données personnelles) puis tronqué. `undefined`/`null` restent `null`. */
export function boundErrorDetail(
  detail: string | null | undefined,
  registry?: PersonalValueRegistry,
  secrets: SecretValueRegistry = secretValues,
  max = ERROR_DETAIL_MAX_CHARS,
): string | null {
  if (detail === null || detail === undefined) return null;
  const masked = maskPersonalText(secrets.redactText(detail), registry);
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}
