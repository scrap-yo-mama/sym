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
  | { done: false; param?: { at: string; value: string | number }; nextUrl?: string };

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

/** Décide de la suite après une page. `maxPagesInput` : plafond demandé par l'appelant (`limits.max_pages_input`). */
export function advancePagination(p: PaginationSpec | undefined, state: PageState, outcome: PageOutcome, ctx: QueryContext, maxPagesInput?: number): PaginationDecision {
  state.pages += 1;
  state.received += outcome.records;
  if (p === undefined || p.type === 'none') return { done: true, reason: 'no_pagination' };
  if (p.type === 'infinite_scroll') return { done: true, reason: 'unsupported' };
  if (p.limits?.hard_max_pages !== undefined && state.pages >= p.limits.hard_max_pages) return { done: true, reason: 'hard_max_pages' };
  if (maxPagesInput !== undefined && state.pages >= maxPagesInput) return { done: true, reason: 'max_pages_input' };
  for (const stop of p.stop ?? []) {
    if (stop.when === 'records_empty' && outcome.records === 0) return { done: true, reason: 'records_empty' };
    if (stop.when === 'path_equals' && outcome.document !== undefined) {
      const v = first(stop.path, outcome.document, ctx)[0];
      if (v !== undefined && v === stop.value) return { done: true, reason: 'path_equals' };
    }
    if (stop.when === 'path_missing' && outcome.document !== undefined && first(stop.path, outcome.document, ctx).length === 0) return { done: true, reason: 'path_missing' };
  }
  if (outcome.records === 0 && p.type !== 'cursor' && p.type !== 'next_link') return { done: true, reason: 'records_empty' };

  switch (p.type) {
    case 'page_param': {
      const step = typeof p.step === 'number' ? p.step : 1;
      return { done: false, param: { at: p.param as string, value: (p.start ?? 1) + state.pages * step } };
    }
    case 'offset': {
      const step = typeof p.step === 'number' ? state.pages * p.step : state.received;
      return { done: false, param: { at: p.param as string, value: (p.start ?? 0) + step } };
    }
    case 'cursor': {
      const raw = outcome.document === undefined || p.next_path === undefined ? undefined : first(p.next_path, outcome.document, ctx)[0];
      if (raw === undefined || raw === null || raw === '') return { done: true, reason: 'no_next' };
      const cursor = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
      if (cursor === undefined) return { done: true, reason: 'no_next' };
      if (state.seenCursors.has(cursor)) return { done: true, reason: 'repeated_cursor' };
      state.seenCursors.add(cursor);
      state.cursor = cursor;
      return { done: false, param: { at: p.param as string, value: cursor } };
    }
    case 'next_link': {
      const fromBody = outcome.document === undefined || p.next_path === undefined ? undefined : first(p.next_path, outcome.document, ctx)[0];
      const link = typeof fromBody === 'string' && fromBody !== '' ? fromBody : parseLinkNext(outcome.linkHeader);
      if (link === undefined) return { done: true, reason: 'no_next' };
      if (state.seenCursors.has(link)) return { done: true, reason: 'repeated_cursor' };
      state.seenCursors.add(link);
      return { done: false, nextUrl: link };
    }
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
