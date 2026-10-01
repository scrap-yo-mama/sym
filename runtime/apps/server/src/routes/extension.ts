// SPDX-License-Identifier: AGPL-3.0-only
// Extension Chrome (tâche 2.6, 07 § 1-2, 13 § 5 et § 12, INV5, INV8).
// - Console : code d'appairage (ré-authentification), appareils et domaines connectés, révocation ; admin : révocation
//   seule (métadonnées, jamais un jeton, `assert_admin_revoke_only`).
// - Extension : échange du code contre un jeton lié à (utilisateur, appareil) ; puis, avec ce jeton seulement,
//   consentement par domaine, cookies en usage serveur (écriture seule, scellés), déconnexion d'un domaine.
// L'utilisateur est toujours celui du jeton ou de la session (garde) : aucun corps ne choisit un propriétaire (INV5).
import { checkSiteDomain } from '@runtime/core/net';
import { extensionTooOld, SITE_COOKIE_LIMITS, verifyPassword, type SiteCookie } from '@runtime/core';
import {
  adminRevokeDevice,
  connectSite,
  CookieDomainMismatchError,
  createPairingCode,
  disconnectSite,
  disconnectSiteById,
  exchangePairingCode,
  listAllDevices,
  listDevices,
  listSites,
  revokeDevice,
  storeSiteCookies,
  withActor,
  type AdminDeviceView,
  type DeviceView,
  type SiteView,
} from '@runtime/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { AttemptLimiter } from '../rate-limit.js';
import { audit, notFound, sendError, type Actor } from './guard.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ré-authentification : 5 échecs par utilisateur sur 15 min → 429 et fermeture de la session (comme les clés d'API). */
const REAUTH_MAX_FAILURES = 5;
/** Échange de code : 10 échecs par IP sur 15 min → 429 (le code a 50 bits d'aléa et vit 10 min). */
const PAIR_MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

const pairingCodeSchema = {
  type: 'object',
  required: ['currentPassword'],
  additionalProperties: false,
  properties: { currentPassword: { type: 'string', minLength: 1, maxLength: 1024 } },
} as const;

const pairSchema = {
  type: 'object',
  required: ['code', 'deviceId'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 32 },
    deviceId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
    deviceLabel: { type: 'string', minLength: 1, maxLength: 100 },
    // Version de l'extension (manifeste) : refus sous `min_extension` (GET /api/version), avant d'échanger le code ;
    // absente : refus dès que `min_extension` dépasse 0.0.0.
    extensionVersion: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const connectSchema = {
  type: 'object',
  required: ['serverUseAllowed'],
  additionalProperties: false,
  properties: { serverUseAllowed: { type: 'boolean' } },
} as const;

const cookiesSchema = {
  type: 'object',
  required: ['cookies'],
  additionalProperties: false,
  properties: {
    cookies: {
      type: 'array',
      maxItems: SITE_COOKIE_LIMITS.maxCookies,
      items: {
        type: 'object',
        required: ['name', 'value', 'domain', 'path', 'secure', 'httpOnly'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: SITE_COOKIE_LIMITS.maxNameLength },
          value: { type: 'string', maxLength: SITE_COOKIE_LIMITS.maxValueLength },
          domain: { type: 'string', minLength: 1, maxLength: 253 },
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          secure: { type: 'boolean' },
          httpOnly: { type: 'boolean' },
          sameSite: { type: 'string', enum: ['no_restriction', 'lax', 'strict', 'unspecified'] },
          expirationDate: { type: 'number', minimum: 0 },
        },
      },
    },
  },
} as const;

const iso = (d: Date | null) => d?.toISOString() ?? null;
const siteJson = (s: SiteView) => ({
  id: s.id,
  domain: s.domain,
  serverUseAllowed: s.serverUseAllowed,
  hasServerCookies: s.hasServerCookies,
  consentedAt: s.consentedAt.toISOString(),
  capturedAt: iso(s.capturedAt),
  expiresAt: iso(s.expiresAt),
});
const deviceJson = (d: DeviceView) => ({
  id: d.id,
  deviceLabel: d.deviceLabel,
  createdAt: d.createdAt.toISOString(),
  lastSeenAt: iso(d.lastSeenAt),
  expiresAt: d.expiresAt.toISOString(),
  revokedAt: iso(d.revokedAt),
});
const adminDeviceJson = (d: AdminDeviceView) => ({ ...deviceJson(d), ownerId: d.ownerId, ownerEmail: d.ownerEmail });

/** Domaine du chemin, normalisé et contrôlé (INV10) ; `null` → 400 `domain_not_allowed`. */
function domainParam(request: FastifyRequest<{ Params: { domain: string } }>): string | null {
  const verdict = checkSiteDomain(request.params.domain);
  return verdict.ok ? verdict.domain : null;
}

export function extensionRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const reauth = new AttemptLimiter({ max: REAUTH_MAX_FAILURES, windowMs: WINDOW_MS });
  const pairing = new AttemptLimiter({ max: PAIR_MAX_FAILURES, windowMs: WINDOW_MS });

  /** Opération sensible (13 § 5, ASVS 7.5.1) : mot de passe actuel exigé. Répond lui-même en cas d'échec. */
  async function reauthenticate(request: FastifyRequest, reply: FastifyReply, actor: Actor, password: string, action: string): Promise<boolean> {
    if (reauth.blocked(actor.userId)) {
      await sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
      return false;
    }
    const { rows } = await ctx.pool.query<{ password_hash: string | null }>(
      "SELECT password_hash FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'",
      [actor.userId],
    );
    const stored = rows[0]?.password_hash;
    if (stored && (await verifyPassword(stored, password))) {
      reauth.reset(actor.userId);
      return true;
    }
    const failures = reauth.fail(actor.userId);
    await audit(ctx, request, actor, { action, outcome: 'denied', meta: { reason: 'reauth_failed', failures } });
    if (failures >= REAUTH_MAX_FAILURES) {
      if (actor.sessionId) await ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [actor.sessionId, actor.userId]);
      await audit(ctx, request, actor, { action: 'auth.session_revoked', outcome: 'success', meta: { reason: 'reauth_failures' } });
      await sendError(reply, 429, 'too_many_attempts', 'trop de tentatives : session fermée');
      return false;
    }
    await sendError(reply, 403, 'reauth_failed', 'mot de passe actuel incorrect');
    return false;
  }

  // --- Console : appairage -------------------------------------------------------------------------------------------

  app.post<{ Body: { currentPassword: string } }>('/api/extension/pairing-codes', { schema: { body: pairingCodeSchema } }, async (request, reply) => {
    const actor = request.actor!;
    if (!(await reauthenticate(request, reply, actor, request.body.currentPassword, 'tunnel.pairing_code'))) return reply;
    const created = await withActor(ctx.pool, actor, (db) => createPairingCode(db, actor.userId));
    if (!created) return sendError(reply, 429, 'too_many_pairing_codes', 'trop de codes d’appairage actifs : utilisez-en un ou attendez son expiration (10 min)');
    const { code, expiresAt } = created;
    await audit(ctx, request, actor, { action: 'tunnel.pairing_code_created', outcome: 'success', meta: { expiresAt: expiresAt.toISOString() } });
    // Seule apparition du code : il n'est stocké que sous forme d'empreinte.
    return reply.code(201).send({ code, expiresAt: expiresAt.toISOString() });
  });

  app.post<{ Body: { code: string; deviceId: string; deviceLabel?: string; extensionVersion?: string } }>('/api/extension/pair', { schema: { body: pairSchema } }, async (request, reply) => {
    const { extensionVersion } = request.body;
    // Avant tout échange : une extension trop ancienne n'use ni le code d'appairage ni une tentative. Dès que
    // min_extension dépasse 0.0.0, une extension qui ne donne pas sa version est refusée aussi (sinon elle contournerait le refus).
    if (extensionTooOld(extensionVersion, ctx.minExtension)) {
      const which = extensionVersion === undefined ? 'cette extension ne donne pas sa version' : `cette version de l’extension (${extensionVersion}) est trop ancienne`;
      return sendError(reply, 426, 'extension_outdated', `${which} : la version ${ctx.minExtension} ou plus récente est requise`);
    }
    const ip = request.ip;
    if (pairing.blocked(ip)) return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
    // Tentative comptée AVANT l'échange (une rafale parallèle ne passe pas la limite), annulée d'une unité si elle
    // réussit : un succès intercalé ne remet jamais le compteur à zéro.
    pairing.fail(ip);
    const paired = await exchangePairingCode(ctx.pool, {
      code: request.body.code,
      deviceId: request.body.deviceId,
      deviceLabel: request.body.deviceLabel ?? null,
    });
    if (!paired) {
      await audit(ctx, request, null, { action: 'tunnel.pair', outcome: 'denied', meta: { reason: 'invalid_code' } });
      return sendError(reply, 400, 'invalid_pairing_code', 'code d’appairage inconnu, expiré ou déjà utilisé');
    }
    pairing.cancel(ip);
    const actor = { userId: paired.ownerId, role: 'member' as const, via: 'extension' as const };
    await audit(ctx, request, actor, { action: 'tunnel.paired', targetType: 'tunnel', targetId: paired.tunnelId, outcome: 'success', meta: { deviceLabel: paired.deviceLabel } });
    // Seule apparition du jeton (stocké en empreinte) : l'extension le garde dans chrome.storage.local.
    return reply.code(201).send({ token: paired.token, expiresAt: paired.expiresAt.toISOString(), email: paired.email, deviceLabel: paired.deviceLabel });
  });

  // --- Extension (jeton d'appareil) ----------------------------------------------------------------------------------

  app.get('/api/extension/session', async (request) => {
    const actor = request.actor!;
    const { sites, device } = await withActor(ctx.pool, actor, async (db) => ({
      sites: await listSites(db, actor.userId),
      device: (
        await db.query<{ device_label: string | null; expires_at: Date }>('SELECT device_label, expires_at FROM tunnels WHERE id = $1 AND owner_id = $2', [actor.tunnelId, actor.userId])
      ).rows[0],
    }));
    return { email: actor.email, deviceLabel: device?.device_label ?? null, expiresAt: iso(device?.expires_at ?? null), sites: sites.map(siteJson) };
  });

  app.delete('/api/extension/session', async (request, reply) => {
    const actor = request.actor!;
    await withActor(ctx.pool, actor, (db) => revokeDevice(db, actor.userId, actor.tunnelId!));
    await audit(ctx, request, actor, { action: 'tunnel.revoked', targetType: 'tunnel', targetId: actor.tunnelId!, outcome: 'success', meta: { by: 'device' } });
    return reply.code(204).send();
  });

  app.put<{ Params: { domain: string }; Body: { serverUseAllowed: boolean } }>(
    '/api/extension/sites/:domain',
    { schema: { body: connectSchema } },
    async (request, reply) => {
      const actor = request.actor!;
      const domain = domainParam(request);
      if (!domain) return sendError(reply, 400, 'domain_not_allowed', 'domaine refusé (adresse privée, nom interne ou invalide)');
      const { site, change } = await withActor(ctx.pool, actor, (db) =>
        connectSite(db, { ownerId: actor.userId, domain, serverUseAllowed: request.body.serverUseAllowed }),
      );
      if (change !== 'unchanged') {
        await audit(ctx, request, actor, {
          action: change === 'connected' ? 'site.connected' : 'site.server_use_changed',
          targetType: 'site_session',
          targetId: site.id,
          outcome: 'success',
          meta: { domain, serverUseAllowed: site.serverUseAllowed },
        });
      }
      return reply.code(change === 'connected' ? 201 : 200).send(siteJson(site));
    },
  );

  // Écart consigné à 07 § 2 (« envoie les cookies par la WSS ») : la WSS n'existe qu'à partir de la tâche 2.7. Jusque-là,
  // l'envoi passe par cette route HTTPS, authentifiée par le même jeton d'appareil (jamais une session de console),
  // avec le même schéma strict et le même scellement (`storeSiteCookies`, seul point d'écriture). Remplacement prévu
  // en 2.7 : un message WSS `cookies_sync` au même schéma appelle `storeSiteCookies`, et cette route est retirée
  // (l'extension n'envoie alors plus aucun cookie hors de la WSS).
  app.put<{ Params: { domain: string }; Body: { cookies: SiteCookie[] } }>(
    '/api/extension/sites/:domain/cookies',
    { schema: { body: cookiesSchema }, bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const actor = request.actor!;
      const domain = domainParam(request);
      if (!domain) return sendError(reply, 400, 'domain_not_allowed', 'domaine refusé (adresse privée, nom interne ou invalide)');
      let outcome: Awaited<ReturnType<typeof storeSiteCookies>>;
      try {
        outcome = await withActor(ctx.pool, actor, (db) => storeSiteCookies(db, ctx.siteSessionKek, { ownerId: actor.userId, domain, cookies: request.body.cookies }));
      } catch (error) {
        if (error instanceof CookieDomainMismatchError) return sendError(reply, 400, 'cookie_domain_mismatch', 'cookie hors du domaine connecté');
        throw error;
      }
      if (outcome === 'not_connected') return notFound(reply);
      if (outcome === 'server_use_not_allowed') {
        // Mode tunnel : les cookies restent dans le navigateur (07 § 2, assert_no_cookie_in_tunnel_mode).
        return sendError(reply, 409, 'server_use_not_allowed', 'ce domaine est en mode tunnel : aucun cookie n’est accepté par l’instance');
      }
      // Nom du champ et nombre, jamais une valeur (13 § 9).
      await audit(ctx, request, actor, { action: 'site.cookies_synced', targetType: 'site_session', outcome: 'success', meta: { domain, count: request.body.cookies.length } });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { domain: string } }>('/api/extension/sites/:domain', async (request, reply) => {
    const actor = request.actor!;
    const domain = domainParam(request);
    if (!domain) return sendError(reply, 400, 'domain_not_allowed', 'domaine refusé (adresse privée, nom interne ou invalide)');
    const removed = await withActor(ctx.pool, actor, (db) => disconnectSite(db, actor.userId, domain));
    if (removed) await audit(ctx, request, actor, { action: 'site.disconnected', targetType: 'site_session', outcome: 'success', meta: { domain } });
    return reply.code(204).send();
  });

  // --- Console : appareils et domaines -------------------------------------------------------------------------------

  app.get('/api/extension/devices', async (request) => {
    const actor = request.actor!;
    const devices = await withActor(ctx.pool, actor, (db) => listDevices(db, actor.userId));
    return { items: devices.map(deviceJson) };
  });

  app.delete<{ Params: { id: string } }>('/api/extension/devices/:id', async (request, reply) => {
    const actor = request.actor!;
    const id = request.params.id;
    if (!UUID.test(id)) return notFound(reply);
    const outcome = await withActor(ctx.pool, actor, (db) => revokeDevice(db, actor.userId, id));
    if (outcome === 'not_found') {
      const { rowCount } = await ctx.pool.query('SELECT 1 FROM tunnels WHERE id = $1', [id]);
      if (rowCount === 1) await audit(ctx, request, actor, { action: 'access.denied', targetType: 'tunnel', targetId: id, outcome: 'denied' });
      return notFound(reply);
    }
    if (outcome === 'revoked') await audit(ctx, request, actor, { action: 'tunnel.revoked', targetType: 'tunnel', targetId: id, outcome: 'success', meta: { by: 'owner' } });
    return reply.code(204).send();
  });

  app.get('/api/sites', async (request) => {
    const actor = request.actor!;
    const sites = await withActor(ctx.pool, actor, (db) => listSites(db, actor.userId));
    return { items: sites.map(siteJson) };
  });

  app.delete<{ Params: { id: string } }>('/api/sites/:id', async (request, reply) => {
    const actor = request.actor!;
    const id = request.params.id;
    if (!UUID.test(id)) return notFound(reply);
    const domain = await withActor(ctx.pool, actor, (db) => disconnectSiteById(db, actor.userId, id));
    if (domain === null) {
      const { rowCount } = await ctx.pool.query('SELECT 1 FROM site_sessions WHERE id = $1', [id]);
      if (rowCount === 1) await audit(ctx, request, actor, { action: 'access.denied', targetType: 'site_session', targetId: id, outcome: 'denied' });
      return notFound(reply);
    }
    await audit(ctx, request, actor, { action: 'site.disconnected', targetType: 'site_session', targetId: id, outcome: 'success', meta: { domain } });
    return reply.code(204).send();
  });

  // --- Admin : révocation seule (A3, INV5) ---------------------------------------------------------------------------

  app.get('/api/admin/tunnels', async (request) => ({ items: (await withActor(ctx.pool, request.actor!, (db) => listAllDevices(db))).map(adminDeviceJson) }));

  app.delete<{ Params: { id: string } }>('/api/admin/tunnels/:id', async (request, reply) => {
    const actor = request.actor!;
    const id = request.params.id;
    if (!UUID.test(id)) return notFound(reply);
    const revoked = await withActor(ctx.pool, actor, (db) => adminRevokeDevice(db, id));
    if (!revoked) return notFound(reply);
    await audit(ctx, request, actor, { action: 'tunnel.revoked', targetType: 'tunnel', targetId: id, outcome: 'success', meta: { by: 'admin', ownerId: revoked.ownerId } });
    return reply.code(204).send();
  });
}
