// SPDX-License-Identifier: AGPL-3.0-only
// Compte de l'appelant (13 § 5, § 7, § 9, 13.1) : identité, sessions d'interface, 2FA TOTP « maison », audit propre.
// Tout filtre par l'appelant (identité système, tables d'authentification hors runtime_app) ; l'objet d'autrui répond
// 404 comme un objet inexistant.
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  matchTotp,
  mfaRequiredFor,
  otpauthUri,
  base32Encode,
} from '@runtime/core';
import { confirmTwoFactor, consumeTotpStep, loadTwoFactor, removeTwoFactor, replaceBackupCodes, startTwoFactorEnrollment } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { AttemptLimiter } from '../rate-limit.js';
import { decodeCursor, encodeCursor, iso, reauthenticate, requireSecondFactor, twoFactorKeks, UUID } from './account-helpers.js';
import { audit, notFound, sendError } from './guard.js';

// Mot de passe actuel facultatif dans le schéma : exigé par `reauthenticate` (400 `current_password_required`) quand le
// compte en a un ; ignoré pour un compte OIDC seul (connexion de moins de 10 minutes, sinon 403 `reauth_required`).
const passwordBody = {
  type: 'object',
  additionalProperties: false,
  properties: { current_password: { type: 'string', minLength: 1, maxLength: 1024 } },
} as const;

/** Ré-authentification ET second facteur (opérations qui changent les facteurs d'un compte à 2FA, 13 § 5, 7.5.1). */
const passwordAndCodeBody = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { current_password: { type: 'string', minLength: 1, maxLength: 1024 }, code: { type: 'string', minLength: 1, maxLength: 32 } },
} as const;

const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { cursor: { type: 'string', maxLength: 512 }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
} as const;

type AuditRow = {
  id: string;
  at: Date;
  actor_user_id: string | null;
  actor_via: string;
  actor_ref: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  ip: string | null;
  user_agent: string | null;
  meta: Record<string, unknown>;
};

export const auditView = (r: AuditRow) => ({
  id: String(r.id),
  at: r.at.toISOString(),
  actor_user_id: r.actor_user_id,
  actor_via: r.actor_via,
  actor_ref: r.actor_ref,
  action: r.action,
  target_type: r.target_type,
  target_id: r.target_id,
  outcome: r.outcome,
  ip: r.ip,
  user_agent: r.user_agent,
  meta: r.meta,
});

export const AUDIT_COLUMNS = 'id, at, actor_user_id, actor_via, actor_ref, action, target_type, target_id, outcome, ip, user_agent, meta';

export function meRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Confirmation de l'enrôlement : 5 échecs par utilisateur sur 15 min. */
  const confirmFailures = new AttemptLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

  app.get('/api/me', async (request) => {
    const actor = request.actor!;
    const { rows } = await ctx.pool.query<{ display_name: string; locale: string; theme: string }>(
      'SELECT display_name, locale, theme FROM users WHERE id = $1',
      [actor.userId],
    );
    return {
      id: actor.userId,
      email: actor.email,
      displayName: rows[0]?.display_name ?? '',
      role: actor.role,
      locale: rows[0]?.locale ?? 'en',
      theme: rows[0]?.theme ?? 'system',
      via: actor.via,
      scopes: actor.scopes,
    };
  });

  // --- Sessions d'interface (13 § 5 : chacun liste et ferme les siennes, 7.5.2) -------------------------------
  app.get('/api/me/sessions', async (request) => {
    const actor = request.actor!;
    const { rows } = await ctx.pool.query<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; ip: string | null; user_agent: string | null }>(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM auth_sessions
       WHERE user_id = $1 AND expires_at > now() AND NOT mfa_pending ORDER BY created_at DESC`,
      [actor.userId],
    );
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at.toISOString(),
        last_seen_at: iso(r.last_seen_at),
        expires_at: r.expires_at.toISOString(),
        ip: r.ip,
        user_agent: r.user_agent,
        current: r.id === actor.sessionId,
      })),
    };
  });

  app.delete('/api/me/sessions', async (request, reply) => {
    const actor = request.actor!;
    const { rowCount } = await ctx.pool.query('DELETE FROM auth_sessions WHERE user_id = $1 AND id <> $2', [actor.userId, actor.sessionId]);
    await audit(ctx, request, actor, { action: 'auth.sessions_revoked', targetType: 'user', targetId: actor.userId, outcome: 'success', meta: { count: rowCount ?? 0, scope: 'others' } });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/me/sessions/:id', async (request, reply) => {
    const actor = request.actor!;
    const id = request.params.id;
    if (!UUID.test(id)) return notFound(reply);
    const { rowCount } = await ctx.pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2', [id, actor.userId]);
    if (rowCount !== 1) {
      const other = await ctx.pool.query('SELECT 1 FROM auth_sessions WHERE id = $1', [id]);
      if (other.rowCount === 1) await audit(ctx, request, actor, { action: 'access.denied', targetType: 'auth_session', targetId: id, outcome: 'denied' });
      return notFound(reply);
    }
    await audit(ctx, request, actor, { action: 'auth.session_revoked', targetType: 'auth_session', targetId: id, outcome: 'success' });
    return reply.code(204).send();
  });

  // --- 2FA TOTP (13 § 7) ------------------------------------------------------------------------------------
  app.post<{ Body: { current_password?: string } }>('/api/me/2fa/enroll', { schema: { body: passwordBody } }, async (request, reply) => {
    const actor = request.actor!;
    if (!(await reauthenticate(ctx, request, reply, actor, request.body.current_password, 'mfa.enroll'))) return reply;
    const secret = generateTotpSecret();
    try {
      if (!(await startTwoFactorEnrollment(ctx.pool, ctx.secretsKek, actor.userId, secret))) {
        return sendError(reply, 409, 'mfa_already_enabled', 'double authentification déjà active');
      }
      await audit(ctx, request, actor, { action: 'mfa.enroll_started', targetType: 'user', targetId: actor.userId, outcome: 'success' });
      // Seule apparition de la graine : elle n'est plus jamais relue par l'API.
      return { otpauth_uri: otpauthUri(secret, actor.email), secret: base32Encode(secret) };
    } finally {
      secret.fill(0);
    }
  });

  app.post<{ Body: { code: string } }>(
    '/api/me/2fa/confirm',
    { schema: { body: { type: 'object', required: ['code'], additionalProperties: false, properties: { code: { type: 'string', pattern: '^\\d{6}$' } } } } },
    async (request, reply) => {
      const actor = request.actor!;
      if (confirmFailures.blocked(actor.userId)) return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
      const state = await loadTwoFactor(ctx.pool, twoFactorKeks(ctx), actor.userId);
      if (state.status !== 'pending') return sendError(reply, 400, 'no_enrollment', 'aucun enrôlement en cours');
      const step = matchTotp(state.secret, request.body.code, { lastUsedStep: state.lastUsedStep });
      state.secret.fill(0);
      if (step === null || !(await consumeTotpStep(ctx.pool, actor.userId, step))) {
        confirmFailures.fail(actor.userId);
        await audit(ctx, request, actor, { action: 'mfa.enroll_failed', targetType: 'user', targetId: actor.userId, outcome: 'denied' });
        return sendError(reply, 400, 'invalid_code', 'code invalide ou déjà utilisé');
      }
      confirmFailures.reset(actor.userId);
      const codes = generateBackupCodes();
      await confirmTwoFactor(ctx.pool, actor.userId);
      await replaceBackupCodes(ctx.pool, actor.userId, codes.map((c) => hashBackupCode(actor.userId, c)!));
      // La session courante vient de prouver le second facteur (enrôlement forcé satisfait).
      await ctx.pool.query("UPDATE auth_sessions SET mfa_pending = false, mfa_method = 'totp' WHERE id = $1 AND user_id = $2", [actor.sessionId, actor.userId]);
      await audit(ctx, request, actor, { action: 'mfa.enabled', targetType: 'user', targetId: actor.userId, outcome: 'success' });
      return { backup_codes: codes };
    },
  );

  // Régénération des codes de secours : mot de passe ET second facteur (une session complète et le mot de passe ne
  // suffisent pas à poser ses propres codes et rendre un accès persistant).
  app.post<{ Body: { current_password?: string; code: string } }>('/api/me/2fa/backup-codes', { schema: { body: passwordAndCodeBody } }, async (request, reply) => {
    const actor = request.actor!;
    if (!(await reauthenticate(ctx, request, reply, actor, request.body.current_password, 'mfa.backup_codes'))) return reply;
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM two_factor WHERE user_id = $1 AND confirmed_at IS NOT NULL', [actor.userId]);
    if (rowCount !== 1) return sendError(reply, 409, 'mfa_not_enabled', 'double authentification inactive');
    if (!(await requireSecondFactor(ctx, request, reply, actor, request.body.code, 'mfa.backup_codes'))) return reply;
    const codes = generateBackupCodes();
    await replaceBackupCodes(ctx.pool, actor.userId, codes.map((c) => hashBackupCode(actor.userId, c)!));
    await audit(ctx, request, actor, { action: 'mfa.backup_codes_regenerated', targetType: 'user', targetId: actor.userId, outcome: 'success' });
    return { backup_codes: codes };
  });

  app.delete<{ Body: { current_password?: string; code: string } }>(
    '/api/me/2fa',
    { schema: { body: passwordAndCodeBody } },
    async (request, reply) => {
      const actor = request.actor!;
      if (mfaRequiredFor(ctx.mfaEnforced, actor.role)) {
        await audit(ctx, request, actor, { action: 'mfa.disable', outcome: 'denied', meta: { reason: 'mfa_enforced' } });
        return sendError(reply, 403, 'mfa_enforced', 'la double authentification est exigée sur cette instance');
      }
      if (!(await reauthenticate(ctx, request, reply, actor, request.body.current_password, 'mfa.disable'))) return reply;
      if (!(await requireSecondFactor(ctx, request, reply, actor, request.body.code, 'mfa.disable'))) return reply;
      await removeTwoFactor(ctx.pool, actor.userId);
      await audit(ctx, request, actor, { action: 'mfa.disabled', targetType: 'user', targetId: actor.userId, outcome: 'success' });
      return reply.code(204).send();
    },
  );

  // --- Audit propre (13 § 9 : tous les rôles lisent leurs propres événements) --------------------------------
  app.get<{ Querystring: { cursor?: string; limit?: number } }>('/api/me/audit', { schema: { querystring: pageQuery } }, async (request, reply) => {
    const actor = request.actor!;
    const cursor = decodeCursor(request.query.cursor, 1);
    if (cursor === null || (cursor && !/^\d{1,19}$/.test(cursor[0]!))) return sendError(reply, 400, 'invalid_cursor', 'curseur invalide');
    const limit = request.query.limit ?? 50;
    const { rows } = await ctx.pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE actor_user_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
       ORDER BY id DESC LIMIT $3`,
      [actor.userId, cursor?.[0] ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { events: page.map(auditView), next_cursor: rows.length > limit && last ? encodeCursor(String(last.id)) : null };
  });
}
