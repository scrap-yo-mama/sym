// SPDX-License-Identifier: AGPL-3.0-only
// Réglages de sécurité et SSO (owner), page de connexion SSO publique, métadonnées de ressource protégée (RFC 9728),
// et connexion OIDC générique (13 § 7, tâche 3.7).
// OIDC : l'instance est client (relying party) avec `openid-client` 6.x (décision de 3.7, 13 § 14 : pas le plugin SSO
// de la bibliothèque). Flux code + PKCE S256, `state` et `nonce` dans un cookie scellé lié au navigateur, `iss` = URL
// de découverte, `aud` = client_id, signature vérifiée sur le JWKS (openid-client). Toute requête vers l'IdP passe par la
// garde SSRF en politique `operator-config` (destination réglée par l'owner). Identité = (issuer, sub) — `tid:oid` pour
// Entra —, JAMAIS l'e-mail : aucune liaison par adresse (assert_oidc_no_email_linking). Liaison depuis une session
// ouverte (action explicite) ou à l'acceptation d'une invitation visant cette adresse. Rôle depuis les groupes de
// l'IdP réévalué à chaque connexion, `owner` jamais attribuable. Une connexion OIDC ne dispense de la 2FA locale que si
// l'IdP atteste un second facteur (`amr`).
import {
  emailDomainAllowed,
  GRANTABLE_SCOPES,
  hashOpaqueToken,
  idpAssertsMfa,
  isOpaqueTokenFormat,
  isRole,
  kekFor,
  openSecret,
  roleFromGroups,
  sealSecret,
  SecretDecryptError,
  type Role,
} from '@runtime/core';
import { createOperatorConfigDispatcher, operatorConfigFetch } from '@runtime/core/net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { issueSession } from '../auth/better-auth.js';
import {
  readSecuritySettings,
  readSsoSettings,
  SettingsError,
  validateSso,
  writeSecuritySettings,
  writeSsoSettings,
  type SecuritySettings,
  type SsoSettings,
} from '../auth/security-settings.js';
import type { ServerContext } from '../context.js';
import { libraryHeaders, rememberDevice } from './account-helpers.js';
import { audit, identify, sendError } from './guard.js';
import { consumeInvitation } from './invitations.js';

/** Validité du cookie d'état OIDC (aller-retour chez l'IdP). */
const STATE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

type OidcState = {
  state: string;
  nonce: string;
  verifier: string;
  intent: 'login' | 'link';
  /** Liaison : l'utilisateur de la session qui a lancé l'action. */
  userId?: string;
  /** Acceptation d'une invitation par l'IdP : empreinte du jeton d'invitation. */
  invitation?: string;
  slug: string;
  exp: number;
};

const securityBody = {
  type: 'object',
  required: ['session_idle_minutes', 'session_absolute_hours', 'allowed_email_domains', 'api_key_max_lifetime_days'],
  additionalProperties: false,
  properties: {
    session_idle_minutes: { type: 'integer', minimum: 5 },
    session_absolute_hours: { type: 'integer', minimum: 1 },
    allowed_email_domains: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 253 } },
    api_key_max_lifetime_days: { type: 'integer', minimum: 1, maximum: 365 },
    audit_retention_months: { type: 'integer', minimum: 1 },
  },
} as const;

const ssoBody = {
  type: 'object',
  required: ['enabled', 'slug', 'issuer_url', 'client_id'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$' },
    label: { type: 'string', maxLength: 100 },
    issuer_url: { type: 'string', maxLength: 2048 },
    client_id: { type: 'string', maxLength: 512 },
    client_secret: { type: 'string', maxLength: 4096 },
    sso_required: { type: 'boolean' },
    jit_provisioning: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, domains: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 253 } } },
    },
    group_roles: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['group', 'role'],
        additionalProperties: false,
        properties: { group: { type: 'string', maxLength: 256 }, role: { type: 'string', enum: ['member', 'admin'] } },
      },
    },
  },
} as const;

type SsoWrite = {
  enabled: boolean;
  slug: string;
  label?: string;
  issuer_url: string;
  client_id: string;
  client_secret?: string;
  sso_required?: boolean;
  jit_provisioning?: { enabled?: boolean; domains?: string[] };
  group_roles?: { group: string; role: 'member' | 'admin' }[];
};

/** Vue de l'API : jamais le secret, seulement s'il est posé. */
const ssoView = (s: SsoSettings) => ({
  enabled: s.enabled,
  slug: s.slug,
  label: s.label,
  issuer_url: s.issuer_url,
  client_id: s.client_id,
  client_secret_set: s.client_secret_id !== null,
  sso_required: s.sso_required,
  jit_provisioning: s.jit_provisioning,
  group_roles: s.group_roles,
});

function stateCookieName(ctx: ServerContext): string {
  return ctx.publicUrl.startsWith('https://') ? '__Host-sy.oidc' : 'sy.oidc';
}

/** Cookie d'état scellé (AES-GCM, KEK `sessions`, AAD dédiée) : rien en base, lié au navigateur. */
function sealState(ctx: ServerContext, state: OidcState): string {
  const sealed = sealSecret(JSON.stringify(state), kekFor(ctx.keyring.current, 0, 'sessions'), 'oidc_state');
  return [sealed.ciphertext, sealed.nonce, sealed.dekWrapped].map((b) => b.toString('base64url')).join('.');
}

function openState(ctx: ServerContext, raw: string | undefined): OidcState | null {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [ciphertext, nonce, dekWrapped] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  try {
    const json = openSecret({ ciphertext, nonce, dekWrapped, alg: 'aes-256-gcm', kekVersion: 0 }, kekFor(ctx.keyring.current, 0, 'sessions'), 'oidc_state');
    const state = JSON.parse(json) as OidcState;
    return state.exp > Date.now() ? state : null;
  } catch (error) {
    if (error instanceof SecretDecryptError || error instanceof SyntaxError) return null;
    throw error;
  }
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  return (request.headers.cookie ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function stateCookie(ctx: ServerContext, value: string, maxAgeSeconds: number): string {
  const secure = ctx.publicUrl.startsWith('https://') ? '; Secure' : '';
  return `${stateCookieName(ctx)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function ssoRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const dispatcher = createOperatorConfigDispatcher(ctx.guard, ctx.extraCa ? { ca: ctx.extraCa } : {});
  const customFetch: oidc.CustomFetch = async (url, options) =>
    (await operatorConfigFetch(url, { method: options.method, headers: options.headers, body: options.body as never, signal: options.signal }, dispatcher)) as unknown as Response;
  let discovered: { key: string; at: number; config: oidc.Configuration } | null = null;

  async function configuration(sso: SsoSettings): Promise<oidc.Configuration> {
    const key = `${sso.issuer_url}|${sso.client_id}|${sso.client_secret_id ?? ''}`;
    if (discovered && discovered.key === key && Date.now() - discovered.at < DISCOVERY_CACHE_MS) return discovered.config;
    const secret = sso.client_secret_id && ctx.secrets ? (await ctx.secrets.get(sso.client_secret_id)).reveal() : null;
    const issuer = new URL(sso.issuer_url);
    if (issuer.protocol !== 'https:' && !ctx.oidcAllowHttp) throw new Error('issuer non https');
    const config = await oidc.discovery(issuer, sso.client_id, undefined, secret ? oidc.ClientSecretPost(secret) : oidc.None(), {
      [oidc.customFetch]: customFetch,
      timeout: 10,
      // Signature de l'ID Token vérifiée sur le JWKS de l'IdP (13 § 7), en plus de iss, aud et nonce.
      execute: [oidc.enableNonRepudiationChecks, ...(ctx.oidcAllowHttp && issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [])],
    });
    discovered = { key, at: Date.now(), config };
    return config;
  }

  const fail = (reply: FastifyReply, code: string) => reply.redirect(`${ctx.publicUrl}/login?sso_error=${encodeURIComponent(code)}`, 302);

  // --- Réglages (owner) ------------------------------------------------------------------------------------
  app.get('/api/settings/security', async () => readSecuritySettings(ctx.pool, { fresh: true }));

  app.put<{ Body: SecuritySettings }>('/api/settings/security', { schema: { body: securityBody } }, async (request, reply) => {
    const actor = request.actor!;
    try {
      const value = await writeSecuritySettings(ctx.pool, request.body);
      // 13 § 9 : nom des champs modifiés, jamais leur valeur.
      await audit(ctx, request, actor, { action: 'settings.security_updated', outcome: 'success', meta: { fields: Object.keys(request.body).sort() } });
      return value;
    } catch (error) {
      if (error instanceof SettingsError) return sendError(reply, 400, 'invalid_settings', error.message);
      throw error;
    }
  });

  app.get('/api/settings/sso', async () => {
    const sso = await readSsoSettings(ctx.pool);
    return sso ? ssoView(sso) : null;
  });

  app.put<{ Body: SsoWrite }>('/api/settings/sso', { schema: { body: ssoBody } }, async (request, reply) => {
    const actor = request.actor!;
    const body = request.body;
    let valid: Omit<SsoSettings, 'client_secret_id'>;
    try {
      valid = validateSso({
        enabled: body.enabled,
        slug: body.slug,
        label: body.label ?? '',
        issuer_url: body.issuer_url,
        client_id: body.client_id,
        sso_required: body.sso_required ?? false,
        jit_provisioning: { enabled: body.jit_provisioning?.enabled ?? false, domains: body.jit_provisioning?.domains ?? [] },
        group_roles: body.group_roles ?? [],
      });
      if (!ctx.oidcAllowHttp && new URL(valid.issuer_url).protocol !== 'https:') throw new SettingsError('issuer_url : https attendu');
    } catch (error) {
      if (error instanceof SettingsError) return sendError(reply, 400, 'invalid_settings', error.message);
      throw error;
    }
    if (!ctx.secrets) return sendError(reply, 503, 'not_ready', 'instance en cours de démarrage');
    const previous = await readSsoSettings(ctx.pool);
    let secretId = previous?.client_secret_id ?? null;
    if (body.client_secret !== undefined) {
      // Écriture seule : le secret est chiffré (INV8) ; l'ancien est supprimé.
      secretId = body.client_secret === '' ? null : await ctx.secrets.put({ ownerId: null, kind: 'oidc_client_secret', label: `oidc ${valid.slug}`, value: body.client_secret });
      if (previous?.client_secret_id) await ctx.pool.query('DELETE FROM secrets WHERE id = $1 AND owner_id IS NULL', [previous.client_secret_id]);
    }
    const value: SsoSettings = { ...valid, client_secret_id: secretId };
    await writeSsoSettings(ctx.pool, value);
    discovered = null;
    const fields = Object.keys(body).sort();
    await audit(ctx, request, actor, { action: 'settings.sso_updated', outcome: 'success', meta: { fields } });
    return ssoView(value);
  });

  // --- Public ----------------------------------------------------------------------------------------------
  app.get('/api/sso', async () => {
    const sso = await readSsoSettings(ctx.pool);
    if (!sso?.enabled) return { enabled: false, sso_required: false, providers: [] };
    return { enabled: true, sso_required: sso.sso_required, providers: [{ slug: sso.slug, label: sso.label }] };
  });

  // RFC 9728 (13 § 11) : V1 sans serveur d'autorisation (Bearer : clé d'API) ; prépare OAuth 2.1 pour MCP (V1.1).
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: `${ctx.publicUrl}/mcp`,
    authorization_servers: [],
    bearer_methods_supported: ['header'],
    scopes_supported: [...GRANTABLE_SCOPES],
  }));

  // --- OIDC : départ ---------------------------------------------------------------------------------------
  app.get<{ Querystring: { intent?: 'login' | 'link'; invitation?: string } }>(
    '/api/auth/oidc/start',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { intent: { type: 'string', enum: ['login', 'link'] }, invitation: { type: 'string', maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const sso = await readSsoSettings(ctx.pool);
      if (!sso?.enabled) return fail(reply, 'sso_disabled');
      const intent = request.query.intent ?? 'login';
      let userId: string | undefined;
      if (intent === 'link') {
        // Liaison explicite depuis une session complète de l'utilisateur lui-même, lancée depuis la console : une
        // navigation déclenchée par un autre site (Sec-Fetch-Site) est refusée (liaison par CSRF).
        const site = request.headers['sec-fetch-site'];
        if (site !== 'same-origin' && site !== 'none') return fail(reply, 'link_not_same_origin');
        const actor = await identify(ctx, request, reply);
        if (!actor || actor.via !== 'ui') return fail(reply, 'session_required');
        userId = actor.userId;
      }
      const invitation = request.query.invitation;
      if (invitation !== undefined && !isOpaqueTokenFormat(invitation)) return fail(reply, 'invitation_invalid');
      let config: oidc.Configuration;
      try {
        config = await configuration(sso);
      } catch (error) {
        request.log.warn({ code: (error as { code?: string }).code ?? 'error' }, 'découverte OIDC impossible');
        return fail(reply, 'idp_unreachable');
      }
      const state: OidcState = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
        intent,
        ...(userId ? { userId } : {}),
        ...(invitation ? { invitation: hashOpaqueToken(invitation) } : {}),
        slug: sso.slug,
        exp: Date.now() + STATE_TTL_MS,
      };
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: `${ctx.publicUrl}/api/auth/oidc/callback`,
        scope: 'openid email profile',
        response_type: 'code',
        code_challenge: await oidc.calculatePKCECodeChallenge(state.verifier),
        code_challenge_method: 'S256',
        state: state.state,
        nonce: state.nonce,
      });
      reply.header('set-cookie', stateCookie(ctx, sealState(ctx, state), STATE_TTL_MS / 1000));
      return reply.redirect(url.href, 302);
    },
  );

  // --- OIDC : retour de l'IdP ------------------------------------------------------------------------------
  app.get('/api/auth/oidc/callback', async (request, reply) => {
    // Le cookie d'état ne sert qu'une fois.
    reply.header('set-cookie', stateCookie(ctx, '', 0));
    const state = openState(ctx, readCookie(request, stateCookieName(ctx)));
    const sso = await readSsoSettings(ctx.pool);
    if (!state || !sso?.enabled || sso.slug !== state.slug) return fail(reply, 'state_invalid');
    const denied = async (reason: string, targetId?: string) => {
      await audit(ctx, request, null, { action: 'auth.login_failed', ...(targetId ? { targetType: 'user', targetId } : {}), outcome: 'denied', meta: { via: 'sso', reason } });
      return fail(reply, reason);
    };
    let claims: Record<string, unknown>;
    try {
      const config = await configuration(sso);
      const tokens = await oidc.authorizationCodeGrant(config, new URL(request.url, ctx.publicUrl), {
        pkceCodeVerifier: state.verifier,
        expectedState: state.state,
        expectedNonce: state.nonce,
        idTokenExpected: true,
      });
      claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    } catch (error) {
      request.log.warn({ code: (error as { code?: string }).code ?? (error as Error).name }, 'retour OIDC refusé');
      return denied('idp_response_invalid');
    }
    const issuer = String(claims['iss'] ?? '');
    const subject = typeof claims['tid'] === 'string' && typeof claims['oid'] === 'string' ? `${claims['tid']}:${claims['oid']}` : String(claims['sub'] ?? '');
    if (!issuer || !subject) return denied('idp_response_invalid');
    const providerId = `oidc:${sso.slug}`;
    const accountId = `${issuer}|${subject}`;
    const email = typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : null;
    const emailVerified = claims['email_verified'] === true;
    const displayName = typeof claims['name'] === 'string' ? claims['name'] : undefined;

    const linked = await ctx.pool.query<{ user_id: string }>('SELECT user_id FROM auth_accounts WHERE provider_id = $1 AND account_id = $2', [providerId, accountId]);
    let userId = linked.rows[0]?.user_id ?? null;

    if (state.intent === 'link') {
      if (!state.userId) return denied('session_required');
      if (userId && userId !== state.userId) return denied('identity_already_linked', state.userId);
      if (!userId) {
        await ctx.pool.query('INSERT INTO auth_accounts (user_id, provider_id, account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [state.userId, providerId, accountId]);
        const actor = await ctx.pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [state.userId]);
        const role = actor.rows[0]?.role;
        await audit(ctx, request, isRole(role) ? { userId: state.userId, role, via: 'ui' } : null, {
          action: 'sso.linked',
          targetType: 'user',
          targetId: state.userId,
          outcome: 'success',
          meta: { provider: providerId },
        });
      }
      return reply.redirect(`${ctx.publicUrl}/settings/account?sso=linked`, 302);
    }

    if (!userId && state.invitation) {
      // Acceptation d'une invitation par l'IdP : adresse VÉRIFIÉE par l'IdP égale à celle de l'invitation.
      if (!email || !emailVerified) return denied('invitation_invalid');
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        const accepted = await consumeInvitation(client, state.invitation, { oidc: { providerId, accountId, email, ...(displayName ? { displayName } : {}) } });
        await client.query(accepted ? 'COMMIT' : 'ROLLBACK');
        if (!accepted) return denied('invitation_invalid');
        userId = accepted.userId;
        await audit(ctx, request, { userId, role: accepted.role, via: 'sso' }, { action: 'invitation.accepted', targetType: 'invitation', targetId: accepted.invitationId, outcome: 'success', meta: { via: 'sso' } });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((error as { code?: string }).code === '23505') return denied('invitation_invalid');
        throw error;
      } finally {
        client.release();
      }
    }

    if (!userId) {
      // Création à la volée (désactivée par défaut) : jamais si l'adresse appartient déjà à un compte (aucune liaison
      // par e-mail, assert_oidc_no_email_linking).
      const jit = sso.jit_provisioning;
      const security = await readSecuritySettings(ctx.pool);
      if (!jit.enabled || !email || !emailVerified || !emailDomainAllowed(email, jit.domains) || !emailDomainAllowed(email, security.allowed_email_domains)) {
        return denied('no_account');
      }
      const exists = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
      if (exists.rowCount !== 0) return denied('no_account', exists.rows[0]!.id);
      const role = roleFromGroups(null, claims['groups'], sso.group_roles);
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        const created = await client.query<{ id: string }>(
          "INSERT INTO users (email, display_name, role, status, email_verified, email_verified_at) VALUES ($1, $2, $3, 'active', true, now()) RETURNING id",
          [email, (displayName ?? '').slice(0, 100), role],
        );
        userId = created.rows[0]!.id;
        await client.query('INSERT INTO auth_accounts (user_id, provider_id, account_id) VALUES ($1, $2, $3)', [userId, providerId, accountId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if ((error as { code?: string }).code === '23505') return denied('no_account');
        throw error;
      } finally {
        client.release();
      }
      await audit(ctx, request, { userId, role, via: 'sso' }, { action: 'user.provisioned', targetType: 'user', targetId: userId, outcome: 'success', meta: { via: 'sso', role } });
    }

    const { rows } = await ctx.pool.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    const user = rows[0];
    if (!user || user.status !== 'active' || !isRole(user.role)) return denied('account_inactive', userId);
    // Rôle réévalué à chaque connexion (13 § 7) : jamais owner, l'owner reste owner.
    const role: Role = roleFromGroups(user.role, claims['groups'], sso.group_roles);
    if (role !== user.role) {
      await ctx.pool.query("UPDATE users SET role = $2, updated_at = now() WHERE id = $1 AND role <> 'owner'", [userId, role]);
      await audit(ctx, request, null, { action: 'user.role_changed', targetType: 'user', targetId: userId, outcome: 'success', meta: { from: user.role, to: role, via: 'sso_groups' } });
    }
    const mfa = idpAssertsMfa(claims['amr']);
    const issued = await issueSession(ctx.auth, libraryHeaders(request), userId, mfa ? 'idp' : undefined);
    const pending = await ctx.pool.query<{ mfa_pending: boolean }>('SELECT mfa_pending FROM auth_sessions WHERE id = $1', [issued.sessionId]);
    const isPending = pending.rows[0]?.mfa_pending === true;
    await audit(ctx, request, { userId, role, via: 'sso' }, { action: 'auth.login', targetType: 'user', targetId: userId, outcome: 'success', meta: { via: 'sso', mfa: mfa ? 'idp' : isPending ? 'pending' : 'none' } });
    reply.header('set-cookie', issued.cookies);
    if (isPending) return reply.redirect(`${ctx.publicUrl}/login?mfa=1`, 302);
    reply.header('set-cookie', await rememberDevice(ctx, userId));
    return reply.redirect(`${ctx.publicUrl}/`, 302);
  });
}
