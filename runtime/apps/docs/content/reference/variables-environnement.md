---
title: "Variables d'environnement"
description: "Toutes les variables lues par le serveur, le worker et la CLI, avec leurs défauts."
---

# Variables d'environnement

Cette page liste les variables d'environnement de l'instance. La colonne **État** dit si le code de cette version les lit déjà : **lue** (effective) ou **prévue** (réservée, documentée, sans effet pour l'instant). Un test compare cette page au code : une variable lue qui n'est pas décrite ici, ou une variable « prévue » qui devient lue sans que la page change, fait échouer la CI.

Tout le reste (modèle IA, proxys, courrier sortant, authentification unique, alertes) se règle **dans la console**, et reste chiffré en base. Aucune variable ne déclenche un contrôle de version sortant ni un rapport d'usage : l'instance n'envoie rien à l'éditeur (voir [Télémétrie](../explications/telemetrie.md)).

## Règles communes

- **Secrets en fichier** : `MASTER_KEY`, `MASTER_KEY_PREVIOUS`, `ADMIN_BOOTSTRAP_TOKEN` et `METRICS_TOKEN` acceptent le suffixe `_FILE` (`MASTER_KEY_FILE=/run/secrets/master_key`), pratique pour les secrets Docker. Poser la variable **et** son `_FILE` est refusé.
- **Variables retirées** : une fois lues, les variables sensibles sont retirées de l'environnement du processus, pour qu'un code tiers ou un processus enfant ne puisse pas les relire. Le bac à sable démarre avec un environnement vide.
- **Valeur invalide** : le démarrage est refusé avec un message qui nomme la variable.
- **Durées** en secondes (`_SECONDS`) ou en jours (`_DAYS`), nombres positifs.

## Base de données

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `DATABASE_URL` | obligatoire | server, worker, CLI | URL PostgreSQL (15 ou plus, 16 recommandé). Peut viser un pooler en mode session. TLS : `sslmode` dans l'URL | lue |
| `DATABASE_URL_DIRECT` | `DATABASE_URL` | server, worker, CLI | connexion directe : file de jobs, verrous, migrations. **Obligatoire** derrière un pooler en mode transaction | lue |
| `DB_POOL_MAX` | 5 | worker | taille du pool de connexions | lue |
| `DATABASE_SSL` | voir la note | — | réglage du TLS vers la base | prévue |

Pour l'instant, le TLS vers la base se règle par `sslmode` dans `DATABASE_URL` ; `DATABASE_SSL` est réservée.

## Clé maîtresse

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `MASTER_KEY` | obligatoire | server, worker, CLI | 32 octets en base64 (44 caractères), sans phrase secrète ; `runtime keygen` ou `openssl rand -base64 32` | lue |
| `MASTER_KEY_PREVIOUS` | aucune | CLI (`rekey`) | ancienne clé, le temps d'une rotation | lue |

## Réseau et accès

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `PUBLIC_URL` | obligatoire (server) | server | adresse publique de l'instance : cookies `Secure`, contrôle d'`Origin`, extension | lue |
| `PORT` | 3000 | server | port d'écoute ; respecte la valeur injectée par l'hébergeur | lue |
| `HOST` | `0.0.0.0` | server | adresse d'écoute | lue |
| `TRUST_PROXY` | `false` | server | nombre de sauts de proxy, ou liste d'adresses ou de plages CIDR. Jamais `true` sans proxy devant | lue |
| `INSTANCE_CONTACT` | aucun | worker | contact de l'opérateur, annoncé dans le jeton du User-Agent du robot et dans `From` quand `IDENTIFY_INSTANCE` est activé ; le réglage saisi à l'assistant de premier démarrage l'emporte | lue |
| `IDENTIFY_INSTANCE` | `false` | worker | `true` : jeton `compatible; Scrapyomama/<version>; +<contact>` dans le User-Agent et en-tête `From` (adresse électronique) ; sinon le User-Agent est celui, réel, du Chromium embarqué. Le réglage admin `identify_instance` l'emporte | lue |
| `MAX_WAIT_SECONDS` | 25 | server | plafond, en secondes, de l’attente synchrone d’un appel REST ou MCP (paramètre `wait`, 1 à 25) ; au-delà, un run à suivre (202) | lue |
| `MAX_CONCURRENT_RUNS` | 50 | server | runs actifs de l’instance au-delà desquels une création de run ou d’API répond 429 `queue_full` avec `Retry-After` (valeur à valider) | lue |
| `MAX_ACTIVE_RUNS_PER_USER` | 20 | server | runs actifs (hors pause) d’un même utilisateur au-delà desquels sa création de run ou d’API répond 429 `user_queue_full` avec `Retry-After` (valeur à valider) | lue |
| `MAX_RUNS_PER_KEY_PER_MINUTE` | 60 | server | créations de run ou d’API par clé d’API et par minute au-delà desquelles l’appel répond 429 `key_rate_limited` avec `Retry-After` (compteur du processus, valeur à valider) | lue |

## Premier démarrage et comptes

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `ADMIN_BOOTSTRAP_TOKEN` | requis tant qu'aucun propriétaire n'existe | server | jeton de l'assistant de premier démarrage ; 32 caractères au moins ; ignoré ensuite | lue |
| `ADMIN_EMAIL` | aucun | server | si posé, l'assistant n'accepte que cette adresse | lue |
| `MFA_ENFORCED` | `off` | server | `off`, `admins` ou `all` : double authentification obligatoire | lue |

## Exécution

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `RUNTIME_MODE` | `all` | image (entrypoint) | `server`, `worker`, `all` ou `migrate` | lue |
| `RUNTIME_VERSION` | `0.0.0` | server, worker | version publiée par `/api/health` et `/api/version` ; posée à la construction de l'image par la chaîne de release | lue |
| `WORKER_CONCURRENCY` | 5 | worker | jobs en parallèle ; au plus `DB_POOL_MAX` | lue |
| `BROWSER_CONCURRENCY` | déduit de la mémoire du conteneur | worker | exécutions navigateur simultanées : `max(1, floor((limite − 0,5 Go) / 1,5 Go))`, soit 1 pour 2 Go et 2 pour 4 Go | lue |
| `DISABLE_BROWSER` | `false` | worker | aucun Chromium : les exécutions navigateur sont refusées | lue |
| `SHUTDOWN_TIMEOUT_SECONDS` | 30 | worker | délai d'arrêt propre | lue |
| `RUN_BUDGET_SECONDS` | 900 | worker | durée maximale d'un run | lue |
| `RUN_HEARTBEAT_SECONDS` | 10 | worker | battement d'un run actif | lue |
| `RUN_STALE_SECONDS` | 30 | worker | un run sans battement depuis ce délai est repris ; au moins 2 × le battement | lue |
| `SWEEP_INTERVAL_SECONDS` | 60 | worker | période du balayeur de runs orphelins | lue |
| `WORKER_HEARTBEAT_SECONDS` | 15 | worker | battement du worker | lue |
| `QUEUE_POLLING_SECONDS` | 2 | worker | période d'interrogation de la file (0,5 au minimum) | lue |
| `WARNING_CHECK_SECONDS` | 900 | worker | contrôle des API « À surveiller » qui durent | lue |
| `ITEMS_REJECTED_MAX_SHARE` | 0.2 | worker | part d’items non conformes au-delà de laquelle un run casse (avec `ITEMS_REJECTED_MIN_COUNT`) ; en dessous, les items non conformes sont écartés et le reste est livré (à valider) | lue |
| `ITEMS_REJECTED_MIN_COUNT` | 5 | worker | nombre minimal d’items non conformes pour qu’un run casse (à valider) | lue |
| `PERSISTENCE_SCHEDULE` | `1h,6h,24h` | worker | délais du mode « SYM ne lâche pas » entre deux ré-enquêtes d’une API en erreur (s, m, h, d) ; le dernier se répète chaque jour, jitter ±20 % (à valider) | lue |
| `PERSISTENCE_BUDGET_USD_DEFAULT` | 1 | worker | plafond de dépense du mode « SYM ne lâche pas » quand l’API n’en fixe pas, cumulé depuis l’entrée en erreur ; jamais illimité, 0 refuse l’activation (à valider) | lue |
| `PERSISTENCE_MAX_DAYS` | 30 | worker | durée maximale en erreur avec ce mode, puis plus aucun essai automatique (à valider) | lue |
| `AUTO_MIGRATE` | `false` dans les modèles | — | migrer au démarrage du serveur | prévue |

## Sécurité réseau et bac à sable

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `ALLOWED_PRIVATE_HOSTS` | vide | worker | noms exacts ou plages CIDR privés que la garde SSRF laisse passer (sauf métadonnées d'un cloud, toujours refusées). Plage CIDR jamais plus large que `/8` en IPv4 ni `/16` en IPv6 | lue |
| `ALLOWED_EGRESS_PORTS` | `80,443` | worker | ports de sortie autorisés pour les webhooks et le courrier | lue |
| `SANDBOX_UID` / `SANDBOX_GID` | 1500 dans l'image | worker | utilisateur dédié du bac à sable ; vont ensemble ; le worker refuse de démarrer en production si l'enfant tournerait sous son propre utilisateur | lue |
| `SANDBOX_LAUNCHER` | fixé dans l'image | worker | lanceur de changement d'utilisateur du bac à sable | lue |
| `SANDBOX_NODE` | fixé dans l'image | worker | Node exécuté par l'enfant du bac à sable, sans capacité (le worker tourne sous une copie de Node réservée à son groupe) | lue |

Le worker de l'image tourne sous une copie de Node dotée de capacités de fichier : le noyau le lance en mode d'exécution
sécurisé (`AT_SECURE`). Il y ignore `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` et `OPENSSL_CONF`,
et glibc lui retire `TMPDIR`, `LD_LIBRARY_PATH` et `LOCPATH`, alors que le server les honore : une autorité de certification
privée posée par `NODE_EXTRA_CA_CERTS` marche côté server et échoue côté worker. Le worker avertit au démarrage si l'une des
cinq premières est posée. Pour PostgreSQL, passez la CA par `sslrootcert` dans `DATABASE_URL`.

## Rétention et stockage

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `RETENTION_DATASETS_DAYS` | 90 | worker | durée de conservation des jeux de données | lue |
| `RETENTION_DATASETS_MAX_DAYS` | 3650 | worker | plafond d'instance ; la durée réglée par API ne peut pas le dépasser | lue |
| `RETENTION_SAMPLES_DAYS` | 14 | worker | échantillons d'enquête, détails d'erreur, entrées de run | lue |
| `RUN_LOG_RETENTION_DAYS` | 30 | server, worker | journaux de run | lue |
| `ARTIFACT_RETENTION_DAYS` | 7 | server, worker | artefacts de run (captures, traces) | lue |
| `RETENTION_TICK_SECONDS` | 300 | worker | période de la passe de rétention | lue |
| `PHONE_DEFAULT_REGION` | aucun | worker | région par défaut pour normaliser les numéros de téléphone des personnes (code pays à deux lettres) | lue |
| `STORAGE_PLAN_GB` | aucun | CLI (`doctor`), création de run | taille prévue de la base : alerte à 80 %, refus des nouveaux runs à 95 % (`storage_full`). Sans valeur, pas de garde disque | lue |

## Journaux, métriques et traces

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `LOG_LEVEL` | `info` | server, worker | `trace`, `debug`, `info`, `warn`, `error` ou `fatal` | lue |
| `LOG_FORMAT` | `json` | — | `pretty` réservé au développement ; seul le JSON est fourni | prévue |
| `METRICS_TOKEN` | aucun | server | sans jeton, `/metrics` répond 404 ; 32 caractères au moins | lue |
| `OTEL_ENABLED` | `false` | server, worker | `false` : le SDK OpenTelemetry n'est **pas chargé** | lue |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | aucun | server, worker | obligatoire si OpenTelemetry est activé ; aucune destination implicite | lue |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | server, worker | ou `http/json` | lue |
| `OTEL_EXPORTER_OTLP_HEADERS` | aucun | server, worker | en-têtes du collecteur, traités comme un secret | lue |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | server, worker | échantillonnage | lue |
| `OTEL_TRACES_SAMPLER_ARG` | 0,1 | server, worker | paramètre de l'échantillonnage, entre 0 et 1 | lue |
| `OTEL_SERVICE_NAME` | `scrapyomama` | server, worker | nom du service dans les traces | lue |
| `ARTIFACTS_LEVEL` | `none` | server, worker | `none`, `screenshot_on_failure`, `trace_on_failure` ou `har_minimal` | lue |
| `ARTIFACT_MAX_BYTES` | 5 Mo | server, worker | taille maximale d'un artefact | lue |
| `ARTIFACT_QUOTA_MB` | 500 | server, worker | quota total d'artefacts | lue |

## Serveur MCP

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `MCP_TOOL_EXPOSURE` | `pinned` | — | outils exposés par API : `generic` (aucun), `pinned` (les API épinglées, 20 au plus) ou `all` (20 au plus) ; voir [Serveur MCP](./mcp.md) | prévue |

## Interrupteurs de surfaces

Ces variables coupent une surface de l'instance, pour réduire ce qu'elle expose.

| Variable | Défaut | Lue par | Rôle | État |
|---|---|---|---|---|
| `DISABLE_REST` | `false` | — | coupe l'API REST | prévue |
| `DISABLE_MCP` | `false` | — | coupe le serveur MCP | prévue |
| `DISABLE_OPENAPI` | `false` | — | coupe la publication de l'OpenAPI | prévue |
| `DISABLE_TUNNEL` | `false` | server | coupe la passerelle du tunnel : aucune route WSS, aucune commande envoyée à l'extension | lue |
| `GATEWAY_INSTANCE` | hôte + pid + aléa | server | identifiant de cette instance pour la passerelle du tunnel (canal de notification PostgreSQL de ses commandes) ; à fixer si plusieurs instances partagent la base | lue |
| `TUNNEL_EXTENSION_IDS` | — | server | identifiants (32 lettres a à p), séparés par des virgules, des extensions autorisées à ouvrir le tunnel : l'origine `chrome-extension://<id>` est vérifiée à l'ouverture. Tant que l'extension n'est pas publiée au Chrome Web Store, posez l'identifiant de votre extension empaquetée, sinon aucune extension n'est acceptée | lue |
| `TUNNEL_ALLOW_ANY_EXTENSION` | `false` | server | `true` accepte toute extension (développement, extension décompressée) ; à ne pas poser en production | lue |

## Variables retirées volontairement

Les variables par lesquelles la bibliothèque d'authentification activerait sa propre télémétrie (`BETTER_AUTH_TELEMETRY` et ses variantes) sont **retirées de l'environnement au démarrage**, avec un avertissement : l'instance n'envoie rien à personne, même si votre hébergeur ou une image de base les pose.
