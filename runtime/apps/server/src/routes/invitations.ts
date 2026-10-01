// SPDX-License-Identifier: AGPL-3.0-only
// Invitations (13 § 6) : uniquement sur invitation, adresse exacte et rôle (`admin` seulement si l'invitant est
// l'owner), 48 h, usage unique, renvoyable, révocable, jeton haché en base. Avec SMTP : lien par e-mail ; sans SMTP :
// lien copiable affiché une fois à l'admin. Acceptation publique : réponse, message et délai IDENTIQUES pour un jeton
// inconnu, expiré, révoqué ou consommé (assert_invitation_single_use, 6.3.8) ; aucun compte créé dans ces cas.
// Renvoi et révocation suivent la même hiérarchie que la création (une invitation « admin » relève de l'owner).
// `sso_required` (13 § 7) : acceptation par l'IdP seulement, jamais par un mot de passe local.
import {
  canInviteAs,
  emailDomainAllowed,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  INVITATION_TTL_HOURS,
  isOpaqueTokenFormat,
  passwordPolicyViolation,
  type Role,
} from '@runtime/core';
import { isMailAddress } from '@runtime/core/net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { issueSession } from '../auth/better-auth.js';
import { readSecuritySettings, readSsoSettings } from '../auth/security-settings.js';
import type { ServerContext } from '../context.js';
import { AttemptLimiter, ipBucket } from '../rate-limit.js';
import { iso, libraryHeaders, meView, rememberDevice, sendAccountMail, smtpConfigured, UUID } from './account-helpers.js';
import { audit, notFound, sendError } from './guard.js';

type InvitationRow = {
  id: string;
  email: string;
  role: 'member' | 'admin';
  invited_by: string | null;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
};

const COLUMNS = 'id, email, role, invited_by, expires_at, created_at, accepted_at, revoked_at';

const view = (r: InvitationRow) => ({
  id: r.id,
  email: r.email,
  role: r.role,
  invited_by: r.invited_by,
  expires_at: r.expires_at.toISOString(),
  created_at: r.created_at.toISOString(),
  accepted_at: iso(r.accepted_at),
  revoked_at: iso(r.revoked_at),
});

/** Réponse unique de l'acceptation refusée (jeton inconnu, expiré, révoqué, consommé, adresse déjà prise). */
const INVITATION_INVALID = { code: 'invitation_invalid', message: 'invitation invalide ou expirée' };

function invitationLink(ctx: Pick<ServerContext, 'publicUrl'>, token: string): string {
  return `${ctx.publicUrl}/invite/${token}`;
}

async function deliver(ctx: ServerContext, request: FastifyRequest, row: InvitationRow, token: string): Promise<{ emailed: boolean; link: string | null }> {
  const link = invitationLink(ctx, token);
  if (!(await smtpConfigured(ctx))) return { emailed: false, link };
  const outcome = await sendAccountMail(
    ctx,
    request,
    row.email,
    'Scrapyomama Runtime: invitation',
    `You are invited to a Scrapyomama Runtime instance (${ctx.publicUrl}). This link is valid for ${INVITATION_TTL_HOURS} hours and works once:\n${link}\n\n` +
      `Vous êtes invité sur une instance Scrapyomama Runtime (${ctx.publicUrl}). Ce lien est valable ${INVITATION_TTL_HOURS} h et ne sert qu’une fois :\n${link}\n`,
  );
  // Envoi impossible (relais en panne) : le lien reste copiable par l'admin, qui peut aussi renvoyer plus tard.
  return outcome === 'sent' ? { emailed: true, link: null } : { emailed: false, link };
}

/**
 * Consomme une invitation valide (verrou de ligne) et crée le compte actif. Renvoie l'utilisateur créé, ou null pour
 * tout jeton inutilisable : aucune ligne `users` n'est alors écrite. `account` : liaison OIDC (issuer, sub) ou mot de passe.
 */
export async function consumeInvitation(
  client: pg.ClientBase,
  tokenHash: string,
  account: { passwordHash: string; displayName?: string } | { oidc: { providerId: string; accountId: string; email: string; displayName?: string } },
): Promise<{ userId: string; role: Role; email: string; invitationId: string } | null> {
  const { rows } = await client.query<{ id: string; email: string; role: 'member' | 'admin' }>(
    `SELECT id, email, role FROM invitations
     WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
    [tokenHash],
  );
  const invitation = rows[0];
  if (!invitation) return null;
  // Liaison OIDC à l'acceptation : seulement si l'adresse vérifiée de l'IdP est EXACTEMENT celle de l'invitation.
  if ('oidc' in account && account.oidc.email.toLowerCase() !== invitation.email.toLowerCase()) return null;
  const taken = await client.query('SELECT 1 FROM users WHERE email = $1', [invitation.email]);
  if (taken.rowCount !== 0) return null;
  const displayName = ('oidc' in account ? account.oidc.displayName : account.displayName) ?? '';
  const created = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name, role, status, email_verified, email_verified_at) VALUES ($1, $2, $3, 'active', true, now()) RETURNING id`,
    [invitation.email, displayName.slice(0, 100), invitation.role],
  );
  const userId = created.rows[0]!.id;
  if ('oidc' in account) {
    await client.query('INSERT INTO auth_accounts (user_id, provider_id, account_id) VALUES ($1, $2, $3)', [userId, account.oidc.providerId, account.oidc.accountId]);
  } else {
    await client.query("INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)", [userId, userId, account.passwordHash]);
  }
  await client.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);
  return { userId, role: invitation.role, email: invitation.email, invitationId: invitation.id };
}

export function invitationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Acceptation : 10 échecs par IP sur 15 min (jetons de 256 bits : la limite vise le bruit, pas la devinette). */
  const acceptFailures = new AttemptLimiter({ max: 10, windowMs: 15 * 60 * 1000, maxEntries: 10_000 });

  app.get('/api/invitations', async () => {
    const { rows } = await ctx.pool.query<InvitationRow>(
      `SELECT ${COLUMNS} FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 500`,
    );
    return { invitations: rows.map(view) };
  });

  app.post<{ Body: { email: string; role: 'member' | 'admin' } }>(
    '/api/invitations',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'role'],
          additionalProperties: false,
          properties: { email: { type: 'string', maxLength: 254 }, role: { type: 'string', enum: ['member', 'admin'] } },
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const email = request.body.email.trim().toLowerCase();
      const role = request.body.role;
      if (!canInviteAs(actor.role, role)) {
        await audit(ctx, request, actor, { action: 'invitation.created', outcome: 'denied', meta: { reason: 'role', role } });
        return sendError(reply, 403, 'forbidden', 'action non autorisée');
      }
      if (!isMailAddress(email)) return sendError(reply, 400, 'invalid_email', 'adresse invalide');
      if (!emailDomainAllowed(email, (await readSecuritySettings(ctx.pool)).allowed_email_domains)) {
        return sendError(reply, 400, 'email_domain_not_allowed', 'domaine non autorisé sur cette instance');
      }
      if ((await ctx.pool.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount !== 0) return sendError(reply, 409, 'user_exists', 'un compte existe déjà pour cette adresse');
      const pending = await ctx.pool.query('SELECT 1 FROM invitations WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()', [email]);
      if (pending.rowCount !== 0) return sendError(reply, 409, 'invitation_pending', 'invitation déjà en cours : renvoyez-la');
      const { token, hash } = generateOpaqueToken();
      const { rows } = await ctx.pool.query<InvitationRow>(
        `INSERT INTO invitations (email, role, invited_by, token_hash, expires_at, sent_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), now()) RETURNING ${COLUMNS}`,
        [email, role, actor.userId, hash, INVITATION_TTL_HOURS],
      );
      const row = rows[0]!;
      const delivery = await deliver(ctx, request, row, token);
      await audit(ctx, request, actor, { action: 'invitation.created', targetType: 'invitation', targetId: row.id, outcome: 'success', meta: { role, emailed: delivery.emailed } });
      return reply.code(201).send({ ...view(row), ...delivery });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/invitations/:id', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const current = await ctx.pool.query<{ role: 'member' | 'admin' }>('SELECT role FROM invitations WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [request.params.id]);
    const role = current.rows[0]?.role;
    if (!role) return notFound(reply);
    if (!canInviteAs(actor.role, role)) {
      await audit(ctx, request, actor, { action: 'invitation.revoked', targetType: 'invitation', targetId: request.params.id, outcome: 'denied', meta: { reason: 'role', role } });
      return sendError(reply, 403, 'forbidden', 'action non autorisée');
    }
    const { rowCount } = await ctx.pool.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [request.params.id]);
    if (rowCount !== 1) return notFound(reply);
    await audit(ctx, request, actor, { action: 'invitation.revoked', targetType: 'invitation', targetId: request.params.id, outcome: 'success' });
    return reply.code(204).send();
  });

  // Renvoi : nouveau jeton (l'ancien lien ne sert plus), nouvelle échéance de 48 h.
  app.post<{ Params: { id: string } }>('/api/invitations/:id/resend', async (request, reply) => {
    const actor = request.actor!;
    if (!UUID.test(request.params.id)) return notFound(reply);
    const current = await ctx.pool.query<{ role: 'member' | 'admin' }>('SELECT role FROM invitations WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [request.params.id]);
    const role = current.rows[0]?.role;
    if (!role) return notFound(reply);
    if (!canInviteAs(actor.role, role)) {
      await audit(ctx, request, actor, { action: 'invitation.resent', targetType: 'invitation', targetId: request.params.id, outcome: 'denied', meta: { reason: 'role', role } });
      return sendError(reply, 403, 'forbidden', 'action non autorisée');
    }
    const { token, hash } = generateOpaqueToken();
    const { rows } = await ctx.pool.query<InvitationRow>(
      `UPDATE invitations SET token_hash = $2, sent_at = now(), expires_at = now() + make_interval(hours => $3)
       WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING ${COLUMNS}`,
      [request.params.id, hash, INVITATION_TTL_HOURS],
    );
    const row = rows[0];
    if (!row) return notFound(reply);
    const delivery = await deliver(ctx, request, row, token);
    await audit(ctx, request, actor, { action: 'invitation.resent', targetType: 'invitation', targetId: row.id, outcome: 'success', meta: { emailed: delivery.emailed } });
    return { ...view(row), ...delivery };
  });

  app.post<{ Body: { token: string; password: string; display_name?: string } }>(
    '/api/invitations/accept',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          additionalProperties: false,
          properties: {
            token: { type: 'string', minLength: 1, maxLength: 1024 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
            display_name: { type: 'string', maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const ipKey = ipBucket(request.ip);
      if (acceptFailures.blocked(ipKey)) return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
      // SSO exigé : l'invitation s'accepte par l'IdP (`/api/auth/oidc/start?invitation=…`), jamais par un mot de passe local.
      // Refus indépendant du jeton : aucun indice sur sa validité.
      const sso = await readSsoSettings(ctx.pool);
      if (sso?.enabled && sso.sso_required) {
        await audit(ctx, request, null, { action: 'invitation.accepted', outcome: 'denied', meta: { reason: 'sso_required' } });
        return sendError(reply, 403, 'sso_required', 'acceptez l’invitation par le fournisseur d’identité de l’instance');
      }
      const violation = passwordPolicyViolation(request.body.password);
      if (violation) return sendError(reply, 400, 'weak_password', `mot de passe refusé (${violation})`);
      // Hachage AVANT tout contrôle du jeton : même délai pour un jeton valide ou non (6.3.8).
      const passwordHash = await hashPassword(request.body.password);
      const token = request.body.token;
      const client = await ctx.pool.connect();
      let accepted: Awaited<ReturnType<typeof consumeInvitation>>;
      try {
        await client.query('BEGIN');
        accepted = isOpaqueTokenFormat(token)
          ? await consumeInvitation(client, hashOpaqueToken(token), { passwordHash, ...(request.body.display_name ? { displayName: request.body.display_name } : {}) })
          : null;
        await client.query(accepted ? 'COMMIT' : 'ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        // Deux acceptations simultanées : la seconde bute sur l'unicité de l'adresse → même réponse qu'un jeton consommé.
        if ((error as { code?: string }).code !== '23505') throw error;
        accepted = null;
      } finally {
        client.release();
      }
      if (!accepted) {
        acceptFailures.fail(ipKey);
        await audit(ctx, request, null, { action: 'invitation.accepted', outcome: 'denied', meta: { reason: 'invalid_token' } });
        return sendError(reply, 400, INVITATION_INVALID.code, INVITATION_INVALID.message);
      }
      const actor = { userId: accepted.userId, role: accepted.role, via: 'ui' as const };
      await audit(ctx, request, actor, { action: 'invitation.accepted', targetType: 'invitation', targetId: accepted.invitationId, outcome: 'success', meta: { role: accepted.role } });
      // Session d'interface (nouveau jeton) ; si MFA_ENFORCED le concerne, le garde force l'enrôlement avant toute autre route.
      const issued = await issueSession(ctx.auth, libraryHeaders(request), accepted.userId);
      reply.header('set-cookie', [...issued.cookies, await rememberDevice(ctx, accepted.userId)]);
      return meView(ctx, { userId: accepted.userId, email: accepted.email, role: accepted.role, via: 'ui', scopes: null });
    },
  );
}
