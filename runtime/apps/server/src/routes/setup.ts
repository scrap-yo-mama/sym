// SPDX-License-Identifier: AGPL-3.0-only
// Assistant de premier démarrage (13 § 4) : jeton ADMIN_BOOTSTRAP_TOKEN (comparaison à temps constant, limite par IP),
// création de l'owner, puis 404 pour toujours (`assert_bootstrap_once`). Le jeton n'est ni stocké ni réaffiché.
import { createHash, timingSafeEqual } from 'node:crypto';
import { hashPassword, passwordPolicyViolation } from '@runtime/core';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { localeFromAcceptLanguage } from '../locale.js';
import { AttemptLimiter } from '../rate-limit.js';
import { audit, notFound, sendError } from './guard.js';

const bodySchema = {
  type: 'object',
  required: ['token', 'email', 'password'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 1024 },
    email: { type: 'string', maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    password: { type: 'string', minLength: 1, maxLength: 1024 },
    displayName: { type: 'string', maxLength: 100 },
  },
} as const;

type Body = { token: string; email: string; password: string; displayName?: string };

const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();

const SETUP_BACKUP_REMINDER =
  'Sauvegardez MASTER_KEY hors de cette plateforme : sans elle, les secrets chiffrés sont définitivement illisibles.';

export function setupRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Par IP (request.ip, voir TRUST_PROXY), 5 échecs sur 15 min, mémoire bornée.
  const failures = new AttemptLimiter({ max: 5, windowMs: 15 * 60 * 1000, maxEntries: 10_000 });

  app.post<{ Body: Body }>('/api/setup', { schema: { body: bodySchema } }, async (request, reply) => {
    if (await ctx.isInitialized()) return notFound(reply);

    if (failures.blocked(request.ip)) {
      return sendError(reply, 429, 'too_many_attempts', 'trop de tentatives, réessayez plus tard');
    }
    const fail = async (reason: string) => {
      failures.fail(request.ip);
      await audit(ctx, request, null, { action: 'setup.attempt', outcome: 'denied', meta: { reason } });
      return sendError(reply, 403, 'forbidden', 'jeton d’amorçage refusé');
    };

    const expected = ctx.bootstrapToken;
    if (!expected) return fail('token_not_configured');
    if (!timingSafeEqual(digest(request.body.token), digest(expected.reveal()))) return fail('token_mismatch');
    const email = request.body.email.trim().toLowerCase();
    if (ctx.adminEmail && email !== ctx.adminEmail) return fail('email_not_allowed');
    const violation = passwordPolicyViolation(request.body.password);
    if (violation) return sendError(reply, 400, 'weak_password', `mot de passe refusé (${violation})`);

    const passwordHash = await hashPassword(request.body.password);
    const client = await ctx.pool.connect();
    let userId: string;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name, role, status, email_verified, email_verified_at, locale)
         VALUES ($1, $2, 'owner', 'active', true, now(), $3) RETURNING id`,
        [email, request.body.displayName ?? '', localeFromAcceptLanguage(request.headers['accept-language'])],
      );
      userId = rows[0]!.id;
      await client.query(
        "INSERT INTO auth_accounts (user_id, provider_id, account_id, password_hash) VALUES ($1, 'credential', $2, $3)",
        [userId, userId, passwordHash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Owner créé entre-temps (index unique users_single_owner) : l'assistant est clos.
      if ((error as { code?: string }).code === '23505') return notFound(reply);
      throw error;
    } finally {
      client.release();
    }
    failures.reset(request.ip);
    await audit(ctx, request, { userId, role: 'owner', via: 'ui' }, { action: 'setup.owner_created', targetType: 'user', targetId: userId, outcome: 'success' });
    return reply.code(201).send({ userId, keyFingerprint: ctx.keyFingerprint, reminder: SETUP_BACKUP_REMINDER });
  });
}
