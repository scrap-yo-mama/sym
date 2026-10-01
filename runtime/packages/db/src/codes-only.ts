// SPDX-License-Identifier: AGPL-3.0-only
// Événements et audit en `{code, params}` (21b § 1, M5) : une ligne de `investigation_events` ou d'`audit_events` ne contient
// JAMAIS une phrase rendue ; le récit est rendu à la lecture, dans la langue du lecteur. Garde d'écriture : une valeur qui est
// (ou contient) un message du catalogue est refusée. Les messages courts (moins de 3 mots) ne comptent pas : un code comme
// `blocked_by_protection` n'est jamais une phrase.
import { defaultI18n, findRenderedSentences, sentenceMatcher } from '@runtime/i18n';

let matcher: ((text: string) => boolean) | null = null;

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
  matcher ??= sentenceMatcher(defaultI18n().catalogs);
  const paths = findRenderedSentences(payload, matcher);
  if (paths.length > 0) throw new RenderedSentenceError(where, paths);
}
