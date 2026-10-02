// SPDX-License-Identifier: AGPL-3.0-only
// Formes des données des écrans de la console (tâche 3.6). Les sessions et leurs événements viennent du contrat
// `@sym/contracts/browser` ; le reste (nœuds, clients, clés, profils, proxys, usage, enregistrements, fichiers, vue en direct)
// est décrit par le CDC (03 § 5, 04 § 2, 04b § 5, 04c § 2.2, § 4.4, § 5.1, 04d § 1, § 2.2, § 4.3) mais pas encore par le
// contrat (version 0.1.0).
// À BRANCHER (tâche de contrat, skill browser-contract-change) : déplacer ces types dans `@sym/contracts/browser`, avec
// `BROWSER_PROTOCOL_VERSION` qui change et des fixtures, puis les importer ici ; ajouter au type `Session` du contrat les
// champs que la console affiche (`apiKeyId`, `apiKeyPrefix`, `nodeId`, `startedAt`, `endedAt`, `liveView.interactive`).
import type { Session, SessionState, SessionType, StorageState } from '@sym/contracts/browser';

/** Session telle que la console admin la lit : session du contrat + clé, nœud et dates (proposition pour 2.2). */
export type ConsoleSession = Session & {
  apiKeyId: string;
  apiKeyPrefix: string;
  nodeId?: string;
  startedAt?: string;
  endedAt?: string;
  /** Option `liveView.interactive` de la création : « Prendre la main » possible. */
  interactiveLiveView: boolean;
};

export type ConsoleSessionPage = { data: ConsoleSession[]; nextCursor: string | null };

export type SessionTab = 'current' | 'past';

export type SessionQuery = {
  tab: SessionTab;
  state?: SessionState;
  type?: SessionType;
  apiKeyId?: string;
  nodeId?: string;
  createdAfter?: string;
  createdBefore?: string;
  /** Recherche `metadata.{clé}={valeur}` (04 § 9). */
  metadata?: { key: string; value: string };
  cursor?: string;
  limit?: number;
};

/** Enregistrement d'une session (04d § 2.2). */
export type Recording = { id: string; type: 'trace' | 'har' | 'video' | 'console' | 'network'; size: number; createdAt: string; expiresAt: string };

/** Fichier téléchargé par la session (04c § 5.1). */
export type SessionFile = { id: string; name: string; size: number; sha256: string; createdAt: string; expiresAt: string };

export const NODE_STATES = ['ready', 'draining', 'down'] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** Nœud et capacité (03 § 5 `nodes`, 04b § 5). */
export type NodeInfo = {
  id: string;
  region: string;
  state: NodeState;
  slotsTotal: number;
  slotsFree: number;
  rssBytes: number;
  limitBytes: number;
  playwright: string;
  chromium: string;
  lastHeartbeatAt: string;
};

/** Quotas d'un client (04d § 4.2). */
export type TenantQuotas = { concurrentSessions: number; minutesPerMonth: number; bytesPerMonth: number; maxSessionSeconds: number };
export type Tenant = { id: string; name: string; quotas: TenantQuotas; createdAt: string };

export const API_KEY_SCOPES = ['sessions:read', 'sessions:write', 'profiles:write', 'admin'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Clé d'API telle que listée : préfixe affiché seulement, jamais la clé (03 § 5 `api_keys`). */
export type ApiKey = {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type CreateKeyRequest = { tenantId: string; name: string; scopes: ApiKeyScope[]; expiresAt: string | null };
/** Réponse de création : la clé entière (`secret`) n'est rendue qu'ici, une seule fois. */
export type CreatedKey = { key: ApiKey; secret: string };

/** Profil persistant (03 § 5 `profiles`, 04c § 4.4). */
export type Profile = { id: string; tenantId: string; name: string; sizeBytes: number; version: number; lockedBySession: string | null; updatedAt: string };

/** Profil de proxy (04c § 2.2) : mot de passe jamais rendu, utilisateur masqué en partie. */
export type ProxyProfile = { id: string; tenantId: string; name: string; type: 'http' | 'https' | 'socks5'; host: string; port: number; username: string; passwordSet: boolean };
export type ProxyTestResult = { ok: true; exitIp: string; latencyMs: number };

export type UsageGroupBy = 'day' | 'key';
export type UsageQuery = { from: string; to: string; groupBy: UsageGroupBy; apiKeyId?: string };
export type UsageItem = { apiKeyId?: string; apiKeyPrefix?: string; day?: string; sessions: number; billedSeconds: number; bytesIn: number; bytesOut: number };
export type UsageTotals = { sessions: number; billedSeconds: number; bytesIn: number; bytesOut: number };
/** `drift` : écart de réconciliation (04d § 4.4), proposé en plus de la réponse de 04d § 4.3. */
export type UsageReport = { period: { from: string; to: string }; items: UsageItem[]; totals: UsageTotals; drift: { seconds: number; bytes: number; checkedAt: string } };

export type LiveMode = 'ro' | 'rw';
/** Réponse de `POST /v1/sessions/{id}/live-url` (04d § 1.1). */
export type LiveUrl = { url: string; mode: LiveMode; expiresAt: string };

/** Messages du relais vers le visionneur (04d § 1.2). */
export type LiveServerMessage =
  | { t: 'frame'; data: string; ts: number; w: number; h: number; tab: string }
  | { t: 'meta'; url: string; title: string; tabs: { id: string; title: string; url: string }[] }
  | { t: 'closed'; reason: string };

/** Messages du visionneur (04d § 1.2 et § 1.3) ; les entrées ne partent qu'en mode interactif. */
export type LiveClientMessage =
  | { t: 'ping' }
  | { t: 'tab'; id: string }
  | { t: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { t: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { t: 'key'; type: 'keyDown' | 'keyUp'; key: string }
  | { t: 'text'; text: string };

export type LiveConnection = {
  readonly mode: LiveMode;
  onMessage(listener: (message: LiveServerMessage) => void): void;
  send(message: LiveClientMessage): void;
  close(): void;
};

export type { StorageState };
