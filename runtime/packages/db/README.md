# @runtime/db

Schéma PostgreSQL v3, migrations SQL versionnées et runner verrouillé (tâche 0.2, CDC [03 § Schéma](../../../cdc/scrapyomama-runtime/03-architecture.md#schéma-postgresql), [13 § 12](../../../cdc/scrapyomama-runtime/13-specs-utilisateurs-auth.md#12-tables), [14 § 4-5 et § 9](../../../cdc/scrapyomama-runtime/14-specs-exploitation.md)).

## Contenu

| Fichier | Rôle |
|---|---|
| `migrations/NNNN_nom/up.sql`, `down.sql` | Migrations **écrites à la main**, qui font foi. `drizzle-kit push` interdit ; Drizzle Kit ne sert pas à générer. |
| `src/schema.ts` | Schéma Drizzle 0.45 (pilote `pg`), miroir typé des migrations. Concordance vérifiée par `schema.integration.test.ts`. |
| `src/migrate.ts` | Runner : table `schema_migrations` (version, nom, sha256 de `up.sql`), `pg_advisory_lock` sur la clé fixe `8315178094305570145`, une transaction par migration, idempotent, refus si une migration appliquée a changé ou si la base est plus récente que le code. `migrateDown` refusé si `NODE_ENV=production`. |
| `src/connection.ts` | `DATABASE_URL` / `DATABASE_URL_DIRECT` et détection du pooler en mode transaction. |
| `src/secrets.ts` | Secrets (INV8, 0.3a) : `keyCheck` (témoin `settings.key_check`), `secretStore` (`put`, `get` → `Secret`, `list` en métadonnées), `rekey` reprenable, `acceptKeyLoss`, registre `ENCRYPTED_COLUMNS`. Crypto pure dans `@runtime/core` (`crypto/`). |
| `src/run-logs.ts` | `appendRunLog` : masquage (`redact`) avant insertion dans `run_logs`. |
| `src/partitions.ts` | Partitions mensuelles de `dataset_items` : création, liste, purge (`DETACH … CONCURRENTLY` puis `DROP`). |

Secrets : `runtime keygen`, `runtime key-check`, `runtime rekey --confirm` (MASTER_KEY = nouvelle, MASTER_KEY_PREVIOUS = ancienne ; lots transactionnels, état dans `settings.rekey_state`, relance = reprise). Enveloppe : KEK = HKDF-SHA256(MASTER_KEY, libellé `kek:secrets`) ; DEK aléatoire par valeur ; AAD `secret|id|kind|owner_id|instance` recalculée à chaque lecture ; `kek_version` = génération de la clé maîtresse. Migration `0002_secret_state` : `secrets.state` (`ok` | `unreadable`), `unreadable_since`.

Commande : `runtime migrate` (applique), `runtime migrate down [--steps N | --all]` (tests et CI seulement). Dans l'image : `RUNTIME_MODE=migrate`.

## Ajouter une migration

1. Créer `migrations/000N_nom/up.sql` et `down.sql` (numérotation continue).
2. Reporter les colonnes dans `src/schema.ts`.
3. `pnpm test:integration` : concordance Drizzle, aller-retour `up`/`down`/`up` (schéma et données identiques), rejeu idempotent, verrou, sur PostgreSQL 16, 17 et 18.

Une migration appliquée n'est jamais modifiée (le runner refuse). En production, correction vers l'avant ; destructif = expand / contract sur deux versions.

## Connexion de session et pooler

LISTEN, pg-boss, les migrations et les verrous exigent une connexion de session. `resolveConnections(env)` :

1. `DATABASE_URL` obligatoire ; URL de session = `DATABASE_URL_DIRECT`, sinon `DATABASE_URL`.
2. **Heuristique** (sans connexion) sur l'URL de session : port `6543` (Supabase/Supavisor, mode transaction), hôte contenant `-pooler.` (Neon, PgBouncer en mode transaction), paramètre `pgbouncer=true`. Un port `6432` (PgBouncer, mode inconnu) ou un pooler Supabase en `5432` (mode session) ne déclenchent rien : la sonde tranche.
3. **Sonde réelle** : trois `pg_backend_pid()` sur le même client doivent être égaux, et un `NOTIFY` émis depuis une autre connexion doit être reçu par `LISTEN` en 3 s.
4. Échec → `DatabaseConfigError` « connexion de session requise : DATABASE_URL (hôte:port) passe par un pooler en mode transaction (raison)… définissez DATABASE_URL_DIRECT ». Le mot de passe n'apparaît jamais.

## Partitions de `dataset_items`

Partitionnement déclaratif `RANGE (created_at)`, clé primaire `(created_at, dataset_id, seq)`, une partition par mois UTC nommée `dataset_items_pAAAAMM`. `ensure_dataset_items_partitions(at, months)` (SQL, idempotente) crée le mois courant et le suivant ; la migration l'appelle, la tâche quotidienne `ensure_partitions` (1.8) aussi. **Pas de partition par défaut** : une écriture hors partition échoue au lieu de remplir une partition qui bloquerait ensuite la création du mois.

## Tables

33 tables (plus `schema_migrations`, gérée par le runner) et 2 vues (`admin_run_metadata`, `admin_dataset_usage`, métadonnées seulement). Tables métier avec `owner_id` NOT NULL indexé et `project_id` NOT NULL (défaut : projet `default`, `00000000-0000-0000-0000-000000000001`) : `apis`, `strategy_versions`, `runs`, `run_attempts`, `run_logs`, `run_artifacts`, `investigation_events`, `status_events`, `datasets`, `dataset_items`, `dedup_keys`, `schedules`, `site_sessions`, `tunnels`, `tunnel_jobs`, `webhook_subscriptions`, `webhook_deliveries`. `secrets` porte `project_id` et un `owner_id` **nullable** (NULL = secret d'instance : LLM, proxys, SMTP). Sans propriétaire par nature : `users` et tables d'auth (rattachées par `user_id`), `audit_events`, `settings`, `projects`, `domain_pacing_state` (clé = domaine seulement, `assert_pacing_key_is_domain`), `worker_heartbeats`, `subject_exclusions` (liste d'instance). RLS : tâche 0.3b.

## Mapping Better Auth 1.7 (adaptateur Drizzle, branché en 0.3b)

Vérifié sur `@better-auth/core@1.7.5` (`db/get-tables`) et `better-auth@1.7.5` (`plugins/two-factor/schema`). Options à passer :

```ts
drizzleAdapter(db, { provider: 'pg', schema: { users, auth_sessions: authSessions, auth_accounts: authAccounts, verifications, two_factor: twoFactor } }),
advanced: { database: { generateId: 'uuid' } },           // colonnes id en uuid
user: { modelName: 'users', fields: { name: 'displayName' },   // clés = propriétés du schéma Drizzle
        additionalFields: { role, status, locale, theme } }, // input: false pour role et status
session: { modelName: 'auth_sessions', fields: { token: 'tokenHash', updatedAt: 'lastSeenAt', ipAddress: 'ip' } },
account: { modelName: 'auth_accounts', fields: { password: 'passwordHash' } },
verification: { modelName: 'verifications' },
plugins: [twoFactor({ schema: { twoFactor: { modelName: 'two_factor', fields: { secret: 'secretCiphertext' } } } })],
```

| Modèle Better Auth | Table | Champs attendus → colonnes |
|---|---|---|
| `user` | `users` | id, name → `display_name`, email (`citext`, unique), emailVerified → `email_verified`, image, createdAt, updatedAt ; plugin 2FA : twoFactorEnabled → `two_factor_enabled` |
| `session` | `auth_sessions` | id, token → `token_hash` (unique), expiresAt, createdAt, updatedAt → `last_seen_at`, ipAddress → `ip`, userAgent, userId |
| `account` | `auth_accounts` | id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password → `password_hash`, createdAt, updatedAt |
| `verification` | `verifications` | id, identifier, value, expiresAt, createdAt, updatedAt |
| `twoFactor` (plugin) | `two_factor` | id, secret → `secret_ciphertext`, backupCodes → `backup_codes`, userId (unique), verified, failedVerificationCount, lockedUntil |

Colonnes propres au produit, ignorées par Better Auth : `users.role/status/locale/theme/email_verified_at/disabled_at/last_login_at`, `auth_sessions.absolute_expires_at/revoked_at`, `two_factor.nonce/key_version/confirmed_at`, table `backup_codes`. Le plugin `apiKey` n'est **pas** utilisé : `api_keys` est notre table (format `sy_live_`, SHA-256, scopes contrôlés en base). Le stockage `rateLimit` en base n'est pas prévu (mémoire par défaut).

**À trancher en 0.3b** : Better Auth écrit le jeton de session tel quel dans `token` (colonne `token_hash`) et chiffre le secret TOTP avec son propre secret, pas avec `MASTER_KEY` + AAD (13 § 5 et § 7) ; les codes de secours du plugin sont une chaîne chiffrée dans `two_factor.backup_codes`, pas des hachés dans `backup_codes`. Il faut soit des crochets (hooks de base) qui hachent et chiffrent, soit un TOTP maison.
