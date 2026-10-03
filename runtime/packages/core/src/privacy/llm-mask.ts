// SPDX-License-Identifier: AGPL-3.0-only
// Masquage en couches avant tout envoi à un LLM (tâche 2.12, 19 §3, 08 §1, r4 R12, R14, R17) : `investigate`, `repair`,
// `judge`, `reflect`, agent d'étape (retours et mémoire qu'il reçoit) et mémoire du catalogue. TOUJOURS appliqué, que
// `llm.redact` soit actif ou non :
//   (1) par schéma : chaque valeur sous un nœud `x-personal` devient un placeholder indexé (`[personal_N]`, même valeur
//       → même index dans un appel), et la valeur est inscrite au registre de l'appel pour masquer aussi le texte libre ;
//   (2) par motifs écrits en TypeScript : e-mail (`%40` compris), téléphone français et E.164, IBAN (clé mod 97), carte
//       (Luhn), IPv4 et IPv6, URL de profil (réseaux sociaux, forges), NIR.
// Jamais appliqué aux champs cibles de l'E4 (l'extraction doit lire la page). La NER locale (couche 3) est en V1.1. Aucune
// promesse « données anonymisées » : le rappel par type est mesuré sur un corpus et publié (rappel-masquage.md).
import { PersonalValueRegistry } from './mask.js';

export const LLM_MASK_TYPES = ['email', 'phone', 'iban', 'card', 'ip', 'profile_url', 'nir'] as const;
export type LlmMaskType = (typeof LLM_MASK_TYPES)[number];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const ipv4Valid = (ip: string) => ip.split('.').every((o) => Number(o) <= 255 && !/^0\d/.test(o));

type Rule = { readonly type: LlmMaskType; readonly re: RegExp; readonly accept?: (match: string) => boolean };

// Ordre : les motifs les plus longs et les plus spécifiques d'abord (une URL de profil avant une adresse, un IBAN, une
// carte et un NIR avant un téléphone, qui en mangerait les chiffres).
const RULES: readonly Rule[] = [
  { type: 'profile_url', re: /\bhttps?:\/\/(?:[a-z0-9-]+\.)?(?:linkedin\.com\/(?:in|pub)|facebook\.com|fb\.com|x\.com|twitter\.com|instagram\.com|github\.com|gitlab\.com|tiktok\.com\/@|youtube\.com\/@|mastodon\.[a-z.]+\/@|threads\.net\/@)[^\s"'<>)]*/gi },
  { type: 'email', re: /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { type: 'iban', re: /\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{4}){2,7}(?:[ -]?[A-Za-z0-9]{1,4})?\b/g, accept: ibanValid },
  { type: 'nir', re: /(?<![\w+])[12][ .]?\d{2}[ .]?(?:0[1-9]|1[0-2]|[2-9]\d)[ .]?(?:\d{2}|2[AB])[ .]?\d{3}[ .]?\d{3}[ .]?\d{2}(?![\w])/g },
  { type: 'card', re: /(?<![\w+])\d(?:[ -]?\d){12,18}(?![\w])/g, accept: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'ip', re: /(?<![\w.:])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, accept: ipv4Valid },
  { type: 'ip', re: /(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}(?::|(?::[0-9a-f]{1,4}){1,7}|[0-9a-f]{1,4})(?![\w:])/gi, accept: (m) => m.includes('::') || m.split(':').length === 8 },
  { type: 'phone', re: /(?<![\w+])(?:\+|00)\d{1,3}[\d ().-]{6,16}\d(?!\w)/g },
  { type: 'phone', re: /(?<![\w.-])0[1-9](?:[ .-]?\d{2}){4}(?![\w-])/g },
  { type: 'phone', re: /(?<![\w.-])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/g },
];

/** Couche 2 : motifs, avec (optionnellement) le registre des valeurs `x-personal` de l'appel. */
export function maskTextForLlm(text: string, registry?: PersonalValueRegistry): string {
  let out = registry === undefined ? text : registry.maskText(text).replace(/\[PERSONAL\]/g, '[personal]');
  for (const rule of RULES) out = out.replace(rule.re, (m) => (rule.accept === undefined || rule.accept(m) ? `[${rule.type}]` : m));
  return out;
}

/** Texte libre d'un retour de l'utilisateur (`reflect`, mémoire, agent d'étape) : couches 1 (registre) et 2. */
export function maskFeedbackForLlm(text: string, registry?: PersonalValueRegistry): string {
  return maskTextForLlm(text, registry);
}

type Personal = { readonly registry: PersonalValueRegistry; readonly index: Map<string, number> };

function personalNode(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const flag = schema['x-personal'];
  return flag === true || (typeof flag === 'string' && flag !== '' && flag !== 'false');
}

function placeholder(value: unknown, state: Personal): unknown {
  if (value === null || value === undefined) return value;
  const key = typeof value === 'string' ? value.trim().toLowerCase() : JSON.stringify(value);
  if (typeof value === 'string') state.registry.add(value);
  let n = state.index.get(key);
  if (n === undefined) {
    n = state.index.size + 1;
    state.index.set(key, n);
  }
  return `[personal_${n}]`;
}

function walk(schema: unknown, value: unknown, state: Personal, depth: number): unknown {
  if (depth > 32) return null;
  if (personalNode(schema)) return placeholder(value, state);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => walk(isRecord(schema) ? schema['items'] : undefined, v, state, depth + 1));
  if (isRecord(value)) {
    const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(props[k], v, state, depth + 1)]));
  }
  return value;
}

function patterns(value: unknown, registry: PersonalValueRegistry): unknown {
  if (typeof value === 'string') return /^\[personal_\d+\]$/.test(value) ? value : maskTextForLlm(value, registry);
  if (Array.isArray(value)) return value.map((v) => patterns(v, registry));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, patterns(v, registry)]));
  return value;
}

export type MaskedItems<T> = { readonly items: T[]; readonly placeholders: number; readonly registry: PersonalValueRegistry };

/**
 * Couches 1 et 2 sur des items : placeholders indexés pour `x-personal` (dans l'ordre de première apparition), puis
 * motifs sur toute chaîne restante, y compris les valeurs `x-personal` déjà vues réapparues dans un champ libre.
 */
export function maskItemsForLlm<T = Record<string, unknown>>(items: readonly unknown[], schema: unknown, registry = new PersonalValueRegistry()): MaskedItems<T> {
  const state: Personal = { registry, index: new Map() };
  const first = items.map((item) => walk(schema, item, state, 0));
  return { items: first.map((item) => patterns(item, registry)) as T[], placeholders: state.index.size, registry };
}
