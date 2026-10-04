// SPDX-License-Identifier: AGPL-3.0-only
// Texte MCP côté utilisateur (21 § 4.3, M3 et M4) : `message` + `message_locale`, titres de prompts, élicitation, phrase de
// langue des `instructions`. Les noms d'outils et de prompts, les valeurs d'énumération et les codes sont stables et en
// anglais ; `mcp.model.*` (descriptions d'outils, `instructions`, `what_to_do`) n'existe qu'en `en`. Aucune clé `_meta`
// réservée `io.modelcontextprotocol/*` n'est émise en V1 (SEP-2792 : V1.1, adaptateur isolé ici).
import { fmtDate } from './format.js';
import { resolveLocale } from './resolve.js';
import type { Params, Renderer } from './render.js';
import { SOURCE_LOCALE, englishName, type Registry } from './registry.js';

/** Noms stables des 5 prompts (05 § 1.3), identiques dans toutes les langues. */
export const MCP_PROMPT_NAMES = ['new_api', 'fix_api', 'first_steps', 'review_catalog', 'resume_api'] as const;
export type McpPromptName = (typeof MCP_PROMPT_NAMES)[number];

/** `prompts/list` localisé : durée de cache courte (de l'ordre de 5 min, à valider, 21 § 4.3). */
export const MCP_PROMPTS_TTL_MS = 300_000;
export const MCP_INSTRUCTIONS_MAX = 1000;
export const MCP_INSTRUCTIONS_VITAL_WINDOW = 512;

/** Langue d'une session MCP (V1) : `?lang=` du connecteur, puis compte du propriétaire de la clé, puis instance, puis `en`. */
export function resolveMcpLocale(input: { lang?: string | undefined; user?: string | null | undefined; instance?: string | undefined }, supported: readonly string[]): { locale: string; source: string } {
  return resolveLocale({ surface: 'mcp', urlHint: input.lang, user: input.user, instance: input.instance }, supported);
}

/**
 * `message` d'une erreur ou d'un résultat, avec la langue réellement rendue (`message_locale`). `what_to_do` n'est pas ici :
 * il reste en anglais, texte unique. Les paramètres `Date` sont écrits dans le fuseau du compte, sinon en UTC étiqueté.
 */
export function localizedMessage(renderer: Renderer, key: string, params: Params, locale: string, timeZone?: string | null): { message: string; message_locale: string } {
  const prepared = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v instanceof Date ? fmtDate(v, locale, timeZone) : v]));
  const rendered = renderer.has(key, locale) ? locale : SOURCE_LOCALE;
  return { message: renderer.render(key, prepared, locale), message_locale: rendered };
}

export interface McpPrompt {
  readonly name: McpPromptName;
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly { name: string; description: string; required: boolean }[];
}

/** Résultat de `prompts/list` : `name` identiques partout, `title` et descriptions dans la langue, cache privé. */
export function listPrompts(renderer: Renderer, locale: string): { prompts: McpPrompt[]; cacheScope: 'private'; ttlMs: number } {
  const text = (key: string) => renderer.render(`mcp.user.prompt.${key}`, {}, locale);
  const args: Record<McpPromptName, McpPrompt['arguments']> = {
    new_api: [{ name: 'url', description: text('arg_url'), required: true }],
    fix_api: [{ name: 'slug', description: text('arg_slug'), required: true }],
    first_steps: [],
    review_catalog: [],
    resume_api: [{ name: 'slug', description: text('arg_slug'), required: true }],
  };
  return {
    prompts: MCP_PROMPT_NAMES.map((name) => ({ name, title: text(`${name}.title`), description: text(`${name}.description`), arguments: args[name] })),
    cacheScope: 'private',
    ttlMs: MCP_PROMPTS_TTL_MS,
  };
}

export type ElicitationKind = 'validate_schema' | 'confirm_cost';

/** Élicitation plate : `message` et titres localisés ; valeurs d'`enum` en code, identiques dans toutes les langues. */
export function elicitation(renderer: Renderer, kind: ElicitationKind, locale: string) {
  const t = (key: string) => renderer.render(`mcp.user.elicitation.${kind}.${key}`, {}, locale);
  const values = kind === 'validate_schema' ? (['accept', 'modify'] as const) : (['accept', 'cancel'] as const);
  return {
    message: t('message'),
    requestedSchema: {
      type: 'object' as const,
      properties: {
        decision: { type: 'string' as const, title: t('decision'), enum: [...values], enumNames: values.map((v) => t(v)) },
        ...(kind === 'validate_schema' ? { remark: { type: 'string' as const, title: t('remark') } } : {}),
      },
      required: ['decision'],
    },
  };
}

/** `instructions` du serveur : règles vitales d'abord (512 premiers caractères), phrase de langue en fin, 1 000 caractères au plus. Anglais seul. */
export function buildInstructions(renderer: Renderer): string {
  const text = [renderer.render('mcp.model.instructions.vital', {}, SOURCE_LOCALE), renderer.render('mcp.model.instructions.rest', {}, SOURCE_LOCALE), renderer.render('mcp.model.instructions.reply_language', {}, SOURCE_LOCALE)].join(' ');
  if (text.length > MCP_INSTRUCTIONS_MAX) throw new Error(`instructions MCP : ${text.length} caractères, ${MCP_INSTRUCTIONS_MAX} au plus`);
  return text;
}

/** Fin de chaque `prompts/get` : « Answer the user in French. » (nom de langue du registre, jamais une saisie libre). */
export function promptTail(renderer: Renderer, registry: Registry, locale: string): string {
  return renderer.render('mcp.model.prompt_tail', { language: englishName(registry, locale) }, SOURCE_LOCALE);
}

/** Consigne de traduction de `what_to_do` (anglais) : le client relaie le `message` dans la langue de l'utilisateur. */
export function whatToDoTranslate(renderer: Renderer): string {
  return renderer.render('mcp.model.what_to_do_translate', {}, SOURCE_LOCALE);
}
