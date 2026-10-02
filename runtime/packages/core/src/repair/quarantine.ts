// SPDX-License-Identifier: AGPL-3.0-only
// Items non conformes écartés (D-49, tâche 2.3, 04 §5, 04b §1) : Ajv valide CHAQUE item contre `output_schema`. Un item
// non conforme n'est jamais livré (INV1 : tout ce qui est livré est conforme) ; il est compté et mis en quarantaine :
// raisons sans valeur (mot-clé Ajv, pointeur de l'instance, nombre), échantillon de 5 items au plus, nettoyé avant
// l'écriture (propriétés non déclarées retirées, valeurs des chemins en erreur masquées, puis couches 1 et 2 de 19 §3 :
// champs `x-personal` et motifs). La casse (classe `extraction`, réparation) n'intervient que si 0 item n'est conforme, ou
// si la part rejetée dépasse `ITEMS_REJECTED_MAX_SHARE` ET que le nombre rejeté atteint `ITEMS_REJECTED_MIN_COUNT`
// (double condition « seuil relatif et plancher absolu », valeurs à valider, 14 §2). Fonctions pures, sans I/O.
import { maskPersonal, PersonalValueRegistry } from '../privacy/mask.js';
import { extractPersonalValues } from '../privacy/subject.js';
import { compileSchema } from '../schema/validator.js';

/** Seuils de casse (14 §2, D-49, **à valider**) et taille de l'échantillon (04 §5). */
export const ITEMS_REJECTED_DEFAULTS = { maxShare: 0.2, minCount: 5, sampleSize: 5 } as const;

export type RejectionThresholds = { readonly maxShare: number; readonly minCount: number };

/** Seuils lus dans l'environnement (`ITEMS_REJECTED_MAX_SHARE` dans [0, 1], `ITEMS_REJECTED_MIN_COUNT` entier ≥ 1). */
export function rejectionThresholdsFromEnv(env: Readonly<Record<string, string | undefined>>): RejectionThresholds {
  const shareText = env['ITEMS_REJECTED_MAX_SHARE'];
  const countText = env['ITEMS_REJECTED_MIN_COUNT'];
  const maxShare = shareText === undefined || shareText === '' ? ITEMS_REJECTED_DEFAULTS.maxShare : Number(shareText);
  const minCount = countText === undefined || countText === '' ? ITEMS_REJECTED_DEFAULTS.minCount : Number(countText);
  if (!Number.isFinite(maxShare) || maxShare < 0 || maxShare > 1) throw new Error('ITEMS_REJECTED_MAX_SHARE invalide : nombre entre 0 et 1 attendu.');
  if (!Number.isInteger(minCount) || minCount < 1) throw new Error('ITEMS_REJECTED_MIN_COUNT invalide : entier ≥ 1 attendu.');
  return { maxShare, minCount };
}

/** Masque d'une valeur en erreur ou d'un champ personnel dans l'échantillon. */
export const REJECTED_VALUE_MASK = '[masqué]';
/** Chaînes de l'échantillon tronquées (19 §2 : 120 caractères). */
const SAMPLE_STRING_MAX = 120;
const MAX_DEPTH = 32;
const MAX_ISSUES_PER_ITEM = 20;
const MAX_REASONS = 50;
const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/** Une raison de rejet : jamais une valeur de l'item. */
export type RejectionReason = { readonly keyword: string; readonly instance_path: string; readonly count: number };

export type RejectedItem = {
  /** Item tel qu'extrait : ne quitte jamais le worker tel quel (seul l'échantillon nettoyé est écrit). */
  readonly item: unknown;
  readonly issues: readonly { readonly keyword: string; readonly instance_path: string }[];
};

export type ItemPartition<T> = { readonly conform: T[]; readonly rejected: RejectedItem[] };

export type RejectionVerdict = 'clean' | 'degraded' | 'break';

/** Résumé écrit en quarantaine (`run_rejected_items`) : agrégats sans valeur et échantillon nettoyé. */
export type QuarantineSummary = {
  readonly total_rejected: number;
  readonly by_reason: readonly RejectionReason[];
  readonly sample: readonly unknown[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Échappement d'un segment de pointeur JSON (RFC 6901). */
const escapeSegment = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Pointeur de l'instance fautive : pour `required` et `additionalProperties`, la propriété nommée est ajoutée. */
function issuePointer(instancePath: string, keyword: string, params: Record<string, unknown>): string {
  if (keyword === 'required' && typeof params['missingProperty'] === 'string') return `${instancePath}/${escapeSegment(params['missingProperty'])}`;
  if (keyword === 'additionalProperties' && typeof params['additionalProperty'] === 'string') return `${instancePath}/${escapeSegment(params['additionalProperty'])}`;
  if (keyword === 'unevaluatedProperties' && typeof params['unevaluatedProperty'] === 'string') return `${instancePath}/${escapeSegment(params['unevaluatedProperty'])}`;
  return instancePath === '' ? '' : instancePath;
}

/**
 * Raisons de non-conformité d'un item (mot-clé Ajv et pointeur, sans valeur) ; `[]` : conforme. Lève `SchemaError` si
 * le schéma est inacceptable (jamais de requête réseau).
 */
export function itemIssues(outputSchema: unknown, item: unknown): { keyword: string; instance_path: string }[] {
  const validate = compileSchema(outputSchema);
  if (validate(item)) return [];
  return (validate.errors ?? []).slice(0, MAX_ISSUES_PER_ITEM).map((e) => ({ keyword: e.keyword, instance_path: issuePointer(e.instancePath, e.keyword, e.params as Record<string, unknown>) }));
}

/** Partage les items : conformes (livrables) et rejetés (quarantaine). L'ordre des conformes est conservé. */
export function partitionItems<T>(outputSchema: unknown, items: readonly T[]): ItemPartition<T> {
  const conform: T[] = [];
  const rejected: RejectedItem[] = [];
  for (const item of items) {
    const issues = itemIssues(outputSchema, item);
    if (issues.length === 0) conform.push(item);
    else rejected.push({ item, issues });
  }
  return { conform, rejected };
}

/**
 * Casse ou non (04 §5) : `break` si 0 item conforme, ou si la part rejetée dépasse `maxShare` ET que le nombre rejeté
 * atteint `minCount` ; `degraded` s'il y a des rejets sous le seuil ; `clean` sinon. `strict` (enquête, critère « ça
 * marche ») : le moindre rejet casse.
 */
export function rejectionVerdict(conform: number, rejected: number, thresholds: RejectionThresholds = ITEMS_REJECTED_DEFAULTS, strict = false): RejectionVerdict {
  if (rejected <= 0) return conform > 0 ? 'clean' : 'break';
  if (strict || conform <= 0) return 'break';
  const share = rejected / (conform + rejected);
  return share > thresholds.maxShare && rejected >= thresholds.minCount ? 'break' : 'degraded';
}

/** Agrégats sans valeur : un compte par (mot-clé, pointeur), triés par compte décroissant puis par pointeur. */
export function rejectionReasons(rejected: readonly RejectedItem[]): RejectionReason[] {
  const counts = new Map<string, RejectionReason>();
  for (const r of rejected) {
    // Une raison compte une fois par item, même si Ajv la rapporte plusieurs fois.
    const seen = new Set<string>();
    for (const issue of r.issues) {
      const key = `${issue.keyword}\u0000${issue.instance_path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = counts.get(key);
      counts.set(key, { keyword: issue.keyword, instance_path: issue.instance_path, count: (prev?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.instance_path.localeCompare(b.instance_path) || a.keyword.localeCompare(b.keyword)).slice(0, MAX_REASONS);
}

/** Sous-schéma d'une propriété déclarée par `properties` seulement (jamais `patternProperties` ni `additionalProperties`). */
function declaredProperty(schema: unknown, key: string): { declared: boolean; schema: unknown } {
  if (!isRecord(schema)) return { declared: false, schema: undefined };
  const props = schema['properties'];
  if (isRecord(props) && Object.hasOwn(props, key)) return { declared: true, schema: props[key] };
  return { declared: false, schema: undefined };
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Copie sûre d'un item réduite aux propriétés DÉCLARÉES de `output_schema` (objets sans prototype, segments empoisonnés
 * refusés) ; les chemins retirés sont rendus (ils restent dans les raisons, jamais leur valeur).
 */
export function stripUndeclared(outputSchema: unknown, item: unknown): { value: unknown; removed: string[] } {
  const removed: string[] = [];
  const walk = (schema: unknown, value: unknown, path: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) return REJECTED_VALUE_MASK;
    if (Array.isArray(value)) {
      const itemSchema = isRecord(schema) ? schema['items'] : undefined;
      return value.slice(0, 50).map((v, i) => walk(itemSchema, v, `${path}/${i}`, depth + 1));
    }
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const prop = declaredProperty(schema, key);
      if (!prop.declared || POISON.has(key)) {
        removed.push(`${path}/${escapeSegment(key)}`);
        continue;
      }
      setOwn(out, key, walk(prop.schema, child, `${path}/${escapeSegment(key)}`, depth + 1));
    }
    return out;
  };
  return { value: walk(outputSchema, item, '', 0), removed };
}

/** Segments d'un pointeur JSON (RFC 6901). */
function segments(pointer: string): string[] {
  if (pointer === '' || !pointer.startsWith('/')) return [];
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Masque la valeur au pointeur s'il existe (les chemins absents, comme un `required` manquant, ne changent rien). */
function maskAt(root: unknown, pointer: string): unknown {
  const segs = segments(pointer);
  if (segs.length === 0) return pointer === '' ? REJECTED_VALUE_MASK : root;
  let parent: unknown = root;
  for (const seg of segs.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[Number(seg)];
    else if (isRecord(parent) && Object.hasOwn(parent, seg)) parent = parent[seg];
    else return root;
  }
  const last = segs.at(-1) as string;
  if (Array.isArray(parent) && /^\d+$/.test(last) && Number(last) < parent.length) parent[Number(last)] = REJECTED_VALUE_MASK;
  else if (isRecord(parent) && Object.hasOwn(parent, last) && !POISON.has(last)) setOwn(parent, last, REJECTED_VALUE_MASK);
  return root;
}

function truncateStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > SAMPLE_STRING_MAX ? `${value.slice(0, SAMPLE_STRING_MAX)}…` : value;
  if (depth > MAX_DEPTH) return REJECTED_VALUE_MASK;
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) setOwn(out, k, truncateStrings(v, depth + 1));
  return out;
}

/**
 * Échantillon d'un item rejeté, nettoyé AVANT toute écriture (04 §5) : (1) propriétés non déclarées retirées (le
 * masquage par chemin de schéma ne suffit pas sur un item hors schéma) ; (2) valeurs des chemins en erreur masquées ;
 * (3) couche 1 de 19 §3 : valeurs `x-personal` masquées ; (4) couche 2 : motifs (e-mail, téléphone), secrets connus et
 * valeurs du registre du run ; chaînes tronquées à 120 caractères.
 */
export function sanitizeRejectedItem(outputSchema: unknown, rejected: RejectedItem, registry?: PersonalValueRegistry): unknown {
  const { value } = stripUndeclared(outputSchema, rejected.item);
  let out = value;
  for (const issue of rejected.issues) out = maskAt(out, issue.instance_path);
  const personal = new PersonalValueRegistry();
  for (const v of extractPersonalValues(outputSchema, out)) personal.add(v);
  out = maskPersonal(out, personal);
  if (registry !== undefined) out = maskPersonal(out, registry);
  return truncateStrings(out);
}

/** Résumé de quarantaine : total, raisons (pointeurs masqués de toute donnée personnelle) et échantillon nettoyé. */
export function quarantineSummary(outputSchema: unknown, rejected: readonly RejectedItem[], registry?: PersonalValueRegistry, sampleSize: number = ITEMS_REJECTED_DEFAULTS.sampleSize): QuarantineSummary {
  // Un nom de clé inconnue vient du site : il reste dans les raisons (chemin), mais passé par le masquage des motifs.
  const reasons = rejectionReasons(rejected).map((r) => ({ ...r, instance_path: maskPersonal(r.instance_path, registry) }));
  return {
    total_rejected: rejected.length,
    by_reason: reasons,
    sample: rejected.slice(0, Math.max(0, sampleSize)).map((r) => sanitizeRejectedItem(outputSchema, r, registry)),
  };
}
