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
| `src/rls.ts` | `withActor(pool, actor, fn)` : transaction sous le rôle `runtime_app` avec `app.user_id` / `app.role` (0.3b). |
| `src/audit.ts` | `appendAudit` : ligne d’`audit_events` (ajout seul), `meta` masquée (`redact` + clés sensibles). |
| `src/queue.ts` | `PgBossJobQueue` : **seul** adaptateur pg-boss 12 (`JobQueue` de `@runtime/core`). Aucun SQL brut sur `pgboss.*` ailleurs. |
| `src/runs.ts` | Cycle de vie des runs (1.3) : `createRun` (run + job, même transaction), `cancelRun`, `recordSkippedRun`, `readRun` ; worker : `claimRun`, `heartbeatRun`, `recordAttempt`, `finishRun`, `requeueRun`, `sweepOrphans` ; bail de réparation ; `worker_heartbeats`. |
| `src/ops/` | Exploitation (4.6, 14 § 6-8) : `runDoctor` (lecture seule, locale ; code de sortie 0/1/2), `connectionBudget`, `buildDiagnostics` (fichier masqué, noms de réglages sans valeurs ; base joignable mais illisible : `database_read_error` à code stable, jamais « injoignable »), `exportCatalog` (liste blanche de colonnes, sans secret), `declareBackup`, `acceptKeyLossLocked` (D-12 ; registre `KEY_LOSS_TREATMENT` : chaque colonne de `ENCRYPTED_COLUMNS` traitée ou déclarée différée), `ensureAppRole` (rôle de cluster `runtime_app`, à recréer avant un `pg_restore` sur un autre cluster), `schemaVersionRefusal` (code plus ancien que le schéma : retour d'image sans restauration refusé). Guide : [`docs/exploitation.md`](../../docs/exploitation.md). |
| `src/partitions.ts` | Partitions mensuelles de `dataset_items` : création, liste, purge (`DETACH … CONCURRENTLY` puis `DROP`). |

Secrets : `runtime keygen`, `runtime key-check`, `runtime rekey --confirm` (MASTER_KEY = nouvelle, MASTER_KEY_PREVIOUS = ancienne ; lots transactionnels, état dans `settings.rekey_state`, relance = reprise). Enveloppe : KEK = HKDF-SHA256(MASTER_KEY, libellé `kek:secrets`) ; DEK aléatoire par valeur ; AAD `secret|id|kind|owner_id|instance` recalculée à chaque lecture ; `kek_version` = génération de la clé maîtresse. Migration `0002_secret_state` : `secrets.state` (`ok` | `unreadable`), `unreadable_since`.

Exploitation : `runtime doctor`, `diagnostics`, `export-catalog`, `backup declare`, `restore-prepare`, `secrets accept-key-loss --confirm` ([guide](../../docs/exploitation.md)).

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

33 tables (plus `schema_migrations`, gérée par le runner) et 2 vues (`admin_run_metadata`, `admin_dataset_usage`, métadonnées seulement). Tables métier avec `owner_id` NOT NULL indexé et `project_id` NOT NULL (défaut : projet `default`, `00000000-0000-0000-0000-000000000001`) : `apis`, `strategy_versions`, `runs`, `run_attempts`, `run_logs`, `run_artifacts`, `investigation_events`, `status_events`, `datasets`, `dataset_items`, `dedup_keys`, `schedules`, `site_sessions`, `tunnels`, `tunnel_jobs`, `webhook_subscriptions`, `webhook_deliveries`. `secrets` porte `project_id` et un `owner_id` **nullable** (NULL = secret d'instance : LLM, proxys, SMTP). Sans propriétaire par nature : `users` et tables d'auth (rattachées par `user_id`), `audit_events`, `settings`, `projects`, `domain_pacing_state` (clé = domaine seulement, `assert_pacing_key_is_domain`), `worker_heartbeats`, `subject_exclusions` (liste d'instance). RLS : migration `0003_rls_app_role` (ci-dessous).

## Mapping Better Auth 1.7 (adaptateur Drizzle, branché en 0.3b)

Vérifié sur `@better-auth/core@1.7.5` (`db/get-tables`) et `better-auth@1.7.5` (`plugins/two-factor/schema`). Options à passer :

```ts
drizzleAdapter(db, { provider: 'pg', schema: { users, auth_sessions: authSessions, auth_accounts: authAccounts, verifications } }), // enveloppé par withHashedSessionTokens
advanced: { database: { generateId: 'uuid' } },           // colonnes id en uuid
user: { modelName: 'users', fields: { name: 'displayName' } },  // clés = propriétés du schéma Drizzle ; rôle et statut relus par notre garde
session: { modelName: 'auth_sessions', fields: { token: 'tokenHash', updatedAt: 'lastSeenAt', ipAddress: 'ip' },
           additionalFields: { absoluteExpiresAt } },            // durée absolue, posée par databaseHooks
account: { modelName: 'auth_accounts', fields: { password: 'passwordHash' } },
verification: { modelName: 'verifications' },
// plugins : aucun en 0.3b (twoFactor écarté, voir « Décisions 0.3b »)
```

| Modèle Better Auth | Table | Champs attendus → colonnes |
|---|---|---|
| `user` | `users` | id, name → `display_name`, email (`citext`, unique), emailVerified → `email_verified`, image, createdAt, updatedAt ; plugin 2FA : twoFactorEnabled → `two_factor_enabled` |
| `session` | `auth_sessions` | id, token → `token_hash` (unique), expiresAt, createdAt, updatedAt → `last_seen_at`, ipAddress → `ip`, userAgent, userId |
| `account` | `auth_accounts` | id, accountId, providerId, userId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password → `password_hash`, createdAt, updatedAt |
| `verification` | `verifications` | id, identifier, value, expiresAt, createdAt, updatedAt |
| `twoFactor` (plugin) | `two_factor` | id, secret → `secret_ciphertext`, backupCodes → `backup_codes`, userId (unique), verified, failedVerificationCount, lockedUntil |

Colonnes propres au produit, ignorées par Better Auth : `users.role/status/locale/theme/email_verified_at/disabled_at/last_login_at`, `auth_sessions.revoked_at`, `two_factor.nonce/key_version/confirmed_at`, table `backup_codes`. Le plugin `apiKey` n'est **pas** utilisé : `api_keys` est notre table (format `sy_live_`, SHA-256, scopes contrôlés en base). Le stockage `rateLimit` en base n'est pas prévu (mémoire par défaut).

## Décisions 0.3b (auth noyau)

Branchement réel : `apps/server/src/auth/better-auth.ts` (Better Auth **1.7.5**, entrée `better-auth/minimal`, sans Kysely).

- **Jeton de session haché** : surcouche de l'adaptateur Drizzle (`apps/server/src/auth/hashed-session-adapter.ts`). Pour le modèle `session`, `token` est remplacé par son SHA-256 à l'écriture et dans chaque clause `where` (y compris `in` et dans les transactions de la bibliothèque) ; le jeton reçu est rendu à l'appelant. La base ne contient que `auth_sessions.token_hash` (test : aucun jeton en clair dans aucune table).
- **2FA non activée en 0.3b** : le plugin `twoFactor` chiffre la graine TOTP avec le secret de la bibliothèque (pas `MASTER_KEY` + AAD) et garde les codes de secours dans une chaîne chiffrée réversible (`storeBackupCodes`), pas hachés. Solution retenue pour 3.7 : **TOTP maison** sur nos primitives — graine CSPRNG scellée par `sealSecret` (KEK `secrets`, AAD `two_factor|user_id|key_version`) dans `two_factor.secret_ciphertext`/`nonce`/`key_version`, vérification RFC 6238 (`node:crypto` HMAC-SHA1, fenêtre ±1, anti-rejeu par dernier pas accepté), 10 codes de secours hachés (SHA-256 d'un aléa de 64 bits minimum) dans `backup_codes`, colonne `two_factor.backup_codes` inutilisée. `ENCRYPTED_COLUMNS` marque `two_factor.secret_ciphertext` pour 3.7.
- **Télémétrie** (`@better-auth/telemetry` 1.7.5, lu) : aucun envoi sans `BETTER_AUTH_TELEMETRY_ENDPOINT` (vide par défaut) ; la variable `BETTER_AUTH_TELEMETRY` l'emporte sur l'option. Donc `telemetry: { enabled: false }` **et** retrait des variables `BETTER_AUTH_TELEMETRY*` de l'environnement au démarrage. Test : intercepteur global (fetch, undici, http, sockets), 0 requête sortante (démarrage, assistant, connexion, session).
- **Aucun plugin** (ni `admin`, ni impersonation, ni SSO) ; seules trois routes de la bibliothèque sont exposées : `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`, `GET /api/auth/get-session` ; tout autre chemin répond 404. `verifications.value` reste en clair tant qu'aucun flux ne l'utilise (réinitialisation par e-mail : 3.7, à hacher alors comme la session).
- **Secret de la bibliothèque** : HKDF de `MASTER_KEY`, libellé `kek:sessions` (une rotation de clé ferme toutes les sessions).
- **Mots de passe** : `crypto.argon2` (argon2id, m = 19 456, t = 2, p = 1), fonctions `hash`/`verify` passées à la bibliothèque ; politique 12-128 caractères + liste locale (`@runtime/core`, `auth/`).

## RLS (migration 0003)

- Rôle `runtime_app` : `NOLOGIN`, ni superutilisateur, ni `BYPASSRLS`, propriétaire d'aucune table ; accordé à l'utilisateur de connexion (`GRANT runtime_app TO current_user`) pour `SET LOCAL ROLE`. Objet du cluster : créé s'il manque, **non supprimé** par `down.sql` (qui retire ses droits dans la base).
- RLS activée sur les 18 tables à `owner_id` (dont `secrets` et `dataset_items`) et sur `api_keys` (`user_id`) ; politique `owner_isolation` (`owner_id = app_current_user_id()`, lecture et écriture) ; `instance_read` : API `instance` sans session (et ses versions de stratégie) lisible par un utilisateur authentifié.
- **Sans `FORCE ROW LEVEL SECURITY`** (écart à 13 § 3) : le propriétaire des tables est l'identité système (`keyCheck`, `rekey`, vues d'administration, bibliothèque d'auth). Sur un hébergeur où il n'est pas superutilisateur, `FORCE` sans politique pour lui rendrait ces opérations silencieusement vides. Les requêtes d'utilisateur ne l'utilisent jamais : elles passent par `withActor` (`SET LOCAL ROLE runtime_app`).
- Droits de `runtime_app` : contenu en CRUD (sous RLS), `api_keys` en SELECT/INSERT + UPDATE de `revoked_at`, `revoked_by`, `last_used_at`, `audit_events` en **INSERT seul** (`assert_audit_append_only`), vues `admin_run_metadata` / `admin_dataset_usage` (filtrées : toutes les lignes si `app.role` ∈ admin/owner, sinon les siennes). Aucun droit sur `users`, les tables d'auth, `settings`.

## File de jobs et runs (tâche 1.3)

pg-boss **12.34.0** (catalogue, `minimumReleaseAge` : 12.34.1+ trop récents au 2026-10-01), derrière `JobQueue` (`@runtime/core`, `run/`). pg-boss crée et migre son schéma `pgboss` sur la connexion de session ; son pool (`max`, défaut 2) compte dans le budget de 14 § 4.

- **Même transaction** : `createRun(tx, queue, …)` insère le run `queued` puis le job (`send` avec l'option `db` de pg-boss) dans la transaction `withActor` de l'appelant. `runtime_app` n'a aucun droit sur `pgboss` : l'adaptateur passe `SET LOCAL ROLE NONE` le temps de l'appel pg-boss, puis rétablit `runtime_app` (même transaction, même COMMIT). La charge du job est `{ run_id }` seul.
- **Jeton de clôture** (migration `0004_run_queue` : `runs.job_id`, `worker_id`, `requeue_count`) : chaque écriture du worker exige `job_id` = son job ; une remise en file change `job_id`.
- **Battements** : `runs.heartbeat_at` toutes les 10 s (`RUN_HEARTBEAT_SECONDS`) ; le job pg-boss a `heartbeatSeconds: 30` et `expireInSeconds` = budget (`RUN_BUDGET_SECONDS`, 900) + 60 ; `worker_heartbeats` toutes les 15 s.
- **Balayeur** (60 s, `SWEEP_INTERVAL_SECONDS`, dans chaque worker, `FOR UPDATE SKIP LOCKED`) : run `running`/`waiting_tunnel` sans battement depuis 30 s (`RUN_STALE_SECONDS`), ou `queued` dont le job n'est plus vivant → remis en file (nouveau job) si `requeue_count` < 1 (0 si `allow_write_actions`), sinon `failed` (`transient`, `worker_lost`). pg-boss ne rejoue jamais un run (`retryLimit: 0`).
- **Arrêt** (SIGTERM) : plus de nouveau job, `draining`, fin des runs sous `SHUTDOWN_TIMEOUT_SECONDS` (30), sinon remise en file sans compter la perte (API qui écrit : `failed`, `worker_shutdown`).
- **Identité** : côté web, `withActor` (RLS) ; côté worker, identité système (propriétaire des tables) limitée aux colonnes de pilotage des runs, du bail et de `worker_heartbeats`. Les données d'utilisateur écrites par un exécuteur passent par `withActor` avec `RunContext.ownerId`.
- **Bail de réparation** : `apis.repair_lease_owner/until` (90 s, renouvelé), jamais de verrou de session.

## Planification, webhooks et alertes (tâche 2.5, migrations `0010_scheduling_webhooks` et `0011_dataset_dedup_webhook_owner`)

Spécification : CDC `08-specs-byo-securite.md` § 5 et § 7, `docs/runtime-v2/t2-file-jobs/04-cron-multi-planification.md`, `o7-extensibilite/03-webhooks.md`. Tests : `schedules.integration.test.ts`, `webhooks.integration.test.ts`, `alerts.integration.test.ts`, `apps/worker/src/scheduling.integration.test.ts`, `tests/security/ssrf-guard.security.test.ts` (étage S).

- **`schedules` est la source de vérité** ; pg-boss n'en est que le miroir (`key = schedules.id`, file `scheduled-run`), reconstruit au démarrage du worker (`reconcileSchedules` ; après chaque écriture d'une ligne, l'appelant — REST de 3.1 — appelle `mirrorSchedule` une fois la transaction validée : lignes actives et propriétaire actif → `schedule()`, clés orphelines ou désactivées → `unschedule()`). Le cron de pg-boss prend un verrou en base à chaque passage et classe chaque occurrence dans un créneau d'unicité : deux workers ne produisent jamais deux jobs pour la même minute. `missed: 'once'` rattrape UNE occurrence manquée pendant un déploiement (la plus récente) ; défaut : `once` si les occurrences sont espacées d'au moins 1 h, `skip` sinon (pas de rafale).
- **Le job ne porte que `{ schedule_id }`** : `handleScheduledRun` relit la ligne (aucune règle copiée), verrouille la planification (`FOR UPDATE`), évalue les règles dans l'ordre statut (`skip_if_status_in`, défaut `[erreur, action_requise, bloquee]`, **`bloquee` non retirable**) → tunnel (`only_if_tunnel_online`, ou `requires.tunnel`) → fenêtre → quota du jour du fuseau → chevauchement, puis crée le run (`trigger = 'schedule'`, `schedule_id`, `scheduled_at`) et son job dans la même transaction, ou trace un run `skipped_*` avec son motif. `runs.schedule_job_id` est unique : un rejeu du même job ne crée rien. Un déclenchement n'élargit jamais l'accès : si l'API est devenue privée ou à session pour un autre que son propriétaire, rien ne part (INV5, INV12).
- **`overlap`** : `skip` (défaut, `skipped_overlap`), `allow`, `queue` (une seule occurrence en attente par planification, file `scheduled-run-deferred`, report toutes les 30 s, abandon après 1 h ; le report porte son occurrence, `occurrence_at`).
- **Heure de l'occurrence, pas du traitement** : `scheduled_at`, `{{today}}`/`{{yesterday}}`, la fenêtre et le quota du jour sont jugés sur l'occurrence servie. Elle se déduit de `createdOn` du job (instant d'émission par le cron, horloge de la file) : la dernière occurrence du cron au plus tard à cet instant, ou celle d'avant si un autre run de la planification l'a déjà prise (rattrapage `missed: once` et occurrence courante sont émis dans le même passage). pg-boss ne transmet pas le créneau de l'occurrence au job final (le `slot` reste dans le job intermédiaire `__pgboss__send-it`) : d'où cette déduction.
- **Horloge simulée** : `PgBossJobQueue({ clock })` accepte la `TestClock` de pg-boss. Elle règle l'heure des connexions DE pg-boss ; les écritures faites dans une transaction de l'appelant (`tx`) lisent l'horloge de Postgres. Pour un test à horloge simulée, démarrer la `TestClock` près de l'heure réelle, et une base neuve par test (pg-boss garde en base l'heure de son dernier passage).
- **Webhooks sortants** (`webhooks.ts`) : cible = URL (garde SSRF à l'enregistrement et à chaque envoi) + événements ; secret `whsec_` chiffré (`secrets`, `kind = webhook_secret`) rendu une fois ; rotation à deux secrets (`rotateWebhookSecret`, l'ancien reste valide 24 h par défaut). Une ligne `webhook_deliveries` par tentative (journal : code, durée, extrait de 512 caractères), `webhook-id` = `evt_<event_id>` stable, `dispatch-id` par (événement, cible), 5 tentatives (immédiat, 5 s, 5 min, 30 min, 2 h) en un job pg-boss par tentative (barème maison ; `retryLimit: 1` : un job interrompu entre l'envoi et l'écriture du journal est rejoué une fois, sans effet sur une ligne déjà close), jamais de relance pour un refus SSRF ou une redirection ; cible `disabled` après 5 jours d'échecs continus (`failing_since`), une série n'étant continue que sans trou de plus de 24 h entre deux échecs (`last_failure_at`). **Appartenance (INV12)** : une livraison n'utilise que la cible de son propriétaire et des secrets `webhook_secret` de ce propriétaire (contrôle dans `deliverWebhookAttempt`/`testWebhookSubscription` et clés étrangères `(subscription_id, owner_id)`, `(secret_id, owner_id)`, `(previous_secret_id, owner_id)` de 0011, le contrôle de clé étrangère contournant la RLS). `testWebhookSubscription`, `rotateWebhookSecret`, `enableWebhookSubscription`, `listDeliveries` et `redeliverWebhook` exigent `ownerId` (cible d'un autre : « introuvable »). Rotation : l'ancien « ancien » secret est supprimé au remplacement ; `purgeExpiredWebhookSecrets` (pas périodique du worker) retire le précédent une fois la grâce passée. Charges minces (INV5), `api.status_changed` vers `bloquee` : `retryable: false`, aucune conséquence automatique.
- **Annonce dans la transaction du fait annoncé** : `finishRunAndNotify` (fin de run → `run.succeeded` / `run.failed` / `items.new`, alerte d'échec d'un run planifié) et `applyStatusAndNotify` (transition → `api.status_changed`, alertes). Les exécuteurs de 2.1 et 2.3 changent le statut par `applyStatusAndNotify`, pas par `applyStatusTransition` seul.
- **Alertes SMTP** (`alerts.ts`) : réglages d'instance dans `settings` (`smtp`, `alerts`), mot de passe chiffré (`kind = smtp_password`). Transitions vers `erreur`, `action_requise`, `bloquee` ; un `warning` au-delà de D = max(7 j, 3 × période) (`checkLongWarnings`, une fois par épisode : `apis.warning_alerted_at`). Une alerte par API et par cause, agrégée sur `alerts.window_seconds` (file `alert-email`, politique `short`, clé `alert:<api>:<cause>`). Sans règle propre de l'API (cible webhook du propriétaire abonnée à `api.status_changed`) ; `alert_on` d'une planification restreint ses alertes. Le relais SMTP passe par la garde SSRF en politique `operator-config` (08b § 1 : privé permis, métadonnées cloud refusées ; `sendMail`, `@runtime/core/net`). L'e-mail cite le run de la transition (`status_events.run_id`) ou celui porté par le job (`AlertJob.run_id`), pas le dernier run de l'API. Le worker journalise le nombre de destinataires, jamais leurs adresses.
- **Dataset, `dedup_key` et `diff`** (`datasets.ts`, `RunContext.writeItems`) : un dataset par run (complété d'appel en appel). Avec `dedup_key`, chaque clé est inscrite dans `dedup_keys` (empreinte HMAC sous la clé des sujets, jamais la valeur en clair), par API ; clé jamais vue = item nouveau, clé déjà vue par le même run = doublon écarté. `diff: new` n'écrit que les nouveautés ; `diff: all` écrit tout et compte les nouveautés. `datasets.new_items` alimente `new_items` de `run.succeeded` et `items.new` (après une exécution de référence), jamais le total du run. Run d'un membre sur l'API d'instance d'un autre : pas de dédup (les clés appartiennent au propriétaire de l'API). **`diff: changed` et `diff: removed` sont refusés à l'enregistrement en V1** : ils exigent l'empreinte du contenu et la valeur des clés disparues, que `dedup_keys` ne garde pas (17 § 6) ; à livrer avec une colonne d'empreinte de contenu (décision à prendre).
- **« Marquer comme attendu » (08 § 5, 04 § 6) : non livré en 2.5, reporté.** Il exclut un run de la base de calcul des signaux de run dégradé (`volume_anomaly`, médiane à même empreinte d'entrée) ; cette base n'est calculée nulle part encore (`volumeAnomaly` de `@runtime/core` n'a pas d'appelant). Cible : la tâche qui branche le calcul des signaux dégradés dans l'exécuteur (1.6/1.7, ou 4.2 à défaut) pour la colonne et l'exclusion, 3.1 pour l'endpoint, 3.4 pour le bouton.
