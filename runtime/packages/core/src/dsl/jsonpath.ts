// SPDX-License-Identifier: AGPL-3.0-only
// JSONPath RFC 9535 via `json-p3` (MIT, sans dépendance, aucun `eval` ni `new Function`, vérifié sur la source publiée).
// Durcissements propres à Scrapyomama :
//   - `match()` / `search()` passent par `regex.ts` (motif I-Regexp borné, texte <= 4 096 caractères) ;
//   - longueur du chemin, nombre de `..` et de filtres bornés (RFC 9535 § 4 : attaques de disponibilité) ;
//   - profondeur de récursion bornée ; résultats comptés et échéance contrôlée pendant l'itération paresseuse.
import { jsonpath, type JSONValue } from 'json-p3';
import { DslError } from './errors.js';
import { MAX_PATH_LENGTH, type Deadline, type DslLimits } from './limits.js';
import { assertBoundedRegex, assertSubjectFits } from './regex.js';

const { JSONPathEnvironment, functions } = jsonpath;
type JSONPathQuery = ReturnType<InstanceType<typeof JSONPathEnvironment>['compile']>;
type JSONPathNode = ReturnType<JSONPathQuery['query']>['nodes'][number];

const MAX_DESCENDANTS = 6;
const MAX_FILTERS = 6;
const MAX_RECURSION = 64;

function guardRegexCall(subject: unknown, pattern: unknown): void {
  if (typeof pattern !== 'string') return;
  const maxSubject = assertBoundedRegex(pattern);
  if (typeof subject === 'string') assertSubjectFits(subject, maxSubject);
}

class BoundedMatch extends functions.Match {
  override call(s: string, pattern: string): boolean {
    guardRegexCall(s, pattern);
    return super.call(s, pattern);
  }
}

class BoundedSearch extends functions.Search {
  override call(s: string, pattern: string): boolean {
    guardRegexCall(s, pattern);
    return super.call(s, pattern);
  }
}

function buildEnvironment(): InstanceType<typeof JSONPathEnvironment> {
  const env = new JSONPathEnvironment({ maxRecursionDepth: MAX_RECURSION, strict: true, nondeterministic: false });
  env.functionRegister.set('match', new BoundedMatch());
  env.functionRegister.set('search', new BoundedSearch());
  // Seules les cinq fonctions de la RFC 9535 sont disponibles.
  for (const name of [...env.functionRegister.keys()]) {
    if (!['length', 'count', 'match', 'search', 'value'].includes(name)) env.functionRegister.delete(name);
  }
  return env;
}

const environment = buildEnvironment();
const cache = new Map<string, JSONPathQuery>();
const CACHE_SIZE = 512;

function countOf(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/** Compile un chemin RFC 9535 (avec cache). Lève `DslError('invalid_jsonpath')` hors norme ou hors bornes. */
export function compileJsonPath(path: string): JSONPathQuery {
  if (typeof path !== 'string') throw new DslError('invalid_jsonpath', 'chemin JSONPath : chaîne attendue');
  if (path.length > MAX_PATH_LENGTH) throw new DslError('invalid_jsonpath', `chemin JSONPath trop long (> ${MAX_PATH_LENGTH} caractères)`);
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  if (countOf(path, '..') > MAX_DESCENDANTS) throw new DslError('invalid_jsonpath', `chemin JSONPath : plus de ${MAX_DESCENDANTS} segments descendants`);
  if (countOf(path, '?') > MAX_FILTERS) throw new DslError('invalid_jsonpath', `chemin JSONPath : plus de ${MAX_FILTERS} filtres`);
  let query: JSONPathQuery;
  try {
    query = environment.compile(path);
  } catch (cause) {
    if (cause instanceof DslError) throw cause;
    throw new DslError('invalid_jsonpath', 'chemin JSONPath invalide (RFC 9535)', { cause });
  }
  cache.set(path, query);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return query;
}

export interface QueryContext {
  limits: DslLimits;
  deadline?: Deadline;
}

/** Noeuds du résultat, bornés en nombre (`maxNodes`) ; l'échéance est contrôlée tous les 256 noeuds. */
export function queryNodes(path: string, document: unknown, context: QueryContext): JSONPathNode[] {
  const query = compileJsonPath(path);
  const nodes: JSONPathNode[] = [];
  try {
    for (const node of query.lazyQuery(document as JSONValue)) {
      nodes.push(node);
      if (nodes.length > context.limits.maxNodes) throw new DslError('too_many_nodes', `chemin JSONPath : plus de ${context.limits.maxNodes} résultats`);
      if ((nodes.length & 255) === 0) context.deadline?.check();
    }
  } catch (cause) {
    if (cause instanceof DslError) throw cause;
    if (cause instanceof RangeError) throw new DslError('depth_exceeded', 'chemin JSONPath : pile épuisée', { cause });
    throw new DslError('invalid_jsonpath', 'évaluation JSONPath impossible', { cause });
  }
  context.deadline?.check();
  return nodes;
}

/** Valeurs du résultat. */
export function queryValues(path: string, document: unknown, context: QueryContext): unknown[] {
  return queryNodes(path, document, context).map((n) => n.value as unknown);
}
