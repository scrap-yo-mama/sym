// SPDX-License-Identifier: AGPL-3.0-only
// Schéma Drizzle : miroir typé de migrations/*/up.sql, qui fait foi. Jamais de `drizzle-kit push`.
// Concordance vérifiée par schema.integration.test.ts (colonnes, types, nullabilité) sur base migrée.
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const SCOPES = ['sessions:write', 'sessions:read', 'profiles:write', 'admin'] as const;
export const NODE_STATES = ['ready', 'draining', 'down'] as const;
export const SESSION_TYPES = ['dedicated', 'shared'] as const;
export const SESSION_STATES = ['pending', 'running', 'ended', 'timed_out', 'failed'] as const;
export const END_REASONS = ['released', 'timeout', 'idle', 'budget_exceeded', 'node_shutdown', 'crash', 'node_lost', 'quota'] as const;
export const PROFILE_MODES = ['read', 'write'] as const;
export const PROXY_TYPES = ['http', 'https', 'socks5'] as const;
export const PROXY_KINDS = ['isp', 'datacenter', 'enterprise'] as const;
export const EVENT_TYPES = [
  'state', 'egress.blocked', 'egress.budget_exceeded', 'download', 'recording.ready', 'recording.truncated',
  'profile.save_failed', 'storage_state.exported', 'live.input',
] as const;
export const ARTIFACT_TYPES = ['trace', 'har', 'video', 'console', 'network', 'download'] as const;
export const USAGE_SOURCES = ['node', 'reconstructed'] as const;
export const IDEMPOTENT_OPERATIONS = ['createSession', 'extendSession'] as const;

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();
const big = (name: string) => bigint(name, { mode: 'number' });

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(2),
  monthlyMinutes: big('monthly_minutes').notNull().default(600),
  monthlyBytes: big('monthly_bytes').notNull().default(10_737_418_240),
  maxSessionSeconds: integer('max_session_seconds').notNull().default(3600),
  createdAt: createdAt(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  keyPrefix: text('key_prefix').notNull().unique(),
  keyHash: text('key_hash').notNull(),
  scopes: text('scopes').array().notNull().$type<(typeof SCOPES)[number][]>(),
  expiresAt: tstz('expires_at'),
  lastUsedAt: tstz('last_used_at'),
  revokedAt: tstz('revoked_at'),
  createdAt: createdAt(),
}, (t) => [index('api_keys_tenant_idx').on(t.tenantId)]);

export const nodes = pgTable('nodes', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  region: text('region').notNull().default('default'),
  playwrightVersion: text('playwright_version').notNull(),
  chromiumVersion: text('chromium_version').notNull(),
  appVersion: text('app_version').notNull(),
  slotsTotal: integer('slots_total').notNull(),
  slotsFree: integer('slots_free').notNull(),
  rssBytes: big('rss_bytes'),
  limitBytes: big('limit_bytes'),
  state: text('state').notNull().default('ready').$type<(typeof NODE_STATES)[number]>(),
  lastBeatAt: tstz('last_beat_at').notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [index('nodes_state_region_idx').on(t.state, t.region)]);

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  objectKey: text('object_key'),
  sizeBytes: big('size_bytes').notNull().default(0),
  version: integer('version').notNull().default(0),
  lockSessionId: uuid('lock_session_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const proxyProfiles = pgTable('proxy_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  type: text('type').notNull().$type<(typeof PROXY_TYPES)[number]>(),
  kind: text('kind').$type<(typeof PROXY_KINDS)[number]>(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  credentialsEncrypted: text('credentials_encrypted'),
  dnsViaProxy: boolean('dns_via_proxy').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  apiKeyId: uuid('api_key_id').notNull(),
  nodeId: text('node_id').references(() => nodes.id),
  type: text('type').notNull().$type<(typeof SESSION_TYPES)[number]>(),
  state: text('state').notNull().default('pending').$type<(typeof SESSION_STATES)[number]>(),
  endReason: text('end_reason').$type<(typeof END_REASONS)[number]>(),
  region: text('region'),
  slotWeight: integer('slot_weight').notNull().default(1),
  options: jsonb('options').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  egressPolicy: jsonb('egress_policy').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  profileId: uuid('profile_id'),
  profileMode: text('profile_mode').$type<(typeof PROFILE_MODES)[number]>(),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, string>>(),
  createdAt: createdAt(),
  startedAt: tstz('started_at'),
  endedAt: tstz('ended_at'),
  expiresAt: tstz('expires_at').notNull(),
}, (t) => [
  index('sessions_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
  index('sessions_node_idx').on(t.nodeId).where(sql`${t.state} IN ('pending', 'running')`),
  index('sessions_metadata_idx').using('gin', sql`${t.metadata} jsonb_path_ops`),
]);

export const sessionEvents = pgTable('session_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  occurredAt: tstz('occurred_at').notNull().defaultNow(),
  type: text('type').notNull().$type<(typeof EVENT_TYPES)[number]>(),
  data: jsonb('data').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
}, (t) => [index('session_events_session_idx').on(t.sessionId, t.id)]);

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  type: text('type').notNull().$type<(typeof ARTIFACT_TYPES)[number]>(),
  name: text('name'),
  objectKey: text('object_key').notNull(),
  sizeBytes: big('size_bytes').notNull(),
  sha256: text('sha256'),
  createdAt: createdAt(),
  expiresAt: tstz('expires_at').notNull(),
}, (t) => [index('artifacts_session_idx').on(t.sessionId), index('artifacts_expires_idx').on(t.expiresAt)]);

export const usageRecords = pgTable('usage_records', {
  sessionId: uuid('session_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  apiKeyId: uuid('api_key_id').notNull(),
  nodeId: text('node_id').notNull().references(() => nodes.id),
  startedAt: tstz('started_at').notNull(),
  endedAt: tstz('ended_at').notNull(),
  browserMs: big('browser_ms').notNull(),
  billedSeconds: big('billed_seconds').notNull(),
  bytesIn: big('bytes_in').notNull().default(0),
  bytesOut: big('bytes_out').notNull().default(0),
  source: text('source').notNull().$type<(typeof USAGE_SOURCES)[number]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('usage_records_tenant_ended_idx').on(t.tenantId, t.endedAt),
  index('usage_records_key_ended_idx').on(t.apiKeyId, t.endedAt),
]);

/** `Idempotency-Key` (04 § 9, migration 0002) : réponse 2xx d'origine par client, opération et clé, gardée 24 h. */
export const idempotencyKeys = pgTable('idempotency_keys', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  operation: text('operation').notNull().$type<(typeof IDEMPOTENT_OPERATIONS)[number]>(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.operation, t.key] }), index('idempotency_keys_created_idx').on(t.createdAt)]);

/** Dernière mesure en cours d'une session, poussée par le nœud (04d § 4.1, migration 0003, tâche 2.6). */
export const usageSnapshots = pgTable('usage_snapshots', {
  sessionId: uuid('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull().references(() => nodes.id),
  startedAt: tstz('started_at').notNull(),
  browserMs: big('browser_ms').notNull(),
  bytesIn: big('bytes_in').notNull(),
  bytesOut: big('bytes_out').notNull(),
  measuredAt: tstz('measured_at').notNull().defaultNow(),
});

/** Rapport de chaque réconciliation (04d § 4.4, migration 0003, tâche 2.6). */
export const usageReconciliations = pgTable('usage_reconciliations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  ranAt: tstz('ran_at').notNull().defaultNow(),
  closures: integer('closures').notNull(),
  inserted: integer('inserted').notNull(),
  replaced: integer('replaced').notNull(),
  reconstructed: integer('reconstructed').notNull(),
  driftSeconds: big('drift_seconds').notNull(),
  driftBytes: big('drift_bytes').notNull(),
  remainingDriftSeconds: big('remaining_drift_seconds').notNull(),
  remainingDriftBytes: big('remaining_drift_bytes').notNull(),
}, (t) => [index('usage_reconciliations_ran_idx').on(t.ranAt)]);
