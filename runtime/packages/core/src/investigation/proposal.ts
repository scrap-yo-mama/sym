// SPDX-License-Identifier: AGPL-3.0-only
// Proposition de l'enquête (tâche 2.1, 04 §4, figure 1 étape C) : le LLM (rôle `investigate`) ne voit que les
// SQUELETTES des gisements (chemins et types, aucune valeur) et la demande ; il rend une liste fermée de champs et, par
// gisement, le chemin de chaque champ et une pagination simple. Le CODE en tire :
// - le schéma de SORTIE (JSON Schema 2020-12 d'un enregistrement), construit ici : aucun `$ref`, bornes fixes ;
// - une stratégie déclarative par gisement (04b §2), validée par `validateDeclarativeSpec` (JSONPath RFC 9535,
//   opérateurs de la liste fermée, `allowed_hosts`, aucun secret) ;
// - l'ÉCHANTILLON, extrait par l'interpréteur de 1.1b sur les données déjà capturées (aucune requête de plus) et validé
//   contre le schéma (INV1). Le LLM n'écrit jamais une valeur de l'échantillon.
// Fonctions pures, sans I/O.
import { extractRecords } from '../dsl/extract.js';
import type { BlobLocator } from '../dsl/blobs.js';
import { HARD_MAX_PAGES_LIMIT, validateDeclarativeSpec, type DeclarativeSpec, type PaginationSpec, type StopCondition } from '../dsl/spec.js';
import { assertSchemaAcceptable, DRAFT_2020_12, SchemaError, validateOutput } from '../schema/validator.js';
import { classValueOps, HTML_LIST_HARD_MAX_PAGES, type DomPagination, type DomSlot } from './dom.js';
import { JOIN_PARENT_SEGMENT, pathSegment, type DataCandidate, type ReconCapture } from './recon.js';

/** Types d'un champ proposé : scalaires, ou `array` (liste de chaînes : étiquettes, banc réel R10). */
export const PROPOSAL_FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array'] as const;
export type ProposalFieldType = (typeof PROPOSAL_FIELD_TYPES)[number];

/** Opérateurs sans paramètre que le LLM peut demander (sous-ensemble de la liste fermée de 04b §2). */
export const PROPOSAL_OPERATORS = ['trim', 'lower', 'upper', 'collapse_spaces', 'to_number', 'to_integer', 'to_boolean', 'parse_date', 'abs_url'] as const;

export const PROPOSAL_PAGINATION_TYPES = ['none', 'page_param', 'offset', 'cursor', 'next_link'] as const;

const FIELD_NAME = '^[a-z][a-z0-9_]{0,63}$';

/**
 * Schéma de la réponse structurée du rôle `investigate`. Toutes les propriétés sont requises (`null` pour l'absence) :
 * compatible avec la sortie structurée stricte des fournisseurs (S1).
 */
/** Couple (E, N) cité par le plan d'essais, avec les règles qui le demandent. */
const RULE_PLAN_COUPLE = {
  type: 'object',
  additionalProperties: false,
  required: ['execution', 'network', 'rule_refs'],
  properties: {
    execution: { type: 'string', maxLength: 32 },
    network: { type: 'string', maxLength: 32 },
    rule_refs: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 80 } },
  },
} as const;

export const INVESTIGATION_PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'sources'],
  properties: {
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'required', 'personal', 'description'],
        properties: {
          name: { type: 'string', pattern: FIELD_NAME },
          type: { enum: [...PROPOSAL_FIELD_TYPES] },
          required: { type: 'boolean' },
          /** Donnée personnelle (nom, e-mail, téléphone, identifiant de personne) : annotation `x-personal` (17 §6). */
          personal: { type: 'boolean' },
          /**
           * Lue par le modèle client : anglais (21 § 4.5), demandé par le prompt, jamais dans la langue du run. Aucun motif de
           * caractères : « Price (€) », « Person’s name » ou une clé française citée sont de l'anglais légitime, et une règle de style
           * ne doit pas faire échouer l'enquête. Seuls les noms (`FIELD_NAME`) et les clés JSON sont refusés hors contrat (M6).
           */
          description: { type: 'string', maxLength: 500 },
        },
      },
    },
    sources: {
      type: 'array',
      // Vide : aucun gisement ne sert les champs (page sans API ni blob) ; seules les voies agentiques restent.
      minItems: 0,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate', 'paths', 'pagination'],
        properties: {
          candidate: { type: 'string', pattern: '^c[0-9]{1,2}$' },
          paths: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field', 'path', 'ops'],
              properties: {
                field: { type: 'string', pattern: FIELD_NAME },
                path: { type: 'string', minLength: 1, maxLength: 300 },
                ops: { type: 'array', maxItems: 4, items: { enum: [...PROPOSAL_OPERATORS] } },
              },
            },
          },
          pagination: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'param', 'start', 'has_more_path', 'next_path'],
            properties: {
              type: { enum: [...PROPOSAL_PAGINATION_TYPES] },
              param: { type: ['string', 'null'], pattern: '^url\\.query\\.[A-Za-z0-9_.-]{1,64}$' },
              start: { type: ['integer', 'null'], minimum: 0, maximum: 1000 },
              has_more_path: { type: ['string', 'null'], maxLength: 300 },
              next_path: { type: ['string', 'null'], maxLength: 300 },
            },
          },
        },
      },
    },
    // Plan d'essais guidé par les règles (tâche 2.10, 18 §4.5) : couples (E, N) placés en tête ou exclus, chacun avec les
    // références `nom@version` des règles qui le demandent. Facultatifs : absents, l'ordre de 04 §3.3 s'applique. Le code
    // les filtre par l'ensemble autorisé (`applyRulePlan`) ; ils ne peuvent rien élargir.
    plan: { type: ['array', 'null'], maxItems: 24, items: RULE_PLAN_COUPLE },
    excluded: { type: ['array', 'null'], maxItems: 24, items: RULE_PLAN_COUPLE },
    // Ambiguïté réelle (lot A du CDC UX, `ambiguity.ts`) : facultatifs, `null` ou absents dans le cas général. Le code vérifie chaque
    // affirmation (existence, taille et champs de la liste ; noms absents du schéma) avant de poser la moindre question.
    unmatched_fields: { type: ['array', 'null'], maxItems: 8, items: { type: 'string', pattern: FIELD_NAME } },
    other_lists: { type: ['array', 'null'], maxItems: 4, items: { type: 'string', pattern: '^c[0-9]{1,2}$' } },
  },
} as const;

export type ProposalField = { readonly name: string; readonly type: ProposalFieldType; readonly required: boolean; readonly personal: boolean; readonly description: string };
export type ProposalPath = { readonly field: string; readonly path: string; readonly ops: readonly string[] };
export type ProposalPagination = {
  readonly type: (typeof PROPOSAL_PAGINATION_TYPES)[number];
  readonly param: string | null;
  readonly start: number | null;
  readonly has_more_path: string | null;
  readonly next_path: string | null;
};
export type ProposalSource = { readonly candidate: string; readonly paths: readonly ProposalPath[]; readonly pagination: ProposalPagination };
export type ProposalCouple = { readonly execution: string; readonly network: string; readonly rule_refs: readonly string[] };
export type InvestigationProposal = {
  readonly fields: readonly ProposalField[];
  readonly sources: readonly ProposalSource[];
  readonly plan?: readonly ProposalCouple[] | null;
  readonly excluded?: readonly ProposalCouple[] | null;
  /** Champs que la demande nomme et qu'aucun gisement ne porte (noms en snake_case) ; sert `requested_field_missing`. */
  readonly unmatched_fields?: readonly string[] | null;
  /** Autres gisements aussi pertinents pour la demande que ceux des sources ; sert `multiple_lists`. */
  readonly other_lists?: readonly string[] | null;
};

/** Plafond dur de pages d'une stratégie proposée (`hard_max_pages`, 04b §2). */
export const PROPOSAL_HARD_MAX_PAGES = 50;
/** Taille de l'échantillon montré avec le schéma proposé. */
export const SAMPLE_SIZE = 5;

/**
 * Schéma de sortie d'un enregistrement, construit par le code depuis la liste fermée des champs (le plus étroit : les
 * seuls champs proposés, `additionalProperties: false`) ; un champ personnel porte `x-personal` (masquage, 17 §6).
 */
export function outputSchemaOf(fields: readonly ProposalField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    properties[f.name] = { type: f.type, ...(f.type === 'array' ? { items: { type: 'string' }, maxItems: 200 } : {}), ...(f.description.trim() === '' ? {} : { description: f.description.trim().slice(0, 500) }), ...(f.personal ? { 'x-personal': true } : {}) };
  }
  return {
    $schema: DRAFT_2020_12,
    type: 'object',
    required: fields.filter((f) => f.required).map((f) => f.name),
    properties,
    additionalProperties: false,
  };
}

/** Champs requis et types d'un schéma de sortie validé par l'appelant (`validate_schema` avec correction). */
export function schemaFieldTypes(schema: unknown): Map<string, { type: string; required: boolean }> {
  const out = new Map<string, { type: string; required: boolean }>();
  const s = schema as { properties?: Record<string, { type?: unknown }>; required?: unknown };
  const required = new Set(Array.isArray(s?.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
  for (const [name, prop] of Object.entries(s?.properties ?? {})) {
    const t = Array.isArray(prop?.type) ? prop.type.find((x) => x !== 'null') : prop?.type;
    out.set(name, { type: typeof t === 'string' ? t : 'string', required: required.has(name) });
  }
  return out;
}

function stopsOf(p: ProposalPagination): StopCondition[] {
  const stop: StopCondition[] = [{ when: 'records_empty' }];
  if (p.has_more_path !== null && p.has_more_path !== '') stop.push({ when: 'path_equals', path: p.has_more_path, value: false });
  if (p.type === 'cursor' || p.type === 'next_link') stop.push({ when: 'repeated_cursor' });
  return stop;
}

/** Pagination déclarative (04b §2) : règles d'arrêt obligatoires, plafond dur, plafond d'entrée `input.max_pages`. */
function paginationOf(p: ProposalPagination): { pagination?: PaginationSpec; param?: string } {
  const limits = { max_pages_input: 'input.max_pages', hard_max_pages: PROPOSAL_HARD_MAX_PAGES };
  switch (p.type) {
    case 'none':
      return {};
    case 'page_param':
    case 'offset':
      if (p.param === null) return {};
      return {
        pagination: { type: p.type, param: p.param, start: p.start ?? (p.type === 'page_param' ? 1 : 0), ...(p.type === 'offset' ? { step: 'items_received' as const } : {}), stop: stopsOf(p), limits },
        param: p.param,
      };
    case 'cursor':
      if (p.param === null || p.next_path === null) return {};
      return { pagination: { type: 'cursor', param: p.param, next_path: p.next_path, stop: stopsOf(p), limits }, param: p.param };
    case 'next_link':
      return { pagination: { type: 'next_link', ...(p.next_path === null ? {} : { next_path: p.next_path }), stop: stopsOf(p), limits } };
  }
}

// ---------------------------------------------------------------------------------------------------- liste HTML (dom)

/** Premier nombre d'un texte (« 1 650 000 € », « 187.33 m² », « 3 chambres ») : I-Regexp, un seul quantificateur non borné. */
const FIRST_NUMBER = '[0-9][0-9 .,]*';
const slotNameOf = (path: string): string | null => /^\$\.([a-z][a-z0-9_]{0,63})$/.exec(path)?.[1] ?? /^\$\['([a-z][a-z0-9_]{0,63})'\]$/.exec(path)?.[1] ?? null;

/**
 * Champ d'une source `html` née d'un bloc du DOM : sous-sélecteur et attribut de l'emplacement (vérifiés par le code), puis
 * opérateurs fixés par le CODE selon le type et la forme : un nombre est lu par le premier nombre du texte (devise, unité,
 * astérisque ignorés) avec le séparateur décimal vu sur la page ; un lien ou une image devient une URL absolue (base : la
 * page) ; un code entre parenthèses perd ses parenthèses. Les opérateurs proposés par le LLM ne gardent que la casse et les
 * espaces (aucune conversion de sa main).
 */
function domField(slot: DomSlot, type: string, required: boolean, proposed: readonly string[], pageUrl: string): Record<string, unknown> {
  // Valeur en classe (« star-rating Three ») : opérateurs du code (classe voisine, table des mots-nombres), jamais du modèle.
  if (slot.classValue !== undefined) return { ...(slot.css === null ? {} : { css: slot.css }), attr: 'class', type, ...(required ? { required: true } : {}), ops: classValueOps(slot.classValue, type) };
  // Liste (étiquettes) : tous les éléments du sélecteur, chacun nettoyé.
  if (type === 'array') return { ...(slot.css === null ? {} : { css: slot.css }), attr: slot.attr, ...(slot.up === undefined ? {} : { up: slot.up }), type, reduce: 'all', ...(required ? { required: true } : {}), ops: ['collapse_spaces', 'trim'] };
  const ops: (string | Record<string, unknown>)[] = ['collapse_spaces', 'trim'];
  // Partie d'un texte composé (« À vendre Maison | Mougins », R13) : le code coupe au séparateur et retire le libellé de tête.
  if (slot.part !== undefined) ops.push(...partOps(slot.part));
  // Préfixe technique d'un identifiant (« carousel-APM-… », R13) : retiré par le code.
  if (slot.strip !== undefined) ops.push({ op: 'regex_extract', pattern: `${slot.strip}(.+)`, group: 1 });
  if (type === 'number' || type === 'integer') {
    // Surface : le nombre suivi de son unité (banc réel R02 : « Du studio au 4 pièces » d'un programme neuf lu « 4 m² »).
    const area = slot.shape.split('|')[0] === 'area';
    ops.push(area ? { op: 'regex_extract', pattern: `(${FIRST_NUMBER}) ?(m²|m2|ft²|ha)`, group: 1 } : { op: 'regex_extract', pattern: FIRST_NUMBER, group: 0 }, 'trim', { op: type === 'number' ? 'to_number' : 'to_integer', decimal: slot.decimal });
  } else if (type === 'boolean') {
    ops.push('to_boolean');
  } else {
    if (slot.attr === 'href' || slot.attr === 'src') ops.push({ op: 'abs_url', base: pageUrl });
    // Séparateur final de toutes les valeurs (« Hybrid — ») : la valeur s'arrête au dernier caractère qui n'en est pas un.
    else if (slot.trailing !== undefined) ops.push({ op: 'regex_extract', pattern: `(.*[^ ${/[-|^\\\]]/.test(slot.trailing) ? '\\' : ''}${slot.trailing}])`, group: 1 });
    else if (slot.shape.split('|')[0] === 'paren_code') ops.push({ op: 'regex_extract', pattern: '[^()]+', group: 0 }, 'trim');
    for (const op of proposed) if (op === 'lower' || op === 'upper') ops.push(op);
  }
  return { ...(slot.css === null ? {} : { css: slot.css }), attr: slot.attr, ...(slot.up === undefined ? {} : { up: slot.up }), type, ...(required ? { required: true } : {}), ops };
}

/** Opérateurs d'une partie de texte composé : I-Regexp, séparateur échappé, libellé de tête (lettres et espaces) retiré. */
function partOps(part: NonNullable<DomSlot['part']>): Record<string, unknown>[] {
  const sep = part.sep === '|' ? '\\|' : part.sep;
  const notSep = part.sep === '|' ? '[^\\|]+' : `[^${part.sep}]+`;
  const pattern = part.index === 1 ? `${sep}(.+)` : part.lead !== undefined ? `${part.lead} (${notSep})` : `(${notSep})`;
  return [{ op: 'regex_extract', pattern, group: 1 }, { op: 'trim' }];
}

/**
 * Pagination déclarative d'une liste HTML, détectée par le CODE (jamais proposée par le LLM) : numéro dans le chemin ou
 * paramètre de page, décalage, ou lien `rel=next`. Règles d'arrêt : page vide (`records_empty`), et dans l'exécuteur page
 * 404 ou page déjà vue (`no_next`) ; plafond dur `HTML_LIST_HARD_MAX_PAGES`.
 */
function domPaginationOf(p: DomPagination | null, size: { readonly counter?: number; readonly count?: number } = {}): { pagination?: PaginationSpec; param?: string } {
  if (p === null) return {};
  const limits = { max_pages_input: 'input.max_pages', hard_max_pages: hardMaxPagesFor(size.counter, size.count) };
  const next = 'next_url' in p && p.next_url !== undefined ? { next_url: p.next_url } : {};
  switch (p.type) {
    case 'page_param':
      return 'path_pattern' in p
        ? { pagination: { type: 'page_param', param: 'url.path', path_pattern: p.path_pattern, start: p.start, stop: [{ when: 'records_empty' }], limits }, param: 'url.path' }
        : { pagination: { type: 'page_param', param: p.param, start: p.start, ...next, stop: [{ when: 'records_empty' }], limits }, param: p.param };
    case 'offset':
      return { pagination: { type: 'offset', param: p.param, start: p.start, step: p.step, ...next, stop: [{ when: 'records_empty' }], limits }, param: p.param };
    case 'next_link':
      return { pagination: { type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits } };
  }
}

/**
 * Plafond dur de pages d'une liste HTML (04b §2) : `HTML_LIST_HARD_MAX_PAGES`, ou, quand la page affiche un compteur de
 * résultats (R13 : « 6197 annonces » à 24 par page), le nombre de pages qu'il annonce plus une marge, borné par le format.
 */
export function hardMaxPagesFor(counter: number | undefined, perPage: number | undefined): number {
  if (counter === undefined || perPage === undefined || perPage <= 0) return HTML_LIST_HARD_MAX_PAGES;
  return Math.min(HARD_MAX_PAGES_LIMIT, Math.max(HTML_LIST_HARD_MAX_PAGES, Math.ceil(counter / perPage) + 5));
}

/**
 * Stratégie déclarative `html` d'UNE page (compilée d'un essai E4) augmentée de la pagination détectée par le code sur cette
 * page (constat Janssens) : `request.params` déclare l'emplacement, `hard_max_pages` borne la liste ; revalidée (liste
 * fermée, INV10 : le motif de chemin ne change jamais l'hôte). `null` si la pagination ne s'applique pas à cette requête.
 */
export function paginateHtmlSpec(spec: DeclarativeSpec, detected: DomPagination, outputSchema: unknown): DeclarativeSpec | null {
  const { pagination, param } = domPaginationOf(detected);
  if (pagination === undefined) return null;
  const raw = {
    ...spec,
    request: { ...spec.request, params: [...(spec.request.params ?? []).filter((p) => p.role !== 'pagination'), ...(param === undefined ? [] : [{ at: param, role: 'pagination' as const }])] },
    pagination,
  };
  const check = validateDeclarativeSpec(raw, { outputSchema });
  return check.ok ? check.spec : null;
}

/**
 * Champs requis à relâcher pour un bloc du DOM (« required only when every record has the value ») : la page 1 ne dit pas
 * ce que montreront les suivantes (constat Janssens : surface sur les 10 cartes de la page 1, absente d'une carte de la page
 * 2). Ne reste requis qu'un champ relié à un emplacement présent sur TOUS les blocs et qui identifie l'enregistrement : le
 * lien, un attribut `data-*`, le titre (`h1`-`h6`). Un champ numérique sur une forme mêlée (« Prix : Nous consulter ») ne
 * l'est jamais. Le reste de la proposition est inchangé.
 */
function domRelaxedFields(proposal: InvestigationProposal, candidates: readonly DataCandidate[]): Set<string> {
  const relaxed = new Set<string>();
  for (const source of proposal.sources) {
    const candidate = candidates.find((c) => c.id === source.candidate);
    if (candidate?.dom === undefined) continue;
    for (const p of source.paths) {
      const name = slotNameOf(p.path);
      const slot = candidate.dom.slots.find((s) => s.name === name);
      const field = proposal.fields.find((f) => f.name === p.field);
      if (slot === undefined || field === undefined) continue;
      const numeric = field.type === 'number' || field.type === 'integer';
      const identifying = slot.attr === 'href' || slot.attr.startsWith('data-') || /^h[1-6](?![a-z0-9])/.test(slot.css ?? '') || (slot.attr === 'text' && /^h[1-6]$/.test(slot.tag ?? '') && slot.up === undefined);
      // Libellé constant de la page 1 (« In stock ») : une autre page peut dire autre chose ou rien ; jamais requis.
      if (slot.present < candidate.count || !identifying || slot.constant !== undefined || (numeric && slot.shape.includes('|'))) relaxed.add(field.name);
    }
  }
  return relaxed;
}

export type BuiltStrategy = {
  readonly candidate: DataCandidate;
  readonly spec: DeclarativeSpec;
  /** La stratégie pagine : un essai conforme doit atteindre la page 2 (sauf liste finie dès la page 1). */
  readonly paginated: boolean;
};

export type ProposalOutcome =
  | {
      readonly ok: true;
      readonly outputSchema: Record<string, unknown>;
      readonly strategies: readonly BuiltStrategy[];
      /** Enregistrements conformes extraits des données capturées (au plus `SAMPLE_SIZE`). */
      readonly sample: readonly Record<string, unknown>[];
      /** Gisements écartés (code stable, sans valeur). */
      readonly rejected: readonly { readonly candidate: string; readonly reason: string }[];
    }
  | { readonly ok: false; readonly reason: 'invalid_schema' | 'no_valid_source' | 'no_conformant_sample'; readonly rejected: readonly { readonly candidate: string; readonly reason: string }[] };

/** Champ d'un chemin virtuel du squelette (jointure, URL de fiche), `undefined` si le chemin n'en est pas un. */
export function virtualField(path: string, candidate: DataCandidate, type: string, required: boolean): Record<string, unknown> | undefined {
  const url = /^(.+)\^url$/.exec(path);
  if (url !== null) {
    const hit = candidate.urls?.find((u) => u.local === url[1]);
    return hit === undefined ? undefined : { path: hit.local, type, ...(required ? { required: true } : {}), ops: [{ op: 'url_template', template: hit.template }] };
  }
  const parent = path.indexOf(JOIN_PARENT_SEGMENT);
  const plain = parent === -1 ? path.lastIndexOf('~') : -1;
  const local = parent !== -1 ? path.slice(0, parent) : plain !== -1 ? path.slice(0, plain) : undefined;
  const take = parent !== -1 ? path.slice(parent + JOIN_PARENT_SEGMENT.length) : plain !== -1 ? path.slice(plain + 1) : undefined;
  if (local === undefined || take === undefined) return undefined;
  const join = candidate.joins?.find((j) => j.local === local);
  if (join === undefined || !(take in join.take) || (parent !== -1 && join.parent === undefined)) return undefined;
  return {
    join: { from: join.from, on: join.local, key: join.key, take: '$' + pathSegment(take), ...(parent !== -1 ? { parent: join.parent } : {}) },
    type,
    ...(required ? { required: true } : {}),
  };
}

/** Corps capturé d'un gisement : réponse JSON (`response`), document servi (`embedded`, `dom`) ou rendu (`dom` vu après rendu). */
export function capturedBody(candidate: DataCandidate, capture: ReconCapture): string | undefined {
  if (candidate.from === 'dom') return candidate.dom?.rendered === true ? (capture.document?.renderedHtml ?? undefined) : capture.document?.html;
  if (candidate.from === 'embedded') return capture.document?.html;
  return capture.exchanges.find((e) => e.url === candidate.request.url && e.method.toUpperCase() === candidate.request.method)?.body;
}

/**
 * Proposition → schéma de sortie, stratégies déclaratives par gisement et échantillon. `fixedSchema` : schéma validé
 * (et peut-être corrigé) par l'appelant, qui l'emporte sur les champs proposés (INV1 : c'est le contrat). Une source
 * dont la spécification est refusée ou qui ne rend aucun enregistrement conforme sur les données capturées est écartée.
 */
export function buildFromProposal(
  proposal: InvestigationProposal,
  candidates: readonly DataCandidate[],
  capture: ReconCapture | null,
  options: {
    readonly fixedSchema?: unknown;
    /** Voies agentiques disponibles (E4, E6) : un schéma sans gisement de données reste essayable par elles. */
    readonly agenticOnly?: boolean;
  } = {},
): ProposalOutcome {
  const rejected: { candidate: string; reason: string }[] = [];
  let outputSchema: Record<string, unknown>;
  let relaxed = new Set<string>();
  if (options.fixedSchema !== undefined) {
    try {
      assertSchemaAcceptable(options.fixedSchema);
    } catch (error) {
      if (error instanceof SchemaError) return { ok: false, reason: 'invalid_schema', rejected };
      throw error;
    }
    outputSchema = options.fixedSchema as Record<string, unknown>;
  } else {
    const names = new Set<string>();
    for (const f of proposal.fields) {
      if (names.has(f.name)) return { ok: false, reason: 'invalid_schema', rejected };
      names.add(f.name);
    }
    relaxed = domRelaxedFields(proposal, candidates);
    outputSchema = outputSchemaOf(proposal.fields.map((f) => (relaxed.has(f.name) ? { ...f, required: false } : f)));
    try {
      assertSchemaAcceptable(outputSchema);
    } catch (error) {
      if (error instanceof SchemaError) return { ok: false, reason: 'invalid_schema', rejected };
      throw error;
    }
  }
  const types = options.fixedSchema !== undefined ? schemaFieldTypes(outputSchema) : new Map(proposal.fields.map((f) => [f.name, { type: f.type, required: f.required && !relaxed.has(f.name) }]));
  const strategies: BuiltStrategy[] = [];
  let sample: Record<string, unknown>[] = [];
  for (const source of proposal.sources) {
    const candidate = candidates.find((c) => c.id === source.candidate);
    if (candidate === undefined) {
      rejected.push({ candidate: source.candidate, reason: 'unknown_candidate' });
      continue;
    }
    if (candidate.unsupported !== undefined) {
      rejected.push({ candidate: candidate.id, reason: candidate.unsupported });
      continue;
    }
    const fields: Record<string, unknown> = {};
    const dom = candidate.from === 'dom' ? candidate.dom : undefined;
    for (const p of source.paths) {
      const t = types.get(p.field);
      if (t === undefined) continue;
      if (dom !== undefined) {
        // Bloc du DOM : le chemin désigne un emplacement par son nom ; le code pose sélecteur, attribut et opérateurs.
        const slot = dom.slots.find((s) => s.name === slotNameOf(p.path));
        if (slot !== undefined) fields[p.field] = domField(slot, t.type, t.required, p.ops, candidate.request.url);
        continue;
      }
      // Chemin virtuel du squelette d'un gisement JSON : jointure vers un autre tableau de la réponse (`$.teamId~name`,
      // `$.teamId~parent~name`) ou URL de la fiche déduite des liens de la page (`$.id^url`) ; le code pose la jointure
      // (opérateur fermé) et le modèle d'URL (hôte déjà dans allowed_hosts), jamais le LLM.
      const virtual = candidate.from === 'response' ? virtualField(p.path, candidate, t.type, t.required) : undefined;
      if (virtual !== undefined) {
        fields[p.field] = virtual;
        continue;
      }
      // Liste lue par un joker (`$.tags[*]`) : toutes les valeurs ; par la clé du tableau (`$.tags`) : le tableau lui-même.
      fields[p.field] = { path: p.path, type: t.type, ...(t.type === 'array' && /\[\*\]$/.test(p.path) ? { reduce: 'all' } : {}), ...(t.required ? { required: true } : {}), ...(p.ops.length === 0 ? {} : { ops: [...p.ops] }) };
    }
    if (dom !== undefined && Object.keys(fields).length === 0) {
      rejected.push({ candidate: candidate.id, reason: 'no_known_slot' });
      continue;
    }
    const { pagination, param } = dom !== undefined ? domPaginationOf(dom.pagination, { ...(candidate.counter === undefined ? {} : { counter: candidate.counter }), count: candidate.count }) : paginationOf(source.pagination);
    const request: Record<string, unknown> = {
      method: candidate.request.method,
      url: candidate.request.url,
      allowed_hosts: [candidate.host],
      ...(candidate.request.body_json === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: { json: candidate.request.body_json } }),
      ...(param === undefined ? {} : { params: [{ at: param, role: 'pagination' }] }),
    };
    const sourceSpec: Record<string, unknown> =
      candidate.from === 'response'
        ? { id: 'api', from: 'response', format: 'json', records: candidate.records }
        : candidate.from === 'dom'
          ? { id: 'page', from: 'html', records: candidate.records }
          : { id: 'ssr', from: 'embedded', locator: candidate.locator as BlobLocator, records: candidate.records };
    const raw = {
      schema_version: 1,
      kind: 'declarative',
      request,
      sources: [sourceSpec],
      fields,
      ...(pagination === undefined ? {} : { pagination }),
      limits: { max_response_bytes: 5_000_000, timeout_ms: 15_000 },
    };
    const check = validateDeclarativeSpec(raw, { outputSchema });
    if (!check.ok) {
      rejected.push({ candidate: candidate.id, reason: `invalid_spec:${check.errors[0]?.code ?? 'unknown'}` });
      continue;
    }
    // Échantillon : l'interpréteur sur les données déjà capturées, validé contre le schéma (INV1).
    const body = capture === null ? undefined : capturedBody(candidate, capture);
    if (body !== undefined) {
      let extracted: ReturnType<typeof extractRecords>;
      try {
        extracted = extractRecords(check.spec, { body }, { outputSchema });
      } catch {
        rejected.push({ candidate: candidate.id, reason: 'extraction_failed' });
        continue;
      }
      const conform = extracted.records.filter((r) => validateOutput(outputSchema, r).ok);
      if (!extracted.ok || conform.length === 0) {
        rejected.push({ candidate: candidate.id, reason: 'no_conformant_record' });
        continue;
      }
      if (sample.length === 0) sample = conform.slice(0, SAMPLE_SIZE);
    }
    strategies.push({ candidate, spec: check.spec, paginated: pagination !== undefined });
  }
  if (strategies.length === 0 && options.agenticOnly === true) return { ok: true, outputSchema, strategies, sample: [], rejected };
  if (strategies.length === 0) return { ok: false, reason: rejected.some((r) => r.reason === 'no_conformant_record') ? 'no_conformant_sample' : 'no_valid_source', rejected };
  if (capture !== null && sample.length === 0) return { ok: false, reason: 'no_conformant_sample', rejected };
  return { ok: true, outputSchema, strategies, sample, rejected };
}

/** Lecture défensive de la réponse du LLM (déjà validée par la couche LLM contre `INVESTIGATION_PROPOSAL_SCHEMA`). */
export function parseProposal(value: unknown): InvestigationProposal | null {
  const v = value as Partial<InvestigationProposal> | null;
  if (v === null || typeof v !== 'object' || !Array.isArray(v.fields) || !Array.isArray(v.sources)) return null;
  return v as InvestigationProposal;
}
