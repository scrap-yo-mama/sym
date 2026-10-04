// SPDX-License-Identifier: AGPL-3.0-only
// Placement d'un paramètre déclaré (`request.params[].at`, `pagination.param`) dans une requête rendue (04b §2).
// Emplacements reconnus : `url.query.<nom>`, `body.json.<chemin>` (segments `nom` ou `nom[n]`), `body.form.<nom>`.
// Tout autre emplacement est refusé ; l'hôte n'est jamais modifiable par ce biais (INV10).
import { DslError } from '../dsl/errors.js';
import type { RenderedRequest } from '../dsl/template.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = /^([A-Za-z_][A-Za-z0-9_-]{0,63})((?:\[\d{1,4}\])*)$/;

type Step = string | number;

function parsePath(path: string): Step[] {
  const steps: Step[] = [];
  for (const part of path.split('.')) {
    const m = SEGMENT.exec(part);
    if (m === null || FORBIDDEN_KEYS.has(m[1] as string)) throw new DslError('invalid_template', `emplacement de paramètre invalide : ${path.slice(0, 100)}`);
    steps.push(m[1] as string);
    for (const index of (m[2] ?? '').matchAll(/\[(\d+)\]/g)) steps.push(Number(index[1]));
  }
  return steps;
}

function setDeep(root: unknown, steps: Step[], value: unknown): unknown {
  const [head, ...rest] = steps;
  if (head === undefined) return value;
  if (typeof head === 'number') {
    const array = Array.isArray(root) ? [...(root as unknown[])] : [];
    if (head > array.length) throw new DslError('invalid_template', 'indice de paramètre hors du tableau');
    array[head] = setDeep(array[head], rest, value);
    return array;
  }
  const base = typeof root === 'object' && root !== null && !Array.isArray(root) ? (root as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(out, head, { value: setDeep(base[head], rest, value), enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * Numéro de page dans le chemin (`param: url.path`, `pagination.path_pattern`, 04b §2) : la page `start` est l'URL de la
 * requête telle quelle ; les suivantes remplacent le CHEMIN par le motif (`{page}` → numéro). Hôte, schéma et requête
 * restent ceux de la requête rendue : la pagination ne sort jamais du domaine (INV10).
 */
export function applyPathPattern(request: RenderedRequest, pattern: string, value: string | number, start: number): RenderedRequest {
  if (value === start) return request;
  if (!/^\/[^?#{}\s]*\{page\}[^?#{}\s]*$/.test(pattern) || pattern.split('{page}').length !== 2) throw new DslError('invalid_template', 'motif de chemin de pagination invalide');
  const url = new URL(request.url);
  url.pathname = pattern.replace('{page}', encodeURIComponent(String(value)));
  return { ...request, url: url.href };
}

/** Renvoie une copie de `request` dont l'emplacement `at` vaut `value`. */
export function applyParamAt(request: RenderedRequest, at: string, value: string | number): RenderedRequest {
  if (at.startsWith('url.query.')) {
    const name = at.slice('url.query.'.length);
    if (!/^[A-Za-z0-9_.[\]-]{1,100}$/.test(name)) throw new DslError('invalid_template', 'nom de paramètre de requête invalide');
    const url = new URL(request.url);
    url.searchParams.set(name, String(value));
    return { ...request, url: url.href };
  }
  if (at.startsWith('body.json.')) {
    if (request.body !== undefined && request.body.kind !== 'json') throw new DslError('invalid_template', 'paramètre body.json sur un corps non JSON');
    const current = request.body?.kind === 'json' ? request.body.value : {};
    return { ...request, body: { kind: 'json', value: setDeep(current, parsePath(at.slice('body.json.'.length)), value) } };
  }
  if (at.startsWith('body.form.')) {
    if (request.body !== undefined && request.body.kind !== 'form') throw new DslError('invalid_template', 'paramètre body.form sur un corps non formulaire');
    const name = at.slice('body.form.'.length);
    if (!SEGMENT.test(name) || FORBIDDEN_KEYS.has(name)) throw new DslError('invalid_template', 'nom de champ de formulaire invalide');
    const form = { ...(request.body?.kind === 'form' ? request.body.value : {}) };
    Object.defineProperty(form, name, { value: String(value), enumerable: true, writable: true, configurable: true });
    return { ...request, body: { kind: 'form', value: form } };
  }
  throw new DslError('invalid_template', `emplacement de paramètre non pris en charge : ${at.slice(0, 100)}`);
}
