// SPDX-License-Identifier: AGPL-3.0-only
// Décodeurs de blobs embarqués (04b § 2, `sources[].from = "embedded"`) : `__NEXT_DATA__`, Nuxt (`__NUXT_DATA__` à plat, `window.__NUXT__`),
// état Apollo (`window.__APOLLO_STATE__`, références `__ref` résolues), JSON-LD, `script#id`.
// Rien n'est exécuté : le texte de la balise est lu comme JSON, ou comme un littéral JSON après `window.VARIABLE =`.
import type { Document, Element } from 'domhandler';
import { elementText, selectElements } from './css.js';
import { DslError } from './errors.js';
import { assertJsonWithinLimits, parseJsonBounded, type DslLimits } from './limits.js';

export const BLOB_KINDS = ['next_data', 'nuxt_data', 'apollo_state', 'json_ld', 'script_id'] as const;
export type BlobKind = (typeof BLOB_KINDS)[number];

export interface BlobLocator {
  kind: BlobKind;
  /** `script_id` : identifiant de la balise. */
  id?: string;
  /** `script_id` : variable globale affectée (`window.NOM = {...}`) si la balise n'est pas du JSON pur. */
  variable?: string;
}

export const SCRIPT_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;
export const VARIABLE_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function scriptsOf(doc: Document, selector: string, limits: DslLimits): Element[] {
  return selectElements(selector, doc, limits.maxItems);
}

/** Littéral JSON affecté à `variable` dans un texte JavaScript (`window.X = {...};`). Balayage borné, sans exécution. */
function extractAssignedJson(text: string, variable: string, limits: DslLimits): unknown {
  let from = 0;
  for (;;) {
    const at = text.indexOf(variable, from);
    if (at === -1) throw new DslError('blob_not_found', 'blob introuvable : variable absente');
    from = at + variable.length;
    const before = text.slice(Math.max(0, at - 12), at);
    const prefixOk = at === 0 || /[\s;{}()]$/.test(before) || /(window|globalThis|self)\.$/.test(before);
    let i = from;
    while (i < text.length && /\s/.test(text[i] as string)) i += 1;
    if (!prefixOk || text[i] !== '=') continue;
    i += 1;
    while (i < text.length && /\s/.test(text[i] as string)) i += 1;
    const open = text[i];
    if (open !== '{' && open !== '[') throw new DslError('invalid_blob', 'blob non JSON : littéral objet ou tableau attendu');
    const end = scanBalanced(text, i, limits);
    return parseJsonBounded(text.slice(i, end), limits);
  }
}

/** Fin (exclusive) du littéral JSON qui commence en `start`. Sensible aux chaînes et aux échappements ; profondeur bornée. */
function scanBalanced(text: string, start: number, limits: DslLimits): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      depth += 1;
      if (depth > limits.maxDepth) throw new DslError('depth_exceeded', 'blob refusé : profondeur excessive');
    } else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new DslError('invalid_blob', 'blob non JSON : littéral non fermé');
}

function scriptJson(el: Element, limits: DslLimits, variable?: string): unknown {
  const text = elementTextRaw(el, limits);
  if (variable !== undefined) return extractAssignedJson(text, variable, limits);
  return parseJsonBounded(text, limits);
}

function elementTextRaw(el: Element, limits: DslLimits): string {
  // Le texte d'un <script> est porté par ses noeuds texte enfants (elementText ignore les <script> imbriqués, pas le noeud lui-même).
  return elementText(el, limits.maxResponseBytes);
}

/** Décodage `devalue` tel qu'écrit par Nuxt 3 (`__NUXT_DATA__`) : tableau à plat, les objets et tableaux portent des indices. */
export function decodeFlatData(flat: unknown, limits: DslLimits): unknown {
  if (!Array.isArray(flat) || flat.length === 0) throw new DslError('invalid_blob', 'blob Nuxt : tableau à plat attendu');
  if (flat.length > limits.maxNodes) throw new DslError('too_many_nodes', 'blob Nuxt : trop de valeurs');
  const memo = new Map<number, { value: unknown; size: number }>();
  const active = new Set<number>();
  const TAGS_TRANSPARENT = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'Readonly', 'ShallowReadonly']);

  const hydrate = (index: number, depth: number): { value: unknown; size: number } => {
    if (!Number.isInteger(index)) throw new DslError('invalid_blob', 'blob Nuxt : indice invalide');
    if (index < 0) {
      // -1 undefined, -2 trou, -3 NaN, -4 +Infinity, -5 -Infinity, -6 -0 : les valeurs non JSON deviennent null.
      return { value: index === -6 ? 0 : null, size: 1 };
    }
    if (index >= flat.length) throw new DslError('invalid_blob', 'blob Nuxt : indice hors tableau');
    const hit = memo.get(index);
    if (hit !== undefined) return hit;
    if (depth > limits.maxDepth) throw new DslError('depth_exceeded', 'blob Nuxt : profondeur excessive');
    if (active.has(index)) throw new DslError('invalid_blob', 'blob Nuxt : références circulaires');
    const raw = flat[index] as unknown;
    let result: { value: unknown; size: number };
    active.add(index);
    if (Array.isArray(raw)) {
      const tag = raw[0];
      if (typeof tag === 'string') {
        if (TAGS_TRANSPARENT.has(tag)) result = hydrate(raw[1] as number, depth);
        else if (tag === 'Date' || tag === 'BigInt') result = { value: typeof raw[1] === 'string' ? raw[1] : null, size: 1 };
        else if (tag === 'EmptyRef' || tag === 'EmptyShallowRef' || tag === 'null') result = { value: null, size: 1 };
        else if (tag === 'Set') result = collect(raw.slice(1) as number[], depth);
        else throw new DslError('invalid_blob', 'blob Nuxt : type de valeur non pris en charge');
      } else {
        result = collect(raw as number[], depth);
      }
    } else if (typeof raw === 'object' && raw !== null) {
      let size = 1;
      const out: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(raw)) {
        const child = hydrate(ref as number, depth + 1);
        size += child.size;
        if (size > limits.maxNodes) throw new DslError('too_many_nodes', 'blob Nuxt : document développé trop grand');
        Object.defineProperty(out, key, { value: child.value, enumerable: true, writable: true, configurable: true });
      }
      result = { value: out, size };
    } else {
      result = { value: raw, size: 1 };
    }
    active.delete(index);
    memo.set(index, result);
    return result;
  };

  const collect = (refs: number[], depth: number): { value: unknown; size: number } => {
    let size = 1;
    const out: unknown[] = [];
    for (const ref of refs) {
      const child = hydrate(ref, depth + 1);
      size += child.size;
      if (size > limits.maxNodes) throw new DslError('too_many_nodes', 'blob Nuxt : document développé trop grand');
      out.push(child.value);
    }
    return { value: out, size };
  };

  return hydrate(0, 1).value;
}

/** État Apollo : remplace chaque `{ __ref: "Type:id" }` par l'objet normalisé référencé. Cycles laissés tels quels, taille bornée. */
export function resolveApolloRefs(state: unknown, limits: DslLimits): unknown {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) throw new DslError('invalid_blob', 'état Apollo : objet attendu');
  const table = state as Record<string, unknown>;
  const memo = new Map<string, { value: unknown; size: number }>();
  const active = new Set<string>();

  const walk = (node: unknown, depth: number): { value: unknown; size: number } => {
    if (typeof node !== 'object' || node === null) return { value: node, size: 1 };
    if (depth > limits.maxDepth * 2) throw new DslError('depth_exceeded', 'état Apollo : profondeur excessive');
    if (!Array.isArray(node)) {
      const ref = (node as Record<string, unknown>)['__ref'];
      if (typeof ref === 'string' && Object.keys(node).length === 1) {
        if (!Object.hasOwn(table, ref)) return { value: null, size: 1 };
        const hit = memo.get(ref);
        if (hit !== undefined) return hit;
        if (active.has(ref)) return { value: node, size: 1 }; // cycle : on garde la référence
        active.add(ref);
        const resolved = walk(table[ref], depth + 1);
        active.delete(ref);
        memo.set(ref, resolved);
        return resolved;
      }
    }
    let size = 1;
    const out: unknown = Array.isArray(node) ? [] : {};
    for (const [key, child] of Object.entries(node)) {
      const r = walk(child, depth + 1);
      size += r.size;
      if (size > limits.maxNodes) throw new DslError('too_many_nodes', 'état Apollo : document développé trop grand');
      if (Array.isArray(out)) out.push(r.value);
      else Object.defineProperty(out, key, { value: r.value, enumerable: true, writable: true, configurable: true });
    }
    return { value: out, size };
  };

  return walk(state, 1).value;
}

function firstScript(doc: Document, selector: string, limits: DslLimits): Element | undefined {
  return scriptsOf(doc, selector, limits)[0];
}

/** Décode le blob désigné par `locator` dans un HTML déjà analysé. */
export function decodeEmbedded(doc: Document, locator: BlobLocator, limits: DslLimits): unknown {
  switch (locator.kind) {
    case 'next_data': {
      const el = firstScript(doc, 'script#__NEXT_DATA__', limits);
      if (el === undefined) throw new DslError('blob_not_found', 'blob introuvable : __NEXT_DATA__');
      return scriptJson(el, limits);
    }
    case 'nuxt_data': {
      const el = firstScript(doc, 'script#__NUXT_DATA__', limits);
      if (el !== undefined) return decodeFlatData(scriptJson(el, limits), limits);
      for (const script of scriptsOf(doc, 'script:not([src])', limits)) {
        const text = elementTextRaw(script, limits);
        if (text.includes('__NUXT__')) return extractAssignedJson(text, '__NUXT__', limits);
      }
      throw new DslError('blob_not_found', 'blob introuvable : __NUXT_DATA__ ou window.__NUXT__');
    }
    case 'apollo_state': {
      const byId = firstScript(doc, 'script#__APOLLO_STATE__', limits);
      if (byId !== undefined) return resolveApolloRefs(scriptJson(byId, limits), limits);
      for (const script of scriptsOf(doc, 'script:not([src])', limits)) {
        const text = elementTextRaw(script, limits);
        if (text.includes('__APOLLO_STATE__')) return resolveApolloRefs(extractAssignedJson(text, '__APOLLO_STATE__', limits), limits);
      }
      throw new DslError('blob_not_found', 'blob introuvable : __APOLLO_STATE__');
    }
    case 'json_ld': {
      const blocks: unknown[] = [];
      for (const script of scriptsOf(doc, 'script[type="application/ld+json"]', limits)) {
        let parsed: unknown;
        try {
          parsed = scriptJson(script, limits);
        } catch (error) {
          if (error instanceof DslError && error.code === 'invalid_json') continue; // un bloc invalide n'invalide pas les autres
          throw error;
        }
        if (Array.isArray(parsed)) blocks.push(...parsed);
        else blocks.push(parsed);
      }
      if (blocks.length === 0) throw new DslError('blob_not_found', 'blob introuvable : JSON-LD');
      assertJsonWithinLimits(blocks, limits);
      return blocks;
    }
    case 'script_id': {
      if (locator.id === undefined || !SCRIPT_ID_PATTERN.test(locator.id)) throw new DslError('invalid_spec', 'locator script_id : id invalide');
      if (locator.variable !== undefined && !VARIABLE_PATTERN.test(locator.variable)) throw new DslError('invalid_spec', 'locator script_id : variable invalide');
      const el = firstScript(doc, `script[id="${locator.id}"]`, limits);
      if (el === undefined) throw new DslError('blob_not_found', 'blob introuvable : script#id');
      return scriptJson(el, limits, locator.variable);
    }
    default:
      throw new DslError('unsupported', 'locator de blob inconnu');
  }
}
