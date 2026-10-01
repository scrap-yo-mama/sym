// SPDX-License-Identifier: AGPL-3.0-only
// Faux fournisseur OIDC pour les tests (tâche 3.7) : découverte, autorisation (redirection immédiate), jeton (PKCE S256
// vérifié, secret du client vérifié), JWKS. ID Token RS256 signé avec une clé jetable générée au démarrage (node:crypto,
// aucune dépendance). Écoute sur 127.0.0.1, port éphémère. Les revendications de la prochaine connexion sont fixées
// par le test (`nextClaims`) ; un ID Token peut être altéré pour vérifier les refus (`tamper`).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type IdpClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  amr?: string[];
  groups?: string[];
  tid?: string;
  oid?: string;
};

export type FakeIdp = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Revendications de la prochaine connexion. */
  nextClaims: IdpClaims;
  /** Altération de l'ID Token suivant (refus attendu côté instance). */
  tamper: 'none' | 'aud' | 'iss' | 'nonce' | 'signature';
  /** Requêtes reçues (`MÉTHODE /chemin`). */
  requests: string[];
  /** Points d'entrée annoncés par la découverte à la place des siens (IdP malveillant ou compromis). */
  discoveryOverrides: Partial<Record<'token_endpoint' | 'jwks_uri' | 'userinfo_endpoint', string>>;
  close: () => Promise<void>;
};

type Pending = { clientId: string; redirectUri: string; challenge: string; nonce: string; claims: IdpClaims };

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

function jwt(privateKey: KeyObject, kid: string, payload: Record<string, unknown>, tamperSignature: boolean): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey);
  if (tamperSignature) signature[0] = (signature[0] ?? 0) ^ 0xff;
  return `${head}.${body}.${b64url(signature)}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(4).toString('hex');
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, Pending>();
  const holder: { server?: Server } = {};
  const idp: FakeIdp = {
    issuer: '',
    clientId: 'zz_test_client',
    clientSecret: `zz_test_secret_${randomBytes(12).toString('hex')}`,
    nextClaims: { sub: 'zz_test_sub' },
    tamper: 'none',
    requests: [],
    discoveryOverrides: {},
    close: () => new Promise((resolve) => (holder.server ? holder.server.close(() => resolve()) : resolve())),
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', idp.issuer);
      idp.requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          ...idp.discoveryOverrides,
        });
      }
      if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const q = url.searchParams;
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('nonce') || !q.get('state')) {
          return json(res, 400, { error: 'invalid_request' });
        }
        const code = randomBytes(16).toString('hex');
        codes.set(code, { clientId: q.get('client_id') ?? '', redirectUri: q.get('redirect_uri') ?? '', challenge: q.get('code_challenge') ?? '', nonce: q.get('nonce') ?? '', claims: idp.nextClaims });
        const target = new URL(q.get('redirect_uri') ?? '');
        target.searchParams.set('code', code);
        target.searchParams.set('state', q.get('state') ?? '');
        target.searchParams.set('iss', idp.issuer);
        res.writeHead(302, { location: target.href });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !pending ||
          form.get('grant_type') !== 'authorization_code' ||
          form.get('client_id') !== idp.clientId ||
          form.get('client_secret') !== idp.clientSecret ||
          form.get('redirect_uri') !== pending.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== pending.challenge
        ) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const now = Math.floor(Date.now() / 1000);
        const tamper = idp.tamper;
        idp.tamper = 'none';
        const idToken = jwt(
          privateKey,
          kid,
          {
            iss: tamper === 'iss' ? `${idp.issuer}/evil` : idp.issuer,
            aud: tamper === 'aud' ? 'someone_else' : idp.clientId,
            iat: now,
            exp: now + 300,
            nonce: tamper === 'nonce' ? 'zz_test_wrong_nonce' : pending.nonce,
            ...pending.claims,
          },
          tamper === 'signature',
        );
        return json(res, 200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
      }
      return json(res, 404, { error: 'not_found' });
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  holder.server = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return idp;
}
