// SPDX-License-Identifier: AGPL-3.0-only
// Format des fichiers de règles, de consignes et de skills (tâche 2.10, 18 §4.1) : Markdown UTF-8, en-tête YAML
// obligatoire, 20 000 caractères au plus (à valider). L'en-tête suit une grammaire FERMÉE (sous-ensemble de YAML : paires
// `clé: valeur`, listes en ligne `["a", "b"]` ou en bloc `- a`), sans dépendance : aucun code n'est exécuté depuis un
// fichier, aucune clé inconnue n'est admise. Empreinte `sha256` sur le fichier normalisé (LF, sans BOM).
import { createHash } from 'node:crypto';
import { normalizeHost } from './glob.js';

/** Taille maximale d'un fichier (18 §4.1, « à valider »). */
export const RULE_MAX_CHARS = 20_000;
export const RULE_DESCRIPTION_MAX = 500;
export const RULE_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const RULE_KINDS = ['instance', 'rule', 'skill'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** Slug d'API visé par `api:<slug>` (même alphabet que les slugs d'API). */
const API_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
/** Libellé de domaine après normalisation (punycode compris). */
const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const KEYS = new Set(['name', 'description', 'kind', 'applies_to', 'version']);

export type RuleDocument = {
  readonly name: string;
  readonly description: string;
  readonly kind: RuleKind;
  /** Globs de domaine normalisés (`*`, `*.x`, `x`) et sélecteurs `api:<slug>`. */
  readonly applies_to: readonly string[];
  /** Version fournie par l'appelant (contrôle de conflit) ; `null` si absente. */
  readonly version: number | null;
  readonly body: string;
  /** Fichier complet normalisé (LF, sans BOM). */
  readonly content: string;
  readonly sha256: string;
};

export class RuleFormatError extends Error {
  readonly code = 'invalid_rule' as const;
  readonly detail: string;
  constructor(detail: string) {
    super(`règle invalide : ${detail}`);
    this.name = 'RuleFormatError';
    this.detail = detail;
  }
}

/** Fichier normalisé : BOM retiré, fins de ligne LF. */
export function normalizeRuleContent(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function ruleSha256(content: string): string {
  return createHash('sha256').update(normalizeRuleContent(content), 'utf8').digest('hex');
}

/** Sélecteur `api:<slug>` ou glob de domaine. */
export type RuleSelector = { readonly kind: 'api'; readonly slug: string } | { readonly kind: 'domain'; readonly glob: string };

/** Lit un sélecteur de `applies_to` ; glob normalisé (minuscules, punycode). Lève `RuleFormatError`. */
export function parseSelector(raw: string): RuleSelector {
  const value = raw.trim();
  if (value.startsWith('api:')) {
    const slug = value.slice(4);
    if (!API_SLUG_RE.test(slug)) throw new RuleFormatError(`applies_to : slug d’API invalide (${slug.slice(0, 64)})`);
    return { kind: 'api', slug };
  }
  if (value === '*') return { kind: 'domain', glob: '*' };
  const wildcard = value.startsWith('*.');
  const host = normalizeHost(wildcard ? value.slice(2) : value);
  if (host === null || host.includes('*') || !host.includes('.') || !host.split('.').every((l) => LABEL_RE.test(l))) {
    throw new RuleFormatError(`applies_to : glob de domaine invalide (${value.slice(0, 64)})`);
  }
  return { kind: 'domain', glob: wildcard ? `*.${host}` : host };
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v) as string;
      } catch {
        throw new RuleFormatError('chaîne entre guillemets illisible');
      }
    }
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function inlineList(raw: string): string[] {
  const v = raw.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) throw new RuleFormatError('liste attendue');
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  const out: string[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,"'\s][^,]*?)\s*(?:,|$)/gy;
  let consumed = 0;
  for (const m of inner.matchAll(re)) {
    out.push(unquote(m[1]!));
    consumed = (m.index ?? 0) + m[0].length;
  }
  if (consumed !== inner.length) throw new RuleFormatError('liste illisible');
  return out;
}

/** En-tête : paires clé-valeur d'une grammaire fermée. */
function parseHeader(lines: readonly string[]): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  let listKey: string | null = null;
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item !== null) {
      if (listKey === null) throw new RuleFormatError('élément de liste hors d’une clé');
      (out.get(listKey) as string[]).push(unquote(item[1]!));
      continue;
    }
    const pair = /^([a-z_]+):(?:\s+(.*))?$/.exec(line);
    if (pair === null) throw new RuleFormatError('ligne d’en-tête illisible');
    const key = pair[1]!;
    if (!KEYS.has(key)) throw new RuleFormatError(`champ inconnu : ${key}`);
    if (out.has(key)) throw new RuleFormatError(`champ répété : ${key}`);
    const value = (pair[2] ?? '').trim();
    if (value === '') {
      out.set(key, []);
      listKey = key;
    } else {
      out.set(key, value.startsWith('[') ? inlineList(value) : unquote(value));
      listKey = null;
    }
  }
  return out;
}

/** Lit et valide un fichier de règle (18 §4.1). Lève `RuleFormatError` (`invalid_rule`). */
export function parseRuleFile(text: string): RuleDocument {
  if (typeof text !== 'string') throw new RuleFormatError('texte attendu');
  const content = normalizeRuleContent(text);
  if (content.length > RULE_MAX_CHARS) throw new RuleFormatError(`fichier de plus de ${RULE_MAX_CHARS} caractères`);
  const lines = content.split('\n');
  if (lines[0] !== '---') throw new RuleFormatError('en-tête YAML obligatoire (première ligne « --- »)');
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new RuleFormatError('en-tête YAML non fermé');
  const header = parseHeader(lines.slice(1, end));
  const str = (key: string): string => {
    const v = header.get(key);
    if (typeof v !== 'string') throw new RuleFormatError(`${key} : texte attendu`);
    return v;
  };
  const name = str('name');
  if (!RULE_NAME_RE.test(name)) throw new RuleFormatError('name : slug [a-z0-9-]{1,64} attendu');
  const description = str('description');
  if (description.trim() === '' || description.length > RULE_DESCRIPTION_MAX) throw new RuleFormatError(`description : 1 à ${RULE_DESCRIPTION_MAX} caractères`);
  const kind = str('kind');
  if (!(RULE_KINDS as readonly string[]).includes(kind)) throw new RuleFormatError('kind : instance, rule ou skill');
  const rawApplies = header.get('applies_to');
  let applies: string[] = [];
  if (kind === 'instance') {
    if (rawApplies !== undefined) throw new RuleFormatError('applies_to interdit pour kind: instance');
  } else {
    if (!Array.isArray(rawApplies) || rawApplies.length === 0 || rawApplies.length > 32) throw new RuleFormatError('applies_to : liste de 1 à 32 sélecteurs obligatoire');
    applies = rawApplies.map((s) => {
      const sel = parseSelector(s);
      return sel.kind === 'api' ? `api:${sel.slug}` : sel.glob;
    });
  }
  let version: number | null = null;
  const rawVersion = header.get('version');
  if (rawVersion !== undefined) {
    if (typeof rawVersion !== 'string' || !/^[1-9][0-9]{0,8}$/.test(rawVersion)) throw new RuleFormatError('version : entier positif attendu');
    version = Number(rawVersion);
  }
  const body = lines.slice(end + 1).join('\n');
  return { name, description, kind: kind as RuleKind, applies_to: [...new Set(applies)], version, body, content, sha256: ruleSha256(content) };
}

/**
 * Forme canonique d'un fichier (comparaison de quasi-copies, 18 §4.9) : en-tête sans `version`, sélecteurs triés, espaces
 * et lignes vides du corps et de la description sans effet. Sert à refuser la recopie d'une proposition en attente avec
 * un octet changé. Contrôle de 2.10, à reprendre par 2.11 et 3.13 (marquage en base des versions dérivées d'une proposition).
 */
export function ruleCanonical(content: string): string {
  const d = parseRuleFile(content);
  const squash = (s: string) => s.trim().replace(/\s+/g, ' ');
  const body = d.body
    .split('\n')
    .map(squash)
    .filter((l) => l !== '')
    .join('\n');
  return JSON.stringify({ name: d.name, kind: d.kind, description: squash(d.description), applies_to: [...d.applies_to].sort(), body });
}
