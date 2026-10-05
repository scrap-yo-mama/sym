// SPDX-License-Identifier: AGPL-3.0-only
// Langue côté serveur (tâche 3.20, 21 § 3 et § 4.4) : langue d'instance (`settings.default_locale`, surcharge `DEFAULT_LOCALE`),
// langue d'une requête REST (`Accept-Language` valide, puis compte du propriétaire de la clé, puis instance, puis `en`) et
// localisation du `message` des erreurs REST, non contractuel : le `code` reste le contrat. L'en-tête `Accept-Language` brut
// n'est jamais journalisé ni conservé : seuls la langue résolue et sa source servent.
import { defaultI18n, resolveLocale, type Source } from '@runtime/i18n';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { ServerContext } from './context.js';
import { errorTexts } from './error-catalog.js';

const DEFAULT_LOCALE_SETTING = 'default_locale';
const CACHE_MS = 2000;
const cache = new WeakMap<pg.Pool, { at: number; value: string | null }>();

/** Langues livrées (registre) : liste des sélecteurs, de la validation et de la résolution. */
export function supportedLocales(): readonly string[] {
  return defaultI18n().supported;
}

export function isSupportedLocale(value: unknown): value is string {
  return typeof value === 'string' && supportedLocales().includes(value);
}

/** Valeur stockée de `settings.default_locale` (à défaut, langue de l'owner), ou null (cache de 2 s). */
async function storedDefaultLocale(pool: pg.Pool): Promise<string | null> {
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // Schéma en retard ou base indisponible (démarrage dégradé, 14 § 5) : la langue n'est jamais la cause d'un échec de réponse.
  let raw: unknown;
  try {
    raw = (await pool.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [DEFAULT_LOCALE_SETTING])).rows[0]?.value;
    // Instance migrée avant 0025_i18n (aucun réglage écrit) : la langue de l'owner en tient lieu, sans rien écrire.
    raw ??= (await pool.query<{ locale: string }>("SELECT locale FROM users WHERE role = 'owner' AND deleted_at IS NULL LIMIT 1")).rows[0]?.locale;
  } catch {
    return null;
  }
  const value = typeof raw === 'string' && isSupportedLocale(raw) ? raw : null;
  cache.set(pool, { at: Date.now(), value });
  return value;
}

/** Langue de l'instance : `DEFAULT_LOCALE` (surcharge), sinon `settings.default_locale`, sinon `en`. */
export async function instanceDefaultLocale(ctx: Pick<ServerContext, 'pool'> & { defaultLocaleEnv?: string | null }): Promise<string> {
  if (ctx.defaultLocaleEnv && isSupportedLocale(ctx.defaultLocaleEnv)) return ctx.defaultLocaleEnv;
  return (await storedDefaultLocale(ctx.pool)) ?? 'en';
}

/** `Accept-Language` d'une requête (jamais journalisé). */
function acceptLanguage(request: FastifyRequest): string | undefined {
  const value = request.headers['accept-language'];
  return typeof value === 'string' ? value : undefined;
}

/** Langue d'une réponse REST (21 § 3) : `Accept-Language` valide, `users.locale` du propriétaire de la clé, instance, `en`. */
async function resolveRequestLocale(ctx: Pick<ServerContext, 'pool'> & { defaultLocaleEnv?: string | null }, request: FastifyRequest): Promise<{ locale: string; source: Source }> {
  return resolveLocale(
    { surface: 'rest', request: acceptLanguage(request), user: request.actor?.locale ?? null, instance: await instanceDefaultLocale(ctx) },
    supportedLocales(),
  );
}

/**
 * Codes dont le message de la route porte le détail de la requête (entrée hors schéma, plafond, motif de refus d'un mot de
 * passe…) : il reste celui de la route (en français) et `message_locale` le dit ; l'action et la marche à suivre viennent
 * quand même du catalogue.
 */
const ROUTE_MESSAGE_CODES = new Set([
  'invalid_input',
  'cost_cap_exceeded',
  'weak_password',
  'lifetime_too_long',
  'extension_outdated',
  'invalid_schedule',
  'invalid_webhook',
  'invalid_settings',
  'invalid_instance_contact',
  'invalid_llm_settings',
  'invalid_proxy',
  'responsible_use_ack_required',
  // Codes que des routes rendent avec le détail du refus (schéma, état d'enquête) : le message de la route est gardé.
  'invalid_schema',
  'not_awaiting_validation',
]);

/**
 * Crochet `onSend` (03-specs-mcp § 10.3) : complète toute erreur REST en enveloppe commune. `message` est réécrit dans la
 * langue résolue quand le catalogue connaît le code (`srv.error.<code>`, ou `srv.error_by_status.<statut>.<code>`) ;
 * `message_locale`, `action_label`, `what_to_do` (anglais) et `retryable` s'ajoutent s'ils manquent (une cause écrite par la
 * route est gardée). Les paramètres d'un message viennent de `scope_required`, `field` et `details`. Pose `Content-Language` et
 * `Vary: Accept-Language`. Le `code` ne change jamais ; un code sans entrée garde son message d'origine.
 */
export function localizeErrors(ctx: Pick<ServerContext, 'pool'> & { defaultLocaleEnv?: string | null }) {
  return async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (typeof payload !== 'string' || reply.statusCode < 400 || !payload.startsWith('{"error"')) return payload;
    let body: { error?: Record<string, unknown> };
    try {
      body = JSON.parse(payload) as typeof body;
    } catch {
      return payload;
    }
    const error = body.error;
    const code = error?.['code'];
    if (error === undefined || typeof code !== 'string' || typeof error['message'] !== 'string') return payload;
    const { renderer } = defaultI18n();
    const { locale } = await resolveRequestLocale(ctx, request);
    const details = typeof error['details'] === 'object' && error['details'] !== null ? (error['details'] as Record<string, unknown>) : {};
    const params = { ...details, scope: error['scope_required'], field: error['field'] };
    const key = [`srv.error_by_status.${reply.statusCode}.${code}`, `srv.error.${code}`].find((k) => renderer.has(k, 'en'));
    const texts = errorTexts(code, locale, params, reply.statusCode);
    // Une cause écrite par la route (`what_to_do` présent : contact du robot, prix du modèle, dossier d'enquête) garde son message.
    const keepRoute = key === undefined || ROUTE_MESSAGE_CODES.has(code) || typeof error['what_to_do'] === 'string';
    if (!keepRoute) error['message'] = renderer.render(key, params as never, locale);
    error['message_locale'] ??= keepRoute ? 'fr' : locale;
    error['action_label'] ??= texts.action_label;
    error['what_to_do'] ??= texts.what_to_do;
    error['retryable'] ??= texts.retryable;
    void reply.header('content-language', locale);
    void reply.header('vary', 'Accept-Language');
    return JSON.stringify(body);
  };
}

/** Langue de la requête en cours (même résolution que les messages d'erreur), pour les réponses qui portent des textes. */
export async function requestLocale(ctx: Pick<ServerContext, 'pool'> & { defaultLocaleEnv?: string | null }, request: FastifyRequest): Promise<string> {
  return (await resolveRequestLocale(ctx, request)).locale;
}
