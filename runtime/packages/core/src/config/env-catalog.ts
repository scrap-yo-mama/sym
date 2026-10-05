// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue des variables d'environnement (14 § 2) : source unique de la référence publiée (docs/variables-env.md) et
// de `.env.example`, générés par `pnpm gen:env-docs`. La validation reste dans les chargeurs de `server` et `worker`
// (aucun schéma Zod en V1 : Zod n'est pas encore une dépendance) ; `assert_env_docs_in_sync` échoue si le catalogue et
// les fichiers générés divergent, ou si le code lit une variable que le catalogue ignore.

export type EnvRole = 'server' | 'worker' | 'cli' | 'image';

export type EnvGroup = 'Base' | 'Clé' | 'Réseau' | 'Accès' | 'Exécution' | 'Sortie réseau' | 'Journaux et métriques' | 'OpenTelemetry' | 'Artefacts' | 'Rétention' | 'Image';

export type EnvVariable = {
  name: string;
  group: EnvGroup;
  /** Qui lit la variable. `image` : posée par l'image, à ne pas changer. */
  roles: readonly EnvRole[];
  /** `true` : le démarrage échoue sans elle. Une chaîne : condition (ex. « tant qu'aucun owner n'existe »). */
  required: boolean | string;
  /** Valeur par défaut affichée (texte), `null` si aucune. */
  default: string | null;
  /** `true` : valeur secrète (jamais journalisée) ; accepte alors `NAME_FILE`. */
  secret: boolean;
  /** Accepte `NAME_FILE=/chemin` (lecture du fichier, blancs finaux retirés). Les deux posées : démarrage refusé. */
  file: boolean;
  description: string;
};

const v = (variable: Omit<EnvVariable, 'secret' | 'file'> & { secret?: boolean; file?: boolean }): EnvVariable => ({
  secret: false,
  file: variable.secret === true,
  ...variable,
});

export const ENV_CATALOG: readonly EnvVariable[] = [
  v({ name: 'DATABASE_URL', group: 'Base', roles: ['server', 'worker', 'cli'], required: true, default: null, secret: true, file: false, description: 'PostgreSQL 15 ou plus (16 recommandé). Peut viser un pooler en mode session ; derrière un pooler en mode transaction, `DATABASE_URL_DIRECT` est obligatoire.' }),
  v({ name: 'DATABASE_URL_DIRECT', group: 'Base', roles: ['server', 'worker', 'cli'], required: 'derrière un pooler en mode transaction', default: '`DATABASE_URL`', secret: true, file: false, description: 'Connexion directe : LISTEN, pg-boss, migrations, verrous. Sans elle derrière un pooler en mode transaction, le démarrage est refusé (« connexion de session requise »).' }),
  v({ name: 'DB_POOL_MAX', group: 'Base', roles: ['worker', 'cli'], required: false, default: '5', description: 'Taille du pool de connexions du worker. `WORKER_CONCURRENCY` doit rester inférieur ou égal.' }),

  v({ name: 'MASTER_KEY', group: 'Clé', roles: ['server', 'worker', 'cli'], required: true, default: null, secret: true, description: 'Exactement 32 octets en base64 (44 caractères), sans phrase secrète. Génération : `runtime keygen` ou `openssl rand -base64 32`. À sauvegarder hors de la plateforme : sans elle, les secrets sont illisibles.' }),
  v({ name: 'MASTER_KEY_PREVIOUS', group: 'Clé', roles: ['cli'], required: false, default: null, secret: true, description: 'Ancienne clé, le temps d’un `runtime rekey --confirm` ; à retirer ensuite.' }),

  v({ name: 'PUBLIC_URL', group: 'Réseau', roles: ['server', 'cli'], required: true, default: null, description: 'URL publique de l’instance, sans chemin : extension, MCP, cookies `Secure`. HTTPS obligatoire : le démarrage est refusé en http://, sauf pour localhost, 127.0.0.1 et [::1] (essai local, docker-compose), ou avec NODE_ENV=development ou test, ou avec `ALLOW_INSECURE_PUBLIC_URL=true`.' }),
  v({ name: 'ALLOW_INSECURE_PUBLIC_URL', group: 'Réseau', roles: ['server'], required: false, default: 'false', description: '`true` autorise une PUBLIC_URL en http:// hors boucle locale (essai sur un réseau privé) : le cookie de session voyage alors sans `Secure` ni HSTS. À ne jamais poser en production.' }),
  v({ name: 'PORT', group: 'Réseau', roles: ['server'], required: false, default: '3000', description: 'Port d’écoute du `server`. Respecte la valeur injectée par la plateforme.' }),
  v({ name: 'HOST', group: 'Réseau', roles: ['server'], required: false, default: '0.0.0.0', description: 'Adresse d’écoute du `server`.' }),
  v({ name: 'TRUST_PROXY', group: 'Réseau', roles: ['server'], required: false, default: '0', description: 'Nombre de proxys devant l’instance (1 chez Render, Railway et Heroku), ou liste d’IP et CIDR. Jamais `true` sans proxy : un client choisirait son IP par `X-Forwarded-For`.' }),
  v({ name: 'DISABLE_TUNNEL', group: 'Réseau', roles: ['server'], required: false, default: 'false', description: '`true` : aucune route WSS ni passerelle du tunnel ; les runs en mode tunnel n’ont alors aucune extension à qui s’adresser.' }),
  v({ name: 'GATEWAY_INSTANCE', group: 'Réseau', roles: ['server'], required: false, default: 'hôte + pid + aléa', description: 'Identifiant de cette instance pour la passerelle du tunnel (canal de notification PostgreSQL de ses commandes) ; à fixer si plusieurs instances partagent la base.' }),
  v({ name: 'TUNNEL_EXTENSION_IDS', group: 'Réseau', roles: ['server'], required: false, default: null, description: 'Identifiants (32 lettres a à p), séparés par des virgules, des extensions autorisées à ouvrir le tunnel : l’origine `chrome-extension://<id>` est vérifiée à l’ouverture. Tant que l’extension n’est pas publiée au Chrome Web Store, posez celui de votre extension empaquetée, sinon aucune extension n’est acceptée.' }),
  v({ name: 'TUNNEL_ALLOW_ANY_EXTENSION', group: 'Réseau', roles: ['server'], required: false, default: 'false', description: '`true` accepte toute extension (développement, extension décompressée) ; à ne pas poser en production.' }),
  v({ name: 'DISABLE_MCP', group: 'Réseau', roles: ['server'], required: false, default: 'false', description: '`true` : aucune route `/mcp` (serveur MCP coupé) ; l’API REST et la console restent servies.' }),
  v({ name: 'MCP_TOOL_EXPOSURE', group: 'Réseau', roles: ['server'], required: false, default: 'pinned', description: 'Outils par API du serveur MCP : `generic` (aucun, tout passe par `run_api` et `list_apis`), `pinned` (les API épinglées pour le MCP, 20 au plus) ou `all` (toutes, 20 au plus ; au-delà de 30 API, `pinned` est conseillé).' }),
  v({ name: 'MCP_DEFAULT_TOOLSETS', group: 'Réseau', roles: ['server'], required: false, default: 'build,run,catalog,iterate', description: 'Toolsets du serveur MCP actifs quand le client ne demande rien (`?toolsets=`) : `build`, `run`, `catalog` et `iterate` (affiner, tester, promouvoir, revenir en arrière), séparés par des virgules. `iterate` est actif par défaut.' }),
  v({ name: 'MCP_ALLOWED_HOSTS', group: 'Réseau', roles: ['server'], required: false, default: 'l’hôte de `PUBLIC_URL`', description: 'Noms d’hôte supplémentaires (sans port), séparés par des virgules, admis dans l’en-tête `Host` d’une requête MCP (réseau interne, autre nom de l’instance) ; tout autre hôte reçoit 403.' }),
  v({ name: 'MCP_ALLOWED_ORIGINS', group: 'Réseau', roles: ['server'], required: false, default: 'l’origine de `PUBLIC_URL`', description: 'Origines supplémentaires admises dans l’en-tête `Origin` d’une requête MCP, séparées par des virgules : origine complète (`https://hote:port`, comparée en entier : schéma, hôte et port, comme celle de `PUBLIC_URL`) ou, plus lâche, nom d’hôte seul (tout schéma et tout port de cet hôte) ; une origine présente et non admise reçoit 403, une requête sans `Origin` (client MCP hors navigateur) est acceptée.' }),

  v({ name: 'ADMIN_BOOTSTRAP_TOKEN', group: 'Accès', roles: ['server', 'cli'], required: 'tant qu’aucun owner n’existe', default: null, secret: true, description: '32 caractères au moins. Jeton de l’assistant de premier démarrage ; ni stocké ni réaffiché. À retirer une fois le premier administrateur créé (`runtime doctor` le signale).' }),
  v({ name: 'ADMIN_EMAIL', group: 'Accès', roles: ['server'], required: false, default: null, description: 'Restreint l’adresse acceptée par l’assistant de premier démarrage.' }),
  v({ name: 'MFA_ENFORCED', group: 'Accès', roles: ['server'], required: false, default: '`off`', description: '`off`, `admins` ou `all` : double authentification (TOTP) obligatoire pour les administrateurs ou pour tous les comptes ; une valeur inconnue refuse le démarrage. Les comptes concernés ne peuvent pas retirer leur 2FA.' }),
  v({ name: 'INSTANCE_CONTACT', group: 'Accès', roles: ['worker'], required: 'avant la première enquête, si l’assistant de premier démarrage ne l’a pas saisi', default: null, description: 'Contact de l’opérateur de l’instance (URL http(s), `mailto:` ou adresse électronique), annoncé dans le jeton du User-Agent du robot (`compatible; Scrapyomama/<version>; +<contact>`) et, si c’est une adresse électronique, dans l’en-tête `From`, quand `IDENTIFY_INSTANCE` est activé ; sert aussi à la page « Usage responsable ». Le réglage saisi à l’assistant l’emporte.' }),
  v({ name: 'IDENTIFY_INSTANCE', group: 'Accès', roles: ['worker'], required: false, default: 'false', description: '`true` : le robot ajoute à son User-Agent le jeton `compatible; Scrapyomama/<version>; +<contact>` et, si le contact est une adresse électronique, l’en-tête `From` (RFC 9110). Désactivé par défaut : le User-Agent est alors celui, réel, du Chromium embarqué (version et plateforme réelles, sans `HeadlessChrome`), le même pour le client HTTP et le navigateur. Le réglage admin `identify_instance` l’emporte. Voir « Le robot Scrapyomama ».' }),

  v({ name: 'RUNTIME_VERSION', group: 'Image', roles: ['server', 'worker', 'cli'], required: false, default: 'version du paquet', description: 'Version publiée par `/api/health` et `/api/version`. Posée à la construction de l’image par la chaîne de release : ne pas la changer. Absente ou `0.0.0` (image construite sans argument, staging), la version du paquet est publiée.' }),
  v({ name: 'RUNTIME_COMMIT', group: 'Image', roles: ['server'], required: false, default: 'aucun', description: 'Commit Git de l’image, publié par `/api/version` (`commit`) et dans `serverInfo.version` du MCP. Posée à la construction de l’image (`--build-arg RUNTIME_COMMIT=<sha>`) ; sans elle, `RENDER_GIT_COMMIT` est utilisée. Une valeur qui n’est pas un commit hexadécimal est ignorée.' }),
  v({ name: 'RENDER_GIT_COMMIT', group: 'Image', roles: ['server'], required: false, default: 'aucun', description: 'Posée par Render à chaque déploiement : commit déployé, repli de `RUNTIME_COMMIT`. Ne pas la poser soi-même.' }),
  v({ name: 'RUNTIME_MODE', group: 'Image', roles: ['image'], required: false, default: '`all`', description: '`server`, `worker`, `all` (les deux dans un processus) ou `migrate`. Lue par le point d’entrée de l’image.' }),
  v({ name: 'NODE_ENV', group: 'Image', roles: ['server', 'worker', 'cli'], required: false, default: '`production`', description: 'Posée par l’image. En production, le worker refuse de démarrer sans l’utilisateur dédié du bac à sable et `runtime migrate down` est refusé.' }),
  v({ name: 'SANDBOX_UID', group: 'Image', roles: ['worker'], required: false, default: '`1500`', description: 'Utilisateur dédié du bac à sable (INV7). Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_GID', group: 'Image', roles: ['worker'], required: false, default: '`1500`', description: 'Groupe dédié du bac à sable. Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_LAUNCHER', group: 'Image', roles: ['worker'], required: false, default: '`/usr/local/libexec/sandbox-launch`', description: 'Lanceur à capacités minimales du bac à sable. Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_NODE', group: 'Image', roles: ['worker'], required: false, default: '`/usr/bin/node`', description: 'Node exécuté par l’enfant du bac à sable (le worker tourne sous une copie de Node à capacités de fichier, réservée à son groupe). Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_SECCOMP', group: 'Image', roles: ['worker'], required: false, default: '`/usr/local/libexec/sandbox-seccomp`', description: 'Filtre seccomp de l’enfant du bac à sable (ni `unshare`, ni `setns`, ni `clone` vers un nouvel espace de noms), posé avant le changement d’utilisateur (premier programme lancé, il exécute le lanceur). Posée par l’image : ne pas la changer.' }),

  v({ name: 'BRIEF_MAX_BYTES', group: 'Exécution', roles: ['server'], required: false, default: '16000', description: 'Taille UTF-8 au plus du dossier d’enquête transmis par l’IA de l’utilisateur (`brief` de `create_api`), entre 1 000 et 16 000 ; au-delà, 400 `brief_too_large`, jamais de troncature.' }),
  v({ name: 'BRIEF_MAX_TOKENS', group: 'Exécution', roles: ['worker'], required: false, default: '1500', description: 'Budget, en jetons estimés, de la section du dossier d’enquête dans le prompt d’enquête et de réparation ; au-delà, les indices les moins sûrs sont retirés.' }),
  v({ name: 'BRIEF_PROBE_MAX', group: 'Exécution', roles: ['worker'], required: false, default: '5', description: 'Indices du dossier vérifiés au plus par enquête (une requête GET chacun par le pipeline d’accès), entre 0 et 5.' }),
  v({ name: 'BRIEF_PROBE_BUDGET_SHARE', group: 'Exécution', roles: ['worker'], required: false, default: '0.25', description: 'Part du budget d’enquête que la vérification des indices peut consommer, entre 0 et 0,25.' }),
  v({ name: 'BRIEF_NEGATIVE_TTL_DAYS', group: 'Exécution', roles: ['worker'], required: false, default: '14', description: 'Jours pendant lesquels un indice dont la vérification a échoué n’est pas vérifié de nouveau (sauf indice revu plus récemment).' }),
  v({ name: 'BRIEF_VERSIONS_KEEP', group: 'Rétention', roles: ['server', 'worker', 'cli'], required: false, default: '5', description: 'Versions du dossier d’enquête gardées par API ; la plus ancienne non référencée par une version de stratégie est purgée.' }),
  v({ name: 'MAX_WAIT_SECONDS', group: 'Exécution', roles: ['server'], required: false, default: '50', description: 'Plafond, en secondes, de l’attente synchrone d’un appel MCP (`wait_seconds`, 1 à 50 ; REST : `wait`, 25 au plus) ; au-delà, l’appel rend un run à suivre (202).' }),
  v({ name: 'CONFIRM_ABOVE_USD', group: 'Exécution', roles: ['server', 'worker'], required: false, default: '0.10', description: 'Dépense estimée, en dollars, des essais d’une enquête (essai retenu et compilation) au-delà de laquelle la validation automatique du schéma, puis le premier run complet lancé par SYM, attendent une confirmation avant tout appel facturé (valeur à valider en recette).' }),
  v({ name: 'MAX_CONCURRENT_RUNS', group: 'Exécution', roles: ['server'], required: false, default: '50', description: 'Runs actifs (en file ou en cours) de l’instance au-delà desquels une création de run ou d’API répond 429 `queue_full` avec `Retry-After` (valeur à valider en recette).' }),
  v({ name: 'MAX_ACTIVE_RUNS_PER_USER', group: 'Exécution', roles: ['server'], required: false, default: '20', description: 'Runs actifs (en file ou en cours, hors pause) d’un même utilisateur au-delà desquels sa création de run ou d’API répond 429 `user_queue_full` avec `Retry-After` : un membre ne remplit pas la file des autres (valeur à valider en recette).' }),
  v({ name: 'MAX_RUNS_PER_KEY_PER_MINUTE', group: 'Exécution', roles: ['server'], required: false, default: '60', description: 'Créations de run (ou d’API) par clé d’API et par minute au-delà desquelles l’appel répond 429 `key_rate_limited` avec `Retry-After` (compteur du processus ; valeur à valider en recette).' }),
  v({ name: 'USER_BUDGET_DAILY_USD', group: 'Exécution', roles: ['server', 'worker'], required: false, default: '50', description: 'Budget en dollars par utilisateur et par jour (UTC) : somme des coûts LLM et proxy de tous ses runs (runs, enquêtes, validations, planifications). Atteint : 429 `budget_exceeded` (non réessayable avant minuit UTC), ou run planifié sauté (`skipped_quota`). Seul filet d’une API sans plafond par run (défaut, D-123) : son run est borné au reste du budget du jour lu à son ouverture, et s’arrête `budget_exceeded` (`user_budget_daily_usd`) s’il l’atteint ; un admin peut le relever. Plafonne aussi le `budget_daily_usd` qu’un membre fixe sur une API (valeur à valider en recette).' }),
  v({ name: 'MAX_COST_USD_PER_RUN', group: 'Exécution', roles: ['server'], required: false, default: '10', description: 'Plafond d’instance du `max_cost_usd` qu’un membre peut fixer sur une API (facultatif : aucun plafond par run par défaut, D-123) : au-delà, 400 `cost_cap_exceeded` (valeur à valider en recette).' }),
  v({ name: 'WORKER_CONCURRENCY', group: 'Exécution', roles: ['worker', 'cli'], required: false, default: '5', description: 'Jobs sans navigateur en parallèle par worker (inférieur ou égal à `DB_POOL_MAX`).' }),
  v({ name: 'BROWSER_CONCURRENCY', group: 'Exécution', roles: ['worker'], required: false, default: 'déduit de la mémoire du conteneur', description: 'Runs navigateur simultanés par worker (1 à 32). Dimensionnement : 2 Go de mémoire pour 1 run navigateur, 4 Go pour 2.' }),
  v({ name: 'DISABLE_BROWSER', group: 'Exécution', roles: ['worker'], required: false, default: 'false', description: '`true` : aucun Chromium, les exécuteurs navigateur sont refusés.' }),
  v({ name: 'AGENT_BROWSER_PROBE', group: 'Exécution', roles: ['worker'], required: false, default: 'false', description: '`true` : au démarrage, le worker vérifie que le Chromium dédié de l’agent démarre (bac à sable, HOME, binaire) et le dit dans les journaux ; n’empêche aucun run.' }),
  v({ name: 'SHUTDOWN_TIMEOUT_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '30', description: 'Délai d’arrêt propre sur SIGTERM.' }),
  v({ name: 'RUN_BUDGET_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '900', description: 'Budget de durée d’un run.' }),
  v({ name: 'RUN_HEARTBEAT_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '10', description: 'Période d’écriture du battement d’un run actif.' }),
  v({ name: 'RUN_STALE_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '30', description: 'Un run actif sans battement depuis ce délai est orphelin (au moins 2 fois `RUN_HEARTBEAT_SECONDS`).' }),
  v({ name: 'SWEEP_INTERVAL_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '60', description: 'Période du balayeur de runs orphelins.' }),
  v({ name: 'WORKER_HEARTBEAT_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '15', description: 'Période du battement du worker (mort après 45 s sans battement).' }),
  v({ name: 'QUEUE_POLLING_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '2', description: 'Période d’interrogation de la file (0,5 s au minimum).' }),
  v({ name: 'WARNING_CHECK_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '900', description: 'Période du contrôle des API en avertissement.' }),
  v({ name: 'RETENTION_TICK_SECONDS', group: 'Exécution', roles: ['worker'], required: false, default: '300', description: 'Période de la passe de rétention.' }),
  v({ name: 'ITEMS_REJECTED_MAX_SHARE', group: 'Exécution', roles: ['worker'], required: false, default: '0.2', description: 'Part d’items non conformes au-delà de laquelle un run casse (avec ITEMS_REJECTED_MIN_COUNT) ; en dessous, ils sont écartés et le reste est livré (à valider).' }),
  v({ name: 'PERSISTENCE_SCHEDULE', group: 'Exécution', roles: ['server', 'worker'], required: false, default: '1h,6h,24h', description: 'Délais du mode « SYM ne lâche pas » entre deux ré-enquêtes d’une API en erreur (s, m, h, d) ; le dernier se répète chaque jour, jitter ±20 % (à valider).' }),
  v({ name: 'PERSISTENCE_BUDGET_USD_DEFAULT', group: 'Exécution', roles: ['server', 'worker'], required: false, default: '1', description: 'Plafond de dépense du mode « SYM ne lâche pas » quand persistence_budget_usd vaut null, cumulé depuis l’entrée en erreur ; jamais illimité, 0 refuse l’activation (à valider).' }),
  v({ name: 'PERSISTENCE_MAX_DAYS', group: 'Exécution', roles: ['server', 'worker'], required: false, default: '30', description: 'Durée maximale en erreur avec le mode « SYM ne lâche pas », puis persistence_exhausted (à valider).' }),
  v({ name: 'ITEMS_REJECTED_MIN_COUNT', group: 'Exécution', roles: ['worker'], required: false, default: '5', description: 'Nombre minimal d’items non conformes pour qu’un run casse (plancher absolu du seuil de casse, à valider).' }),

  v({ name: 'ALLOWED_PRIVATE_HOSTS', group: 'Sortie réseau', roles: ['server', 'worker'], required: false, default: 'vide', description: 'Dérogation de la garde SSRF réservée à l’administrateur : noms exacts ou CIDR séparés par des virgules (préfixe /16 au minimum). Vide : tout hôte privé est refusé.' }),
  v({ name: 'ALLOWED_EGRESS_PORTS', group: 'Sortie réseau', roles: ['server', 'worker'], required: false, default: '80, 443', description: 'Ports sortants autorisés, séparés par des virgules.' }),

  v({ name: 'LOG_LEVEL', group: 'Journaux et métriques', roles: ['server', 'worker'], required: false, default: 'info', description: '`trace`, `debug`, `info`, `warn`, `error` ou `fatal`. Journal JSON sur stdout, masqué.' }),
  v({ name: 'METRICS_TOKEN', group: 'Journaux et métriques', roles: ['server'], required: false, default: 'aucun', secret: true, description: '32 caractères au moins. Sans jeton, `/metrics` répond 404 ; avec, `Authorization: Bearer` est exigé.' }),

  v({ name: 'OTEL_ENABLED', group: 'OpenTelemetry', roles: ['server', 'worker'], required: false, default: 'false', description: '`false` : le SDK n’est pas chargé. Aucun en-tête `traceparent`, `tracestate` ni `baggage` ne part vers les cibles, proxys ou LLM.' }),
  v({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', group: 'OpenTelemetry', roles: ['server', 'worker'], required: 'si `OTEL_ENABLED=true`', default: null, description: 'Collecteur OTLP ; aucune destination implicite.' }),
  v({ name: 'OTEL_EXPORTER_OTLP_PROTOCOL', group: 'OpenTelemetry', roles: ['server', 'worker'], required: false, default: 'http/protobuf', description: '`http/protobuf` ou `http/json`.' }),
  v({ name: 'OTEL_EXPORTER_OTLP_HEADERS', group: 'OpenTelemetry', roles: ['server', 'worker'], required: false, default: null, description: 'En-têtes d’export, traités comme un secret.' }),
  v({ name: 'OTEL_TRACES_SAMPLER', group: 'OpenTelemetry', roles: ['server', 'worker'], required: false, default: 'parentbased_traceidratio', description: 'Échantillonneur de traces.' }),
  v({ name: 'OTEL_TRACES_SAMPLER_ARG', group: 'OpenTelemetry', roles: ['server', 'worker'], required: false, default: '0.1', description: 'Argument de l’échantillonneur.' }),
  v({ name: 'OTEL_SERVICE_NAME', group: 'OpenTelemetry', roles: ['server', 'worker'], required: false, default: 'scrapyomama', description: 'Nom du service dans les traces.' }),

  v({ name: 'ARTIFACTS_LEVEL', group: 'Artefacts', roles: ['server', 'worker'], required: false, default: 'none', description: '`none` (aucun artefact), `screenshot_on_failure`, `trace_on_failure` ou `har_minimal`. Les artefacts sont chiffrés.' }),
  v({ name: 'ARTIFACT_MAX_BYTES', group: 'Artefacts', roles: ['server', 'worker'], required: false, default: '5242880', description: 'Taille maximale d’un artefact, en octets (5 Mo).' }),
  v({ name: 'ARTIFACT_QUOTA_MB', group: 'Artefacts', roles: ['server', 'worker'], required: false, default: '500', description: 'Quota total d’artefacts, en Mo.' }),
  v({ name: 'ARTIFACT_RETENTION_DAYS', group: 'Artefacts', roles: ['server', 'worker'], required: false, default: '7', description: 'Durée de conservation des artefacts, en jours.' }),

  v({ name: 'RETENTION_DATASETS_DAYS', group: 'Rétention', roles: ['worker', 'cli'], required: false, default: '90', description: 'Conservation des jeux de données (valeur initiale, modifiable dans Réglages).' }),
  v({ name: 'RETENTION_DATASETS_MAX_DAYS', group: 'Rétention', roles: ['worker', 'cli'], required: false, default: '3650', description: 'Plafond de conservation des jeux de données.' }),
  v({ name: 'RETENTION_SAMPLES_DAYS', group: 'Rétention', roles: ['worker', 'cli'], required: false, default: '14', description: 'Conservation des échantillons d’enquête.' }),
  v({ name: 'RETENTION_PROFILES_DAYS', group: 'Rétention', roles: ['worker', 'cli'], required: false, default: '90', description: 'Conservation des profils de qualité des runs (hors baseline validée, gardée avec sa version).' }),
  v({ name: 'RUN_LOG_RETENTION_DAYS', group: 'Rétention', roles: ['server', 'worker', 'cli'], required: false, default: '30', description: 'Conservation des journaux de run.' }),
  v({ name: 'STORAGE_PLAN_GB', group: 'Rétention', roles: ['server', 'worker', 'cli'], required: false, default: 'aucun', description: 'Taille de la base de votre offre, en Go. Sans elle, pas de garde disque ; à 95 %, un nouveau run est refusé (`storage_full`).' }),
  v({ name: 'DEFAULT_LOCALE', group: 'Base', roles: ['server'], required: false, default: 'langue de l’owner', description: 'Langue de l’instance (code d’une langue livrée, `en` ou `fr` aujourd’hui) : surcharge `settings.default_locale`, initialisée avec la langue du navigateur de l’owner au premier démarrage. Elle ne remplace jamais le choix d’une personne.' }),
  v({ name: 'PHONE_DEFAULT_REGION', group: 'Rétention', roles: ['worker', 'cli'], required: false, default: 'FR', description: 'Région ISO 3166-1 des numéros de téléphone nationaux des personnes concernées (droit à l’effacement).' }),
];

export const ENV_GROUPS: readonly EnvGroup[] = ['Base', 'Clé', 'Réseau', 'Accès', 'Exécution', 'Sortie réseau', 'Journaux et métriques', 'OpenTelemetry', 'Artefacts', 'Rétention', 'Image'];

export function envVariableNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const variable of ENV_CATALOG) {
    names.add(variable.name);
    if (variable.file) names.add(`${variable.name}_FILE`);
  }
  return names;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');
const roleLabel: Record<EnvRole, string> = { server: 'server', worker: 'worker', cli: 'CLI', image: 'image' };
const requirement = (variable: EnvVariable): string => (variable.required === true ? 'obligatoire' : variable.required === false ? 'facultative' : `obligatoire ${variable.required}`);

/** Référence publiée (Markdown) : générée, jamais éditée à la main (`pnpm gen:env-docs`). */
export function renderEnvReference(catalog: readonly EnvVariable[] = ENV_CATALOG): string {
  const lines = [
    '<!-- Généré par `pnpm gen:env-docs` depuis packages/core/src/config/env-catalog.ts : ne pas éditer à la main. -->',
    '# Variables d’environnement',
    '',
    'Cette référence est générée depuis le catalogue du code. Une variable donnée avec `NOM_FILE` accepte `NOM_FILE=/chemin` (le contenu du fichier,',
    'sans ses blancs finaux, remplace la valeur ; les deux posées : démarrage refusé), ce qui permet les secrets Docker.',
    'Tout le reste (clés LLM, proxys, SMTP) se règle dans l’interface et reste chiffré en base. Aucune variable ne déclenche de',
    'contrôle de version sortant ni de rapport d’usage.',
    '',
    'Dans l’image, le worker tourne sous une copie de Node à capacités de fichier : le noyau le lance en mode d’exécution sécurisé',
    '(`AT_SECURE`). Il y ignore `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` et `OPENSSL_CONF`, et glibc',
    'lui retire `TMPDIR`, `LD_LIBRARY_PATH` et `LOCPATH`, alors que le server les honore. Le worker avertit au démarrage si l’une',
    'des cinq premières est posée. Une autorité de certification privée pour PostgreSQL passe par `sslrootcert` dans `DATABASE_URL`.',
    '',
  ];
  for (const group of ENV_GROUPS) {
    const rows = catalog.filter((variable) => variable.group === group);
    if (rows.length === 0) continue;
    lines.push(`## ${group}`, '', '| Variable | Lue par | Statut | Défaut | Rôle |', '|---|---|---|---|---|');
    for (const variable of rows) {
      const name = `\`${variable.name}\`${variable.file ? ` (\`${variable.name}_FILE\`)` : ''}${variable.secret ? ' secret' : ''}`;
      lines.push(`| ${name} | ${variable.roles.map((role) => roleLabel[role]).join(', ')} | ${requirement(variable)} | ${cell(variable.default ?? 'aucun')} | ${cell(variable.description)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * `.env.example` : uniquement des valeurs qui FONT ÉCHOUER le démarrage (jamais un secret d’exemple utilisable) ;
 * `MASTER_KEY` vide est refusé avec la commande `keygen`, le jeton court est refusé (32 caractères minimum).
 */
export function renderEnvExample(): string {
  return [
    '# Généré par `pnpm gen:env-docs` : ne pas éditer à la main. Référence complète : docs/variables-env.md.',
    '# Ces valeurs font ÉCHOUER le démarrage tant que vous ne les remplacez pas : aucune ne sert d’exemple utilisable.',
    '# Sur un VPS, `deploy/install.sh` génère un .env complet (MASTER_KEY par `runtime keygen`, jeton d’amorçage).',
    '',
    '# PostgreSQL 15 ou plus (16 recommandé).',
    'DATABASE_URL=',
    '# 32 octets en base64 : `runtime keygen` ou `openssl rand -base64 32`. À sauvegarder hors de la plateforme.',
    'MASTER_KEY=',
    '# URL publique de l’instance, par exemple https://runtime.example.org',
    'PUBLIC_URL=',
    '# Jeton de l’assistant de premier démarrage (32 caractères au moins) : `openssl rand -base64 32`.',
    'ADMIN_BOOTSTRAP_TOKEN=changeme',
    '',
  ].join('\n');
}

/** Préfixes réservés (14 § 2) : une variable inconnue qui commence ainsi est une faute de frappe probable, signalée au démarrage. */
const RESERVED_PREFIXES = ['RUNTIME_', 'MASTER_'] as const;

/**
 * Variables préfixées `RUNTIME_` ou `MASTER_` que le catalogue ne connaît pas (`MASTER_KEY_PRIVIOUS`, `RUNTIME_MODEE`…).
 * Jamais une erreur : l'instance démarre, l'avertissement nomme les variables (jamais leur valeur : elle peut être un secret).
 */
export function unknownReservedVariables(env: Readonly<Record<string, string | undefined>>): string[] {
  const known = envVariableNames();
  return Object.keys(env)
    .filter((name) => RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !known.has(name))
    .sort();
}

/** Message d'avertissement pour `unknownReservedVariables` (vide : `null`). */
export function unknownReservedVariablesWarning(env: Readonly<Record<string, string | undefined>>): string | null {
  const unknown = unknownReservedVariables(env);
  if (unknown.length === 0) return null;
  return `Avertissement : variable(s) ${unknown.join(', ')} inconnue(s) du catalogue (préfixe réservé RUNTIME_ ou MASTER_), ignorée(s) : faute de frappe ? Référence : docs/variables-env.md.`;
}
