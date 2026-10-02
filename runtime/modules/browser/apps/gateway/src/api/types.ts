// SPDX-License-Identifier: AGPL-3.0-only
// Interfaces de la passerelle que d'autres tâches implémentent (tâche 2.2). L'API REST n'en connaît que la forme :
//   - Authenticator : clés d'API `Authorization: Bearer` (argon2id, préfixe, scopes, expiration : tâche 2.1) ;
//   - ConnectTokenIssuer : jetons de connexion courts liés à une session et à un protocole (HMAC dérivé de MASTER_KEY,
//     tâche 2.1 ; vérifiés à l'upgrade WSS, tâche 2.3) ;
//   - SessionLauncher : démarrage, libération et prolongation sur le nœud propriétaire. Mode `all` : le superviseur de
//     sessions du nœud dans le même processus (tâche 1.2) ; modes séparés : `POST /internal/sessions` du nœud (04b § 8),
//     choix du nœud et file (tâche 2.4).
import type { EgressGuard, Keys } from '@sym-browser/core';
import type pg from 'pg';
import type { CreateSessionRequest, SessionType } from '@sym/contracts/browser';

/** Scopes d'une clé d'API (04 § 1). */
export type Scope = 'sessions:write' | 'sessions:read' | 'profiles:write' | 'admin';

/** Identité d'une clé d'API valide. */
export type Principal = { tenantId: string; apiKeyId: string; scopes: readonly Scope[] };

interface Authenticator {
  /** Secret reçu en `Authorization: Bearer` ; `null` si la clé est inconnue, révoquée ou expirée. */
  authenticate(secret: string): Promise<Principal | null>;
}

type ConnectProtocol = 'playwright' | 'cdp';

interface ConnectTokenIssuer {
  issue(input: { sessionId: string; protocol: ConnectProtocol; ttlSeconds: number }): string | Promise<string>;
}

type LaunchRequest = {
  sessionId: string;
  tenantId: string;
  type: SessionType;
  region: string | null;
  options: CreateSessionRequest;
  expiresAt: Date;
  idleTimeoutSeconds: number;
};

export interface SessionLauncher {
  /** Démarre la session (`pending → running` écrit par le nœud) ; `launch_failed` : aucun nœud n'a pu la lancer. */
  launch(request: LaunchRequest): Promise<{ ok: true } | { ok: false; code: 'launch_failed' }>;
  /** Libère une session tenue par un nœud (destruction puis état final) ; `not_held` : aucun nœud ne la tient. */
  release(sessionId: string): Promise<'released' | 'not_held'>;
  /** Prolonge sur le nœud (délais et base) ; `not_held` : la passerelle prolonge en base seule. */
  extend(sessionId: string, seconds: number): Promise<'extended' | 'not_held'>;
}

export type GatewayDeps = {
  db: pg.Pool;
  auth: Authenticator;
  tokens: ConnectTokenIssuer;
  launcher: SessionLauncher;
  /** URL publique de la passerelle (`https://hôte`) : base des `connectUrls` (`wss://hôte/v1/sessions/{id}/…`). */
  publicUrl: string;
  /** Attente maximale d'un démarrage (`QUEUE_TIMEOUT_MS`, défaut 30 000). */
  queueTimeoutMs?: number;
  /** Défauts de l'instance (04 § 3). */
  defaults?: { timeoutSeconds?: number; idleTimeoutSeconds?: number };
  /** Plateforme servie (`GET /v1/version`), défaut `process.platform`. */
  platform?: string;
  /** Erreur interne (500) : journal masqué de la passerelle. */
  onError?: (error: unknown) => void;
  /** Flux SSE (tâche 2.5) : période du battement `: ping` (15 s par défaut). */
  events?: { heartbeatMs?: number };
  /**
   * Webhooks (tâche 2.5) : garde réseau de l'egress (SYMB_PRIVATE_HOSTS) appliquée aux URL, KEK de scellement des secrets,
   * livreur (désactivé avec `false`). Sans elle, ni route de réglage ni livraison.
   */
  webhooks?: {
    guard: EgressGuard;
    keys: Keys;
    dispatcher?: false | { pollMs?: number; retryDelaysMs?: readonly number[]; timeoutMs?: number; batch?: number };
  };
};
