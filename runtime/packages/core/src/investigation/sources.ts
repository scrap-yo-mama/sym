// SPDX-License-Identifier: AGPL-3.0-only
// Sources candidates de l'enquête montrées au CLIENT (D-124, cdc/scrapyomama-ux/03-specs-mcp.md §9 bis) : pour chaque
// gisement de la reconnaissance, un identifiant stable (`source_id`, celui du gisement), son type (DOM répété, JSON, XHR,
// blob), son nombre d'éléments, un aperçu de 3 éléments, la pagination détectée, le compteur affiché par le site et son rôle
// (liste de résultats, carrousel). Le CLIENT et l'utilisateur lisent l'aperçu (comme l'échantillon du schéma proposé) ; il
// n'entre JAMAIS dans un prompt du LLM d'enquête (08 §4, 17 §6). Aperçu borné : 3 éléments, 6 champs, 120 caractères par
// valeur ; une adresse e-mail ou un numéro de téléphone est masqué. Fonctions pures, sans I/O.
import type { Element } from 'domhandler';
import { elementText, parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS, parseJsonBounded } from '../dsl/limits.js';
import { queryValues } from '../dsl/jsonpath.js';
import type { DomPagination } from './dom.js';
import { narrativeUrl } from './events.js';
import { capturedBody } from './proposal.js';
import type { DataCandidate, ReconCapture } from './recon.js';

export const SOURCE_PREVIEW_ITEMS = 3;
const PREVIEW_FIELDS = 6;
const PREVIEW_CHARS = 120;

export type SourceKind = 'dom' | 'json' | 'xhr' | 'blob';
export type SourcePreviewValue = string | number | boolean | null;

/** Vue d'une source candidate dans l'événement `reconnaissance.finished` (REST, MCP, console). */
export type SourceView = {
  readonly source_id: string;
  readonly type: SourceKind;
  readonly count: number;
  readonly preview: readonly Readonly<Record<string, SourcePreviewValue>>[];
  /** Pagination détectée par le code : type, paramètre, pas, URL des pages suivantes (sans requête ni fragment). */
  readonly pagination: { readonly type: string; readonly param?: string; readonly step?: number; readonly next_url?: string } | null;
  /** Compteur de résultats affiché par la page (« 6197 annonces »), sinon `null`. */
  readonly counter: number | null;
  /** Rôle lu par le code : liste de résultats, carrousel (pénalisé), ou `null`. */
  readonly role: 'results' | 'carousel' | null;
};

const EMAIL = /[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}/;
const PHONE = /^\+?[\d\s().-]{9,20}$/;

function previewValue(value: unknown): SourcePreviewValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  if (EMAIL.test(text) || (PHONE.test(text) && text.replace(/\D/g, '').length >= 9)) return '[masqué]';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

function domPreview(candidate: DataCandidate, body: string): Record<string, SourcePreviewValue>[] {
  const slots = candidate.dom?.slots.filter((s) => s.part === undefined && s.up === undefined).slice(0, PREVIEW_FIELDS) ?? [];
  let blocks: Element[];
  try {
    blocks = selectElements(candidate.records, parseHtml(body, DEFAULT_DSL_LIMITS), 10_000);
  } catch {
    return [];
  }
  return blocks.slice(0, SOURCE_PREVIEW_ITEMS).map((block) => {
    const out: Record<string, SourcePreviewValue> = {};
    for (const slot of slots) {
      let el: Element | undefined;
      try {
        el = slot.css === null ? block : selectElements(slot.css, block, 1_000)[0];
      } catch {
        el = undefined;
      }
      if (el === undefined) continue;
      const raw = slot.attr === 'text' ? elementText(el, 10_000) : (el.attribs[slot.attr] ?? '');
      const value = previewValue(raw);
      if (value !== undefined) out[slot.name] = value;
    }
    return out;
  });
}

function jsonPreview(candidate: DataCandidate, body: string): Record<string, SourcePreviewValue>[] {
  try {
    const records = queryValues(candidate.records, parseJsonBounded(body, DEFAULT_DSL_LIMITS), { limits: DEFAULT_DSL_LIMITS }).slice(0, SOURCE_PREVIEW_ITEMS);
    return records.map((record) => {
      const out: Record<string, SourcePreviewValue> = {};
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return out;
      for (const [key, raw] of Object.entries(record as Record<string, unknown>)) {
        if (Object.keys(out).length >= PREVIEW_FIELDS) break;
        if (!/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(key)) continue;
        const value = previewValue(raw);
        if (value !== undefined) out[key] = value;
      }
      return out;
    });
  } catch {
    return [];
  }
}

function paginationView(p: DomPagination | null | undefined): SourceView['pagination'] {
  if (p === null || p === undefined) return null;
  return {
    type: p.type,
    ...('param' in p ? { param: p.param } : {}),
    ...('step' in p ? { step: p.step } : {}),
    ...('next_url' in p && p.next_url !== undefined ? { next_url: narrativeUrl(p.next_url) } : {}),
  };
}

/** Vues des sources candidates d'une reconnaissance (D-124), dans l'ordre des gisements. */
export function sourceViews(candidates: readonly DataCandidate[], capture: ReconCapture | null): SourceView[] {
  return candidates.map((c) => {
    const body = capture === null ? undefined : (c.from === 'embedded' ? undefined : capturedBody(c, capture));
    const preview = body === undefined ? [] : c.from === 'dom' ? domPreview(c, body) : jsonPreview(c, body);
    return {
      source_id: c.id,
      type: c.from === 'dom' ? 'dom' : c.from === 'embedded' ? 'blob' : capture?.mode === 'browser' ? 'xhr' : 'json',
      count: c.count,
      preview,
      pagination: paginationView(c.dom?.pagination),
      counter: c.counter ?? null,
      role: c.dom?.hints?.carousel === true ? 'carousel' : c.dom?.hints?.results === true ? 'results' : null,
    };
  });
}
