<!-- Fichier généré par scripts/docs-reference.ts (`pnpm --filter @sym-browser/module docs:reference`) : ne pas éditer. -->

# Référence de la configuration

Variables d’environnement lues par l’image (`SYMB_MODE` : `all`, `gateway` ou `node`). Un secret accepte aussi `NOM_FILE=/chemin`. Une configuration invalide arrête le démarrage avec un message qui nomme la variable ; `node dist/main.js --check-config` valide sans écouter.

## Process

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `SYMB_MODE` | `all` | — | non | `all` (passerelle et nœud dans un process, stockage disque), `gateway` ou `node` : rôle du process (03 § 4). |
| `PORT` | `3000` | — | non | Port d’écoute (0 à 65535 ; 0 : port libre choisi par le système, pour les tests). Respecte la valeur injectée par la plateforme. |
| `NODE_ENV` | `production` | — | non | `production`, `development` ou `test`. Seul `test` active les drapeaux de test ; ailleurs leur présence arrête le démarrage. |
| `SHUTDOWN_GRACE_SECONDS` | `270` | — | non | Grâce de drainage sur SIGTERM, de 1 à 300 secondes (04b § 9). |

## Base et clé

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `DATABASE_URL` | — | `all`, `gateway`, `node` | oui (`_FILE`) | PostgreSQL 16 à 18, schéma `postgres://` ou `postgresql://`. |
| `MASTER_KEY` | — | `all`, `gateway`, `node` | oui (`_FILE`) | Exactement 32 octets en base64 (44 caractères), sans phrase secrète. Génération : `openssl rand -base64 32`. À sauvegarder hors de la plateforme : sans elle, les secrets sont illisibles. |
| `MASTER_KEY_PREVIOUS` | — | — | oui (`_FILE`) | Ancienne clé, le temps d’un changement de clé ; même format que `MASTER_KEY`. À retirer ensuite. |

## Nœud

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `NODE_TOKEN` | — | `gateway`, `node` | oui (`_FILE`) | Secret partagé passerelle et nœud, 32 caractères au moins. Inutile en mode `all` (le nœud s’enregistre sur 127.0.0.1). |
| `NODE_PUBLIC_URL` | — | `node` | non | URL privée (http ou https) annoncée à la passerelle. En mode `all` : `http://127.0.0.1:<PORT>`. |
| `NODE_ID` | nom d’hôte | — | non | Identifiant stable du nœud (1 à 63 caractères `A-Za-z0-9_.-`). |
| `NODE_REGION` | `default` | — | non | Région annoncée à la passerelle (`a-z0-9_.-`, 1 à 40 caractères). |
| `MAX_SESSIONS` | calculé (04b § 3) | — | non | Slots du nœud, de 1 à 64 ; remplace la valeur calculée depuis la mémoire du conteneur. |
| `WARM_BROWSERS` | `1` | — | non | Chromium chauds préchauffés (0 à 64). |
| `CONTEXTS_PER_BROWSER` | figé par la tâche 0.6 | — | non | Contextes simultanés par Chromium chaud (1 à 64) ; sans valeur, la constante mesurée par la tâche 0.6. |
| `RECYCLE_AFTER_SESSIONS` | `50` | — | non | Sessions servies avant recyclage d’un Chromium. |
| `RECYCLE_AFTER_MS` | `3600000` | — | non | Âge d’un Chromium avant recyclage, en millisecondes. |
| `RECYCLE_RSS_PERCENT` | `90` | — | non | Seuil mémoire de recyclage, en pourcentage (1 à 100). |
| `HEARTBEAT_MS` | `5000` | — | non | Période du battement du nœud vers la passerelle, en millisecondes (100 au minimum). |
| `SYMB_DATA_DIR` | `/data` | — | non | Répertoires de travail des sessions (`sessions/{id}`), chemin absolu. |
| `SYMB_PRIVATE_HOSTS` | — | — | non | Hôtes privés joignables par l’egress : noms exacts ou CIDR séparés par des virgules. Vide : tout hôte privé est refusé. |
| `SYMB_IP_ECHO_URL` | `https://api.ipify.org/?format=json` | — | non | Point d’écho HTTPS du test de proxy amont à la création de session (réponse JSON `{ip}` ou texte brut) : son hôte s’ajoute à la politique pour ce seul test (04c § 2.3). |

## Passerelle

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `QUEUE_MAX` | `50` | — | non | Taille globale de la file d’attente de sessions. |
| `QUEUE_MAX_PER_TENANT` | `10` | — | non | Taille de la file par client. |
| `QUEUE_TIMEOUT_MS` | `30000` | — | non | Attente maximale en file, en millisecondes. |

## Stockage

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `OBJECT_STORE` | `disk` | — | non | `disk` ou `s3`. Le mode `all` n’accepte que `disk`. |
| `OBJECT_DIR` | `/data/objects` | — | non | Répertoire du mode `disk`, chemin absolu. |
| `S3_ENDPOINT` | — | — | non | Point d’accès d’un stockage S3 compatible (R2, MinIO), URL http ou https ; vide : AWS S3. |
| `S3_BUCKET` | — | — | non | Bucket ; obligatoire avec `OBJECT_STORE=s3`. |
| `S3_REGION` | — | — | non | Région du bucket. |
| `S3_ACCESS_KEY_ID` | — | — | oui (`_FILE`) | Identifiant d’accès S3 ; obligatoire avec `OBJECT_STORE=s3`. |
| `S3_SECRET_ACCESS_KEY` | — | — | oui (`_FILE`) | Secret d’accès S3 ; obligatoire avec `OBJECT_STORE=s3`. |

## Limites

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `SYMB_PROFILE_MAX_BYTES` | `104857600` | — | non | Taille maximale d’un profil persistant, en octets (100 Mo, à valider). |
| `SYMB_DOWNLOAD_MAX_BYTES` | `524288000` | — | non | Plafond par fichier téléchargé, en octets (500 Mo, à valider). |
| `SYMB_SESSION_DOWNLOAD_MAX_BYTES` | `2147483648` | — | non | Plafond de téléchargements par session, en octets (2 Go, à valider). |
| `SYMB_UPLOAD_MAX_BYTES` | `104857600` | — | non | Plafond par envoi de fichier, en octets (100 Mo, à valider). |
| `SYMB_CDP_MAX_MESSAGE_BYTES` | `104857600` | — | non | Taille maximale d’un message CDP relayé, en octets (100 Mo, à valider). |
| `SYMB_RECORDING_MAX_BYTES` | `209715200` | — | non | Plafond par enregistrement, en octets (200 Mo, à valider). |

## Rétention

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `SYMB_RETENTION_TRACE_DAYS` | `7` | — | non | Conservation des traces Playwright, en jours. |
| `SYMB_RETENTION_HAR_DAYS` | `7` | — | non | Conservation des HAR, en jours. |
| `SYMB_RETENTION_VIDEO_DAYS` | `7` | — | non | Conservation des vidéos, en jours. |
| `SYMB_RETENTION_LOG_DAYS` | `7` | — | non | Conservation des journaux de session, en jours. |
| `SYMB_RETENTION_DOWNLOAD_HOURS` | `24` | — | non | Conservation des téléchargements gardés, en heures. |

## Journaux et accès

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `SYMB_LOG_LEVEL` | `info` | — | non | `trace`, `debug`, `info`, `warn`, `error` ou `fatal` : seuil des journaux (JSON sur stdout). |
| `SYMB_METRICS_TOKEN` | aucun (généré par keygen, tâche 0.3) | — | oui (`_FILE`) | Jeton de lecture de `/metrics`, 32 caractères au moins. |
| `SYMB_BOOTSTRAP_TOKEN` | généré au premier démarrage | — | oui (`_FILE`) | Jeton de `/setup` (premier démarrage), 32 caractères au moins. |
| `SYMB_BOOTSTRAP_API_KEY` | — | — | oui (`_FILE`) | Première clé d’API (client `sym`) créée si la table des clés est vide ; clé d’échange avec SYM. 32 caractères au moins. |

## Test

| Variable | Défaut | Obligatoire en | Secret | Description |
|---|---|---|---|---|
| `SYMB_TEST_MODE` | — | — | non | `1` sous `NODE_ENV=test` : route `/v1/_test/process-info/{id}`. Sa présence ailleurs arrête le démarrage. |
| `SYMB_TEST_ALLOW_PRIVATE` | — | — | non | `1` sous `NODE_ENV=test` : l’egress joint les fixtures privées. Sa présence ailleurs arrête le démarrage. |
