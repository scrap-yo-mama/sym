// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue des variables d'environnement de SYM Browser (cdc/sym-browser 04b § 11, tâche 0.4) : source unique des noms,
// des défauts, des rôles qui les lisent et des secrets. Même convention que le catalogue de SYM (lecture seule, non importé) :
// un secret accepte `NOM_FILE=/chemin` (contenu du fichier, blancs finaux retirés ; les deux posées : démarrage refusé).
// Les variables lues par les clients (`SYMB_URL`, `SYMB_API_KEY` du SDK ; `BROWSER_*` de SYM) n'en font pas partie.

/** Mode de déploiement (03 § 4). Défini ici, au plus bas, pour que le catalogue n'importe rien. */
export const SERVICE_MODES = ['all', 'gateway', 'node'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export function isServiceMode(value: unknown): value is ServiceMode {
  return typeof value === 'string' && (SERVICE_MODES as readonly string[]).includes(value);
}

/** Rôle réel d'un process : le mode `all` porte les deux. */
export type ServiceRole = 'gateway' | 'node';

export type BrowserEnvGroup = 'Process' | 'Base et clé' | 'Nœud' | 'Passerelle' | 'Stockage' | 'Limites' | 'Rétention' | 'Journaux et accès' | 'Test';

export type BrowserEnvVariable = {
  name: string;
  group: BrowserEnvGroup;
  /** Rôles qui lisent la variable (le mode `all` les réunit). */
  roles: readonly ServiceRole[];
  /** Modes dans lesquels le démarrage échoue sans elle. */
  required: readonly ServiceMode[];
  /** Défaut, écrit comme une valeur d'environnement (analysé par le même code qu'une valeur posée) ; `null` : aucun. */
  default: string | null;
  /** Défaut affiché quand il n'est pas une constante (calculé, généré). */
  defaultLabel?: string;
  /** Valeur secrète : jamais journalisée ni affichée, retirée de l'environnement après lecture, accepte `NOM_FILE`. */
  secret: boolean;
  description: string;
};

const ALL: readonly ServiceRole[] = ['gateway', 'node'];
const NODE: readonly ServiceRole[] = ['node'];
const GATEWAY: readonly ServiceRole[] = ['gateway'];
const EVERYWHERE: readonly ServiceMode[] = ['all', 'gateway', 'node'];

type Spec = Omit<BrowserEnvVariable, 'secret' | 'required' | 'default'> & Partial<Pick<BrowserEnvVariable, 'secret' | 'required' | 'default'>>;
const v = (spec: Spec): BrowserEnvVariable => ({ secret: false, required: [], default: null, ...spec });

export const BROWSER_ENV_CATALOG: readonly BrowserEnvVariable[] = [
  v({ name: 'SYMB_MODE', group: 'Process', roles: ALL, default: 'all', description: '`all` (passerelle et nœud dans un process, stockage disque), `gateway` ou `node` : rôle du process (03 § 4).' }),
  v({ name: 'PORT', group: 'Process', roles: ALL, default: '3000', description: 'Port d’écoute (0 à 65535 ; 0 : port libre choisi par le système, pour les tests). Respecte la valeur injectée par la plateforme.' }),
  v({ name: 'NODE_ENV', group: 'Process', roles: ALL, default: 'production', description: '`production`, `development` ou `test`. Seul `test` active les drapeaux de test ; ailleurs leur présence arrête le démarrage.' }),
  v({ name: 'SHUTDOWN_GRACE_SECONDS', group: 'Process', roles: ALL, default: '270', description: 'Grâce de drainage sur SIGTERM, de 1 à 300 secondes (04b § 9).' }),

  v({ name: 'DATABASE_URL', group: 'Base et clé', roles: ALL, required: EVERYWHERE, secret: true, description: 'PostgreSQL 16 à 18, schéma `postgres://` ou `postgresql://`.' }),
  v({ name: 'MASTER_KEY', group: 'Base et clé', roles: ALL, required: EVERYWHERE, secret: true, description: 'Exactement 32 octets en base64 (44 caractères), sans phrase secrète. Génération : `openssl rand -base64 32`. À sauvegarder hors de la plateforme : sans elle, les secrets sont illisibles.' }),
  v({ name: 'MASTER_KEY_PREVIOUS', group: 'Base et clé', roles: ALL, secret: true, description: 'Ancienne clé, le temps d’un changement de clé ; même format que `MASTER_KEY`. À retirer ensuite.' }),

  v({ name: 'NODE_TOKEN', group: 'Nœud', roles: ALL, required: ['gateway', 'node'], secret: true, description: 'Secret partagé passerelle et nœud, 32 caractères au moins. Inutile en mode `all` (le nœud s’enregistre sur 127.0.0.1).' }),
  v({ name: 'NODE_PUBLIC_URL', group: 'Nœud', roles: NODE, required: ['node'], description: 'URL privée (http ou https) annoncée à la passerelle. En mode `all` : `http://127.0.0.1:<PORT>`.' }),
  v({ name: 'NODE_ID', group: 'Nœud', roles: NODE, defaultLabel: 'nom d’hôte', description: 'Identifiant stable du nœud (1 à 63 caractères `A-Za-z0-9_.-`).' }),
  v({ name: 'NODE_REGION', group: 'Nœud', roles: NODE, default: 'default', description: 'Région annoncée à la passerelle (`a-z0-9_.-`, 1 à 40 caractères).' }),
  v({ name: 'MAX_SESSIONS', group: 'Nœud', roles: NODE, defaultLabel: 'calculé (04b § 3)', description: 'Slots du nœud, de 1 à 64 ; remplace la valeur calculée depuis la mémoire du conteneur.' }),
  v({ name: 'WARM_BROWSERS', group: 'Nœud', roles: NODE, default: '1', description: 'Chromium chauds préchauffés (0 à 64).' }),
  v({ name: 'CONTEXTS_PER_BROWSER', group: 'Nœud', roles: NODE, defaultLabel: 'figé par la tâche 0.6', description: 'Contextes simultanés par Chromium chaud (1 à 64) ; sans valeur, la constante mesurée par la tâche 0.6.' }),
  v({ name: 'RECYCLE_AFTER_SESSIONS', group: 'Nœud', roles: NODE, default: '50', description: 'Sessions servies avant recyclage d’un Chromium.' }),
  v({ name: 'RECYCLE_AFTER_MS', group: 'Nœud', roles: NODE, default: '3600000', description: 'Âge d’un Chromium avant recyclage, en millisecondes.' }),
  v({ name: 'RECYCLE_RSS_PERCENT', group: 'Nœud', roles: NODE, default: '90', description: 'Seuil mémoire de recyclage, en pourcentage (1 à 100).' }),
  v({ name: 'HEARTBEAT_MS', group: 'Nœud', roles: NODE, default: '5000', description: 'Période du battement du nœud vers la passerelle, en millisecondes (100 au minimum).' }),
  v({ name: 'SYMB_DATA_DIR', group: 'Nœud', roles: NODE, default: '/data', description: 'Répertoires de travail des sessions (`sessions/{id}`), chemin absolu.' }),
  v({ name: 'SYMB_PRIVATE_HOSTS', group: 'Nœud', roles: NODE, description: 'Hôtes privés joignables par l’egress : noms exacts ou CIDR séparés par des virgules. Vide : tout hôte privé est refusé.' }),
  v({ name: 'SYMB_IP_ECHO_URL', group: 'Nœud', roles: ALL, defaultLabel: 'fixée par la tâche 1.6', description: 'Point d’écho HTTPS du test de proxy à la création de session.' }),

  v({ name: 'QUEUE_MAX', group: 'Passerelle', roles: GATEWAY, default: '50', description: 'Taille globale de la file d’attente de sessions.' }),
  v({ name: 'QUEUE_MAX_PER_TENANT', group: 'Passerelle', roles: GATEWAY, default: '10', description: 'Taille de la file par client.' }),
  v({ name: 'QUEUE_TIMEOUT_MS', group: 'Passerelle', roles: GATEWAY, default: '30000', description: 'Attente maximale en file, en millisecondes.' }),

  v({ name: 'OBJECT_STORE', group: 'Stockage', roles: ALL, default: 'disk', description: '`disk` ou `s3`. Le mode `all` n’accepte que `disk`.' }),
  v({ name: 'OBJECT_DIR', group: 'Stockage', roles: ALL, default: '/data/objects', description: 'Répertoire du mode `disk`, chemin absolu.' }),
  v({ name: 'S3_ENDPOINT', group: 'Stockage', roles: ALL, description: 'Point d’accès d’un stockage S3 compatible (R2, MinIO), URL http ou https ; vide : AWS S3.' }),
  v({ name: 'S3_BUCKET', group: 'Stockage', roles: ALL, description: 'Bucket ; obligatoire avec `OBJECT_STORE=s3`.' }),
  v({ name: 'S3_REGION', group: 'Stockage', roles: ALL, description: 'Région du bucket.' }),
  v({ name: 'S3_ACCESS_KEY_ID', group: 'Stockage', roles: ALL, secret: true, description: 'Identifiant d’accès S3 ; obligatoire avec `OBJECT_STORE=s3`.' }),
  v({ name: 'S3_SECRET_ACCESS_KEY', group: 'Stockage', roles: ALL, secret: true, description: 'Secret d’accès S3 ; obligatoire avec `OBJECT_STORE=s3`.' }),

  v({ name: 'SYMB_PROFILE_MAX_BYTES', group: 'Limites', roles: ALL, default: '104857600', description: 'Taille maximale d’un profil persistant, en octets (100 Mo, à valider).' }),
  v({ name: 'SYMB_DOWNLOAD_MAX_BYTES', group: 'Limites', roles: NODE, default: '524288000', description: 'Plafond par fichier téléchargé, en octets (500 Mo, à valider).' }),
  v({ name: 'SYMB_SESSION_DOWNLOAD_MAX_BYTES', group: 'Limites', roles: NODE, default: '2147483648', description: 'Plafond de téléchargements par session, en octets (2 Go, à valider).' }),
  v({ name: 'SYMB_UPLOAD_MAX_BYTES', group: 'Limites', roles: NODE, default: '104857600', description: 'Plafond par envoi de fichier, en octets (100 Mo, à valider).' }),
  v({ name: 'SYMB_CDP_MAX_MESSAGE_BYTES', group: 'Limites', roles: GATEWAY, default: '104857600', description: 'Taille maximale d’un message CDP relayé, en octets (100 Mo, à valider).' }),
  v({ name: 'SYMB_RECORDING_MAX_BYTES', group: 'Limites', roles: NODE, default: '209715200', description: 'Plafond par enregistrement, en octets (200 Mo, à valider).' }),

  v({ name: 'SYMB_RETENTION_TRACE_DAYS', group: 'Rétention', roles: ALL, default: '7', description: 'Conservation des traces Playwright, en jours.' }),
  v({ name: 'SYMB_RETENTION_HAR_DAYS', group: 'Rétention', roles: ALL, default: '7', description: 'Conservation des HAR, en jours.' }),
  v({ name: 'SYMB_RETENTION_VIDEO_DAYS', group: 'Rétention', roles: ALL, default: '7', description: 'Conservation des vidéos, en jours.' }),
  v({ name: 'SYMB_RETENTION_LOG_DAYS', group: 'Rétention', roles: ALL, default: '7', description: 'Conservation des journaux de session, en jours.' }),
  v({ name: 'SYMB_RETENTION_DOWNLOAD_HOURS', group: 'Rétention', roles: ALL, default: '24', description: 'Conservation des téléchargements gardés, en heures.' }),

  v({ name: 'SYMB_LOG_LEVEL', group: 'Journaux et accès', roles: ALL, default: 'info', description: '`trace`, `debug`, `info`, `warn`, `error` ou `fatal` : seuil des journaux (JSON sur stdout).' }),
  v({ name: 'SYMB_METRICS_TOKEN', group: 'Journaux et accès', roles: ALL, secret: true, defaultLabel: 'aucun (généré par keygen, tâche 0.3)', description: 'Jeton de lecture de `/metrics`, 32 caractères au moins.' }),
  v({ name: 'SYMB_BOOTSTRAP_TOKEN', group: 'Journaux et accès', roles: GATEWAY, secret: true, defaultLabel: 'généré au premier démarrage', description: 'Jeton de `/setup` (premier démarrage), 32 caractères au moins.' }),
  v({ name: 'SYMB_BOOTSTRAP_API_KEY', group: 'Journaux et accès', roles: GATEWAY, secret: true, description: 'Première clé d’API (client `sym`) créée si la table des clés est vide ; clé d’échange avec SYM. 32 caractères au moins.' }),

  v({ name: 'SYMB_TEST_MODE', group: 'Test', roles: ALL, description: '`1` sous `NODE_ENV=test` : route `/v1/_test/process-info/{id}`. Sa présence ailleurs arrête le démarrage.' }),
  v({ name: 'SYMB_TEST_ALLOW_PRIVATE', group: 'Test', roles: NODE, description: '`1` sous `NODE_ENV=test` : l’egress joint les fixtures privées. Sa présence ailleurs arrête le démarrage.' }),
];

export const BROWSER_ENV_GROUPS: readonly BrowserEnvGroup[] = ['Process', 'Base et clé', 'Nœud', 'Passerelle', 'Stockage', 'Limites', 'Rétention', 'Journaux et accès', 'Test'];

export function findEnvVariable(name: string): BrowserEnvVariable | undefined {
  return BROWSER_ENV_CATALOG.find((variable) => variable.name === name);
}

/** Noms connus, `NOM_FILE` des secrets compris. */
export function browserEnvNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const variable of BROWSER_ENV_CATALOG) {
    names.add(variable.name);
    if (variable.secret) names.add(`${variable.name}_FILE`);
  }
  return names;
}

/** Préfixes réservés : une variable inconnue qui commence ainsi est une faute de frappe probable, signalée au démarrage. */
const RESERVED_PREFIXES = ['SYMB_', 'MASTER_'] as const;

/** Variables `SYMB_*` ou `MASTER_*` que le catalogue ne connaît pas (`SYMB_MODEE`, `MASTER_KEY_PRIVIOUS`…). Jamais une erreur. */
export function unknownReservedVariables(env: Readonly<Record<string, string | undefined>>): string[] {
  const known = browserEnvNames();
  return Object.keys(env)
    .filter((name) => RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !known.has(name))
    .sort();
}

/** Avertissement pour `unknownReservedVariables` : les noms seulement, jamais les valeurs (elles peuvent être des secrets). */
export function unknownReservedVariablesWarning(env: Readonly<Record<string, string | undefined>>): string | null {
  const unknown = unknownReservedVariables(env);
  if (unknown.length === 0) return null;
  return `Avertissement : variable(s) ${unknown.join(', ')} inconnue(s) du catalogue (préfixe réservé SYMB_ ou MASTER_), ignorée(s) : faute de frappe ?`;
}
