<!-- Généré par `pnpm gen:env-docs` depuis packages/core/src/config/env-catalog.ts : ne pas éditer à la main. -->
# Variables d’environnement

Cette référence est générée depuis le catalogue du code. Une variable donnée avec `NOM_FILE` accepte `NOM_FILE=/chemin` (le contenu du fichier,
sans ses blancs finaux, remplace la valeur ; les deux posées : démarrage refusé), ce qui permet les secrets Docker.
Tout le reste (clés LLM, proxys, SMTP) se règle dans l’interface et reste chiffré en base. Aucune variable ne déclenche de
contrôle de version sortant ni de rapport d’usage.

Dans l’image, le worker tourne sous une copie de Node à capacités de fichier : le noyau le lance en mode d’exécution sécurisé
(`AT_SECURE`). Il y ignore `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` et `OPENSSL_CONF`, et glibc
lui retire `TMPDIR`, `LD_LIBRARY_PATH` et `LOCPATH`, alors que le server les honore. Le worker avertit au démarrage si l’une
des cinq premières est posée. Une autorité de certification privée pour PostgreSQL passe par `sslrootcert` dans `DATABASE_URL`.

## Base

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `DATABASE_URL` secret | server, worker, CLI | obligatoire | aucun | PostgreSQL 15 ou plus (16 recommandé). Peut viser un pooler en mode session ; derrière un pooler en mode transaction, `DATABASE_URL_DIRECT` est obligatoire. |
| `DATABASE_URL_DIRECT` secret | server, worker, CLI | obligatoire derrière un pooler en mode transaction | `DATABASE_URL` | Connexion directe : LISTEN, pg-boss, migrations, verrous. Sans elle derrière un pooler en mode transaction, le démarrage est refusé (« connexion de session requise »). |
| `DB_POOL_MAX` | worker, CLI | facultative | 5 | Taille du pool de connexions du worker. `WORKER_CONCURRENCY` doit rester inférieur ou égal. |

## Clé

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `MASTER_KEY` (`MASTER_KEY_FILE`) secret | server, worker, CLI | obligatoire | aucun | Exactement 32 octets en base64 (44 caractères), sans phrase secrète. Génération : `runtime keygen` ou `openssl rand -base64 32`. À sauvegarder hors de la plateforme : sans elle, les secrets sont illisibles. |
| `MASTER_KEY_PREVIOUS` (`MASTER_KEY_PREVIOUS_FILE`) secret | CLI | facultative | aucun | Ancienne clé, le temps d’un `runtime rekey --confirm` ; à retirer ensuite. |

## Réseau

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `PUBLIC_URL` | server, CLI | obligatoire | aucun | URL publique de l’instance (http ou https), sans chemin : extension, MCP, cookies `Secure`. `runtime doctor` avertit si elle n’est pas en HTTPS. |
| `PORT` | server | facultative | 3000 | Port d’écoute du `server`. Respecte la valeur injectée par la plateforme. |
| `HOST` | server | facultative | 0.0.0.0 | Adresse d’écoute du `server`. |
| `TRUST_PROXY` | server | facultative | 0 | Nombre de proxys devant l’instance (1 chez Render, Railway et Heroku), ou liste d’IP et CIDR. Jamais `true` sans proxy : un client choisirait son IP par `X-Forwarded-For`. |
| `DISABLE_TUNNEL` | server | facultative | false | `true` : aucune route WSS ni passerelle du tunnel ; les runs en mode tunnel n’ont alors aucune extension à qui s’adresser. |
| `GATEWAY_INSTANCE` | server | facultative | hôte + pid + aléa | Identifiant de cette instance pour la passerelle du tunnel (canal de notification PostgreSQL de ses commandes) ; à fixer si plusieurs instances partagent la base. |
| `TUNNEL_EXTENSION_IDS` | server | facultative | aucun | Identifiants (32 lettres a à p), séparés par des virgules, des extensions autorisées à ouvrir le tunnel : l’origine `chrome-extension://<id>` est vérifiée à l’ouverture. Tant que l’extension n’est pas publiée au Chrome Web Store, posez celui de votre extension empaquetée, sinon aucune extension n’est acceptée. |
| `TUNNEL_ALLOW_ANY_EXTENSION` | server | facultative | false | `true` accepte toute extension (développement, extension décompressée) ; à ne pas poser en production. |
| `DISABLE_MCP` | server | facultative | false | `true` : aucune route `/mcp` (serveur MCP coupé) ; l’API REST et la console restent servies. |
| `MCP_TOOL_EXPOSURE` | server | facultative | pinned | Outils par API du serveur MCP : `generic` (aucun, tout passe par `run_api` et `list_apis`), `pinned` (les API épinglées pour le MCP, 20 au plus) ou `all` (toutes, 20 au plus ; au-delà de 30 API, `pinned` est conseillé). |
| `MCP_ALLOWED_HOSTS` | server | facultative | l’hôte de `PUBLIC_URL` | Noms d’hôte supplémentaires (sans port), séparés par des virgules, admis dans l’en-tête `Host` d’une requête MCP (réseau interne, autre nom de l’instance) ; tout autre hôte reçoit 403. |
| `MCP_ALLOWED_ORIGINS` | server | facultative | l’origine de `PUBLIC_URL` | Origines supplémentaires admises dans l’en-tête `Origin` d’une requête MCP, séparées par des virgules : origine complète (`https://hote:port`, comparée en entier : schéma, hôte et port, comme celle de `PUBLIC_URL`) ou, plus lâche, nom d’hôte seul (tout schéma et tout port de cet hôte) ; une origine présente et non admise reçoit 403, une requête sans `Origin` (client MCP hors navigateur) est acceptée. |

## Accès

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `ADMIN_BOOTSTRAP_TOKEN` (`ADMIN_BOOTSTRAP_TOKEN_FILE`) secret | server, CLI | obligatoire tant qu’aucun owner n’existe | aucun | 32 caractères au moins. Jeton de l’assistant de premier démarrage ; ni stocké ni réaffiché. À retirer une fois le premier administrateur créé (`runtime doctor` le signale). |
| `ADMIN_EMAIL` | server | facultative | aucun | Restreint l’adresse acceptée par l’assistant de premier démarrage. |
| `MFA_ENFORCED` | server | facultative | `off` | `off`, `admins` ou `all` : double authentification (TOTP) obligatoire pour les administrateurs ou pour tous les comptes ; une valeur inconnue refuse le démarrage. Les comptes concernés ne peuvent pas retirer leur 2FA. |
| `INSTANCE_CONTACT` | worker | obligatoire avant la première enquête, si l’assistant de premier démarrage ne l’a pas saisi | aucun | Contact de l’opérateur de l’instance (URL http(s), `mailto:` ou adresse électronique), annoncé dans le jeton du User-Agent du robot (`compatible; Scrapyomama/<version>; +<contact>`) et, si c’est une adresse électronique, dans l’en-tête `From`, quand `IDENTIFY_INSTANCE` est activé ; sert aussi à la page « Usage responsable ». Le réglage saisi à l’assistant l’emporte. |
| `IDENTIFY_INSTANCE` | worker | facultative | false | `true` : le robot ajoute à son User-Agent le jeton `compatible; Scrapyomama/<version>; +<contact>` et, si le contact est une adresse électronique, l’en-tête `From` (RFC 9110). Désactivé par défaut : le User-Agent est alors celui, réel, du Chromium embarqué (version et plateforme réelles, sans `HeadlessChrome`), le même pour le client HTTP et le navigateur. Le réglage admin `identify_instance` l’emporte. Voir « Le robot Scrapyomama ». |

## Exécution

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `BRIEF_MAX_BYTES` | server | facultative | 16000 | Taille UTF-8 au plus du dossier d’enquête transmis par l’IA de l’utilisateur (`brief` de `create_api`), entre 1 000 et 16 000 ; au-delà, 400 `brief_too_large`, jamais de troncature. |
| `BRIEF_MAX_TOKENS` | worker | facultative | 1500 | Budget, en jetons estimés, de la section du dossier d’enquête dans le prompt d’enquête et de réparation ; au-delà, les indices les moins sûrs sont retirés. |
| `BRIEF_PROBE_MAX` | worker | facultative | 5 | Indices du dossier vérifiés au plus par enquête (une requête GET chacun par le pipeline d’accès), entre 0 et 5. |
| `BRIEF_PROBE_BUDGET_SHARE` | worker | facultative | 0.25 | Part du budget d’enquête que la vérification des indices peut consommer, entre 0 et 0,25. |
| `BRIEF_NEGATIVE_TTL_DAYS` | worker | facultative | 14 | Jours pendant lesquels un indice dont la vérification a échoué n’est pas vérifié de nouveau (sauf indice revu plus récemment). |
| `MAX_WAIT_SECONDS` | server | facultative | 25 | Plafond, en secondes, de l’attente synchrone d’un appel REST ou MCP (paramètre `wait`, 1 à 25) ; au-delà, l’appel rend un run à suivre (202). |
| `MAX_CONCURRENT_RUNS` | server | facultative | 50 | Runs actifs (en file ou en cours) de l’instance au-delà desquels une création de run ou d’API répond 429 `queue_full` avec `Retry-After` (valeur à valider en recette). |
| `MAX_ACTIVE_RUNS_PER_USER` | server | facultative | 20 | Runs actifs (en file ou en cours, hors pause) d’un même utilisateur au-delà desquels sa création de run ou d’API répond 429 `user_queue_full` avec `Retry-After` : un membre ne remplit pas la file des autres (valeur à valider en recette). |
| `MAX_RUNS_PER_KEY_PER_MINUTE` | server | facultative | 60 | Créations de run (ou d’API) par clé d’API et par minute au-delà desquelles l’appel répond 429 `key_rate_limited` avec `Retry-After` (compteur du processus ; valeur à valider en recette). |
| `WORKER_CONCURRENCY` | worker, CLI | facultative | 5 | Jobs sans navigateur en parallèle par worker (inférieur ou égal à `DB_POOL_MAX`). |
| `BROWSER_CONCURRENCY` | worker | facultative | déduit de la mémoire du conteneur | Runs navigateur simultanés par worker (1 à 32). Dimensionnement : 2 Go de mémoire pour 1 run navigateur, 4 Go pour 2. |
| `DISABLE_BROWSER` | worker | facultative | false | `true` : aucun Chromium, les exécuteurs navigateur sont refusés. |
| `SHUTDOWN_TIMEOUT_SECONDS` | worker | facultative | 30 | Délai d’arrêt propre sur SIGTERM. |
| `RUN_BUDGET_SECONDS` | worker | facultative | 900 | Budget de durée d’un run. |
| `RUN_HEARTBEAT_SECONDS` | worker | facultative | 10 | Période d’écriture du battement d’un run actif. |
| `RUN_STALE_SECONDS` | worker | facultative | 30 | Un run actif sans battement depuis ce délai est orphelin (au moins 2 fois `RUN_HEARTBEAT_SECONDS`). |
| `SWEEP_INTERVAL_SECONDS` | worker | facultative | 60 | Période du balayeur de runs orphelins. |
| `WORKER_HEARTBEAT_SECONDS` | worker | facultative | 15 | Période du battement du worker (mort après 45 s sans battement). |
| `QUEUE_POLLING_SECONDS` | worker | facultative | 2 | Période d’interrogation de la file (0,5 s au minimum). |
| `WARNING_CHECK_SECONDS` | worker | facultative | 900 | Période du contrôle des API en avertissement. |
| `RETENTION_TICK_SECONDS` | worker | facultative | 300 | Période de la passe de rétention. |
| `ITEMS_REJECTED_MAX_SHARE` | worker | facultative | 0.2 | Part d’items non conformes au-delà de laquelle un run casse (avec ITEMS_REJECTED_MIN_COUNT) ; en dessous, ils sont écartés et le reste est livré (à valider). |
| `ITEMS_REJECTED_MIN_COUNT` | worker | facultative | 5 | Nombre minimal d’items non conformes pour qu’un run casse (plancher absolu du seuil de casse, à valider). |

## Sortie réseau

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `ALLOWED_PRIVATE_HOSTS` | server, worker | facultative | vide | Dérogation de la garde SSRF réservée à l’administrateur : noms exacts ou CIDR séparés par des virgules (préfixe /16 au minimum). Vide : tout hôte privé est refusé. |
| `ALLOWED_EGRESS_PORTS` | server, worker | facultative | 80, 443 | Ports sortants autorisés, séparés par des virgules. |

## Journaux et métriques

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `LOG_LEVEL` | server, worker | facultative | info | `trace`, `debug`, `info`, `warn`, `error` ou `fatal`. Journal JSON sur stdout, masqué. |
| `METRICS_TOKEN` (`METRICS_TOKEN_FILE`) secret | server | facultative | aucun | 32 caractères au moins. Sans jeton, `/metrics` répond 404 ; avec, `Authorization: Bearer` est exigé. |

## OpenTelemetry

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `OTEL_ENABLED` | server, worker | facultative | false | `false` : le SDK n’est pas chargé. Aucun en-tête `traceparent`, `tracestate` ni `baggage` ne part vers les cibles, proxys ou LLM. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | server, worker | obligatoire si `OTEL_ENABLED=true` | aucun | Collecteur OTLP ; aucune destination implicite. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | server, worker | facultative | http/protobuf | `http/protobuf` ou `http/json`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | server, worker | facultative | aucun | En-têtes d’export, traités comme un secret. |
| `OTEL_TRACES_SAMPLER` | server, worker | facultative | parentbased_traceidratio | Échantillonneur de traces. |
| `OTEL_TRACES_SAMPLER_ARG` | server, worker | facultative | 0.1 | Argument de l’échantillonneur. |
| `OTEL_SERVICE_NAME` | server, worker | facultative | scrapyomama | Nom du service dans les traces. |

## Artefacts

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `ARTIFACTS_LEVEL` | server, worker | facultative | none | `none` (aucun artefact), `screenshot_on_failure`, `trace_on_failure` ou `har_minimal`. Les artefacts sont chiffrés. |
| `ARTIFACT_MAX_BYTES` | server, worker | facultative | 5242880 | Taille maximale d’un artefact, en octets (5 Mo). |
| `ARTIFACT_QUOTA_MB` | server, worker | facultative | 500 | Quota total d’artefacts, en Mo. |
| `ARTIFACT_RETENTION_DAYS` | server, worker | facultative | 7 | Durée de conservation des artefacts, en jours. |

## Rétention

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `BRIEF_VERSIONS_KEEP` | server, worker, CLI | facultative | 5 | Versions du dossier d’enquête gardées par API ; la plus ancienne non référencée par une version de stratégie est purgée. |
| `RETENTION_DATASETS_DAYS` | worker, CLI | facultative | 90 | Conservation des jeux de données (valeur initiale, modifiable dans Réglages). |
| `RETENTION_DATASETS_MAX_DAYS` | worker, CLI | facultative | 3650 | Plafond de conservation des jeux de données. |
| `RETENTION_SAMPLES_DAYS` | worker, CLI | facultative | 14 | Conservation des échantillons d’enquête. |
| `RETENTION_PROFILES_DAYS` | worker, CLI | facultative | 90 | Conservation des profils de qualité des runs (hors baseline validée, gardée avec sa version). |
| `RUN_LOG_RETENTION_DAYS` | server, worker, CLI | facultative | 30 | Conservation des journaux de run. |
| `STORAGE_PLAN_GB` | server, worker, CLI | facultative | aucun | Taille de la base de votre offre, en Go. Sans elle, pas de garde disque ; à 95 %, un nouveau run est refusé (`storage_full`). |
| `PHONE_DEFAULT_REGION` | worker, CLI | facultative | FR | Région ISO 3166-1 des numéros de téléphone nationaux des personnes concernées (droit à l’effacement). |

## Image

| Variable | Lue par | Statut | Défaut | Rôle |
|---|---|---|---|---|
| `RUNTIME_VERSION` | server, worker, CLI | facultative | `0.0.0` | Version publiée par `/api/health` et `/api/version`. Posée à la construction de l’image par la chaîne de release : ne pas la changer. |
| `RUNTIME_MODE` | image | facultative | `all` | `server`, `worker`, `all` (les deux dans un processus) ou `migrate`. Lue par le point d’entrée de l’image. |
| `NODE_ENV` | server, worker, CLI | facultative | `production` | Posée par l’image. En production, le worker refuse de démarrer sans l’utilisateur dédié du bac à sable et `runtime migrate down` est refusé. |
| `SANDBOX_UID` | worker | facultative | `1500` | Utilisateur dédié du bac à sable (INV7). Posée par l’image : ne pas la changer. |
| `SANDBOX_GID` | worker | facultative | `1500` | Groupe dédié du bac à sable. Posée par l’image : ne pas la changer. |
| `SANDBOX_LAUNCHER` | worker | facultative | `/usr/local/libexec/sandbox-launch` | Lanceur à capacités minimales du bac à sable. Posée par l’image : ne pas la changer. |
| `SANDBOX_NODE` | worker | facultative | `/usr/bin/node` | Node exécuté par l’enfant du bac à sable (le worker tourne sous une copie de Node à capacités de fichier, réservée à son groupe). Posée par l’image : ne pas la changer. |
| `SANDBOX_SECCOMP` | worker | facultative | `/usr/local/libexec/sandbox-seccomp` | Filtre seccomp de l’enfant du bac à sable (ni `unshare`, ni `setns`, ni `clone` vers un nouvel espace de noms), posé avant le changement d’utilisateur (premier programme lancé, il exécute le lanceur). Posée par l’image : ne pas la changer. |
