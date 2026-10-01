// SPDX-License-Identifier: AGPL-3.0-only
// Better Auth 1.7 limité au noyau (13 § 5) : e-mail + mot de passe, sessions d'interface. Aucun plugin de la
// bibliothèque chargé (ni admin/impersonation, ni SSO, ni oidcProvider, ni mcp, ni twoFactor : la 2FA est « maison »,
// tâche 3.7). Inscription publique fermée ; le contrôle d'accès reste dans notre code (routes/guard.ts).
// Seul ajout : `runtime-session`, notre extension SERVEUR SEULEMENT (aucun chemin HTTP), qui ouvre une session pour un
// utilisateur déjà authentifié par notre code (second facteur vérifié, connexion OIDC validée, invitation acceptée).
import { hashPassword, verifyPassword } from '@runtime/core';
import { schema, type Db } from '@runtime/db';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { betterAuth } from 'better-auth/minimal';
import type { BetterAuthPlugin } from 'better-auth/types';
import type pg from 'pg';
import { withHashedSessionTokens } from './hashed-session-adapter.js';
import { DEFAULT_SECURITY_SETTINGS, type SecuritySettings } from './security-settings.js';

/** Inactivité 12 h (glissante, plafond de la bibliothèque ; l'owner la réduit, routes/guard.ts), absolue 7 jours par défaut. */
const SESSION_IDLE_SECONDS = 12 * 3600;

/** Facteur qui a complété une session : `totp`, `backup_code`, ou `idp` (amr de l'IdP OIDC). */
export type MfaMethod = 'totp' | 'backup_code' | 'idp';

export type AuthDeps = { db: Db; pool: pg.Pool; secret: string; publicUrl: string; settings?: () => Promise<SecuritySettings> };

function sessionCookieName(publicUrl: string): string {
  return publicUrl.startsWith('https://') ? '__Host-sy.session' : 'sy.session';
}

/**
 * Extension serveur seulement : `auth.api.issueSession({ body: { userId, mfaMethod } })`. Jamais routée (better-call
 * ignore un point d'entrée sans chemin et marqué SERVER_ONLY) ; seul notre code l'appelle, après avoir lui-même établi
 * l'identité. Les crochets de création de session s'appliquent (compte actif, durée absolue, 2FA en attente).
 */
function runtimeSessionPlugin(): BetterAuthPlugin {
  return {
    id: 'runtime-session',
    endpoints: {
      issueSession: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
        const body = (ctx.body ?? {}) as { userId?: unknown; mfaMethod?: unknown };
        if (typeof body.userId !== 'string') throw new APIError('BAD_REQUEST');
        const mfaMethod = body.mfaMethod === 'totp' || body.mfaMethod === 'backup_code' || body.mfaMethod === 'idp' ? body.mfaMethod : null;
        const user = await ctx.context.internalAdapter.findUserById(body.userId);
        if (!user) throw new APIError('UNAUTHORIZED');
        const session = await ctx.context.internalAdapter.createSession(user.id, false, mfaMethod ? { mfaMethod } : {});
        if (!session) throw new APIError('UNAUTHORIZED');
        await setSessionCookie(ctx, { session, user });
        return { userId: user.id, sessionId: session.id };
      }),
    },
  };
}

export function createAuth({ db, pool, secret, publicUrl, settings }: AuthDeps) {
  const secure = publicUrl.startsWith('https://');
  const readSettings = settings ?? (async () => DEFAULT_SECURITY_SETTINGS);
  return betterAuth({
    appName: 'Scrapyomama Runtime',
    baseURL: publicUrl,
    basePath: '/api/auth',
    secret,
    trustedOrigins: [publicUrl],
    // INV9 : désactivée explicitement (défaut déjà false) ; les variables BETTER_AUTH_TELEMETRY* sont retirées (config.ts).
    telemetry: { enabled: false, debug: false },
    logger: { level: 'error' },
    database: withHashedSessionTokens(
      drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          users: schema.users,
          auth_sessions: schema.authSessions,
          auth_accounts: schema.authAccounts,
          verifications: schema.verifications,
        },
      }),
    ),
    user: { modelName: 'users', fields: { name: 'displayName' } },
    session: {
      modelName: 'auth_sessions',
      fields: { token: 'tokenHash', updatedAt: 'lastSeenAt', ipAddress: 'ip' },
      additionalFields: {
        absoluteExpiresAt: { type: 'date', required: false, input: false },
        // 2FA « maison » (3.7) : mot de passe vérifié, second facteur attendu ; facteur qui a complété la session.
        mfaPending: { type: 'boolean', required: false, input: false },
        mfaMethod: { type: 'string', required: false, input: false },
      },
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: 3600,
      // Pas de cache de session en cookie : une révocation est immédiate (13 § 5).
      cookieCache: { enabled: false },
    },
    account: { modelName: 'auth_accounts', fields: { password: 'passwordHash' }, accountLinking: { enabled: false } },
    verification: { modelName: 'verifications' },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: { hash: hashPassword, verify: ({ hash, password }) => verifyPassword(hash, password) },
    },
    advanced: {
      database: { generateId: 'uuid' },
      // Seule source d’IP : X-Forwarded-For réécrit par routes/auth.ts avec request.ip (en-têtes du client retirés).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      useSecureCookies: false,
      cookies: { session_token: { name: sessionCookieName(publicUrl) } },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
    },
    rateLimit: { enabled: true, storage: 'memory', window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 10 } } },
    databaseHooks: {
      session: {
        create: {
          // Compte désactivé ou non activé : aucune session. Durée absolue (réglage de l'owner) posée à la création.
          // Compte à 2FA confirmée : la session naît EN ATTENTE du second facteur, sauf si notre code l'a déjà vérifié
          // (`mfaMethod` posé par `issueSession`).
          before: async (session) => {
            const { rows } = await pool.query<{ status: string; mfa: boolean }>(
              `SELECT u.status, EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS mfa
               FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
              [session.userId],
            );
            const user = rows[0];
            if (user?.status !== 'active') return false;
            const { session_absolute_hours: hours } = await readSettings();
            const method = (session as { mfaMethod?: unknown }).mfaMethod;
            const verified = method === 'totp' || method === 'backup_code' || method === 'idp';
            return {
              data: {
                ...session,
                absoluteExpiresAt: new Date(Date.now() + hours * 3600 * 1000),
                mfaPending: user.mfa && !verified,
                mfaMethod: verified ? method : null,
              },
            };
          },
          after: async (session) => {
            await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [session.userId]);
          },
        },
      },
    },
    plugins: [runtimeSessionPlugin()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

type IssueSession = (input: { body: { userId: string; mfaMethod?: MfaMethod }; headers: Headers; returnHeaders: true }) => Promise<{
  headers: Headers;
  response: { userId: string; sessionId: string };
}>;

/**
 * Ouvre une session d'interface pour un utilisateur que NOTRE code vient d'authentifier (second facteur, OIDC,
 * invitation). Renvoie les en-têtes `Set-Cookie` à relayer. Lève si le compte n'est pas actif.
 */
export async function issueSession(auth: Auth, headers: Headers, userId: string, mfaMethod?: MfaMethod): Promise<{ cookies: string[]; sessionId: string }> {
  const issue = (auth.api as unknown as { issueSession: IssueSession }).issueSession;
  const { headers: out, response } = await issue({ body: { userId, ...(mfaMethod ? { mfaMethod } : {}) }, headers, returnHeaders: true });
  return { cookies: out.getSetCookie(), sessionId: response.sessionId };
}
