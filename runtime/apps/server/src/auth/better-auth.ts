// Better Auth 1.7 limité au noyau (13 § 5) : e-mail + mot de passe, sessions d'interface. Aucun plugin chargé
// (ni admin/impersonation, ni SSO, ni oidcProvider, ni mcp, ni twoFactor : la 2FA arrive en 3.7, voir README).
// Inscription publique fermée ; le contrôle d'accès reste dans notre code (routes/guard.ts).
import { hashPassword, verifyPassword } from '@runtime/core';
import { schema, type Db } from '@runtime/db';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { betterAuth } from 'better-auth/minimal';
import type pg from 'pg';
import { withHashedSessionTokens } from './hashed-session-adapter.js';

/** Inactivité 12 h (glissante), durée absolue 7 jours (13 § 5, « à valider »). */
const SESSION_IDLE_SECONDS = 12 * 3600;
const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;

export type AuthDeps = { db: Db; pool: pg.Pool; secret: string; publicUrl: string };

function sessionCookieName(publicUrl: string): string {
  return publicUrl.startsWith('https://') ? '__Host-sy.session' : 'sy.session';
}

export function createAuth({ db, pool, secret, publicUrl }: AuthDeps) {
  const secure = publicUrl.startsWith('https://');
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
      additionalFields: { absoluteExpiresAt: { type: 'date', required: false, input: false } },
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
          // Compte désactivé ou non activé : aucune session. Durée absolue posée à la création.
          before: async (session) => {
            const { rows } = await pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [session.userId]);
            if (rows[0]?.status !== 'active') return false;
            return { data: { ...session, absoluteExpiresAt: new Date(Date.now() + SESSION_ABSOLUTE_SECONDS * 1000) } };
          },
          after: async (session) => {
            await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [session.userId]);
          },
        },
      },
    },
    plugins: [],
  });
}

export type Auth = ReturnType<typeof createAuth>;
