// SPDX-License-Identifier: AGPL-3.0-only
// Schéma Drizzle : miroir typé de migrations/*/up.sql, qui fait foi. Jamais de `drizzle-kit push`.
// Concordance vérifiée par schema.integration.test.ts (colonnes, types, nullabilité) sur base migrée.
import {
  API_STATUSES,
  EXECUTIONS,
  FAILURE_CLASSES,
  INVESTIGATION_PHASES,
  NETWORKS,
  RUN_KINDS,
  RUN_OUTCOMES,
  RUN_STATES,
  RUN_TRIGGERS,
  STEP_OUTCOMES,
  STRATEGY_ARCHIVE_REASONS,
  STRATEGY_COMPILABLE,
  STRATEGY_CREATORS,
  VISIBILITIES,
  type AttemptResult,
  type FailureClass,
} from '@runtime/core';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Projet unique « default » de la V1 (ligne insérée par 0001_init). */
export const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000001';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();
const usd = (name: string) => numeric(name, { precision: 12, scale: 6 });
const projectId = () =>
  uuid('project_id')
    .notNull()
    .default(DEFAULT_PROJECT_ID)
    .references(() => projects.id);
const ownerId = () =>
  uuid('owner_id')
    .notNull()
    .references(() => users.id);

// --- Projets, réglages -------------------------------------------------------
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  createdAt: createdAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

// --- Utilisateurs et authentification (13 § 12, Better Auth 1.7) -------------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull().unique(),
    displayName: text('display_name').notNull().default(''),
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerifiedAt: tstz('email_verified_at'),
    image: text('image'),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
    status: text('status', { enum: ['invited', 'active', 'disabled'] }).notNull().default('invited'),
    // Migration 0025_i18n : le registre des langues (`@runtime/i18n`) valide ; la CHECK n'impose que la forme.
    locale: text('locale').notNull().default('en'),
    theme: text('theme', { enum: ['light', 'dark', 'system'] }).notNull().default('system'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: tstz('disabled_at'),
    lastLoginAt: tstz('last_login_at'),
    // Migration 0012_accounts_advanced (tâche 3.7) : compte supprimé et anonymisé.
    deletedAt: tstz('deleted_at'),
    // Migration 0025_i18n : fuseau IANA (indice de localisation : donnée personnelle, 17 § 6), nullable.
    timezone: text('timezone'),
    // Migration 0025_i18n : fuseau déjà initialisé (toute écriture, même null) ; la console ne le pose qu'à la première connexion.
    timezoneInitialized: boolean('timezone_initialized').notNull().default(false),
  },
  (t) => [uniqueIndex('users_single_owner').on(t.role).where(sql`role = 'owner'`)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    absoluteExpiresAt: tstz('absolute_expires_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: tstz('revoked_at'),
    // Migration 0012_accounts_advanced (tâche 3.7) : second facteur attendu, facteur utilisé.
    mfaPending: boolean('mfa_pending').notNull().default(false),
    mfaMethod: text('mfa_method', { enum: ['totp', 'backup_code', 'idp'] }),
  },
  (t) => [index('auth_sessions_user_id_idx').on(t.userId)],
);

/** Appareils reconnus (D-15, migration 0012) : empreinte du jeton seulement. */
export const authKnownDevices = pgTable(
  'auth_known_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [index('auth_known_devices_user_id_idx').on(t.userId)],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    passwordHash: text('password_hash'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('auth_accounts_provider_account_key').on(t.providerId, t.accountId),
    index('auth_accounts_user_id_idx').on(t.userId),
  ],
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    role: text('role', { enum: ['member', 'admin'] }).notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
    // Migration 0012_accounts_advanced : échéance ≤ dernier envoi + 48 h (CHECK invitations_ttl).
    sentAt: tstz('sent_at').notNull().defaultNow(),
    // Migration 0025_i18n : langue choisie par l'invitant, copiée dans users.locale à l'acceptation.
    locale: text('locale').notNull().default('en'),
  },
  (t) => [index('invitations_email_idx').on(t.email)],
);

export const twoFactor = pgTable('two_factor', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Migration 0012_accounts_advanced (tâche 3.7) : graine TOTP scellée (enveloppe complète, AAD two_factor|user_id).
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  nonce: bytea('nonce'),
  dekWrapped: bytea('dek_wrapped'),
  alg: text('alg'),
  keyVersion: integer('key_version'),
  /** Dernier pas TOTP accepté (anti-rejeu). */
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  /** Graine illisible après une perte de MASTER_KEY : codes de secours seulement, puis ré-enrôlement. */
  unreadableSince: tstz('unreadable_since'),
  // Colonnes du plugin Better Auth (jamais chargé, 0.3b) : gardées inutilisées (migration additive).
  backupCodes: text('backup_codes'),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: tstz('locked_until'),
  confirmedAt: tstz('confirmed_at'),
  createdAt: createdAt(),
});

export const backupCodes = pgTable(
  'backup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [unique('backup_codes_user_code_key').on(t.userId, t.codeHash)],
);

/** Scopes accordables à une clé d'API (13 § 8), contrôlés aussi en base. */
export const API_KEY_SCOPES = [
  'apis:read',
  'apis:run',
  'apis:write',
  'runs:read',
  'datasets:read',
  'schedules:write',
  'sites:read',
] as const;

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    scopes: text('scopes').array().notNull().default(sql`'{}'`),
    expiresAt: tstz('expires_at').notNull(),
    lastUsedAt: tstz('last_used_at'),
    createdAt: createdAt(),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('api_keys_user_id_idx').on(t.userId)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz('at').notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorVia: text('actor_via', { enum: ['ui', 'apikey', 'mcp', 'sso', 'system', 'extension'] }).notNull(),
    actorRef: text('actor_ref'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    outcome: text('outcome', { enum: ['success', 'denied', 'error'] }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    meta: jsonb('meta').notNull().default({}),
  },
  (t) => [index('audit_events_at_idx').on(t.at), index('audit_events_actor_idx').on(t.actorUserId, t.at)],
);

// --- Conformité (17) ---------------------------------------------------------
export const subjectExclusions = pgTable('subject_exclusions', {
  subjectHash: text('subject_hash').primaryKey(),
  at: tstz('at').notNull().defaultNow(),
});

export const responsibleUseAcks = pgTable(
  'responsible_use_acks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.version] })],
);

// --- Secrets (INV8) : owner_id NULL = secret d'instance -------------------------
export const secrets = pgTable(
  'secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: projectId(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    aad: bytea('aad').notNull(),
    alg: text('alg').notNull().default('aes-256-gcm'),
    dekWrapped: bytea('dek_wrapped').notNull(),
    kekVersion: integer('kek_version').notNull(),
    // 0002 : 'unreadable' = indéchiffrable avec la clé courante, conservé pour « À ressaisir ».
    state: text('state', { enum: ['ok', 'unreadable'] }).notNull().default('ok'),
    unreadableSince: tstz('unreadable_since'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('secrets_owner_id_idx').on(t.ownerId), index('secrets_kek_version_idx').on(t.kekVersion), unique('secrets_id_owner_key').on(t.id, t.ownerId)],
);

// --- Catalogue (04b § 1) -----------------------------------------------------
// Énumérations définies une fois dans @runtime/core (model/enums.ts), réexportées ici ; concordance avec les CHECK SQL
// vérifiée par enums.integration.test.ts.
export { API_STATUSES, EXECUTIONS, FAILURE_CLASSES, NETWORKS, RUN_STATES };
export type { FailureClass };

/** access_policy par défaut (17 § 4) : paiement jamais en V1 ; sans `robots`, champ retiré par D-91 (migration 0021). */
export const DEFAULT_ACCESS_POLICY = {
  on_ai_signal: 'warn',
  intended_use: 'context',
  prefer_official: true,
  payment: { mode: 'never' },
} as const;

export const apis = pgTable(
  'apis',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('private'),
    description: text('description').notNull().default(''),
    inputSchema: jsonb('input_schema').notNull().default({}),
    outputSchema: jsonb('output_schema').notNull().default({}),
    // 0017_rest_api (3.1) : ordre déclaré des propriétés de premier niveau du schéma de sortie (colonnes du CSV).
    outputColumns: text('output_columns').array(),
    views: jsonb('views').notNull().default({}),
    status: text('status', { enum: API_STATUSES }).notNull().default('enquete'),
    investigationPhase: text('investigation_phase', {
      enum: INVESTIGATION_PHASES,
    }),
    statusReason: text('status_reason'),
    stale: boolean('stale').notNull().default(false),
    cleanStreak: integer('clean_streak').notNull().default(0),
    lastSignalAt: tstz('last_signal_at'),
    currentStrategyVersion: integer('current_strategy_version'),
    requires: jsonb('requires').notNull().default({}),
    requiresSession: boolean('requires_session').notNull().default(false),
    networkPolicy: jsonb('network_policy').notNull().default({ allow: ['direct'] }),
    accessPolicy: jsonb('access_policy').notNull().default(DEFAULT_ACCESS_POLICY),
    domainPacing: jsonb('domain_pacing')
      .notNull()
      .default({ min_delay_ms: 1500, max_requests_per_run: 200, max_wait_ms: 60000 }),
    purpose: text('purpose').notNull().default(''),
    legalBasis: text('legal_basis'),
    containsPersonalData: boolean('contains_personal_data').notNull().default(false),
    allowWriteActions: boolean('allow_write_actions').notNull().default(false),
    // 0026_no_run_cap (D-123) : NULL = aucun plafond par run (défaut) ; le budget du jour de l'utilisateur reste le filet.
    maxCostUsd: usd('max_cost_usd'),
    budgetDailyUsd: usd('budget_daily_usd').notNull().default('5'),
    mcpExposed: boolean('mcp_exposed').notNull().default(true),
    pinned: boolean('pinned').notNull().default(false),
    repairLeaseOwner: text('repair_lease_owner'),
    repairLeaseUntil: tstz('repair_lease_until'),
    // 0010_scheduling_webhooks (2.5) : un warning au-delà de D n'alerte qu'une fois par épisode.
    warningAlertedAt: tstz('warning_alerted_at'),
    // 0016_investigation (2.1) : état de l'enquête entre deux runs (demande, gisements, proposition, schéma validé).
    investigation: jsonb('investigation'),
    // 0021_persistence_mode (2.16, D-49) : mode « SYM ne lâche pas », opt-in ; plafond propre (NULL = défaut d'instance).
    persistenceMode: boolean('persistence_mode').notNull().default(false),
    persistenceBudgetUsd: usd('persistence_budget_usd'),
    // 0023_step_repair (2.13) : mode « agent instruit », opt-in explicite (déclencheur apis_instructed_mode_guard).
    instructedMode: boolean('instructed_mode').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('apis_project_slug_key').on(t.projectId, t.slug),
    index('apis_owner_id_idx').on(t.ownerId),
    check('apis_session_private', sql`NOT ${t.requiresSession} OR ${t.visibility} = 'private'`),
    check('apis_access_policy_payment', sql`coalesce(${t.accessPolicy} #>> '{payment,mode}', 'never') = 'never'`),
    check('apis_persistence_budget_usd_check', sql`${t.persistenceBudgetUsd} IS NULL OR ${t.persistenceBudgetUsd} > 0`),
  ],
);

// 0021_persistence_mode (2.16, D-49) : cycle du mode « SYM ne lâche pas » d'une API en `erreur` (aucune valeur du site).
export const apiPersistence = pgTable(
  'api_persistence',
  {
    apiId: uuid('api_id')
      .primaryKey()
      .references(() => apis.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    enteredErrorAt: tstz('entered_error_at').notNull(),
    failureClass: text('failure_class'),
    attempt: integer('attempt').notNull().default(0),
    nextAt: tstz('next_at'),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    lastAttemptAt: tstz('last_attempt_at'),
    spentUsd: usd('spent_usd').notNull().default('0'),
    lastOutcome: text('last_outcome'),
    ended: text('ended', { enum: ['refused', 'ineligible', 'exhausted'] }),
    endedReason: text('ended_reason'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('api_persistence_domain_idx').on(t.domain).where(sql`${t.ended} IS NULL`),
    index('api_persistence_due_idx').on(t.nextAt).where(sql`${t.ended} IS NULL AND ${t.runId} IS NULL`),
    check('api_persistence_ended_idle', sql`${t.ended} IS NULL OR (${t.nextAt} IS NULL AND ${t.runId} IS NULL)`),
  ],
);

// Une tentative par domaine enregistrable et par créneau (clé = domaine seul) ; identité système seulement.
export const persistenceDomainSlots = pgTable('persistence_domain_slots', {
  domain: text('domain').primaryKey(),
  apiId: uuid('api_id').references(() => apis.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
  slotUntil: tstz('slot_until').notNull(),
});

export const strategyVersions = pgTable(
  'strategy_versions',
  {
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    execution: text('execution', { enum: EXECUTIONS }).notNull(),
    network: text('network', { enum: NETWORKS }).notNull(),
    spec: jsonb('spec').notNull().default({}),
    scriptRef: text('script_ref'),
    estCostUsd: usd('est_cost_usd'),
    createdBy: text('created_by', { enum: STRATEGY_CREATORS }).notNull(),
    parentVersion: integer('parent_version'),
    patch: jsonb('patch'),
    // 0023_step_repair (2.13) : compilable en E5, étapes instruites (non fiables tant que non confirmées), archivage.
    compilable: text('compilable', { enum: STRATEGY_COMPILABLE }).notNull().default('unknown'),
    instructedSteps: jsonb('instructed_steps'),
    instructedStepsSha256: text('instructed_steps_sha256'),
    instructedStepsConfirmed: jsonb('instructed_steps_confirmed'),
    archiveReason: text('archive_reason', { enum: STRATEGY_ARCHIVE_REASONS }),
    sourceSteps: jsonb('source_steps'),
    // 0017_rest_api (3.1) : la version a été courante au moins une fois (déclencheur sur apis) ; seule une telle version se rétablit.
    wasCurrent: boolean('was_current').notNull().default(false),
    createdAt: createdAt(),
    // 0019 : source de la version (demande, schéma, décisions, règles ; 18 §4.6).
    source: jsonb('source'),
    // 0020_catalog_memory_quality (2.12) : signature calculée par le code.
    signature: jsonb('signature'),
  },
  (t) => [primaryKey({ columns: [t.apiId, t.version] }), index('strategy_versions_owner_id_idx').on(t.ownerId)],
);

// --- Règles et skills Markdown (tâche 2.10, 18 §4.6, migration 0019) -----------------------------------------------

export const ruleFiles = pgTable(
  'rule_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL : fichier d'instance (installé au démarrage ou écrit par un admin en console).
    ownerId: uuid('owner_id').references(() => users.id),
    projectId: projectId(),
    kind: text('kind', { enum: ['instance', 'rule', 'skill'] }).notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    appliesTo: text('applies_to').array().notNull().default(sql`'{}'`),
    targetApiIds: uuid('target_api_ids').array().notNull().default(sql`'{}'`),
    visibility: text('visibility', { enum: ['private', 'instance'] }).notNull().default('private'),
    currentVersion: integer('current_version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [index('rule_files_owner_id_idx').on(t.ownerId)],
);

export const ruleFileVersions = pgTable(
  'rule_file_versions',
  {
    ruleFileId: uuid('rule_file_id')
      .notNull()
      .references(() => ruleFiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    description: text('description').notNull(),
    appliesTo: text('applies_to').array().notNull().default(sql`'{}'`),
    targetApiIds: uuid('target_api_ids').array().notNull().default(sql`'{}'`),
    authorId: uuid('author_id').references(() => users.id),
    origin: text('origin', { enum: ['ui', 'rest', 'mcp', 'import', 'seed', 'proposal', 'optimizer'] }).notNull(),
    reviewState: text('review_state', { enum: ['none', 'to_review', 'confirmed'] }).notNull().default('none'),
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: tstz('confirmed_at'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ruleFileId, t.version] }), index('rule_file_versions_sha256_idx').on(t.sha256)],
);

export const strategyVersionRules = pgTable(
  'strategy_version_rules',
  {
    apiId: uuid('api_id').notNull(),
    strategyVersion: integer('strategy_version').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    ruleFileId: uuid('rule_file_id')
      .notNull()
      .references(() => ruleFiles.id),
    ruleVersion: integer('rule_version').notNull(),
    sha256: text('sha256').notNull(),
    level: text('level', { enum: ['instance', 'domain', 'api'] }).notNull(),
    loaded: text('loaded', { enum: ['injected', 'skill_read', 'embedded', 'truncated'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.apiId, t.strategyVersion, t.ruleFileId] }),
    foreignKey({ name: 'strategy_version_rules_api_id_strategy_version_fkey', columns: [t.apiId, t.strategyVersion], foreignColumns: [strategyVersions.apiId, strategyVersions.version] }).onDelete('cascade'),
    foreignKey({ name: 'strategy_version_rules_rule_file_id_rule_version_fkey', columns: [t.ruleFileId, t.ruleVersion], foreignColumns: [ruleFileVersions.ruleFileId, ruleFileVersions.version] }),
    index('strategy_version_rules_owner_id_idx').on(t.ownerId),
    index('strategy_version_rules_rule_idx').on(t.ruleFileId),
  ],
);

// --- Exécutions ----------------------------------------------------------------

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id),
    ownerId: ownerId(),
    apiOwnerId: uuid('api_owner_id')
      .notNull()
      .references(() => users.id),
    projectId: projectId(),
    strategyVersion: integer('strategy_version'),
    trigger: text('trigger', { enum: RUN_TRIGGERS }).notNull(),
    state: text('state', { enum: RUN_STATES }).notNull().default('queued'),
    outcome: text('outcome', { enum: RUN_OUTCOMES }),
    degradedReasons: text('degraded_reasons').array().notNull().default(sql`'{}'`),
    input: jsonb('input'),
    // NULL : coût LLM inconnu (prix absent, 08 §1 ; migration 0013).
    costLlmUsd: usd('cost_llm_usd').default('0'),
    costProxyUsd: usd('cost_proxy_usd').notNull().default('0'),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensCached: bigint('tokens_cached', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    tokensReasoning: bigint('tokens_reasoning', { mode: 'number' }).notNull().default(0),
    usageEstimated: boolean('usage_estimated').notNull().default(false),
    items: integer('items').notNull().default(0),
    datasetId: uuid('dataset_id'),
    durationMs: integer('duration_ms'),
    failureClass: text('failure_class').$type<FailureClass>(),
    retryable: boolean('retryable'),
    errorDetail: text('error_detail'),
    traceId: text('trace_id'),
    heartbeatAt: tstz('heartbeat_at'),
    // 0004_run_queue (1.3) : job pg-boss courant (jeton de clôture), worker qui tient le run, remises en file.
    jobId: uuid('job_id'),
    workerId: text('worker_id'),
    requeueCount: integer('requeue_count').notNull().default(0),
    // 0010_scheduling_webhooks (2.5) : planification d'origine, instant du déclenchement, job d'origine (unique).
    scheduleId: uuid('schedule_id').references((): AnyPgColumn => schedules.id, { onDelete: 'set null' }),
    scheduledAt: tstz('scheduled_at'),
    scheduleJobId: uuid('schedule_job_id'),
    // 0016_investigation (2.1) : exécution d'une stratégie ou enquête.
    kind: text('kind', { enum: RUN_KINDS }).notNull().default('run'),
    // 0017_rest_api (3.1) : pause demandée par l'utilisateur (run `queued` sans job), reprise par `resume`.
    pausedAt: tstz('paused_at'),
    // Migration 0025_i18n : langue du demandeur au lancement (déclencheur `runs_set_locale`) ; prose du LLM seulement.
    locale: text('locale').notNull(),
    // 0018_run_rejected_items (2.3, D-49) : items extraits non conformes, jamais livrés.
    itemsRejected: integer('items_rejected').notNull().default(0),
    // 0020_catalog_memory_quality (2.12) : fiche de qualité et avis consultatif du juge.
    quality: jsonb('quality'),
    judge: jsonb('judge'),
    createdAt: createdAt(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
  },
  (t) => [index('runs_owner_id_idx').on(t.ownerId), index('runs_api_created_idx').on(t.apiId, t.createdAt.desc())],
);

export const runAttempts = pgTable(
  'run_attempts',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    execution: text('execution', { enum: EXECUTIONS }).notNull(),
    network: text('network', { enum: NETWORKS }).notNull(),
    resultClass: text('result_class').$type<AttemptResult>(), // CHECK : 0006_failure_class_unify
    estCostUsd: usd('est_cost_usd'),
    // NULL : coût inconnu (prix absent, 08 §1 ; migration 0013).
    costUsd: usd('cost_usd').default('0'),
    ms: integer('ms'),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    engine: text('engine'),
    // 0023_step_repair (2.13) : journal par étape (jetons et coût par étape, `cost_usd`).
    stepId: text('step_id'),
    stepLevel: smallint('step_level'),
    stepOutcome: text('step_outcome', { enum: STEP_OUTCOMES }),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    // 0019 : règles qui ont placé l'essai (`nom@version`, 18 §4.6).
    ruleRefs: text('rule_refs').array().notNull().default(sql`'{}'`),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] }), index('run_attempts_owner_id_idx').on(t.ownerId)],
);

export const runLogs = pgTable(
  'run_logs',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    ts: tstz('ts').notNull().defaultNow(),
    level: text('level', { enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] }).notNull(),
    event: text('event').notNull(),
    data: jsonb('data'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    index('run_logs_owner_id_idx').on(t.ownerId),
    index('run_logs_ts_idx').on(t.ts),
  ],
);

export const runArtifacts = pgTable(
  'run_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    kind: text('kind', { enum: ['screenshot', 'trace', 'har'] }).notNull(),
    bytes: integer('bytes').notNull(),
    sensitivity: text('sensitivity').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    nonce: bytea('nonce').notNull(),
    keyVersion: integer('key_version').notNull(),
    dekWrapped: bytea('dek_wrapped').notNull().default(sql`'\\x'`),
    alg: text('alg').notNull().default('aes-256-gcm'),
    // 0005 : 'unreadable' = non ouvrable par l'ancienne clé pendant `rekey` (marqué et audité, jamais supprimé en silence).
    state: text('state', { enum: ['ok', 'unreadable'] }).notNull().default('ok'),
    unreadableSince: tstz('unreadable_since'),
    createdAt: createdAt(),
  },
  (t) => [index('run_artifacts_owner_id_idx').on(t.ownerId), index('run_artifacts_run_id_idx').on(t.runId)],
);

export const investigationEvents = pgTable(
  'investigation_events',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] }), index('investigation_events_owner_id_idx').on(t.ownerId)],
);

// 0018_run_rejected_items (2.3, D-49) : quarantaine d'un run (agrégats sans valeur, échantillon nettoyé de 5 items au plus).
export const runRejectedItems = pgTable(
  'run_rejected_items',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => runs.id, { onDelete: 'cascade' }),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    totalRejected: integer('total_rejected').notNull(),
    byReason: jsonb('by_reason').notNull().default([]),
    sample: jsonb('sample').notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index('run_rejected_items_owner_id_idx').on(t.ownerId),
    index('run_rejected_items_api_id_idx').on(t.apiId),
    index('run_rejected_items_created_at_idx').on(t.createdAt),
  ],
);

// 0020_catalog_memory_quality (2.12) : profil de chaque run (après Ajv et la garde de classification) et baseline validée.
export const runProfiles = pgTable(
  'run_profiles',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id')
      .unique()
      .references(() => runs.id, { onDelete: 'set null' }),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    strategyVersion: integer('strategy_version'),
    inputHash: text('input_hash').notNull(),
    profile: jsonb('profile').notNull(),
    baseline: boolean('baseline').notNull().default(false),
    validatedBy: uuid('validated_by').references(() => users.id),
    validatedAt: tstz('validated_at'),
    createdAt: createdAt(),
  },
  (t) => [index('run_profiles_owner_id_idx').on(t.ownerId), index('run_profiles_api_input_idx').on(t.apiId, t.inputHash, t.createdAt.desc())],
);

// 0020_catalog_memory_quality (2.12) : entrées de mémoire consultées par une version (sha256 du dossier).
export const strategyVersionMemoryRefs = pgTable(
  'strategy_version_memory_refs',
  {
    apiId: uuid('api_id').notNull(),
    strategyVersion: integer('strategy_version').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    refApiId: uuid('ref_api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    refVersion: integer('ref_version'),
    tier: smallint('tier').notNull(),
    dossierSha256: text('dossier_sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.apiId, t.strategyVersion, t.refApiId] }),
    foreignKey({ columns: [t.apiId, t.strategyVersion], foreignColumns: [strategyVersions.apiId, strategyVersions.version] }).onDelete('cascade'),
    index('strategy_version_memory_refs_owner_id_idx').on(t.ownerId),
  ],
);

// 0024_investigation_briefs (2.14) : versions du dossier d'enquête (contenu masqué, immuable sauf effacement) et faits du
// code par indice (clé d'identité), sous RLS owner_id, purgés avec l'API.
export const apiBriefs = pgTable(
  'api_briefs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    briefVersion: integer('brief_version').notNull(),
    content: jsonb('content').notNull(),
    contentSha256: text('content_sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    subjectExcluded: text('subject_excluded').array().notNull().default(sql`'{}'`),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    via: text('via').notNull(),
    erasedAt: tstz('erased_at'),
    samplesPurgedAt: tstz('samples_purged_at'),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.apiId, t.briefVersion), index('api_briefs_owner_id_idx').on(t.ownerId)],
);

export const briefHintOutcomes = pgTable(
  'brief_hint_outcomes',
  {
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    identityKey: text('identity_key').notNull(),
    briefVersion: integer('brief_version').notNull(),
    hintId: text('hint_id').notNull(),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    reason: text('reason'),
    probe: jsonb('probe'),
    stale: boolean('stale').notNull().default(false),
    expiresAt: tstz('expires_at'),
    probedAt: tstz('probed_at'),
    lastOkAt: tstz('last_ok_at'),
    verifiedEventDay: date('verified_event_day'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.apiId, t.identityKey] }), index('brief_hint_outcomes_owner_id_idx').on(t.ownerId)],
);

export const statusEvents = pgTable(
  'status_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('status_events_api_at_idx').on(t.apiId, t.at), index('status_events_owner_id_idx').on(t.ownerId)],
);

// --- Résultats (14 § 9) --------------------------------------------------------
export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    ownerId: ownerId(),
    projectId: projectId(),
    itemCount: integer('item_count').notNull().default(0),
    /** 0011 (2.5) : items dont la clé de déduplication n'avait jamais été vue pour l'API (`diff`, `items.new`). */
    newItems: integer('new_items').notNull().default(0),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    retentionDays: integer('retention_days'),
    pinned: boolean('pinned').notNull().default(false),
    /** Exemption datée et motivée (0009, 17 § 6) : obligatoires quand `pinned`. */
    pinnedReason: text('pinned_reason'),
    pinnedUntil: tstz('pinned_until'),
    expiresAt: tstz('expires_at'),
    deletedAt: tstz('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('datasets_owner_id_idx').on(t.ownerId),
    check(
      'datasets_pinned_exemption_check',
      sql`NOT ${t.pinned} OR (${t.pinnedReason} IS NOT NULL AND btrim(${t.pinnedReason}) <> '' AND ${t.pinnedUntil} IS NOT NULL)`,
    ),
  ],
);

/** Table partitionnée par mois sur created_at (partitions créées par ensure_dataset_items_partitions). */
export const datasetItems = pgTable(
  'dataset_items',
  {
    createdAt: createdAt(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    runId: uuid('run_id'),
    ownerId: uuid('owner_id').notNull(),
    projectId: uuid('project_id').notNull().default(DEFAULT_PROJECT_ID),
    item: jsonb('item').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    dedupKey: text('dedup_key'),
  },
  (t) => [
    primaryKey({ columns: [t.createdAt, t.datasetId, t.seq] }),
    index('dataset_items_dataset_seq_idx').on(t.datasetId, t.seq),
    index('dataset_items_owner_id_idx').on(t.ownerId),
  ],
);

export const dedupKeys = pgTable(
  'dedup_keys',
  {
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(),
    ownerId: ownerId(),
    projectId: projectId(),
    lastSeen: tstz('last_seen').notNull().defaultNow(),
    lastRunId: uuid('last_run_id'),
  },
  (t) => [
    primaryKey({ columns: [t.apiId, t.keyHash] }),
    index('dedup_keys_owner_id_idx').on(t.ownerId),
    index('dedup_keys_last_seen_idx').on(t.lastSeen),
  ],
);

// --- Planification, cadence, sessions de sites, tunnel, webhooks ---------------
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apiId: uuid('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    input: jsonb('input').notNull().default({}),
    rules: jsonb('rules').notNull().default({}),
    overlap: text('overlap').notNull().default('skip'),
    onMissed: text('on_missed').notNull().default('skip'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('schedules_owner_id_idx').on(t.ownerId), index('schedules_api_id_idx').on(t.apiId)],
);

export const domainPacingState = pgTable('domain_pacing_state', {
  domain: text('domain').primaryKey(),
  nextSlotAt: tstz('next_slot_at').notNull().defaultNow(),
  circuitState: text('circuit_state', { enum: ['closed', 'open', 'half_open'] }).notNull().default('closed'),
  circuitOpenedAt: tstz('circuit_opened_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  // Migration 0005_pacing_state (tâche 1.9) : cadence adaptative, disjoncteur, budget de retries.
  minDelayMs: integer('min_delay_ms').notNull().default(1500),
  adaptiveDelayMs: integer('adaptive_delay_ms').notNull().default(0),
  calmSuccesses: integer('calm_successes').notNull().default(0),
  adaptiveChangedAt: tstz('adaptive_changed_at'),
  penaltyUntil: tstz('penalty_until'),
  circuitOpenUntil: tstz('circuit_open_until'),
  circuitTrips: integer('circuit_trips').notNull().default(0),
  probeStartedAt: tstz('probe_started_at'),
  windowStartedAt: tstz('window_started_at'),
  windowRequests: integer('window_requests').notNull().default(0),
  windowRetries: integer('window_retries').notNull().default(0),
  updatedAt: updatedAt(),
});

export const siteSessions = pgTable(
  'site_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: projectId(),
    domain: text('domain').notNull(),
    serverUseAllowed: boolean('server_use_allowed').notNull().default(false),
    ciphertext: bytea('ciphertext'),
    nonce: bytea('nonce'),
    keyVersion: integer('key_version'),
    capturedAt: tstz('captured_at'),
    expiresAt: tstz('expires_at'),
    createdAt: createdAt(),
    // Migration 0008_extension_pairing (tâche 2.6) : enveloppe complète, consentement daté. Colonnes chiffrées en
    // écriture seule pour runtime_app (aucun SELECT sur ciphertext, nonce, dek_wrapped, alg).
    dekWrapped: bytea('dek_wrapped'),
    alg: text('alg'),
    consentedAt: tstz('consented_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
    // Migration 0027_session_server_state (CDC V1 sym-sessions, A1) : nature du secret (cookie en V1), usage et
    // vérification, étiquette du compte. La durée de vie du secret reste `expires_at`.
    secretKind: text('secret_kind').notNull().default('cookie'),
    lastUsedAt: tstz('last_used_at'),
    lastCheckedAt: tstz('last_checked_at'),
    accountLabel: text('account_label'),
  },
  (t) => [
    unique('site_sessions_owner_domain_key').on(t.ownerId, t.domain),
    check('site_sessions_server_use', sql`${t.serverUseAllowed} OR ${t.ciphertext} IS NULL`),
    check('site_sessions_secret_kind', sql`${t.secretKind} IN ('cookie')`),
    check('site_sessions_account_label_len', sql`${t.accountLabel} IS NULL OR length(${t.accountLabel}) <= 120`),
  ],
);

// Journal d'usage des sessions (migration 0027) : ajout seul pour le rôle applicatif, aucune valeur de secret.
export const siteSessionEvents = pgTable(
  'site_session_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    siteSessionId: uuid('site_session_id').references(() => siteSessions.id, { onDelete: 'set null' }),
    domain: text('domain').notNull(),
    event: text('event').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    outcome: text('outcome'),
    createdAt: createdAt(),
  },
  (t) => [
    index('site_session_events_owner_idx').on(t.ownerId, t.createdAt.desc()),
    index('site_session_events_session_idx').on(t.siteSessionId).where(sql`${t.siteSessionId} IS NOT NULL`),
    index('site_session_events_run_idx').on(t.runId).where(sql`${t.runId} IS NOT NULL`),
    check('site_session_events_event', sql`${t.event} IN ('used', 'checked', 'revoked', 'refresh_requested', 'refreshed')`),
    check('site_session_events_outcome_len', sql`${t.outcome} IS NULL OR length(${t.outcome}) <= 120`),
  ],
);

export const tunnels = pgTable(
  'tunnels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: projectId(),
    deviceId: text('device_id').notNull(),
    deviceLabel: text('device_label'),
    tokenHash: text('token_hash').notNull().unique(),
    gatewayInstance: text('gateway_instance'),
    connEpoch: bigint('conn_epoch', { mode: 'number' }).notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    lastSeenAt: tstz('last_seen_at'),
    createdAt: createdAt(),
    // Migration 0008_extension_pairing (tâche 2.6).
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    // Migration 0014_tunnel_gateway (tâche 2.7) : connexion WSS en cours.
    connectedAt: tstz('connected_at'),
  },
  (t) => [
    index('tunnels_owner_id_idx').on(t.ownerId),
    uniqueIndex('tunnels_owner_connected').on(t.ownerId).where(sql`${t.gatewayInstance} IS NOT NULL`),
  ],
);

/**
 * Créations de run par clé d'API sur une fenêtre d'une minute ouverte par la première création (08b § 3, migration 0017) :
 * compteur partagé entre instances du serveur. Table système, jamais lue sous runtime_app.
 */
export const runCreationCounters = pgTable('run_creation_counters', {
  bucket: text('bucket').primaryKey(),
  windowStart: tstz('window_start').notNull(),
  hits: integer('hits').notNull(),
});

/** Code d'appairage de l'extension (07 § 1) : usage unique, 10 min, empreinte seulement (migration 0008). */
export const extensionPairingCodes = pgTable(
  'extension_pairing_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    tunnelId: uuid('tunnel_id').references(() => tunnels.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('extension_pairing_codes_owner_id_idx').on(t.ownerId)],
);

export const tunnelJobs = pgTable(
  'tunnel_jobs',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    tunnelId: uuid('tunnel_id').references(() => tunnels.id, { onDelete: 'set null' }),
    ownerId: ownerId(),
    projectId: projectId(),
    payload: jsonb('payload').notNull().default({}),
    state: text('state').notNull().default('pending'),
    trace: jsonb('trace'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Migration 0014_tunnel_gateway (tâche 2.7) : commande, routage, réponse.
    cmd: text('cmd').notNull(),
    domain: text('domain').notNull(),
    execution: text('execution'),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    replayable: boolean('replayable').notNull().default(false),
    allowWriteActions: boolean('allow_write_actions').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    gatewayInstance: text('gateway_instance'),
    dispatchedAt: tstz('dispatched_at'),
    finishedAt: tstz('finished_at'),
    result: jsonb('result'),
    error: text('error'),
  },
  (t) => [index('tunnel_jobs_owner_id_idx').on(t.ownerId), index('tunnel_jobs_run_id_idx').on(t.runId)],
);

export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  startedAt: tstz('started_at').notNull().defaultNow(),
  lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  version: text('version').notNull(),
  browserContexts: integer('browser_contexts').notNull().default(0),
  rssMb: integer('rss_mb'),
  draining: boolean('draining').notNull().default(false),
});

export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: projectId(),
    url: text('url').notNull(),
    events: text('events').array().notNull().default(sql`'{}'`),
    secretId: uuid('secret_id').references(() => secrets.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
    disabledAt: tstz('disabled_at'),
    // 0010_scheduling_webhooks (2.5) : rotation à deux secrets, désactivation après 5 jours d'échecs.
    previousSecretId: uuid('previous_secret_id').references(() => secrets.id, { onDelete: 'set null' }),
    previousSecretExpiresAt: tstz('previous_secret_expires_at'),
    failingSince: tstz('failing_since'),
    lastSuccessAt: tstz('last_success_at'),
    testedAt: tstz('tested_at'),
    // 0011 (2.5) : dernier échec (série « continue » = jamais plus de 24 h sans échec). Clés étrangères liées au
    // propriétaire (secret_id, owner_id) → secrets (id, owner_id), `ON DELETE SET NULL (colonne)` : écrites en SQL seulement.
    lastFailureAt: tstz('last_failure_at'),
    // 0017_rest_api (3.1) : abonnement limité à une API (NULL = toutes les API du propriétaire).
    apiId: uuid('api_id').references((): AnyPgColumn => apis.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhook_subscriptions_owner_id_idx').on(t.ownerId), unique('webhook_subscriptions_id_owner_key').on(t.id, t.ownerId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    ownerId: ownerId(),
    projectId: projectId(),
    event: text('event').notNull(),
    dispatchId: uuid('dispatch_id').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] }).notNull().default('pending'),
    httpStatus: integer('http_status'),
    nextAttemptAt: tstz('next_attempt_at'),
    // 0010_scheduling_webhooks (2.5) : journal de livraison et charge rejouable.
    eventId: uuid('event_id').notNull().defaultRandom(),
    payload: jsonb('payload').notNull().default({}),
    durationMs: integer('duration_ms'),
    responseExcerpt: text('response_excerpt'),
    errorCode: text('error_code'),
    finishedAt: tstz('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('webhook_deliveries_dispatch_attempt_key').on(t.dispatchId, t.attempt),
    // 0011 : (subscription_id, owner_id) → webhook_subscriptions (id, owner_id), ON DELETE CASCADE.
    foreignKey({ name: 'webhook_deliveries_subscription_owner_fkey', columns: [t.subscriptionId, t.ownerId], foreignColumns: [webhookSubscriptions.id, webhookSubscriptions.ownerId] }).onDelete('cascade'),
    index('webhook_deliveries_owner_id_idx').on(t.ownerId),
  ],
);
