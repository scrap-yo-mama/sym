// SPDX-License-Identifier: AGPL-3.0-only
// Contrat des réponses REST (tâche 3.1) : chaque réponse observée est validée contre le schéma que l'OpenAPI servie
// (`/api/openapi.json`) déclare pour son opération et son code. Ajv 2020-12 (dialecte d'OpenAPI 3.1), sans contrôle des
// formats ni mot-clé inconnu bloquant (`writeOnly`, `example`). Les opérations vérifiées sont comptées : un test exige
// que chaque endpoint livré ait au moins une réponse contrôlée.
import { Ajv2020 } from 'ajv/dist/2020.js';

type Doc = { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>; components?: Record<string, Record<string, unknown>> };

const ID = 'https://zz-test.invalid/openapi.json';
const pointer = (...parts: string[]) => parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

export class OpenApiContract {
  readonly #ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  readonly #doc: Doc;
  /** « MÉTHODE /chemin code » contrôlés. */
  readonly covered = new Set<string>();

  constructor(doc: unknown) {
    this.#doc = doc as Doc;
    this.#ajv.addSchema(doc as object, ID);
  }

  /** Opérations du document (« MÉTHODE /chemin »). */
  operations(): string[] {
    const out: string[] = [];
    for (const [path, item] of Object.entries(this.#doc.paths)) {
      for (const method of ['get', 'put', 'post', 'delete', 'patch']) if (item[method]) out.push(`${method.toUpperCase()} ${path}`);
    }
    return out.sort();
  }

  /**
   * Valide `body` contre la réponse déclarée de l'opération. Renvoie les erreurs (vide : conforme). Un code non déclaré
   * est une erreur ; une réponse sans corps JSON déclaré (204, flux) n'est contrôlée que sur le code.
   */
  check(method: string, path: string, status: number, body: unknown): string[] {
    const op = this.#doc.paths[path]?.[method.toLowerCase()];
    if (!op) return [`opération absente : ${method} ${path}`];
    let response = op.responses?.[String(status)] as { $ref?: string; content?: Record<string, { schema?: unknown }> } | undefined;
    if (!response) return [`code ${status} non déclaré pour ${method} ${path}`];
    let base = pointer('paths', path, method.toLowerCase(), 'responses', String(status));
    if (response.$ref) {
      const name = response.$ref.replace('#/components/responses/', '');
      response = this.#doc.components?.['responses']?.[name] as typeof response;
      base = pointer('components', 'responses', name);
    }
    this.covered.add(`${method.toUpperCase()} ${path} ${status}`);
    if (!response?.content?.['application/json']?.schema) return [];
    const validate = this.#ajv.getSchema(`${ID}#/${base}/content/application~1json/schema`);
    if (!validate) return [`schéma introuvable : ${base}`];
    if (validate(body)) return [];
    return (validate.errors ?? []).map((e) => `${e.instancePath || '(racine)'} ${e.message ?? ''} ${JSON.stringify(e.params)}`);
  }

  /** Compile chaque schéma nommé (toute référence interne doit se résoudre). */
  compileAll(): string[] {
    const errors: string[] = [];
    for (const name of Object.keys(this.#doc.components?.['schemas'] ?? {})) {
      try {
        if (!this.#ajv.getSchema(`${ID}#/components/schemas/${pointer(name)}`)) errors.push(name);
      } catch (error) {
        errors.push(`${name} : ${(error as Error).message}`);
      }
    }
    return errors;
  }
}
