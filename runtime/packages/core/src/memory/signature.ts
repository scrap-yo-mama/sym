// SPDX-License-Identifier: AGPL-3.0-only
// Signature d'une version de stratégie (tâche 2.12, 19 §2, r1 R10) : calculée par le code à la reconnaissance, SANS LLM
// et sans aucun texte du site. Domaine enregistrable, techno, types JSON-LD, gabarit d'URL (noms de paramètres, segments
// variables remplacés), profil de balises haché, forme du schéma hachée, couple retenu, pagination. Pour le re-classement
// structurel (r1 R11), la signature garde aussi les pq-grammes de la séquence de balises et les classes CSS, HACHÉS
// (8 caractères hexadécimaux chacun) : ni nom de classe ni texte en clair.
import { createHash } from 'node:crypto';
import type { Execution, Network } from '../model/index.js';
import { registrableDomain } from '../pacing/domain.js';
import { cssClassTokens, pqGrams, tagSequence } from './pqgram.js';

export type StrategySignature = {
  readonly registrable_domain: string;
  readonly tech: readonly string[];
  readonly jsonld_types: readonly string[];
  readonly url_template: string;
  readonly tag_profile_sha256: string;
  readonly schema_shape_sha256: string;
  /** `E1/N1` … `E6/N4` (04 §2). */
  readonly couple: string;
  readonly pagination: string;
  /** pq-grammes hachés de la séquence de balises (re-classement structurel, r1 R11). */
  readonly tag_grams: readonly string[];
  /** Classes CSS hachées. */
  readonly class_tokens: readonly string[];
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const E: Readonly<Record<Execution, string>> = { fetch: 'E1', fetch_in_page: 'E2', playwright: 'E3', agent_fetch: 'E4', hybrid: 'E5', agent: 'E6' };
const N: Readonly<Record<Network, string>> = { direct: 'N1', dc_proxy: 'N2', res_proxy: 'N3', tunnel: 'N4' };

/** `E1/N1` : couple (exécution, réseau) de 04 §2. */
export function coupleOf(execution: Execution, network: Network): string {
  return `${E[execution] ?? 'E?'}/${N[network] ?? 'N?'}`;
}

const ID_SEGMENT = /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{24,})$/i;

/** Changements de casse dans un segment de lettres : au-delà de 3 sur 12 caractères ou plus, jeton probable. */
const caseFlips = (seg: string): number => {
  let flips = 0;
  for (let i = 1; i < seg.length; i += 1) {
    const a = seg[i - 1]!;
    const b = seg[i]!;
    if (/[a-z]/.test(a) && /[A-Z]/.test(b)) flips += 1;
    else if (/[A-Z]/.test(a) && /[a-z]/.test(b) && i > 1) flips += 1;
  }
  return flips;
};

/**
 * Segment de chemin qui peut porter une valeur (identifiant, nom d'utilisateur, jeton court) : un chiffre (hors segment
 * tout numérique, `{n}`), un point (`jean.dupont`), ou une forte entropie (12 caractères ou plus, casses alternées).
 * Revue 2.12 : un gabarit montré pour un autre domaine ne garde que des mots de route.
 */
const VALUE_LIKE = (seg: string): boolean => /\d/.test(seg) || seg.includes('.') || (seg.length >= 12 && caseFlips(seg) >= 3);

/**
 * Gabarit d'URL : origine et chemin, segments numériques remplacés par `{n}`, identifiants longs (hex, UUID, jetons) par
 * `{id}`, segments d'allure de valeur (chiffre, point, forte entropie) ou hors alphabet par `{s}`, valeur de chaque
 * paramètre de requête par `{nom}` ; aucun fragment ni identifiant d'URL. Une URL illisible donne une chaîne vide.
 */
export function urlTemplate(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const path = u.pathname
    .split('/')
    .map((seg) => (seg === '' ? seg : /^\d+$/.test(seg) ? '{n}' : ID_SEGMENT.test(seg) ? '{id}' : /^[A-Za-z0-9_~-]{1,64}$/.test(seg) && !VALUE_LIKE(seg) ? seg : '{s}'))
    .join('/');
  const names = [...new Set([...u.searchParams.keys()])].filter((k) => /^[A-Za-z0-9_.[\]-]{1,64}$/.test(k));
  const query = names.map((k) => `${k}={${k}}`).join('&');
  return `${u.protocol}//${u.host}${path}${query === '' ? '' : `?${query}`}`;
}

/** Technos reconnues par marqueurs du document (sans lire de texte). */
function techOf(html: string): string[] {
  const out = new Set<string>();
  if (/id=["']__NEXT_DATA__["']|\/_next\/static\//.test(html)) out.add('nextjs');
  if (/window\.__NUXT__|\/_nuxt\//.test(html)) out.add('nuxt');
  if (/ng-version=|ng-app/.test(html)) out.add('angular');
  if (/data-reactroot|__REACT_DEVTOOLS/.test(html)) out.add('react');
  if (/wp-content\/|wp-json/.test(html)) out.add('wordpress');
  if (/cdn\.shopify\.com|Shopify\.theme/.test(html)) out.add('shopify');
  if (/window\.__APOLLO_STATE__/.test(html)) out.add('apollo');
  return [...out].sort();
}

/** Types JSON-LD (`@type`) des blocs `application/ld+json` : noms validés, jamais d'autre valeur. */
function jsonLdTypes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of (m[1] ?? '').matchAll(/"@type"\s*:\s*"([A-Za-z]{1,40})"/g)) out.add(t[1]!);
  }
  return [...out].sort().slice(0, 10);
}

/** Forme du schéma : chemins et types, sans description, titre ni exemple. */
export function schemaShape(schema: unknown, prefix = '$'): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const type = Array.isArray(node['type']) ? (node['type'] as unknown[]).join('|') : String(node['type'] ?? 'any');
  const out = [`${prefix}:${type}`];
  const props = node['properties'];
  if (typeof props === 'object' && props !== null) for (const [k, v] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) out.push(...schemaShape(v, `${prefix}.${k}`));
  if (node['items'] !== undefined) out.push(...schemaShape(node['items'], `${prefix}[]`));
  return out;
}

export type SignatureInput = {
  readonly pageUrl: string;
  readonly requestUrl?: string | null;
  readonly html?: string | null;
  readonly outputSchema: unknown;
  readonly execution: Execution;
  readonly network: Network;
  readonly pagination?: string | null;
};

export function computeSignature(input: SignatureInput): StrategySignature {
  const html = input.html ?? '';
  const tags = tagSequence(html);
  let domain: string;
  try {
    domain = registrableDomain(input.pageUrl);
  } catch {
    domain = '';
  }
  return {
    registrable_domain: domain,
    tech: techOf(html),
    jsonld_types: jsonLdTypes(html),
    url_template: urlTemplate(input.requestUrl ?? input.pageUrl),
    tag_profile_sha256: sha256(tags.join('>')),
    schema_shape_sha256: sha256(schemaShape(input.outputSchema).join('\n')),
    couple: coupleOf(input.execution, input.network),
    pagination: input.pagination ?? 'none',
    tag_grams: pqGrams(tags).slice(0, 512),
    class_tokens: cssClassTokens(html).slice(0, 256),
  };
}
