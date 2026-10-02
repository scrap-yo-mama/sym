// SPDX-License-Identifier: AGPL-3.0-only
// Interfaces de la passerelle que d'autres tâches implémentent (tâche 2.2). L'API REST n'en connaît que la forme :
//   - auth : `ApiKeyAuthenticator` de la tâche 2.1 (clés argon2id, préfixe affiché, scopes fermés, expiration), sur
//     `pgApiKeyStore` de @sym-browser/db ;
//   - tokens : `ConnectTokens` de la tâche 2.1 (jetons HMAC liés à une session et à un protocole, `loadKeyring`) ;
//   - SessionLauncher : démarrage, libération et prolongation sur le nœud propriétaire. Mode `all` : le superviseur de
//     sessions du nœud dans le même processus (tâche 1.2) ; modes séparés : `POST /internal/sessions` du nœud (04b § 8),
//     choix du nœud et file (tâche 2.4 : la passerelle place la session sur un nœud avant de la lancer).
import type { ApiKeyAuthenticator, ApiScope, BrowserMetrics, ConnectTokens, EgressGuard, Keys, MetricsRegistry, Principal, Secret } from '@sym-browser/core';
import type pg from 'pg';
import type { LiveTokens, UsageClosure } from '@sym-browser/core';
import type { UsageReconciliation } from '@sym-browser/db';
import type { CreateSessionRequest, SessionType } from '@sym/contracts/browser';

/** Scopes d'une clé d'API (04 § 1) : ensemble fermé de la tâche 2.1. */
export type Scope = ApiScope;
export type { Principal };

export type LaunchRequest = {
  sessionId: string;
  /** Nœud choisi par l'admission (tâche 2.4) et son URL privée. */
  nodeId: string;
  nodeUrl: string;
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
  /** Clés d'API (`new ApiKeyAuthenticator(pgApiKeyStore(pool))`, tâche 2.1). */
  auth: Pick<ApiKeyAuthenticator, 'check'>;
  /** Jetons de connexion (`new ConnectTokens(keyring)`, tâche 2.1) : émis pour les `connectUrls`, vérifiés par le relais. */
  tokens: Pick<ConnectTokens, 'issue' | 'verify'>;
  launcher: SessionLauncher;
  /** URL publique de la passerelle (`https://hôte`) : base des `connectUrls` (`wss://hôte/v1/sessions/{id}/…`). */
  publicUrl: string;
  /** Attente maximale d'un démarrage, file comprise (`QUEUE_TIMEOUT_MS`, défaut 30 000). */
  queueTimeoutMs?: number;
  /** Bornes de la file (`QUEUE_MAX`, `QUEUE_MAX_PER_TENANT` ; défauts 50 et 10). */
  queue?: { queueMax?: number; queueMaxPerTenant?: number };
  /** Période de service de la file tant qu'une demande attend (défaut 250 ms). */
  queuePollMs?: number;
  /** Défauts de l'instance (04 § 3). */
  defaults?: { timeoutSeconds?: number; idleTimeoutSeconds?: number };
  /** Plateforme servie (`GET /v1/version`), défaut `process.platform`. */
  platform?: string;
  /**
   * Relais WSS `/playwright` et `/cdp` (tâche 2.3) ; absent : routes non servies. `liveTokens` (tâche 3.2) : vue en direct,
   * `liveViewUrl` dans les réponses et relais `/live/stream` ; absent : ni l'un ni l'autre.
   */
  relay?: { nodeToken: string; pingIntervalMs?: number; cdpMaxMessageBytes?: number; liveTokens?: Pick<LiveTokens, 'issue' | 'verify'> };
  /**
   * Métriques de la passerelle (04d § 3.1, tâche 3.7) : registre servi par `GET /metrics` sous
   * `Authorization: Bearer <SYMB_METRICS_TOKEN>` (`token` nul : route fermée). Absent : pas de route `/metrics`.
   */
  observability?: { registry: MetricsRegistry; metrics: BrowserMetrics; token: Secret | null };
  /**
   * Clôtures des journaux usage.wal des nœuds joignables (réconciliation, 04d § 4.4, tâche 2.6). Mode `all` : le journal du
   * nœud du processus ; modes séparés : lecture interne des nœuds. Absent : seule la reconstruction s'applique.
   */
  usageWal?: () => Promise<UsageClosure[]>;
  /** Rapport de chaque réconciliation demandée par l'API (jauge `symb_usage_drift_seconds`, journal `warn` si écart). */
  onUsageReconciled?: (report: UsageReconciliation) => void;
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
