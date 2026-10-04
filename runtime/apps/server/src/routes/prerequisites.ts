// SPDX-License-Identifier: AGPL-3.0-only
// `GET /api/me/prerequisites` (UX-09, UX-19 ; 03-specs-mcp § 8) : ce qu'il reste à régler avant qu'une enquête parte, lisible par
// TOUTE clé d'API (aucun scope) et par la session. Contact du robot, modèle et prix du rôle enquête, clé du fournisseur lisible,
// case « usage responsable » de la personne qui porte la clé. Rien de secret : des états, des codes du catalogue d'erreurs et
// des chemins de console. Textes dans la langue de la requête (`srv.error.*`, `srv.errorAction.*`).
import { readRobotEngine } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { errorTexts } from '../error-catalog.js';
import { requestLocale } from '../i18n.js';
import { RESPONSIBLE_USE_VERSION } from '../rest/shared.js';
import { instanceContactProblem } from './identity.js';
import { readSetting, unreadable } from './settings.js';

type Item = {
  id: string;
  /** `true` réglé, `false` à régler, `null` inconnu (aucun worker n'a encore publié son environnement). */
  ok: boolean | null;
  /** Une enquête ne peut pas partir sans lui ; `false` : information (l'usage responsable ne s'exige que pour une donnée personnelle). */
  blocking: boolean;
  code: string | null;
  message: string;
  action_label: string | null;
  console_path: string | null;
};

type StoredLlm = { providers?: { id: string; api_key_secret_id?: string; models?: Record<string, { price?: { in?: unknown; out?: unknown } } | null> }[]; roles?: Record<string, { provider?: string; model?: string } | undefined> };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type PrerequisitesView = { ready: boolean; missing: number; items: Item[] };

/** Les prérequis de la personne `userId`, textes dans `locale`. */
export async function prerequisitesView(ctx: ServerContext, userId: string, locale: string): Promise<PrerequisitesView> {
  const done = (id: string, ok: boolean | null, code: string, blocking: boolean, consolePath: string | null, params: Record<string, unknown> = {}): Item => {
    const texts = errorTexts(code, locale, params);
    return { id, ok, blocking, code: ok === false ? code : null, message: ok === false ? (texts.message ?? '') : '', action_label: ok === false ? texts.action_label : null, console_path: ok === false ? consolePath : null };
  };
  // Aucun worker n'a publié son environnement : l'état du contact est inconnu (null), jamais un « manque » deviné.
  const engine = await readRobotEngine(ctx.pool);
  const problem = await instanceContactProblem(ctx);
  const contact: Item = engine === null ? done('instance_contact', null, 'instance_contact_missing', true, null) : problem === null ? { id: 'instance_contact', ok: true, blocking: true, code: null, message: '', action_label: null, console_path: null } : done('instance_contact', false, 'instance_contact_missing', true, '/settings/robot');
  const items: Item[] = [contact];

  const llm = (await readSetting<StoredLlm>(ctx, 'llm')) ?? {};
  const role = llm.roles?.['investigate'];
  const provider = role === undefined || role === null ? undefined : (llm.providers ?? []).find((p) => p.id === role.provider);
  const model = role?.model;
  const configured = provider !== undefined && typeof model === 'string' && model !== '';
  items.push(configured ? { id: 'llm_model:investigate', ok: true, blocking: true, code: null, message: '', action_label: null, console_path: null } : done('llm_model:investigate', false, 'llm_model_missing', true, '/settings/models'));
  const price = configured ? provider.models?.[model]?.price : undefined;
  const priced = isNumber(price?.in) && isNumber(price?.out);
  items.push(!configured || priced ? { id: 'llm_price:investigate', ok: configured ? true : null, blocking: true, code: null, message: '', action_label: null, console_path: null } : done('llm_price:investigate', false, 'llm_price_missing', true, '/settings/models', { model }));
  const secretId = provider?.api_key_secret_id;
  const bad = typeof secretId === 'string' ? await unreadable(ctx, [secretId]) : new Set<string>();
  items.push(bad.size === 0 ? { id: 'llm_key_readable', ok: configured ? true : null, blocking: true, code: null, message: '', action_label: null, console_path: null } : done('llm_key_readable', false, 'llm_settings_unreadable', true, '/settings/models'));

  const acked = (await ctx.pool.query('SELECT 1 FROM responsible_use_acks WHERE user_id = $1 AND version = $2', [userId, RESPONSIBLE_USE_VERSION])).rowCount === 1;
  items.push(acked ? { id: 'responsible_use', ok: true, blocking: false, code: null, message: '', action_label: null, console_path: null } : done('responsible_use', false, 'responsible_use_ack_required', false, '/responsible-use'));

  const missing = items.filter((i) => i.ok === false && i.blocking).length;
  return { ready: missing === 0, missing, items };
}

export function prerequisitesRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/me/prerequisites', async (request) => prerequisitesView(ctx, request.actor!.userId, await requestLocale(ctx, request)));
}
