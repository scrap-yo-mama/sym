// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle de FIDÉLITÉ d'une stratégie avant de l'accepter (banc réel, passage 1 : R03 nom vide sur 78 éléments, R04 équipe
// qui reçoit le mode de travail, R07 note et disponibilité absentes, R09 date de début qui reçoit l'organisateur, R10
// étiquettes absentes ; toutes acceptées « conformes au schéma »). Partie PURE, sans I/O ni LLM :
// (a) `fidelityCheck` : contrôle déterministe sur les éléments rendus par les essais :
//     - remplissage par champ : un champ vide sur plus de 20 % des éléments ALORS QUE la page en montre (emplacement relié
//       présent sur au moins 80 % des blocs, ou clé du gisement au nom du champ laissée de côté) ;
//     - deux champs aux mêmes valeurs sur au moins 80 % des éléments (le même emplacement relié deux fois) ;
//     - forme cohérente avec le nom du champ : une date ressemble à une date, une URL à une URL, un e-mail à un e-mail, un
//       nom n'est pas une URL ;
//     - plausibilité (banc réel R13) : bornes selon la nature du champ (pièces, chambres, surfaces, prix, année, pourcentage,
//       note), relations sur un même élément (chambres ≤ pièces, surface habitable ≠ terrain), aberrations statistiques,
//       ville et type de bien inversés, badge marketing pris pour un champ, référence au préfixe technique ;
// (b) `fidelitySamples` : 3 éléments échantillonnés (premier, milieu, dernier) avec le fragment de leur source (HTML du bloc,
//     ou objet JSON de l'enregistrement), pour le juge LLM court (packages/agent, `judgeFidelity`), qui ne voit que des
//     DONNÉES NON FIABLES encadrées par un jeton ;
// (c) `fidelityDiff` : le différentiel montré à la nouvelle proposition des emplacements, en CODES seulement (champ, motif,
//     part des éléments, autre champ) : jamais une valeur du site dans le prompt `investigate`.
import type { AnyNode, Document, Element } from 'domhandler';
import { decodeEmbedded } from '../dsl/blobs.js';
import { parseHtml, selectElements } from '../dsl/css.js';
import { extractRecords } from '../dsl/extract.js';
import { queryValues } from '../dsl/jsonpath.js';
import { DEFAULT_DSL_LIMITS, parseJsonBounded } from '../dsl/limits.js';
import type { DeclarativeSpec, FieldSpec } from '../dsl/spec.js';
import type { DataCandidate } from './recon.js';

/** Part maximale d'éléments vides pour un champ que la page montre. */
export const FIDELITY_MAX_EMPTY_SHARE = 0.2;
/** Part d'éléments identiques à partir de laquelle deux champs sont le même emplacement relié deux fois. */
export const FIDELITY_DUPLICATE_SHARE = 0.8;
/** Éléments montrés au juge LLM. */
export const FIDELITY_JUDGE_SAMPLES = 3;
/** Plafond du coût d'un appel du juge (USD), connu avant l'envoi. */
export const FIDELITY_JUDGE_MAX_USD = 0.01;

export type FidelityIssueCode =
  | 'empty'
  | 'truncated'
  | 'duplicate'
  | 'not_a_date'
  | 'not_a_url'
  | 'not_an_email'
  | 'looks_like_url'
  | 'looks_like_id'
  | 'implausible'
  | 'outlier'
  | 'inconsistent'
  | 'swapped'
  | 'marketing_label'
  | 'technical_prefix'
  | 'judge_wrong'
  | 'judge_missing';
export type FidelityIssue = {
  readonly field: string;
  readonly code: FidelityIssueCode;
  /** Part des éléments touchés (0 à 1), quand elle a un sens. */
  readonly share?: number;
  /** Autre champ (doublon, incohérence, inversion). */
  readonly other?: string;
  /** Nature du champ déduite de son nom ou de sa description (bornes appliquées) : code, jamais une valeur du site. */
  readonly kind?: FieldKind;
};
export type FidelityCheck = { readonly ok: boolean; readonly issues: readonly FidelityIssue[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round = (x: number): number => Math.round(x * 100) / 100;

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function schemaFields(schema: unknown): { name: string; type: string; description: string; uri: boolean }[] {
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
  return Object.entries(props).map(([name, p]) => {
    const t = isRecord(p) ? p['type'] : undefined;
    const type = Array.isArray(t) ? (t.find((x) => x !== 'null') as string | undefined) : (t as string | undefined);
    const format = isRecord(p) ? p['format'] : undefined;
    return { name, type: typeof type === 'string' ? type : 'string', description: isRecord(p) && typeof p['description'] === 'string' ? p['description'] : '', uri: format === 'uri' || format === 'url' || format === 'uri-reference' || format === 'iri' };
  });
}

const DATE_NAME = /(?:^|_)(?:date|dates|start|starts|end|ends|begin|begins|time|datetime|deadline|published|created|updated|day|when|debut|fin)(?:_|$)|_at$|_on$/;
const URL_NAME = /(?:^|_)(?:url|urls|link|href|website|permalink)(?:_|$)/;
const EMAIL_NAME = /(?:^|_)e?mail(?:_|$)/;
const LABEL_NAME = /(?:^|_)(?:name|title|nom|titre|label)(?:_|$)/;
const MONTH = /\b(?:jan|feb|fev|fév|mar|apr|avr|may|mai|jun|juin|jul|juil|aug|aou|aoû|sep|oct|nov|dec|déc)[a-zéû]*\.?\b/i;

/** Valeur qui ressemble à une date ou une heure (ISO, jj/mm/aaaa, mois en lettres avec un nombre, année, hh:mm, époque). */
export function looksLikeDate(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (/\d{4}-\d{2}-\d{2}/.test(s) || /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(s) || /\b\d{1,2}:\d{2}\b/.test(s)) return true;
  if (/\b(?:19|20)\d{2}\b/.test(s)) return true;
  return MONTH.test(s) && /\d/.test(s);
}

/** Identifiant opaque : UUID, ou condensé hexadécimal long (banc réel R05 : `team` valait un UUID). */
const OPAQUE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;
const ID_NAME = /(?:^|_)(?:id|ids|uuid|guid|ref|reference|code|slug|sku|key|token|hash)(?:_|$)/;
const looksLikeId = (v: unknown): boolean => typeof v === 'string' && OPAQUE_ID.test(v.trim());

const looksLikeUrl = (v: unknown): boolean => typeof v === 'string' && /^(?:https?:\/\/|\/)[^\s]*$/i.test(v.trim());

// ---------------------------------------------------------------------------------------------------- plausibilité
// Banc réel R13 (liste de biens de prestige, acceptée « saine ») : pièces et chambres lues dans d'autres nombres de la carte,
// surface du terrain prise pour la surface habitable, référence préfixée par l'identifiant du carrousel, type de bien = badge
// « Nouveauté », puis ville et type inversés. Règles GÉNÉRIQUES, selon le nom et la description du champ (fr et en), sans
// dépendre d'un site : bornes par nature de champ, relations entre deux champs d'un même élément, aberrations statistiques
// (échelle log, écart interquartile), champs inversés, badge marketing, préfixe technique d'une référence.

/** Part d'éléments aux valeurs hors bornes, aberrantes ou incohérentes au-delà de laquelle le champ est refusé. */
export const FIDELITY_IMPLAUSIBLE_SHARE = 0.05;
/** Part d'éléments à partir de laquelle un champ texte ressemble à un autre (champs inversés, badge). */
export const FIDELITY_SWAPPED_SHARE = 0.5;
/** Distance minimale à la médiane (ordres de grandeur) d'une valeur aberrante : les prix de luxe (3e5 à 5e7) n'en sont pas. */
const OUTLIER_MIN_DECADES = 2;
/** Multiple de l'écart interquartile (échelle log10) au-delà duquel une valeur sort des clôtures. */
const OUTLIER_IQR_FENCE = 3;
/** Nombre minimal de valeurs pour juger une aberration statistique. */
const OUTLIER_MIN_VALUES = 8;

/** Nature d'un champ, déduite de son nom (puis de sa description) : code du différentiel, jamais une valeur du site. */
export type FieldKind = 'rooms' | 'bedrooms' | 'bathrooms' | 'living_area' | 'land_area' | 'outdoor_area' | 'price' | 'year' | 'percent' | 'rating';
type TextKind = 'location' | 'property_type' | 'reference';

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const wordsOf = (s: string): string[] => fold(s.replace(/([a-z])([A-Z])/g, '$1_$2')).split(/[^a-z0-9²]+/).filter((w) => w !== '');

const PRICE_WORDS = ['price', 'prices', 'prix', 'cost', 'cout', 'amount', 'montant', 'tarif', 'fee', 'fees', 'rent', 'loyer', 'salary', 'salaire', 'budget', 'charges'];
const CHANGE_WORDS = ['change', 'changes', 'variation', 'growth', 'evolution', 'delta', 'diff', 'difference', 'return', 'yield', 'gain', 'loss'];
const AREA_WORDS = ['surface', 'surfaces', 'area', 'size', 'm2', 'm²', 'sqm', 'sqft', 'superficie', 'footage', 'square'];
const LAND_WORDS = ['land', 'terrain', 'lot', 'plot', 'parcel', 'parcelle', 'garden', 'jardin', 'grounds'];
const OUTDOOR_WORDS = ['exterieur', 'exterieure', 'exterieures', 'exterieurs', 'outdoor', 'exterior', 'terrace', 'terrasse', 'balcony', 'balcon', 'outside'];
const OTHER_UNIT = /\b(?:km|km2|km²|kilometres?|kilometers?|ha|hectares?|acres?|miles?|mi2)\b|km²/;
const SQFT = /\b(?:sqft|sq ft|ft2|ft²|square (?:feet|foot)|square_feet)\b|\bft\b/;
const BIG_BUILDING = /\b(?:hotels?|hostels?|resorts?|buildings?|immeubles?|campus|ships?|cruises?|stadiums?)\b/;
const TOY_SET = /\b(?:set|sets|lego|puzzles?|kits?|toys?|jouets?|jeux?|boites?|box|pack)\b/;
const COUNT_WORDS = ['count', 'counts', 'nb', 'num', 'number', 'total', 'reviews', 'votes'];
const NOT_STATISTICAL = ['id', 'ids', 'code', 'codes', 'ref', 'reference', 'zip', 'postal', 'postcode', 'phone', 'tel', 'telephone', 'siren', 'siret', 'ean', 'isbn', 'sku', 'gtin', 'lat', 'lng', 'lon', 'long', 'latitude', 'longitude', 'rank', 'position', 'index', 'order', 'insee', 'page', 'year', 'annee'];

/** Nature numérique d'un champ d'après les mots donnés (ceux du nom, ou à défaut ceux de la description). */
function kindOfWords(words: readonly string[], text: string): FieldKind | undefined {
  const w = new Set(words);
  const has = (list: readonly string[]): boolean => list.some((x) => w.has(x));
  const change = has(CHANGE_WORDS);
  if (has(PRICE_WORDS)) return change ? undefined : 'price';
  if (has(['bedroom', 'bedrooms', 'beds', 'chambre', 'chambres'])) return 'bedrooms';
  if (has(['bathroom', 'bathrooms', 'bath', 'baths', 'sdb']) || (has(['salle', 'salles']) && has(['bain', 'bains', 'eau']))) return 'bathrooms';
  if (has(['room', 'rooms']) || (has(['piece', 'pieces']) && !TOY_SET.test(text))) return 'rooms';
  const area = has(AREA_WORDS);
  if (has(LAND_WORDS) && (area || has(['terrain', 'garden', 'jardin', 'parcelle'])) && !(w.has('lot') && !area)) return 'land_area';
  if (has(OUTDOOR_WORDS)) return 'outdoor_area';
  if (!OTHER_UNIT.test(text)) {
    const living = has(['living', 'habitable', 'habitation', 'interior', 'interieur', 'floor', 'built']);
    if ((living && area) || has(['surface', 'surfaces', 'm2', 'm²', 'sqm', 'sqft', 'footage'])) return 'living_area';
    if (has(['area', 'superficie', 'size']) && /\b(?:living|habitable|floor|interior|property|apartment|flat|house|home|m2|sqm|sqft|square (?:feet|foot|meters?|metres?))\b|m²/.test(text)) return 'living_area';
  }
  if (has(['year', 'annee'])) return 'year';
  if (has(['percent', 'percentage', 'pct', 'pourcentage', 'pourcent'])) return change ? undefined : 'percent';
  if (has(['rating', 'note', 'stars', 'star', 'etoiles', 'etoile']) && !has(COUNT_WORDS)) return 'rating';
  return undefined;
}

/** Nature numérique d'un champ : son nom d'abord, sa description ensuite. */
export function numericFieldKind(name: string, description = ''): FieldKind | undefined {
  const text = fold(`${name.replace(/_/g, ' ')} ${description}`);
  const byName = kindOfWords(wordsOf(name), text);
  if (byName !== undefined || description.trim() === '') return byName;
  // La description seule est plus bavarde : une variation ou un compte d'avis ne bornent rien.
  const d = wordsOf(description);
  if (d.some((x) => CHANGE_WORDS.includes(x))) return undefined;
  if (/\bpercent(?:age)?\b|pourcentage|%/.test(text)) return 'percent';
  return kindOfWords(d, text);
}

function textFieldKind(name: string): TextKind | undefined {
  const w = new Set(wordsOf(name));
  const has = (list: readonly string[]): boolean => list.some((x) => w.has(x));
  if (has(['url', 'urls', 'link', 'href', 'website', 'email', 'mail', 'phone'])) return undefined;
  if (has(['ref', 'reference', 'id', 'identifier', 'identifiant', 'sku', 'mandat', 'mandate']) && !has(['postal', 'zip', 'insee', 'country'])) return 'reference';
  if (has(['type', 'kind', 'category', 'categorie', 'typology', 'typologie', 'nature'])) return 'property_type';
  if (has(['city', 'ville', 'location', 'localisation', 'locality', 'localite', 'town', 'commune', 'address', 'adresse', 'place', 'lieu', 'region', 'departement', 'department', 'district', 'quartier', 'neighborhood', 'neighbourhood', 'sector', 'secteur', 'country', 'pays', 'zone'])) return 'location';
  return undefined;
}

/** Bornes plausibles d'une nature de champ (sqft : surfaces en pieds carrés). */
function boundsOf(kind: FieldKind, text: string): { min: number; max: number; halfSteps?: boolean; integer?: boolean } | undefined {
  switch (kind) {
    case 'rooms':
    case 'bedrooms':
    case 'bathrooms':
      return { min: 0, max: BIG_BUILDING.test(text) ? 10_000 : 100, halfSteps: true };
    case 'living_area':
      return SQFT.test(text) ? { min: 50, max: 1_100_000 } : { min: 5, max: 100_000 };
    case 'land_area':
    case 'outdoor_area':
    case 'price':
      return { min: 0, max: Number.POSITIVE_INFINITY };
    case 'year':
      return { min: 1000, max: new Date().getFullYear() + 10, integer: true };
    case 'percent':
      return { min: 0, max: 100 };
    case 'rating':
      return { min: 0, max: 100 };
  }
}

/** Valeur numérique d'un élément : nombre fini, ou texte qui n'est qu'un nombre. */
function numeric(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^\s*[+-]?\d+(?:[.,]\d+)?\s*$/.test(v)) return Number(v.trim().replace(',', '.'));
  return undefined;
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Part des valeurs aberrantes : hors des clôtures de l'écart interquartile en log10 ET à 2 ordres de grandeur de la médiane. */
function outlierShare(values: readonly number[]): number {
  const logs = values.filter((v) => v > 0).map((v) => Math.log10(v));
  if (logs.length < OUTLIER_MIN_VALUES) return 0;
  const sorted = [...logs].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const bad = logs.filter((l) => (l < q1 - OUTLIER_IQR_FENCE * iqr || l > q3 + OUTLIER_IQR_FENCE * iqr) && Math.abs(l - median) >= OUTLIER_MIN_DECADES);
  return bad.length / values.length;
}

const PROPERTY_TYPES = new Set([
  'appartement', 'appartements', 'maison', 'maisons', 'villa', 'villas', 'propriete', 'proprietes', 'loft', 'lofts', 'terrain', 'terrains', 'chalet', 'chalets', 'penthouse', 'penthouses', 'duplex', 'triplex', 'studio', 'studios',
  'chateau', 'chateaux', 'manoir', 'mas', 'bastide', 'domaine', 'immeuble', 'ferme', 'longere', 'moulin', 'demeure', 'local', 'bureau', 'bureaux', 'commerce', 'parking', 'garage', 'pavillon', 'hotel particulier',
  'apartment', 'apartments', 'flat', 'flats', 'house', 'houses', 'home', 'homes', 'land', 'plot', 'condo', 'condos', 'townhouse', 'townhouses', 'cottage', 'mansion', 'estate', 'castle', 'farmhouse', 'ranch', 'office', 'bungalow',
]);
const MARKETING_BADGES = new Set([
  'nouveaute', 'nouveautes', 'nouveau', 'nouvelle', 'exclusivite', 'exclusif', 'exclusive', 'exclu', 'coup de coeur', 'vendu', 'vendue', 'sous offre', 'sous compromis', 'prix en baisse', 'baisse de prix', 'a la une', 'loue', 'reserve',
  'new', 'new listing', 'just listed', 'exclusive listing', 'sold', 'under offer', 'under contract', 'pending', 'price reduced', 'reduced', 'featured', 'hot', 'off market', 'off-market', 'coming soon', 'open house', 'let agreed', 'reserved', 'top', 'premium',
]);
const plain = (v: unknown): string => (typeof v === 'string' ? fold(v).replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim() : '');
function looksLikePropertyType(v: unknown): boolean {
  const s = plain(v);
  const words = s.split(' ');
  if (s === '' || words.length > 5) return false;
  return PROPERTY_TYPES.has(words[0]!) || PROPERTY_TYPES.has(words.slice(0, 2).join(' '));
}
const looksLikeBadge = (v: unknown): boolean => MARKETING_BADGES.has(plain(v));
const TECH_PREFIX = /^(carousel|slider|slide|swiper|gallery|lightbox|property|listing|item|card|product|photo|image|img|thumb|thumbnail)[-_:]+(.{3,})$/i;
const STRONG_PREFIX = new Set(['carousel', 'slider', 'slide', 'swiper', 'gallery', 'lightbox']);

/** Contrôles de plausibilité (bornes, relations, aberrations, inversions, badge, préfixe) : problèmes trouvés. */
function plausibilityIssues(records: readonly Record<string, unknown>[], fields: readonly { name: string; type: string; description: string }[]): FidelityIssue[] {
  const issues: FidelityIssue[] = [];
  const flagged = new Set<string>();
  const kinds = new Map<string, { kind: FieldKind; text: string }>();
  // (1) bornes par nature, puis aberrations statistiques des autres champs numériques.
  for (const f of fields) {
    const values = records.map((r) => numeric(r[f.name])).filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    const text = fold(`${f.name.replace(/_/g, ' ')} ${f.description}`);
    const kind = numericFieldKind(f.name, f.description);
    if (kind !== undefined) {
      kinds.set(f.name, { kind, text });
      const b = boundsOf(kind, text)!;
      const bad = values.filter((v) => v < b.min || v > b.max || (b.halfSteps === true && !Number.isInteger(v * 2)) || (b.integer === true && !Number.isInteger(v))).length / values.length;
      if (bad > FIDELITY_IMPLAUSIBLE_SHARE) {
        issues.push({ field: f.name, code: 'implausible', share: round(bad), kind });
        flagged.add(f.name);
        continue;
      }
    }
    if (wordsOf(f.name).some((w) => NOT_STATISTICAL.includes(w))) continue;
    const out = outlierShare(values);
    if (out > FIDELITY_IMPLAUSIBLE_SHARE) {
      issues.push({ field: f.name, code: 'outlier', share: round(out) });
      flagged.add(f.name);
    }
  }
  // (2) relations sur un même élément : chambres ≤ pièces ; surface habitable ni égale ni toujours supérieure au terrain.
  // Chambres et pièces hors bornes ne se comparent pas ; une surface égale au terrain se dit même hors bornes (elle nomme la cause).
  const first = (kind: FieldKind, any = false): string | undefined => [...kinds].find(([name, k]) => k.kind === kind && (any || !flagged.has(name)))?.[0];
  const pairs = (a: string, b: string) => records.map((r) => [numeric(r[a]), numeric(r[b])] as const).filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined);
  const bedrooms = first('bedrooms');
  const rooms = first('rooms');
  if (bedrooms !== undefined && rooms !== undefined) {
    const both = pairs(bedrooms, rooms);
    const bad = both.length >= 3 ? both.filter(([b, r]) => b > r).length / both.length : 0;
    if (bad > FIDELITY_IMPLAUSIBLE_SHARE) issues.push({ field: bedrooms, code: 'inconsistent', share: round(bad), other: rooms, kind: 'bedrooms' });
  }
  const living = first('living_area', true);
  for (const other of [first('land_area', true), first('outdoor_area', true)]) {
    if (living === undefined || other === undefined) continue;
    const both = pairs(living, other).filter(([a, b]) => a > 0 && b > 0);
    if (both.length < 3) continue;
    const equal = both.filter(([a, b]) => a === b).length / both.length;
    const above = both.filter(([a, b]) => a >= b).length / both.length;
    const land = kinds.get(other)?.kind === 'land_area';
    if (equal >= FIDELITY_DUPLICATE_SHARE || (land && above >= 0.9)) {
      issues.push({ field: living, code: 'inconsistent', share: round(equal >= FIDELITY_DUPLICATE_SHARE ? equal : above), other, kind: 'living_area' });
      break;
    }
  }
  // (3) champs texte : ville / type inversés, badge marketing, préfixe technique d'une référence.
  const texts = fields.map((f) => ({ ...f, kind: textFieldKind(f.name) })).filter((f) => f.kind !== undefined);
  const filledText = (name: string) => records.map((r) => r[name]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  const shareOf = (values: readonly string[], pred: (v: string) => boolean) => (values.length === 0 ? 0 : values.filter(pred).length / values.length);
  const locations = texts.filter((f) => f.kind === 'location').map((f) => f.name);
  const types = texts.filter((f) => f.kind === 'property_type').map((f) => f.name);
  const swapped = new Set<string>();
  for (const loc of locations) {
    const s = shareOf(filledText(loc), looksLikePropertyType);
    if (s < FIDELITY_SWAPPED_SHARE) continue;
    // Le champ de type qui porte un badge n'est pas l'autre moitié de l'inversion : il reçoit « marketing_label » plus bas.
    const counterpart = types.find((t) => !swapped.has(t) && filledText(t).length > 0 && shareOf(filledText(t), looksLikePropertyType) < FIDELITY_SWAPPED_SHARE && shareOf(filledText(t), looksLikeBadge) < FIDELITY_SWAPPED_SHARE);
    swapped.add(loc);
    issues.push({ field: loc, code: 'swapped', share: round(s), ...(counterpart === undefined ? {} : { other: counterpart }) });
    if (counterpart !== undefined) {
      swapped.add(counterpart);
      issues.push({ field: counterpart, code: 'swapped', share: round(shareOf(filledText(counterpart), (v) => !looksLikePropertyType(v))), other: loc });
    }
  }
  for (const t of types) {
    if (swapped.has(t)) continue;
    const values = filledText(t);
    if (values.length < 3 || shareOf(values, looksLikePropertyType) >= FIDELITY_SWAPPED_SHARE) continue;
    for (const loc of locations) {
      if (loc === t || swapped.has(loc)) continue;
      const places = filledText(loc).map((v) => ` ${plain(v).replace(/[-']/g, ' ')} `);
      const inPlaces = (v: string): boolean => {
        const p = plain(v).replace(/[-']/g, ' ');
        return p.length >= 3 && !looksLikeBadge(v) && places.some((l) => l.includes(` ${p} `));
      };
      const s = shareOf(values, inPlaces);
      if (s >= FIDELITY_SWAPPED_SHARE) {
        issues.push({ field: t, code: 'swapped', share: round(s), other: loc });
        swapped.add(t);
        break;
      }
    }
  }
  for (const f of texts) {
    if (f.kind === 'reference' || swapped.has(f.name)) continue;
    const values = filledText(f.name);
    const s = values.length < 3 ? 0 : shareOf(values, looksLikeBadge);
    if (s >= FIDELITY_SWAPPED_SHARE) issues.push({ field: f.name, code: 'marketing_label', share: round(s) });
  }
  const urlFields = fields.filter((f) => f.type === 'string' && (URL_NAME.test(f.name.toLowerCase()) || shareOf(filledText(f.name), looksLikeUrl) >= 0.5)).map((f) => f.name);
  for (const f of texts.filter((x) => x.kind === 'reference')) {
    const filled = records.filter((r) => typeof r[f.name] === 'string' && (r[f.name] as string).trim() !== '');
    if (filled.length < 3) continue;
    const bad = filled.filter((r) => {
      const v = (r[f.name] as string).trim();
      const m = TECH_PREFIX.exec(v);
      if (m === null) return false;
      const urls = urlFields.map((u) => (typeof r[u] === 'string' ? (r[u] as string).toLowerCase() : '')).filter((u) => u !== '');
      if (urls.some((u) => u.includes(v.toLowerCase()))) return false;
      return STRONG_PREFIX.has(m[1]!.toLowerCase()) || urls.some((u) => u.includes(m[2]!.toLowerCase()));
    }).length / filled.length;
    if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'technical_prefix', share: round(bad) });
  }
  return issues;
}

/** Emplacement du gisement DOM relié à un champ de la stratégie (même sélecteur, même attribut, même ancêtre). */
function slotOfField(candidate: DataCandidate | null | undefined, field: FieldSpec | undefined) {
  if (candidate?.dom === undefined || field === undefined) return undefined;
  return candidate.dom.slots.find((s) => (s.css ?? undefined) === field.css && s.attr === (field.attr ?? 'text') && s.up === field.up);
}

const keyName = (path: string): string =>
  path
    .replace(/\[\*\]|\[\d+\]/g, '')
    .split(/[.[\]'"]+/)
    .filter((p) => p !== '' && p !== '$')
    .at(-1)
    ?.toLowerCase() ?? '';

/** Le gisement porte une clé ou un emplacement au nom du champ, laissé de côté par la stratégie. */
function unmappedMatch(candidate: DataCandidate | null | undefined, spec: DeclarativeSpec | null | undefined, field: string): boolean {
  if (candidate === null || candidate === undefined) return false;
  const used = new Set(Object.values(spec?.fields ?? {}).flatMap((f) => [f.path ?? '', f.css ?? '']));
  const target = field.toLowerCase();
  for (const key of Object.keys(candidate.skeleton)) {
    if (used.has(key)) continue;
    const slot = candidate.dom?.slots.find((s) => `$.${s.name}` === key);
    if (slot !== undefined && used.has(slot.css ?? '')) continue;
    const name = slot === undefined ? keyName(key) : slot.name;
    if (name === target || (target.length >= 4 && name.split('_').includes(target)) || (name.length >= 4 && target.split('_').includes(name))) return true;
  }
  return false;
}

/**
 * Contrôle déterministe de fidélité (a) sur les éléments rendus par les essais d'une stratégie. `spec` et `candidate` (le
 * gisement de la stratégie) disent si la page MONTRE un champ vide : emplacement relié présent sur 80 % des blocs, ou clé
 * du gisement au nom du champ que la stratégie ne lit pas. Sans eux, seuls doublons et formes sont jugés.
 */
export function fidelityCheck(input: {
  readonly records: readonly Record<string, unknown>[];
  readonly outputSchema: unknown;
  readonly spec?: DeclarativeSpec | null;
  readonly candidate?: DataCandidate | null;
  /** La page montre des liens (UX-22) : un champ `format: uri` vide sur plus de 20 % des éléments est alors un défaut. */
  readonly pageShowsLinks?: boolean;
}): FidelityCheck {
  const records = input.records;
  const issues: FidelityIssue[] = [];
  if (records.length === 0) return { ok: true, issues };
  const fields = schemaFields(input.outputSchema);
  const n = records.length;
  for (const f of fields) {
    const values = records.map((r) => r[f.name]);
    const filled = values.filter((v) => !isEmpty(v));
    const emptyShare = (n - filled.length) / n;
    if (emptyShare > FIDELITY_MAX_EMPTY_SHARE) {
      const mapped = input.spec?.fields[f.name];
      const slot = slotOfField(input.candidate, mapped);
      const shown = (f.uri && input.pageShowsLinks === true) || (slot !== undefined && input.candidate !== null && input.candidate !== undefined && slot.present >= input.candidate.count * 0.8) || (mapped === undefined && unmappedMatch(input.candidate, input.spec, f.name));
      if (shown) issues.push({ field: f.name, code: 'empty', share: round(emptyShare) });
    }
    if (filled.length === 0) continue;
    const share = (pred: (v: unknown) => boolean) => filled.filter((v) => !pred(v)).length / filled.length;
    const name = f.name.toLowerCase();
    // Valeurs coupées « ... » (UX-27) : le texte d'une liste, tel qu'affiché, au lieu de la valeur complète (attribut, fiche).
    if (f.type === 'string') {
      const long = filled.filter((v): v is string => typeof v === 'string' && v.trim().length >= 5);
      const cut = long.filter((v) => /(?:\.{3}|…)$/.test(v.trim())).length;
      if (long.length > 0 && cut / long.length > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'truncated', share: round(cut / long.length) });
    }
    if (f.type === 'string' && (DATE_NAME.test(name) || /\bdate\b/i.test(f.description)) && !URL_NAME.test(name) && !f.uri) {
      const bad = share(looksLikeDate);
      if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'not_a_date', share: round(bad) });
    } else if (f.type === 'string' && (URL_NAME.test(name) || f.uri)) {
      const bad = share(looksLikeUrl);
      if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'not_a_url', share: round(bad) });
    } else if (f.type === 'string' && EMAIL_NAME.test(name)) {
      const bad = share((v) => typeof v === 'string' && v.includes('@'));
      if (bad > FIDELITY_MAX_EMPTY_SHARE) issues.push({ field: f.name, code: 'not_an_email', share: round(bad) });
    } else if (f.type === 'string' && LABEL_NAME.test(name)) {
      const urls = filled.filter(looksLikeUrl).length / filled.length;
      if (urls >= 0.5) issues.push({ field: f.name, code: 'looks_like_url', share: round(urls) });
    }
    // Un libellé (équipe, département, lieu, nom…) qui reçoit un identifiant opaque : la clé de liaison a été lue à la place du libellé.
    if (f.type === 'string' && !ID_NAME.test(name) && !URL_NAME.test(name)) {
      const ids = filled.filter(looksLikeId).length / filled.length;
      if (ids >= 0.5) issues.push({ field: f.name, code: 'looks_like_id', share: round(ids) });
    }
  }
  // Doublons : deux champs texte aux mêmes valeurs (hors URL : un lien de fiche et un lien « postuler » peuvent coïncider).
  const texts = fields.filter((f) => f.type === 'string');
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]!.name;
      const b = texts[j]!.name;
      const both = records.filter((r) => !isEmpty(r[a]) && !isEmpty(r[b]));
      if (both.length < Math.max(2, n * 0.5)) continue;
      const same = both.filter((r) => String(r[a]).trim() === String(r[b]).trim() && !looksLikeUrl(r[a]));
      if (same.length >= both.length * FIDELITY_DUPLICATE_SHARE) {
        const s = round(same.length / both.length);
        issues.push({ field: a, code: 'duplicate', share: s, other: b }, { field: b, code: 'duplicate', share: s, other: a });
      }
    }
  }
  issues.push(...plausibilityIssues(records, fields));
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------------------------------- échantillon du juge

export type FidelitySample = {
  /** Valeurs extraites par le code (enregistrement de la stratégie). */
  readonly record: Record<string, unknown>;
  /** Fragment de la source de cet enregistrement : HTML épuré du bloc, ou JSON de l'objet. DONNÉE NON FIABLE. */
  readonly fragment: string;
  readonly kind: 'html' | 'json';
};

const KEPT_ATTRS = new Set(['class', 'href', 'src', 'alt', 'title', 'datetime', 'content', 'itemprop', 'aria-label', 'data-sort-value']);
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas']);
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML épuré d'un élément (balises, texte, attributs utiles ; liens sans requête), borné à `maxChars`. */
export function condenseElement(root: Element, maxChars: number): string {
  let out = '';
  const push = (s: string): boolean => {
    if (out.length + s.length > maxChars) return false;
    out += s;
    return true;
  };
  type Item = AnyNode | { close: string };
  const stack: Item[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ('close' in node) {
      if (!push(`</${node.close}>`)) break;
      continue;
    }
    if (node.type === 'text') {
      const t = node.data.replace(/\s+/g, ' ');
      if (t.trim() !== '' && !push(escapeText(t))) break;
      continue;
    }
    if (node.type !== 'tag') continue;
    const el = node as Element;
    if (SKIPPED.has(el.name)) continue;
    const attrs = Object.entries(el.attribs)
      .filter(([k, v]) => KEPT_ATTRS.has(k) && v.trim() !== '')
      .map(([k, v]) => ` ${k}="${escapeText(k === 'href' || k === 'src' ? (v.split(/[?#]/, 1)[0] ?? '') : v.replace(/\s+/g, ' ').trim()).replace(/"/g, '&quot;').slice(0, 120)}"`)
      .join('');
    if (!push(`<${el.name}${attrs}>`)) break;
    stack.push({ close: el.name });
    for (let i = el.children.length - 1; i >= 0; i -= 1) stack.push(el.children[i]!);
  }
  return out;
}

function ancestor(el: Element, up: number): Element | null {
  let cur: Element | null = el;
  for (let k = 0; k < up && cur !== null; k += 1) cur = cur.parent !== null && cur.parent.type === 'tag' ? (cur.parent as Element) : null;
  return cur;
}

/**
 * Échantillon du juge (b) : la stratégie relue SANS LLM sur le corps capturé (`body` : page HTML, réponse JSON, page qui
 * porte le blob), puis les éléments premier, du milieu et dernier, chacun avec le fragment de sa source. Un champ lu sous un
 * ancêtre (`up`, titre de groupe) ajoute ce titre au fragment. `[]` si la stratégie ne rend rien sur ce corps.
 */
export function fidelitySamples(spec: DeclarativeSpec, body: string, outputSchema: unknown, options: { readonly count?: number; readonly maxChars?: number } = {}): FidelitySample[] {
  const count = options.count ?? FIDELITY_JUDGE_SAMPLES;
  const maxChars = options.maxChars ?? 1_200;
  const source = spec.sources[0];
  if (source === undefined) return [];
  let records: Record<string, unknown>[];
  try {
    const out = extractRecords({ ...spec, sources: [source] }, { body }, { outputSchema, itemPolicy: 'quarantine' });
    if (!out.ok) return [];
    records = out.records;
  } catch {
    return [];
  }
  let roots: unknown[];
  try {
    if (source.from === 'html') {
      roots = selectElements(source.records, parseHtml(body, DEFAULT_DSL_LIMITS), DEFAULT_DSL_LIMITS.maxItems);
    } else if (source.from === 'embedded') {
      const doc: Document = parseHtml(body, DEFAULT_DSL_LIMITS);
      roots = queryValues(source.records, decodeEmbedded(doc, source.locator!, DEFAULT_DSL_LIMITS), { limits: DEFAULT_DSL_LIMITS });
    } else {
      roots = queryValues(source.records, parseJsonBounded(body, DEFAULT_DSL_LIMITS), { limits: DEFAULT_DSL_LIMITS });
    }
  } catch {
    return [];
  }
  if (roots.length !== records.length || records.length === 0) return [];
  const picks = [...new Set([0, Math.floor((records.length - 1) / 2), records.length - 1])].slice(0, count);
  const grouped = Object.values(spec.fields).filter((f) => f.up !== undefined && f.css !== undefined);
  return picks.map((i) => {
    const root = roots[i];
    if (source.from !== 'html') return { record: records[i]!, fragment: JSON.stringify(root).slice(0, maxChars), kind: 'json' as const };
    const el = root as Element;
    const heads = grouped
      .map((f) => {
        const top = ancestor(el, f.up!);
        const head = top === null ? undefined : selectElements(f.css!, top, 1_000)[0];
        return head === undefined ? '' : `<group_heading>${condenseElement(head, 200)}</group_heading>`;
      })
      .join('');
    return { record: records[i]!, fragment: `${heads}${condenseElement(el, Math.max(200, maxChars - heads.length))}`, kind: 'html' as const };
  });
}

// ---------------------------------------------------------------------------------------------------- différentiel

const pct = (i: FidelityIssue): number => Math.round((i.share ?? 1) * 100);
/** Bornes dites au modèle, par nature de champ (texte fixe du code). */
const RANGES: Partial<Record<FieldKind, string>> = {
  rooms: 'a count of rooms is a whole number from 0 to 100',
  bedrooms: 'a count of bedrooms is a whole number from 0 to 100',
  bathrooms: 'a count of bathrooms is a whole number from 0 to 100',
  living_area: 'a living area is between 5 and 100000 square meters',
  land_area: 'an area is never negative',
  outdoor_area: 'an area is never negative',
  price: 'a price is never negative',
  year: 'a year is between 1000 and ten years from now',
  percent: 'a percentage is between 0 and 100',
  rating: 'a rating is between 0 and 100',
};

const MESSAGES: Record<FidelityIssueCode, (i: FidelityIssue) => string> = {
  truncated: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are cut with "...": read the full value (the title or aria-label attribute, or the full text of the element), not the shortened display`,
  empty: (i) => `empty on ${Math.round((i.share ?? 1) * 100)}% of records although the page shows it: map it to the slot or key that holds it`,
  duplicate: (i) => `same values as "${i.other}" on ${Math.round((i.share ?? 1) * 100)}% of records: one of the two reads the wrong slot`,
  not_a_date: (i) => `${Math.round((i.share ?? 1) * 100)}% of values do not look like a date: wrong slot or key`,
  not_a_url: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are not URLs: wrong slot or key`,
  not_an_email: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are not e-mail addresses: wrong slot or key`,
  looks_like_url: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are URLs, not a name: wrong slot or key`,
  implausible: (i) => `${pct(i)}% of values are outside the plausible range (${(i.kind === undefined ? undefined : RANGES[i.kind]) ?? 'for this kind of field'}): wrong slot, it reads another number of the record`,
  outlier: (i) => `${pct(i)}% of values are at least two orders of magnitude away from the values of the other records: wrong slot or key for those records`,
  inconsistent: (i) =>
    i.kind === 'bedrooms'
      ? `greater than "${i.other}" on ${pct(i)}% of records (bedrooms never outnumber rooms): one of the two reads another number of the record`
      : `equal to or greater than "${i.other}" on ${pct(i)}% of records: the living area reads the land or outdoor area; map the slot of the living area`,
  swapped: (i) =>
    i.other === undefined
      ? `${pct(i)}% of values look like a property type, not a place: wrong slot or key`
      : `values look like what "${i.other}" should hold on ${pct(i)}% of records: the two fields read each other's slot, exchange their paths`,
  marketing_label: (i) => `${pct(i)}% of values are a marketing badge of the card (such as new, exclusive or sold), not this field: map the slot that holds the field, or leave it out`,
  technical_prefix: (i) => `${pct(i)}% of values carry a technical prefix of the page markup (a carousel, slide or card element id) before the code: map a slot that holds the bare code`,
  looks_like_id: (i) => `${Math.round((i.share ?? 1) * 100)}% of values are opaque identifiers, not a label: a joined path such as "$.<key>~<field>" holds the label`,
  judge_wrong: () => 'a reviewer compared the values with the source blocks and found them wrong: wrong slot or key',
  judge_missing: () => 'a reviewer found the value in the source blocks while the extraction left it empty',
};

/**
 * Différentiel montré à la nouvelle proposition des emplacements (c) : par champ, le motif en anglais, la part des éléments
 * et l'autre champ ; aucune valeur du site. Borné à 20 lignes.
 */
export function fidelityDiff(issues: readonly FidelityIssue[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const i of issues) {
    const key = `${i.field}/${i.code}/${i.other ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- field "${i.field}": ${MESSAGES[i.code](i)}`);
    if (lines.length >= 20) break;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------- champs requis

/**
 * Champs requis absents d'éléments rendus en politique `quarantine` (banc réel R02 : la vérification de la règle d'arrêt
 * atteint des pages au second gabarit de carte, sans le champ que la page 1 montrait partout) : nom et nombre d'éléments.
 */
export function missingRequiredFields(records: readonly Record<string, unknown>[], schema: unknown): { readonly field: string; readonly records: number }[] {
  const required = isRecord(schema) && Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  return required.map((field) => ({ field, records: records.filter((r) => isEmpty(r[field])).length })).filter((m) => m.records > 0);
}

/** Schéma de sortie sans ces champs parmi les requis (un champ que la page ne montre pas toujours devient facultatif). */
export function relaxRequired(schema: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r) => typeof r === 'string' && !fields.includes(r)) : [];
  return { ...schema, required };
}

/** Stratégie déclarative dont ces champs ne sont plus requis (l'extraction stricte ne casse plus sur leur absence). */
export function relaxSpecRequired(spec: DeclarativeSpec, fields: readonly string[]): DeclarativeSpec {
  const next: Record<string, FieldSpec> = {};
  for (const [name, field] of Object.entries(spec.fields)) {
    if (!fields.includes(name) || field.required !== true) {
      next[name] = field;
      continue;
    }
    const { required: _required, ...rest } = field;
    next[name] = rest;
  }
  return { ...spec, fields: next };
}
