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

  v({ name: 'PUBLIC_URL', group: 'Réseau', roles: ['server', 'cli'], required: true, default: null, description: 'URL publique de l’instance (http ou https), sans chemin : extension, MCP, cookies `Secure`. `runtime doctor` avertit si elle n’est pas en HTTPS.' }),
  v({ name: 'PORT', group: 'Réseau', roles: ['server'], required: false, default: '3000', description: 'Port d’écoute du `server`. Respecte la valeur injectée par la plateforme.' }),
  v({ name: 'HOST', group: 'Réseau', roles: ['server'], required: false, default: '0.0.0.0', description: 'Adresse d’écoute du `server`.' }),
  v({ name: 'TRUST_PROXY', group: 'Réseau', roles: ['server'], required: false, default: '0', description: 'Nombre de proxys devant l’instance (1 chez Render, Railway et Heroku), ou liste d’IP et CIDR. Jamais `true` sans proxy : un client choisirait son IP par `X-Forwarded-For`.' }),
  v({ name: 'DISABLE_TUNNEL', group: 'Réseau', roles: ['server'], required: false, default: 'false', description: '`true` : aucune route WSS ni passerelle du tunnel ; les runs en mode tunnel n’ont alors aucune extension à qui s’adresser.' }),
  v({ name: 'GATEWAY_INSTANCE', group: 'Réseau', roles: ['server'], required: false, default: 'hôte + pid + aléa', description: 'Identifiant de cette instance pour la passerelle du tunnel (canal de notification PostgreSQL de ses commandes) ; à fixer si plusieurs instances partagent la base.' }),
  v({ name: 'TUNNEL_EXTENSION_IDS', group: 'Réseau', roles: ['server'], required: false, default: null, description: 'Identifiants (32 lettres a à p), séparés par des virgules, des extensions autorisées à ouvrir le tunnel : l’origine `chrome-extension://<id>` est vérifiée à l’ouverture. Tant que l’extension n’est pas publiée au Chrome Web Store, posez celui de votre extension empaquetée, sinon aucune extension n’est acceptée.' }),
  v({ name: 'TUNNEL_ALLOW_ANY_EXTENSION', group: 'Réseau', roles: ['server'], required: false, default: 'false', description: '`true` accepte toute extension (développement, extension décompressée) ; à ne pas poser en production.' }),

  v({ name: 'ADMIN_BOOTSTRAP_TOKEN', group: 'Accès', roles: ['server', 'cli'], required: 'tant qu’aucun owner n’existe', default: null, secret: true, description: '32 caractères au moins. Jeton de l’assistant de premier démarrage ; ni stocké ni réaffiché. À retirer une fois le premier administrateur créé (`runtime doctor` le signale).' }),
  v({ name: 'ADMIN_EMAIL', group: 'Accès', roles: ['server'], required: false, default: null, description: 'Restreint l’adresse acceptée par l’assistant de premier démarrage.' }),
  v({ name: 'MFA_ENFORCED', group: 'Accès', roles: ['server'], required: false, default: '`off`', description: '`off`, `admins` ou `all` : double authentification (TOTP) obligatoire pour les administrateurs ou pour tous les comptes ; une valeur inconnue refuse le démarrage. Les comptes concernés ne peuvent pas retirer leur 2FA.' }),
  v({ name: 'INSTANCE_CONTACT', group: 'Accès', roles: ['worker'], required: 'avant la première enquête, si l’assistant de premier démarrage ne l’a pas saisi', default: null, description: 'Contact de l’opérateur de l’instance (URL http(s), `mailto:` ou adresse électronique), annoncé dans le jeton du User-Agent du robot (`compatible; Scrapyomama/<version>; +<contact>`) et, si c’est une adresse électronique, dans l’en-tête `From`, quand `IDENTIFY_INSTANCE` est activé ; sert aussi à la page « Usage responsable ». Le réglage saisi à l’assistant l’emporte.' }),
  v({ name: 'IDENTIFY_INSTANCE', group: 'Accès', roles: ['worker'], required: false, default: 'false', description: '`true` : le robot ajoute à son User-Agent le jeton `compatible; Scrapyomama/<version>; +<contact>` et, si le contact est une adresse électronique, l’en-tête `From` (RFC 9110). Désactivé par défaut : le User-Agent est alors celui, réel, du Chromium embarqué (version et plateforme réelles, sans `HeadlessChrome`), le même pour le client HTTP et le navigateur. Le réglage admin `identify_instance` l’emporte. Voir « Le robot Scrapyomama ».' }),

  v({ name: 'RUNTIME_VERSION', group: 'Image', roles: ['server', 'worker', 'cli'], required: false, default: '`0.0.0`', description: 'Version publiée par `/api/health` et `/api/version`. Posée à la construction de l’image par la chaîne de release : ne pas la changer.' }),
  v({ name: 'RUNTIME_MODE', group: 'Image', roles: ['image'], required: false, default: '`all`', description: '`server`, `worker`, `all` (les deux dans un processus) ou `migrate`. Lue par le point d’entrée de l’image.' }),
  v({ name: 'NODE_ENV', group: 'Image', roles: ['server', 'worker', 'cli'], required: false, default: '`production`', description: 'Posée par l’image. En production, le worker refuse de démarrer sans l’utilisateur dédié du bac à sable et `runtime migrate down` est refusé.' }),
  v({ name: 'SANDBOX_UID', group: 'Image', roles: ['worker'], required: false, default: '`1500`', description: 'Utilisateur dédié du bac à sable (INV7). Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_GID', group: 'Image', roles: ['worker'], required: false, default: '`1500`', description: 'Groupe dédié du bac à sable. Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_LAUNCHER', group: 'Image', roles: ['worker'], required: false, default: '`/usr/local/libexec/sandbox-launch`', description: 'Lanceur à capacités minimales du bac à sable. Posée par l’image : ne pas la changer.' }),
  v({ name: 'SANDBOX_NODE', group: 'Image', roles: ['worker'], required: false, default: '`/usr/bin/node`', description: 'Node exécuté par l’enfant du bac à sable (le worker tourne sous une copie de Node à capacités de fichier, réservée à son groupe). Posée par l’image : ne pas la changer.' }),

  v({ name: 'WORKER_CONCURRENCY', group: 'Exécution', roles: ['worker', 'cli'], required: false, default: '5', description: 'Jobs sans navigateur en parallèle par worker (inférieur ou égal à `DB_POOL_MAX`).' }),
  v({ name: 'BROWSER_CONCURRENCY', group: 'Exécution', roles: ['worker'], required: false, default: 'déduit de la mémoire du conteneur', description: 'Runs navigateur simultanés par worker (1 à 32). Dimensionnement : 2 Go de mémoire pour 1 run navigateur, 4 Go pour 2.' }),
  v({ name: 'DISABLE_BROWSER', group: 'Exécution', roles: ['worker'], required: false, default: 'false', description: '`true` : aucun Chromium, les exécuteurs navigateur sont refusés.' }),
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
  v({ name: 'RUN_LOG_RETENTION_DAYS', group: 'Rétention', roles: ['server', 'worker', 'cli'], required: false, default: '30', description: 'Conservation des journaux de run.' }),
  v({ name: 'STORAGE_PLAN_GB', group: 'Rétention', roles: ['server', 'worker', 'cli'], required: false, default: 'aucun', description: 'Taille de la base de votre offre, en Go. Sans elle, pas de garde disque ; à 95 %, un nouveau run est refusé (`storage_full`).' }),
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
