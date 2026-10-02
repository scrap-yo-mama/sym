// SPDX-License-Identifier: AGPL-3.0-only
// Profils de proxy nommés (cdc/sym-browser 04c § 2.2, BINV6) et identifiants de proxy en ligne d'une session. Utilisateur et
// mot de passe scellés ensemble par l'enveloppe AES-256-GCM de la tâche 0.3 (`@sym-browser/core`), AAD
// `proxy_profile|tenantId|profileId` (ou `session_proxy|tenantId|sessionId`), stockés en texte dans
// `proxy_profiles.credentials_encrypted` (table de la tâche 0.2). Le nœud seul les ouvre, en mémoire, au démarrage d'une
// session ; les réponses d'API n'affichent que `passwordSet` et l'utilisateur masqué (`ab***`).
// Le stockage est une interface (`ProxyProfileStore`) : la mémoire pour les tests, PostgreSQL branché par la passerelle
// (routes `/v1/proxy-profiles`, tâche 2.2) sur le miroir Drizzle `proxyProfiles` de `@sym-browser/db`.
import { randomUUID } from 'node:crypto';
import {
  Secret,
  SecretDecryptError,
  openSecret,
  proxyProfileAad,
  sealSecret,
  secretValues,
  sessionProxyAad,
  type Kek,
  type SealedValue,
} from '@sym-browser/core';
import { UPSTREAM_PROXY_KINDS, type UpstreamProxy, type UpstreamProxyKind, type UpstreamProxyType } from '@sym/contracts/browser';
import { EgressPolicyError } from '../policy.js';
import { checkUpstreamFields, type UpstreamProxyConfig } from './dialer.js';

/** KEK courante et, pendant un changement de `MASTER_KEY`, la précédente (choisie par la version du scellé). */
export type ProxyProfileKeys = { current: Kek; previous?: Kek };

/** Ligne de `proxy_profiles` (colonnes du miroir Drizzle de la tâche 0.2). */
export type StoredProxyProfile = {
  id: string;
  tenantId: string;
  name: string;
  type: UpstreamProxyType;
  kind: UpstreamProxyKind | null;
  host: string;
  port: number;
  credentialsEncrypted: string | null;
  dnsViaProxy: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export interface ProxyProfileStore {
  get(tenantId: string, id: string): Promise<StoredProxyProfile | undefined>;
  list(tenantId: string): Promise<StoredProxyProfile[]>;
  insert(row: StoredProxyProfile): Promise<void>;
  update(row: StoredProxyProfile): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

/** Vue d'API d'un profil : jamais de mot de passe, utilisateur masqué. */
export type ProxyProfileView = {
  id: string;
  name: string;
  type: UpstreamProxyType;
  kind?: UpstreamProxyKind;
  host: string;
  port: number;
  username?: string;
  passwordSet: boolean;
  dnsViaProxy: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProxyProfileInput = {
  name: string;
  type: UpstreamProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  kind?: UpstreamProxyKind;
  dnsViaProxy?: boolean;
};

/** Correctif (`PATCH`) : champ absent conservé ; `username` ou `password` à `null` efface les identifiants. */
export type ProxyProfilePatch = Partial<Omit<ProxyProfileInput, 'username' | 'password' | 'kind'>> & {
  username?: string | null;
  password?: string | null;
  kind?: UpstreamProxyKind | null;
};

/** Profil ouvert par le nœud pour une session (mot de passe en `Secret`). */
export type OpenedProxyProfile = UpstreamProxyConfig & { dnsViaProxy: boolean };

export class ProxyProfileNotFoundError extends Error {
  override name = 'ProxyProfileNotFoundError';
  readonly code = 'not_found';
  constructor() {
    super('profil de proxy introuvable');
  }
}

/** Utilisateur masqué : deux premiers caractères puis `***` (04c § 2.2). */
export function maskUsername(username: string): string {
  return username.length < 2 ? '***' : `${username.slice(0, 2)}***`;
}

/** Format texte d'une valeur scellée (`credentials_encrypted`) : JSON versionné, champs binaires en base64. */
export function serializeSealed(sealed: SealedValue): string {
  return JSON.stringify({
    v: 1,
    alg: sealed.alg,
    kekVersion: sealed.kekVersion,
    nonce: sealed.nonce.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    dekWrapped: sealed.dekWrapped.toString('base64'),
  });
}

export function parseSealed(text: string): SealedValue {
  let raw: { v?: unknown; alg?: unknown; kekVersion?: unknown; nonce?: unknown; ciphertext?: unknown; dekWrapped?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new SecretDecryptError();
  }
  if (raw.v !== 1 || typeof raw.alg !== 'string' || typeof raw.kekVersion !== 'number' || typeof raw.nonce !== 'string' || typeof raw.ciphertext !== 'string' || typeof raw.dekWrapped !== 'string') {
    throw new SecretDecryptError();
  }
  return {
    alg: raw.alg,
    kekVersion: raw.kekVersion,
    nonce: Buffer.from(raw.nonce, 'base64'),
    ciphertext: Buffer.from(raw.ciphertext, 'base64'),
    dekWrapped: Buffer.from(raw.dekWrapped, 'base64'),
  };
}

type Credentials = { username: string; password?: string };

function sealCredentials(credentials: Credentials, keys: ProxyProfileKeys, aad: string): string {
  return serializeSealed(sealSecret(JSON.stringify(credentials), keys.current, aad));
}

/** Ouvre des identifiants scellés ; le mot de passe est inscrit au registre de masquage des journaux (couche 3). */
function openCredentials(text: string, keys: ProxyProfileKeys, aad: string): Credentials {
  const sealed = parseSealed(text);
  const kek = [keys.current, keys.previous].find((k) => k?.version === sealed.kekVersion);
  if (kek === undefined) throw new SecretDecryptError();
  const parsed = JSON.parse(openSecret(sealed, kek, aad)) as Credentials;
  if (parsed.password !== undefined) secretValues.add(parsed.password);
  return parsed;
}

function checkProfile(input: ProxyProfileInput): string {
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 200) throw new EgressPolicyError('name', 'nom non vide de 200 caractères au plus attendu');
  if (input.dnsViaProxy !== undefined && typeof input.dnsViaProxy !== 'boolean') throw new EgressPolicyError('dnsViaProxy', 'booléen attendu');
  if (input.password !== undefined && typeof input.password !== 'string') throw new EgressPolicyError('password', 'chaîne attendue');
  if (input.kind !== undefined && !(UPSTREAM_PROXY_KINDS as readonly unknown[]).includes(input.kind)) throw new EgressPolicyError('kind', '`isp`, `datacenter` ou `enterprise` attendu');
  return checkUpstreamFields(input, '', input.password === undefined ? undefined : Buffer.byteLength(input.password));
}

function view(row: StoredProxyProfile, credentials: Credentials | undefined): ProxyProfileView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ...(row.kind === null ? {} : { kind: row.kind }),
    host: row.host,
    port: row.port,
    ...(credentials === undefined ? {} : { username: maskUsername(credentials.username) }),
    passwordSet: credentials?.password !== undefined,
    dnsViaProxy: row.dnsViaProxy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type ProxyProfilesOptions = {
  store: ProxyProfileStore;
  keys: ProxyProfileKeys;
  newId?: () => string;
  now?: () => Date;
};

export type ProxyProfiles = {
  create(tenantId: string, input: ProxyProfileInput): Promise<ProxyProfileView>;
  get(tenantId: string, id: string): Promise<ProxyProfileView | undefined>;
  list(tenantId: string): Promise<ProxyProfileView[]>;
  update(tenantId: string, id: string, patch: ProxyProfilePatch): Promise<ProxyProfileView>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Nœud seulement : identifiants ouverts en mémoire pour le démarrage d'une session. */
  open(tenantId: string, id: string): Promise<OpenedProxyProfile>;
};

export function createProxyProfiles(options: ProxyProfilesOptions): ProxyProfiles {
  const { store, keys } = options;
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const aadOf = (row: { tenantId: string; id: string }) => proxyProfileAad({ tenantId: row.tenantId, profileId: row.id });
  const credentialsOf = (row: StoredProxyProfile): Credentials | undefined =>
    row.credentialsEncrypted === null ? undefined : openCredentials(row.credentialsEncrypted, keys, aadOf(row));
  const assertUniqueName = async (tenantId: string, name: string, except?: string): Promise<void> => {
    if ((await store.list(tenantId)).some((p) => p.name === name && p.id !== except)) throw new EgressPolicyError('name', 'nom déjà pris par un autre profil de ce client');
  };

  return {
    create: async (tenantId, input) => {
      const host = checkProfile(input);
      const name = input.name.trim();
      await assertUniqueName(tenantId, name);
      const at = now();
      const id = newId();
      const credentials = input.username === undefined ? undefined : { username: input.username, ...(input.password === undefined ? {} : { password: input.password }) };
      const row: StoredProxyProfile = {
        id,
        tenantId,
        name,
        type: input.type,
        kind: input.kind ?? null,
        host,
        port: input.port,
        credentialsEncrypted: credentials === undefined ? null : sealCredentials(credentials, keys, aadOf({ tenantId, id })),
        dnsViaProxy: input.dnsViaProxy ?? true,
        createdAt: at,
        updatedAt: at,
      };
      await store.insert(row);
      return view(row, credentials);
    },
    get: async (tenantId, id) => {
      const row = await store.get(tenantId, id);
      return row === undefined ? undefined : view(row, credentialsOf(row));
    },
    list: async (tenantId) => (await store.list(tenantId)).map((row) => view(row, credentialsOf(row))),
    update: async (tenantId, id, patch) => {
      const row = await store.get(tenantId, id);
      if (row === undefined) throw new ProxyProfileNotFoundError();
      const current = credentialsOf(row);
      const username = patch.username === undefined ? current?.username : (patch.username ?? undefined);
      const password = patch.password === undefined ? current?.password : (patch.password ?? undefined);
      const merged: ProxyProfileInput = {
        name: patch.name ?? row.name,
        type: patch.type ?? row.type,
        host: patch.host ?? row.host,
        port: patch.port ?? row.port,
        ...(username === undefined ? {} : { username }),
        ...(password === undefined ? {} : { password }),
        ...((patch.kind === undefined ? row.kind : patch.kind) === null ? {} : { kind: (patch.kind === undefined ? row.kind : patch.kind) as UpstreamProxyKind }),
        dnsViaProxy: patch.dnsViaProxy ?? row.dnsViaProxy,
      };
      const host = checkProfile(merged);
      await assertUniqueName(tenantId, merged.name.trim(), id);
      const credentials = username === undefined ? undefined : { username, ...(password === undefined ? {} : { password }) };
      const next: StoredProxyProfile = {
        ...row,
        name: merged.name.trim(),
        type: merged.type,
        kind: merged.kind ?? null,
        host,
        port: merged.port,
        credentialsEncrypted: credentials === undefined ? null : sealCredentials(credentials, keys, aadOf(row)),
        dnsViaProxy: merged.dnsViaProxy ?? true,
        updatedAt: now(),
      };
      await store.update(next);
      return view(next, credentials);
    },
    remove: (tenantId, id) => store.delete(tenantId, id),
    open: async (tenantId, id) => {
      const row = await store.get(tenantId, id);
      if (row === undefined) throw new EgressPolicyError('egress.upstream.profileId', 'profil de proxy inconnu pour ce client');
      const credentials = credentialsOf(row);
      return {
        type: row.type,
        host: row.host,
        port: row.port,
        ...(row.kind === null ? {} : { kind: row.kind }),
        ...(credentials === undefined ? {} : { username: credentials.username }),
        ...(credentials?.password === undefined ? {} : { password: new Secret(credentials.password) }),
        dnsViaProxy: row.dnsViaProxy,
      };
    },
  };
}

/** Stockage en mémoire (tests, mode `all` sans base pendant le développement). */
export function createMemoryProxyProfileStore(): ProxyProfileStore {
  const rows = new Map<string, StoredProxyProfile>();
  const key = (tenantId: string, id: string) => `${tenantId}|${id}`;
  return {
    get: async (tenantId, id) => {
      const row = rows.get(key(tenantId, id));
      return row === undefined ? undefined : { ...row };
    },
    list: async (tenantId) => [...rows.values()].filter((r) => r.tenantId === tenantId).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r })),
    insert: async (row) => {
      if (rows.has(key(row.tenantId, row.id))) throw new Error('profil de proxy déjà présent');
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    update: async (row) => {
      if (!rows.has(key(row.tenantId, row.id))) throw new ProxyProfileNotFoundError();
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    delete: async (tenantId, id) => rows.delete(key(tenantId, id)),
  };
}

/** Proxy en ligne tel que stocké dans `sessions.options` : identifiants scellés, utilisateur masqué. */
export type StoredInlineUpstream = {
  type: UpstreamProxyType;
  host: string;
  port: number;
  kind?: UpstreamProxyKind;
  username?: string;
  passwordSet: boolean;
  credentialsEncrypted?: string;
};

/** Scelle un proxy en ligne pour la base (AAD `session_proxy|tenantId|sessionId`) ; effacé à la fin de la session. */
export function sealInlineUpstream(upstream: UpstreamProxy, keys: ProxyProfileKeys, row: { tenantId: string; sessionId: string }): StoredInlineUpstream {
  const host = checkUpstreamFields(upstream, 'egress.upstream.', upstream.password === undefined ? undefined : Buffer.byteLength(upstream.password));
  const credentials = upstream.username === undefined ? undefined : { username: upstream.username, ...(upstream.password === undefined ? {} : { password: upstream.password }) };
  return {
    type: upstream.type,
    host,
    port: upstream.port,
    ...(upstream.kind === undefined ? {} : { kind: upstream.kind }),
    ...(credentials === undefined ? {} : { username: maskUsername(credentials.username), credentialsEncrypted: sealCredentials(credentials, keys, sessionProxyAad(row)) }),
    passwordSet: credentials?.password !== undefined,
  };
}

/** Rouvre un proxy en ligne scellé (nœud seulement). */
export function openInlineUpstream(stored: StoredInlineUpstream, keys: ProxyProfileKeys, row: { tenantId: string; sessionId: string }): UpstreamProxyConfig {
  const credentials = stored.credentialsEncrypted === undefined ? undefined : openCredentials(stored.credentialsEncrypted, keys, sessionProxyAad(row));
  return {
    type: stored.type,
    host: stored.host,
    port: stored.port,
    ...(stored.kind === undefined ? {} : { kind: stored.kind }),
    ...(credentials === undefined ? {} : { username: credentials.username }),
    ...(credentials?.password === undefined ? {} : { password: new Secret(credentials.password) }),
  };
}
