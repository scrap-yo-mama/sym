// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot (tâche 3.8b, 17 §5, 06 « Identité du robot ») : écriture des réglages admin `identify_instance`
// (interrupteur, désactivé par défaut) et `instance_contact` (contact de l'opérateur), que le worker relit à chaque run
// (`readIdentifyInstanceSetting`, `readInstanceContactSetting`). Rôle admin ou owner (`settings:identity:write`), session
// d'interface seulement, chaque écriture auditée (champs modifiés, jamais le contact). Le contact est validé par
// `normalizeInstanceContact` (rien qui puisse casser l'en-tête : espace, CR/LF, schéma, identifiants). Le User-Agent réel du
// moteur est rendu en lecture seule : le worker publie la version de Chromium et la plateforme réelle, la route en déduit la
// chaîne (`engineUserAgent`), sans jamais l'accepter en écriture. Aucune option de furtivité : une identification honnête ou rien.
import { buildUserAgent, engineUserAgent, InstanceContactError, normalizeInstanceContact } from '@runtime/core/access';
import {
  readIdentifyInstanceSetting,
  readInstanceContactSetting,
  readRobotEngine,
  writeRobotIdentitySettings,
} from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { audit, sendError } from './guard.js';

type Body = { identify_instance?: boolean; instance_contact?: string | null };

const identityBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    // `enum` et non `type: boolean` : la validation de Fastify convertit `null` en `false`, ce qui désactiverait l'identification sans que l'admin l'ait demandé.
    identify_instance: { enum: [true, false] },
    instance_contact: { type: ['string', 'null'], maxLength: 400 },
  },
} as const;

type IdentityView = {
  identify_instance: boolean | null;
  instance_contact: string | null;
  engine: { version: string; platform: string } | null;
  user_agent: string | null;
  user_agent_identified: string | null;
  product_version: string;
};

/** Réglage `identify_instance` tel que le worker le lit : booléen, ou `{ enabled }` ; `null` quand il n'est pas posé. */
function settingBoolean(value: unknown): boolean | null {
  const raw = typeof value === 'object' && value !== null && 'enabled' in value ? (value as { enabled?: unknown }).enabled : value;
  return typeof raw === 'boolean' ? raw : null;
}

/** Contact tel que le worker le lit (chaîne, ou `{ contact }`) ; `null` s'il n'est pas posé ou illisible. */
function settingContact(value: unknown): string | null {
  const raw = typeof value === 'object' && value !== null && 'contact' in value ? (value as { contact?: unknown }).contact : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return normalizeInstanceContact(raw);
  } catch {
    return null;
  }
}

async function identityView(ctx: ServerContext): Promise<IdentityView> {
  const [identify, contact, engine] = await Promise.all([readIdentifyInstanceSetting(ctx.pool), readInstanceContactSetting(ctx.pool), readRobotEngine(ctx.pool)]);
  const instanceContact = settingContact(contact);
  let userAgent: string | null = null;
  let identified: string | null = null;
  if (engine !== null) {
    try {
      userAgent = engineUserAgent(engine);
      identified = buildUserAgent({ engine, identify: { version: ctx.appVersion, contact: instanceContact } });
    } catch {
      // Moteur publié illisible : la console n'affiche aucun User-Agent plutôt qu'une valeur inventée.
    }
  }
  return {
    identify_instance: settingBoolean(identify),
    instance_contact: instanceContact,
    engine: userAgent === null ? null : engine,
    user_agent: userAgent,
    user_agent_identified: identified,
    product_version: ctx.appVersion,
  };
}

export function identityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/settings/identity', async () => identityView(ctx));

  app.put<{ Body: Body }>('/api/settings/identity', { schema: { body: identityBody } }, async (request, reply) => {
    const actor = request.actor!;
    const body = request.body;
    // Tout est validé avant la première écriture : un contact refusé ne laisse aucune écriture partielle.
    let contact: string | null | undefined;
    if (body.instance_contact !== undefined) {
      try {
        contact = body.instance_contact === null ? null : normalizeInstanceContact(body.instance_contact);
      } catch (error) {
        if (error instanceof InstanceContactError) return sendError(reply, 400, 'invalid_instance_contact', error.message);
        throw error;
      }
    }
    await writeRobotIdentitySettings(ctx.pool, {
      ...(body.identify_instance === undefined ? {} : { identifyInstance: body.identify_instance }),
      ...(contact === undefined ? {} : { contact }),
    });
    // 13 § 9 : nom des champs modifiés, jamais le contact ; l'état de l'interrupteur est un booléen, sans secret.
    await audit(ctx, request, actor, {
      action: 'settings.identity_updated',
      outcome: 'success',
      meta: { fields: Object.keys(body).sort(), ...(body.identify_instance === undefined ? {} : { identify_instance: body.identify_instance }) },
    });
    return identityView(ctx);
  });
}
