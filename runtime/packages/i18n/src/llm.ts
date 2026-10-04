// SPDX-License-Identifier: AGPL-3.0-only
// Bloc de langue des prompts LLM (21 § 4.5, M6). Les prompts internes restent en anglais, un seul jeu ; les rôles qui
// écrivent de la prose pour l'humain reçoivent ce bloc fixe, ajouté par le code. Le nom de langue vient du registre, jamais
// d'une saisie libre. Les sorties machine (clés JSON, énumérations, sélecteurs, `failure_class`) restent en anglais.
import type { Renderer } from './render.js';
import { SOURCE_LOCALE, englishName, languageEntry, type Registry } from './registry.js';

/** Bloc `Language:` pour `runs.locale` (langue inconnue du registre → anglais). */
export function languageBlock(renderer: Renderer, registry: Registry, locale: string): string {
  const known = languageEntry(registry, locale) !== undefined;
  const code = known ? locale : SOURCE_LOCALE;
  return renderer.render('mcp.model.llm.language_block', { language_name_en: englishName(registry, code), locale: code }, SOURCE_LOCALE);
}

/** Ajoute le bloc de langue à la fin d'un prompt système. */
export function withLanguageBlock(prompt: string, block: string): string {
  return `${prompt.trimEnd()}\n\n${block}\n`;
}
