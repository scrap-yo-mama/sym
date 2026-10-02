// SPDX-License-Identifier: AGPL-3.0-only
// Pagination : valeur du paramètre pour la page suivante et règles d'arrêt (04b § 2). L'arrêt est certain : `hard_max_pages`
// est obligatoire (vérifié à l'enregistrement) et un curseur déjà vu arrête toujours la boucle.
import { DslError } from './errors.js';
import { queryValues, type QueryContext } from './jsonpath.js';
import type { PaginationSpec } from './spec.js';

export interface PageState {
  /** Pages déjà récupérées. */
  pages: number;
  /** Enregistrements reçus au total. */
  received: number;
  cursor: string | null;
  seenCursors: Set<string>;
}

export interface PageOutcome {
  records: number;
  /** Document JSON de la réponse (pour `next_path` et les conditions `path_*`). */
  document?: unknown;
  /** En-tête `Link` brut (RFC 8288), repli de `next_link`. */
  linkHeader?: string;
}

export type StopReason = 'no_pagination' | 'records_empty' | 'path_equals' | 'path_missing' | 'repeated_cursor' | 'hard_max_pages' | 'max_pages_input' | 'no_next' | 'unsupported';

export type PaginationDecision =
  | { done: true; reason: StopReason }
  | { done: false; param?: { at: string; value: string | number }; nextUrl?: string; /** Suite = défilement de la page chargée (infinite_scroll). */ scroll?: true };

export function startPagination(): PageState {
  return { pages: 0, received: 0, cursor: null, seenCursors: new Set() };
}

/** Valeur initiale du paramètre de pagination (page 1 ou décalage de départ). */
export function initialParam(p: PaginationSpec): { at: string; value: number } | undefined {
  if (p.param === undefined) return undefined;
  if (p.type === 'page_param') return { at: p.param, value: p.start ?? 1 };
  if (p.type === 'offset') return { at: p.param, value: p.start ?? 0 };
  return undefined;
}

export function parseLinkNext(header: string | undefined): string | undefined {
  if (header === undefined || header.length > 8_000) return undefined;
  for (const part of header.split(',')) {
    const m = /^\s*<([^>]{1,2000})>\s*;(.*)$/.exec(part);
    if (m !== null && /(^|;)\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?\s*(;|$)/i.test(m[2] ?? '')) return m[1];
  }
  return undefined;
}

const first = (path: string, doc: unknown, ctx: QueryContext): unknown[] => queryValues(path, doc, ctx);

/**
 * Décide de la suite après une page. `maxPagesInput` : plafond demandé par l'appelant (`limits.max_pages_input`).
 * Ordre (04 §4 : « règle d'arrêt vérifiée sur la dernière page ») : d'abord la FIN NATURELLE de la liste (règle `stop[]`,
 * page vide, curseur absent ou répété, plus de lien suivant), ensuite les plafonds (`max_pages` de l'entrée, plafond
 * dur). Quand la dernière page coïncide avec un plafond, c'est donc la règle d'arrêt qui est constatée, pas le plafond.
 * `infinite_scroll` : la suite est un défilement de la page déjà chargée (`scroll: true`), jamais une requête nouvelle.
 */
export function advancePagination(p: PaginationSpec | undefined, state: PageState, outcome: PageOutcome, ctx: QueryContext, maxPagesInput?: number): PaginationDecision {
  state.pages += 1;
  state.received += outcome.records;
  if (p === undefined || p.type === 'none') return { done: true, reason: 'no_pagination' };
  for (const stop of p.stop ?? []) {
    if (stop.when === 'records_empty' && outcome.records === 0) return { done: true, reason: 'records_empty' };
    if (stop.when === 'path_equals' && outcome.document !== undefined) {
      const v = first(stop.path, outcome.document, ctx)[0];
      if (v !== undefined && v === stop.value) return { done: true, reason: 'path_equals' };
    }
    if (stop.when === 'path_missing' && outcome.document !== undefined && first(stop.path, outcome.document, ctx).length === 0) return { done: true, reason: 'path_missing' };
  }
  if (outcome.records === 0 && p.type !== 'cursor' && p.type !== 'next_link') return { done: true, reason: 'records_empty' };

  // Suite naturelle de la liste (peut aussi en constater la fin : curseur absent ou répété, plus de lien).
  let next: PaginationDecision;
  switch (p.type) {
    case 'page_param': {
      const step = typeof p.step === 'number' ? p.step : 1;
      next = { done: false, param: { at: p.param as string, value: (p.start ?? 1) + state.pages * step } };
      break;
    }
    case 'offset': {
      const step = typeof p.step === 'number' ? state.pages * p.step : state.received;
      next = { done: false, param: { at: p.param as string, value: (p.start ?? 0) + step } };
      break;
    }
    case 'cursor': {
      const raw = outcome.document === undefined || p.next_path === undefined ? undefined : first(p.next_path, outcome.document, ctx)[0];
      const cursor = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
      if (cursor === undefined || cursor === '') return { done: true, reason: 'no_next' };
      if (state.seenCursors.has(cursor)) return { done: true, reason: 'repeated_cursor' };
      state.seenCursors.add(cursor);
      state.cursor = cursor;
      next = { done: false, param: { at: p.param as string, value: cursor } };
      break;
    }
    case 'next_link': {
      const fromBody = outcome.document === undefined || p.next_path === undefined ? undefined : first(p.next_path, outcome.document, ctx)[0];
      const link = typeof fromBody === 'string' && fromBody !== '' ? fromBody : parseLinkNext(outcome.linkHeader);
      if (link === undefined) return { done: true, reason: 'no_next' };
      if (state.seenCursors.has(link)) return { done: true, reason: 'repeated_cursor' };
      state.seenCursors.add(link);
      next = { done: false, nextUrl: link };
      break;
    }
    case 'infinite_scroll':
      next = { done: false, scroll: true };
      break;
  }
  // Plafonds : arrêt certain (`hard_max_pages` est obligatoire à l'enregistrement) et plafond demandé par l'appelant.
  if (p.limits?.hard_max_pages !== undefined && state.pages >= p.limits.hard_max_pages) return { done: true, reason: 'hard_max_pages' };
  if (maxPagesInput !== undefined && state.pages >= maxPagesInput) return { done: true, reason: 'max_pages_input' };
  return next;
}

/**
 * Suivi des enregistrements déjà livrés d'un défilement infini. Le DOM d'un flux est cumulatif (les éléments déjà vus
 * restent) ou glissant (liste virtualisée : les anciens sortent) ; dans les deux cas, ce qui est « nouveau » après un
 * défilement est ce qui n'a pas déjà été vu, compté par occurrence (deux éléments identiques légitimes restent deux).
 *
 * Limite connue : l'identité d'un enregistrement est son contenu (JSON), la spec ne déclarant aucun champ identifiant. Sur
 * une liste glissante, un nouvel enregistrement de contenu identique à un enregistrement déjà vu (sorti de la fenêtre)
 * est écarté. Consignée dans tests/invariants.json (assert_infinite_scroll_paginated).
 */
export class ScrollTracker {
  private readonly seen = new Map<string, number>();

  /** Enregistrements de `current` jamais vus jusqu'ici, dans l'ordre du document ; les marque comme vus. */
  fresh<T>(current: readonly T[]): T[] {
    const occurrence = new Map<string, number>();
    const out: T[] = [];
    for (const record of current) {
      const key = JSON.stringify(record);
      const n = (occurrence.get(key) ?? 0) + 1;
      occurrence.set(key, n);
      if (n > (this.seen.get(key) ?? 0)) out.push(record);
    }
    for (const [key, n] of occurrence) if (n > (this.seen.get(key) ?? 0)) this.seen.set(key, n);
    return out;
  }
}

/** Lien « suivant » issu d'une réponse (donc non fiable) : résolu contre l'URL courante, http(s) seulement, hôte dans `allowed_hosts`. */
export function resolveNextUrl(link: string, currentUrl: string, allowedHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(link, currentUrl);
  } catch {
    throw new DslError('invalid_template', 'lien de pagination invalide');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || !allowedHosts.includes(url.hostname)) {
    throw new DslError('host_not_allowed', 'lien de pagination hors allowed_hosts');
  }
  return url.href;
}
