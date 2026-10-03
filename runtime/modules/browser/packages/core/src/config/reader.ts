// SPDX-License-Identifier: AGPL-3.0-only
// Lecteur typé de l'environnement : n'accède qu'aux variables du catalogue, applique ses défauts, lit `NOM_FILE`, retire les
// secrets de l'environnement, et accumule les erreurs (toutes les variables invalides sont rapportées d'un coup).
import { readFileSync } from 'node:fs';
import { findEnvVariable, type ServiceMode } from './env-catalog.js';
import { Secret } from './secret.js';

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  override name = 'ConfigError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Configuration invalide :\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.issues = issues;
  }
}

const shown = (value: string): string => (value.length > 40 ? `${value.slice(0, 40)}…` : value);

export class Reader {
  /** Variables du catalogue effectivement lues (le test du catalogue compare cet ensemble au catalogue). */
  readonly touched = new Set<string>();
  readonly issues: string[] = [];
  mode: ServiceMode = 'all';
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  fail(message: string): void {
    this.issues.push(message);
  }

  #entry(name: string): NonNullable<ReturnType<typeof findEnvVariable>> {
    const entry = findEnvVariable(name);
    if (!entry) throw new Error(`${name} n'est pas dans le catalogue d'environnement (env-catalog.ts) : l'y ajouter avant de la lire.`);
    this.touched.add(name);
    return entry;
  }

  #missing(name: string, secret: boolean): void {
    if (this.#entry(name).required.includes(this.mode)) this.fail(`${name} obligatoire en mode ${this.mode}${secret ? ` (ou ${name}_FILE)` : ''}.`);
  }

  /** Valeur brute (blancs retirés), défaut du catalogue appliqué ; `null` si absente ou vide. Obligatoire selon le mode. */
  text(name: string): string | null {
    const entry = this.#entry(name);
    const raw = this.#env[name]?.trim();
    if (raw) return raw;
    if (entry.default !== null) return entry.default;
    this.#missing(name, false);
    return null;
  }

  /** Valeur effectivement posée par l'opérateur (sans défaut, sans contrôle d'obligation). */
  present(name: string): boolean {
    this.#entry(name);
    return (this.#env[name]?.trim() ?? '') !== '';
  }

  /** Secret : `NOM` ou `NOM_FILE` (contenu du fichier, blancs finaux retirés), retiré de l'environnement dans tous les cas. */
  secret(name: string, check?: (value: string) => string | undefined): Secret | null {
    this.#entry(name);
    const direct = this.#env[name]?.trim() ?? '';
    const file = this.#env[`${name}_FILE`]?.trim() ?? '';
    try {
      let value = direct;
      if (direct && file) {
        this.fail(`${name} et ${name}_FILE sont posées toutes les deux : n'en gardez qu'une.`);
        return null;
      }
      if (file) {
        try {
          value = readFileSync(file, 'utf8').replace(/\s+$/, '');
        } catch (error) {
          this.fail(`${name}_FILE illisible (${file}) : ${(error as NodeJS.ErrnoException).code ?? 'erreur'}.`);
          return null;
        }
      }
      if (value === '') {
        this.#missing(name, true);
        return null;
      }
      const problem = check?.(value);
      if (problem) {
        this.fail(`${name} invalide : ${problem}.`);
        return null;
      }
      return new Secret(value);
    } finally {
      delete this.#env[name];
      delete this.#env[`${name}_FILE`];
    }
  }

  int(name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
    const value = this.text(name);
    if (value === null) return null;
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      this.fail(`${name} invalide : entier de ${min} à ${max === Number.MAX_SAFE_INTEGER ? 'l’infini' : max} attendu (reçu « ${shown(value)} »).`);
      return null;
    }
    return n;
  }

  oneOf<T extends string>(name: string, values: readonly T[]): T | null {
    const value = this.text(name);
    if (value === null) return null;
    if (!(values as readonly string[]).includes(value)) {
      this.fail(`${name} invalide : ${values.join(', ')} attendu (reçu « ${shown(value)} »).`);
      return null;
    }
    return value as T;
  }

  /** Chaîne qui doit satisfaire `check` (retourne le motif de refus, ou `undefined`). */
  checked(name: string, expectation: string, check: (value: string) => boolean): string | null {
    const value = this.text(name);
    if (value === null) return null;
    if (!check(value)) {
      this.fail(`${name} invalide : ${expectation} (reçu « ${shown(value)} »).`);
      return null;
    }
    return value;
  }
}
