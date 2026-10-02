// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot (tâche 3.8b, 17 §5, 06 « Identité du robot ») : écriture des réglages admin `identify_instance`
// (interrupteur, désactivé par défaut) et `instance_contact` (contact de l'opérateur), que le worker relit à chaque run
// (`readIdentifyInstanceSetting`, `readInstanceContactSetting`). Rôle admin ou owner (`settings:identity:write`), session
// d'interface seulement, chaque écriture auditée (champs modifiés, jamais le contact). Le contact est validé par
// `normalizeInstanceContact` (rien qui puisse casser l'en-tête : espace, CR/LF, schéma, identifiants). Le User-Agent réel du
// moteur est rendu en lecture seule : le worker publie la version de Chromium et la plateforme réelle, la route en déduit la
// chaîne (`engineUserAgent`), sans jamais l'accepter en écriture. Aucune option de furtivité : une identification honnête ou rien.
import { buildUserAgent, engineUserAgent, InstanceContactError, normalizeInstanceContact, resolveIdentifyInstance, resolveInstanceContact } from '@runtime/core/access';
import {
  readIdentifyInstanceSetting,
  readInstanceContactSetting,
  readRobotEngine,
  writeRobotIdentitySettings,
} from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { auditEvent, sendError } from './guard.js';

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

type IdentitySource = 'setting' | 'env' | 'default';

type IdentityView = {
  identify_instance: boolean | null;
  identify_effective: boolean | null;
  identify_source: IdentitySource | null;
  instance_contact: string | null;
  instance_contact_effective: string | null;
  instance_contact_source: Exclude<IdentitySource, 'default'> | null;
  engine: { version: string; platform: string } | null;
  worker_version: string | null;
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

/**
 * Ce que le worker applique, résolu par SES fonctions (`resolveIdentifyInstance`, `resolveInstanceContact`) : le réglage d'abord,
 * puis l'environnement que le worker a publié avec son moteur, puis le défaut. Sans réglage ni publication, l'environnement du worker
 * est inconnu : `null` plutôt qu'une valeur inventée.
 */
function effectiveIdentity(identify: boolean | null, contact: string | null, published: { identifyInstance: boolean | null; instanceContact: string | null } | null): Pick<IdentityView, 'identify_effective' | 'identify_source' | 'instance_contact_effective' | 'instance_contact_source'> {
  const env: Record<string, string> = {};
  const envIdentify = published?.identifyInstance ?? null;
  const envContact = published?.instanceContact ?? null;
  if (envIdentify !== null) env['IDENTIFY_INSTANCE'] = String(envIdentify);
  if (envContact !== null) env['INSTANCE_CONTACT'] = envContact;
  const identifySource: IdentitySource | null = identify !== null ? 'setting' : published === null ? null : envIdentify !== null ? 'env' : 'default';
  const contactSource = contact !== null ? 'setting' : envContact !== null ? 'env' : null;
  let effectiveContact: string | null;
  try {
    effectiveContact = resolveInstanceContact(contact, env);
  } catch {
    effectiveContact = null;
  }
  return {
    identify_effective: identifySource === null ? null : resolveIdentifyInstance(identify, env),
    identify_source: identifySource,
    instance_contact_effective: effectiveContact,
    instance_contact_source: effectiveContact === null ? null : contactSource,
  };
}

async function identityView(ctx: ServerContext): Promise<IdentityView> {
  const [identifySetting, contactSetting, engine] = await Promise.all([readIdentifyInstanceSetting(ctx.pool), readInstanceContactSetting(ctx.pool), readRobotEngine(ctx.pool)]);
  const identify = settingBoolean(identifySetting);
  const instanceContact = settingContact(contactSetting);
  const effective = effectiveIdentity(identify, instanceContact, engine?.env ?? null);
  // Version annoncée dans le jeton : celle que le worker publie (sa `RUNTIME_VERSION`), sinon celle du serveur (worker plus ancien).
  const workerVersion = engine?.productVersion ?? null;
  let userAgent: string | null = null;
  let identified: string | null = null;
  if (engine !== null) {
    const identity = { version: engine.version, platform: engine.platform };
    try {
      userAgent = engineUserAgent(identity);
      identified = buildUserAgent({ engine: identity, identify: { version: workerVersion ?? ctx.appVersion, contact: effective.instance_contact_effective } });
    } catch {
      // Moteur publié illisible : la console n'affiche aucun User-Agent plutôt qu'une valeur inventée.
    }
  }
  return {
    identify_instance: identify,
    ...effective,
    instance_contact: instanceContact,
    engine: userAgent === null || engine === null ? null : { version: engine.version, platform: engine.platform },
    worker_version: workerVersion,
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
    // Réglages et audit dans la MÊME transaction. 13 § 9 : nom des champs dont la valeur change (pas ceux du corps), jamais le
    // contact ; l'état de l'interrupteur, quand il change, est un booléen sans secret.
    await writeRobotIdentitySettings(
      ctx.pool,
      { ...(body.identify_instance === undefined ? {} : { identifyInstance: body.identify_instance }), ...(contact === undefined ? {} : { contact }) },
      (changed) =>
        auditEvent(request, actor, {
          action: 'settings.identity_updated',
          outcome: 'success',
          meta: { fields: [...changed].sort(), ...(changed.includes('identify_instance') ? { identify_instance: body.identify_instance } : {}) },
        }),
    );
    return identityView(ctx);
  });
}
