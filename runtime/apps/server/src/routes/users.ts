// SPDX-License-Identifier: AGPL-3.0-only
// Administration des comptes (13 § 2, § 6, 13.1) : liste, rôle, statut, suppression, lien de réinitialisation,
// révocation des accès, réinitialisation de la 2FA, transfert de propriété ; journal d'audit de l'instance.
// Règles de hiérarchie relues en base à chaque requête (rôle courant de l'acteur ET de la cible) ; un refus est audité
// `denied`. Administrer n'est pas accéder (INV5) : aucune de ces routes ne lit un contenu ni n'ouvre une session au nom
// d'autrui ; un lien de réinitialisation ne vaut que pour un compte à 2FA (le lien seul ne suffit pas à le prendre).
import {
  canActOnAccount,
  generateOpaqueToken,
  isRole,
  RESET_LINK_TTL_HOURS,
  verifyPassword,
  type AccountAction,
  type Role,
} from '@runtime/core';
import { deactivateUser, deleteOrAnonymizeUser, hasConfirmedTwoFactor, reactivateUser, removeTwoFactor, revokeUserAccess } from '@runtime/db';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { ServerContext } from '../context.js';
import { decodeCursor, encodeCursor, iso, UUID, verifySecondFactor } from './account-helpers.js';
import { audit, notFound, sendError, type Actor } from './guard.js';
import { AUDIT_COLUMNS, auditView } from './me.js';

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  mfa_enabled: boolean;
  created_at: Date;
  created_at_text: string;
  last_login_at: Date | null;
  disabled_at: Date | null;
};

const USER_COLUMNS = `u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.created_at::text AS created_at_text, u.last_login_at, u.disabled_at,
  EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS mfa_enabled`;

const userView = (r: UserRow) => ({
  id: r.id,
  email: r.email,
  display_name: r.display_name,
  role: r.role,
  status: r.status,
  mfa_enabled: r.mfa_enabled,
  created_at: r.created_at.toISOString(),
  last_login_at: iso(r.last_login_at),
  disabled_at: iso(r.disabled_at),
});

const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { cursor: { type: 'string', maxLength: 512 }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
} as const;

/** Cible d'une action d'administration (compte non supprimé), rôle relu en base ; null : 404 uniforme. */
async function targetOf(ctx: ServerContext, id: string): Promise<UserRow | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await ctx.pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}

/** Contrôle de hiérarchie ; en cas de refus, audit `denied` et 403. */
async function allowed(ctx: ServerContext, request: FastifyRequest, reply: FastifyReply, actor: Actor, target: UserRow, action: AccountAction, label: string): Promise<boolean> {
  if (isRole(target.role) && canActOnAccount({ id: actor.userId, role: actor.role }, { id: target.id, role: target.role }, action)) return true;
  await audit(ctx, request, actor, { action: label, targetType: 'user', targetId: target.id, outcome: 'denied', meta: { reason: 'hierarchy', target_role: target.role } });
  await sendError(reply, 403, 'forbidden', 'action non autorisée');
  return false;
}

async function inTransaction<T>(ctx: ServerContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function userRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { cursor?: string; limit?: number } }>('/api/users', { schema: { querystring: pageQuery } }, async (request, reply) => {
    const cursor = decodeCursor(request.query.cursor, 2);
    if (cursor === null || (cursor && !UUID.test(cursor[1]!))) return sendError(reply, 400, 'invalid_cursor', 'curseur invalide');
    const limit = request.query.limit ?? 50;
    const { rows } = await ctx.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users u WHERE u.deleted_at IS NULL
         AND ($1::timestamptz IS NULL OR (u.created_at, u.id) > ($1::timestamptz, $2::uuid))
       ORDER BY u.created_at, u.id LIMIT $3`,
      [cursor?.[0] ?? null, cursor?.[1] ?? '00000000-0000-0000-0000-000000000000', limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { users: page.map(userView), next_cursor: rows.length > limit && last ? encodeCursor(last.created_at_text, last.id) : null };
  });

  app.patch<{ Params: { id: string }; Body: { role?: 'member' | 'admin'; status?: 'active' | 'disabled' } }>(
    '/api/users/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { role: { type: 'string', enum: ['member', 'admin'] }, status: { type: 'string', enum: ['active', 'disabled'] } },
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const target = await targetOf(ctx, request.params.id);
      if (!target) return notFound(reply);
      const { role, status } = request.body;
      // Seul l'owner change un rôle ; personne ne change le sien ; l'owner ne se rétrograde pas (transfert d'abord).
      if (role !== undefined && role !== target.role && !(await allowed(ctx, request, reply, actor, target, 'set_role', 'user.role_changed'))) return reply;
      if (status !== undefined && status !== target.status && !(await allowed(ctx, request, reply, actor, target, 'manage', status === 'disabled' ? 'user.deactivated' : 'user.reactivated'))) {
        return reply;
      }
      if (status === 'active' && target.status === 'invited') return sendError(reply, 409, 'invalid_status', 'compte en attente d’invitation');
      await inTransaction(ctx, async (client) => {
        if (role !== undefined && role !== target.role) {
          await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [target.id, role]);
        }
        if (status === 'disabled' && target.status !== 'disabled') {
          const done = await deactivateUser(client, target.id, actor.userId);
          await audit(ctx, request, actor, { action: 'user.deactivated', targetType: 'user', targetId: target.id, outcome: 'success', meta: { revoked: done } });
        } else if (status === 'active' && target.status === 'disabled') {
          await reactivateUser(client, target.id);
        }
      });
      if (role !== undefined && role !== target.role) {
        await audit(ctx, request, actor, { action: 'user.role_changed', targetType: 'user', targetId: target.id, outcome: 'success', meta: { from: target.role, to: role } });
      }
      if (status === 'active' && target.status === 'disabled') {
        await audit(ctx, request, actor, { action: 'user.reactivated', targetType: 'user', targetId: target.id, outcome: 'success' });
      }
      return userView((await targetOf(ctx, target.id))!);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (request, reply) => {
    const actor = request.actor!;
    const target = await targetOf(ctx, request.params.id);
    if (!target) return notFound(reply);
    if (!(await allowed(ctx, request, reply, actor, target, 'manage', 'user.deleted'))) return reply;
    // Désactiver avant supprimer (13 § 6).
    if (target.status !== 'disabled') return sendError(reply, 409, 'user_not_disabled', 'désactivez le compte avant de le supprimer');
    const outcome = await inTransaction(ctx, (client) => deleteOrAnonymizeUser(client, target.id, actor.userId));
    await audit(ctx, request, actor, { action: 'user.deleted', targetType: 'user', targetId: target.id, outcome: 'success', meta: { mode: outcome } });
    return reply.code(204).send();
  });

  // Lien de réinitialisation copiable (13 § 4 et § 6) : jamais de mot de passe choisi par l'admin (6.4.6), et seulement
  // pour un compte à 2FA (le lien seul ne permet pas de le prendre). Toutes les sessions du compte sont fermées.
  app.post<{ Params: { id: string } }>('/api/users/:id/reset-link', async (request, reply) => {
    const actor = request.actor!;
    const target = await targetOf(ctx, request.params.id);
    if (!target) return notFound(reply);
    if (!(await allowed(ctx, request, reply, actor, target, 'manage', 'user.reset_link'))) return reply;
    if (target.status !== 'active') return sendError(reply, 409, 'user_not_active', 'compte inactif');
    if (!(await hasConfirmedTwoFactor(ctx.pool, target.id))) {
      await audit(ctx, request, actor, { action: 'user.reset_link', targetType: 'user', targetId: target.id, outcome: 'denied', meta: { reason: 'mfa_required' } });
      return sendError(reply, 409, 'mfa_required', 'lien réservé aux comptes à double authentification : utilisez la commande serveur');
    }
    const { token, hash } = generateOpaqueToken();
    const expires = await inTransaction(ctx, async (client) => {
      await client.query("DELETE FROM verifications WHERE identifier = 'reset:' || $1::text", [target.id]);
      const { rows } = await client.query<{ expires_at: Date }>(
        "INSERT INTO verifications (identifier, value, expires_at) VALUES ('reset:' || $1::text, $2, now() + make_interval(hours => $3)) RETURNING expires_at",
        [target.id, hash, RESET_LINK_TTL_HOURS],
      );
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [target.id]);
      return rows[0]!.expires_at;
    });
    await audit(ctx, request, actor, { action: 'user.reset_link', targetType: 'user', targetId: target.id, outcome: 'success' });
    return reply.code(201).send({ link: `${ctx.publicUrl}/reset-password/${token}`, expires_at: expires.toISOString() });
  });

  // Fermeture des sessions, clés et jetons de tunnel d'un compte (users:revoke_sessions) : un admin révoque, il ne voit
  // ni n'utilise (13 § 8). Sur un autre admin, c'est la seule action permise à un admin.
  app.post<{ Params: { id: string } }>('/api/users/:id/revoke-access', async (request, reply) => {
    const actor = request.actor!;
    const target = await targetOf(ctx, request.params.id);
    if (!target) return notFound(reply);
    if (!(await allowed(ctx, request, reply, actor, target, 'revoke_access', 'user.access_revoked'))) return reply;
    const revoked = await inTransaction(ctx, (client) => revokeUserAccess(client, target.id, actor.userId));
    await audit(ctx, request, actor, { action: 'user.access_revoked', targetType: 'user', targetId: target.id, outcome: 'success', meta: { revoked } });
    return reply.code(204).send();
  });

  // Réinitialisation de la 2FA d'un membre (owner pour un admin) : action d'admin journalisée, ré-enrôlement exigé.
  app.delete<{ Params: { id: string } }>('/api/users/:id/2fa', async (request, reply) => {
    const actor = request.actor!;
    const target = await targetOf(ctx, request.params.id);
    if (!target) return notFound(reply);
    if (!(await allowed(ctx, request, reply, actor, target, 'manage', 'mfa.reset'))) return reply;
    await inTransaction(ctx, async (client) => {
      await removeTwoFactor(client, target.id);
      await client.query('DELETE FROM auth_sessions WHERE user_id = $1', [target.id]);
    });
    await audit(ctx, request, actor, { action: 'mfa.reset', targetType: 'user', targetId: target.id, outcome: 'success' });
    return reply.code(204).send();
  });

  // Transfert de propriété (13 § 2) : owner seul, mot de passe ET second facteur ; l'ancien owner devient admin.
  app.post<{ Body: { to_user_id: string; current_password: string; totp_code: string } }>(
    '/api/owner/transfer',
    {
      schema: {
        body: {
          type: 'object',
          required: ['to_user_id', 'current_password', 'totp_code'],
          additionalProperties: false,
          properties: {
            to_user_id: { type: 'string', format: 'uuid' },
            current_password: { type: 'string', minLength: 1, maxLength: 1024 },
            totp_code: { type: 'string', pattern: '^\\d{6}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = request.actor!;
      const deny = async (reason: string, status = 403, code = 'forbidden', message = 'action non autorisée') => {
        await audit(ctx, request, actor, { action: 'owner.transferred', outcome: 'denied', meta: { reason } });
        return sendError(reply, status, code, message);
      };
      const { rows } = await ctx.pool.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'",
        [actor.userId],
      );
      const stored = rows[0]?.password_hash;
      if (!stored || !(await verifyPassword(stored, request.body.current_password))) return deny('reauth_failed', 403, 'reauth_failed', 'mot de passe actuel incorrect');
      if (!(await hasConfirmedTwoFactor(ctx.pool, actor.userId))) return deny('mfa_required', 403, 'mfa_required', 'activez la double authentification avant le transfert');
      if ((await verifySecondFactor(ctx, actor.userId, request.body.totp_code)) !== 'totp') return deny('invalid_code', 400, 'invalid_code', 'code invalide ou déjà utilisé');
      const target = await targetOf(ctx, request.body.to_user_id);
      if (!target || target.id === actor.userId) return notFound(reply);
      if (target.status !== 'active') return sendError(reply, 409, 'user_not_active', 'compte inactif');
      await inTransaction(ctx, async (client) => {
        // Index unique partiel `users_single_owner` : l'ancien owner descend avant que le nouveau monte.
        await client.query("UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1 AND role = 'owner'", [actor.userId]);
        await client.query("UPDATE users SET role = 'owner', updated_at = now() WHERE id = $1", [target.id]);
      });
      await audit(ctx, request, { ...actor, role: 'admin' as Role }, { action: 'owner.transferred', targetType: 'user', targetId: target.id, outcome: 'success', meta: { from: actor.userId } });
      return reply.code(204).send();
    },
  );

  // --- Journal d'audit de l'instance (13 § 9) : admin (lecture), owner (export NDJSON) --------------------------
  const auditQuery = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', maxLength: 100 },
      actor: { type: 'string', format: 'uuid' },
      outcome: { type: 'string', enum: ['success', 'denied', 'error'] },
      since: { type: 'string', format: 'date-time' },
      until: { type: 'string', format: 'date-time' },
      cursor: { type: 'string', maxLength: 512 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  } as const;
  type AuditQuery = { action?: string; actor?: string; outcome?: string; since?: string; until?: string; cursor?: string; limit?: number };

  app.get<{ Querystring: AuditQuery }>('/api/audit', { schema: { querystring: auditQuery } }, async (request, reply) => {
    const q = request.query;
    const cursor = decodeCursor(q.cursor, 1);
    if (cursor === null || (cursor && !/^\d{1,19}$/.test(cursor[0]!))) return sendError(reply, 400, 'invalid_cursor', 'curseur invalide');
    const limit = q.limit ?? 50;
    const { rows } = await ctx.pool.query<Parameters<typeof auditView>[0]>(
      `SELECT ${AUDIT_COLUMNS} FROM audit_events
       WHERE ($1::text IS NULL OR action = $1) AND ($2::uuid IS NULL OR actor_user_id = $2) AND ($3::text IS NULL OR outcome = $3)
         AND ($4::timestamptz IS NULL OR at >= $4) AND ($5::timestamptz IS NULL OR at < $5) AND ($6::bigint IS NULL OR id < $6::bigint)
       ORDER BY id DESC LIMIT $7`,
      [q.action ?? null, q.actor ?? null, q.outcome ?? null, q.since ?? null, q.until ?? null, cursor?.[0] ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { events: page.map(auditView), next_cursor: rows.length > limit && last ? encodeCursor(String(last.id)) : null };
  });

  app.get<{ Querystring: { since?: string; until?: string } }>(
    '/api/audit/export',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', format: 'date-time' }, until: { type: 'string', format: 'date-time' } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      const { since, until } = request.query;
      await audit(ctx, request, actor, { action: 'audit.exported', outcome: 'success', meta: { since: since ?? null, until: until ?? null } });
      // Flux par lots de 1 000 (mémoire bornée) ; destination : le navigateur de l'owner (INV9).
      async function* lines(): AsyncGenerator<string> {
        let after: string | null = null;
        for (;;) {
          const batch: { rows: Parameters<typeof auditView>[0][] } = await ctx.pool.query(
            `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE ($1::timestamptz IS NULL OR at >= $1) AND ($2::timestamptz IS NULL OR at < $2)
               AND ($3::bigint IS NULL OR id > $3::bigint) ORDER BY id LIMIT 1000`,
            [since ?? null, until ?? null, after],
          );
          for (const row of batch.rows) yield `${JSON.stringify(auditView(row))}\n`;
          if (batch.rows.length < 1000) return;
          after = String(batch.rows.at(-1)!.id);
        }
      }
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', 'attachment; filename="audit.ndjson"')
        .send(Readable.from(lines()));
    },
  );
}
