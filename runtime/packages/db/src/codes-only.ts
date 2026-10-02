// SPDX-License-Identifier: AGPL-3.0-only
// Événements et audit en `{code, params}` (21b § 1, M5) : une ligne de `investigation_events` ou d'`audit_events` ne contient
// JAMAIS une phrase rendue ; le récit est rendu à la lecture, dans la langue du lecteur. Garde d'écriture : une valeur qui est
// (ou contient) un message du catalogue est refusée. Les messages courts (moins de 3 mots) ne comptent pas : un code comme
// `blocked_by_protection` n'est jamais une phrase. Les DONNÉES collectées (échantillon, schéma proposé, signaux du site :
// `COLLECTED_DATA_FIELDS`) ne sont pas contrôlées : un texte de site qui ressemble au catalogue n'est pas une phrase rendue.
// Deux modes : `assertCodesOnly` LÈVE (audit, écritures produites par le code seul) ; `scrubRenderedSentences` REMPLACE la valeur
// par le code `rendered_sentence_removed` et rend les chemins refusés, pour le chemin d'une enquête ou d'un run : une prose de
// tiers (détail d'erreur d'un script, texte de site, 21b § 1 « prose stockée comme donnée ») qui recoupe le catalogue ne doit
// jamais faire échouer l'enquête, `finishFailed` compris ; aucune phrase n'est stockée pour autant.
import { COLLECTED_DATA_FIELDS, defaultI18n, findRenderedSentences, sentenceMatcher } from '@runtime/i18n';

let matcher: ((text: string) => boolean) | null = null;
const matches = (text: string): boolean => (matcher ??= sentenceMatcher(defaultI18n().catalogs))(text);

/** Code écrit à la place d'une valeur refusée par la garde en mode `scrub`. */
export const RENDERED_SENTENCE_REMOVED = 'rendered_sentence_removed';

/** Que faire d'une phrase du catalogue trouvée dans une charge : lever (par défaut) ou la remplacer par un code. */
export type RenderedSentenceMode = 'throw' | 'scrub';

export class RenderedSentenceError extends Error {
  override name = 'RenderedSentenceError';
  readonly paths: readonly string[];
  constructor(where: string, paths: readonly string[]) {
    super(`${where} : une phrase rendue ne se stocke pas (code et paramètres seulement) : ${paths.join(', ')}`);
    this.paths = paths;
  }
}

/** Refuse un contenu qui porte une phrase du catalogue ; `where` nomme la table pour le message d'erreur. */
export function assertCodesOnly(where: string, payload: unknown): void {
  const paths = findRenderedSentences(payload, matches, { skip: COLLECTED_DATA_FIELDS });
  if (paths.length > 0) throw new RenderedSentenceError(where, paths);
}

/**
 * Copie de `payload` où chaque valeur qui porte une phrase du catalogue est remplacée par `RENDERED_SENTENCE_REMOVED`, et chemins
 * remplacés (noms de champs seulement, jamais la valeur). Mêmes règles que `assertCodesOnly` (données collectées non contrôlées).
 */
export function scrubRenderedSentences<T>(payload: T): { payload: T; paths: string[] } {
  const paths: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      if (!matches(value)) return value;
      paths.push(path);
      return RENDERED_SENTENCE_REMOVED;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, COLLECTED_DATA_FIELDS.has(k) ? v : walk(v, `${path}.${k}`)]));
    }
    return value;
  };
  const clean = walk(payload, '$') as T;
  return paths.length === 0 ? { payload, paths } : { payload: clean, paths };
}
