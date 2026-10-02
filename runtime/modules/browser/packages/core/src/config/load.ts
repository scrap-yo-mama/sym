// SPDX-License-Identifier: AGPL-3.0-only
// Chargement de la configuration de SYM Browser (04b § 11) : lue une fois au démarrage, secrets retirés de l'environnement.
// Une valeur invalide arrête le process avec un message qui nomme la variable (tâche 0.4) ; toutes les erreurs d'un coup.
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { isServiceMode, SERVICE_MODES, unknownReservedVariablesWarning, type ServiceMode } from './env-catalog.js';
import { ConfigError, Reader, type Env } from './reader.js';
import type { Secret } from './secret.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const NODE_ENVS = ['production', 'development', 'test'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export type ObjectStoreConfig =
  | { kind: 'disk'; dir: string }
  | { kind: 's3'; endpoint: string | null; bucket: string; region: string | null; accessKeyId: Secret; secretAccessKey: Secret };

export type BrowserConfig = {
  mode: ServiceMode;
  port: number;
  nodeEnv: NodeEnv;
  /** Délai de drainage sur SIGTERM, en secondes (1 à 300). */
  shutdownGraceSeconds: number;
  databaseUrl: Secret;
  masterKey: Secret;
  masterKeyPrevious: Secret | null;
  /** Secret passerelle ↔ nœud ; `null` en mode `all`. */
  nodeToken: Secret | null;
  node: {
    id: string;
    region: string;
    /** URL annoncée à la passerelle ; en mode `all`, `http://127.0.0.1:<PORT>`. */
    publicUrl: string;
    /** `null` : valeur calculée depuis la mémoire du conteneur (04b § 3, tâche 1.1). */
    maxSessions: number | null;
    warmBrowsers: number;
    /** `null` : constante figée par la tâche 0.6. */
    contextsPerBrowser: number | null;
    recycleAfterSessions: number;
    recycleAfterMs: number;
    recycleRssPercent: number;
    heartbeatMs: number;
  };
  queue: { max: number; maxPerTenant: number; timeoutMs: number };
  objectStore: ObjectStoreConfig;
  dataDir: string;
  /** Noms exacts ou CIDR joignables par l'egress en plus d'Internet (04c § 1.2). */
  privateHosts: string[];
  ipEchoUrl: string | null;
  limits: { profileMaxBytes: number; downloadMaxBytes: number; sessionDownloadMaxBytes: number; uploadMaxBytes: number; cdpMaxMessageBytes: number; recordingMaxBytes: number };
  retention: { traceDays: number; harDays: number; videoDays: number; logDays: number; downloadHours: number };
  logLevel: LogLevel;
  metricsToken: Secret | null;
  bootstrapToken: Secret | null;
  bootstrapApiKey: Secret | null;
  /** Drapeaux de test, vrais seulement sous `NODE_ENV=test`. */
  test: { mode: boolean; allowPrivate: boolean };
  /** Avertissements de démarrage (variables inconnues) ; jamais de valeur. */
  warnings: string[];
};

const TOKEN_MIN_LENGTH = 32;
const tokenCheck = (value: string): string | undefined => (value.length < TOKEN_MIN_LENGTH ? `${TOKEN_MIN_LENGTH} caractères au moins` : undefined);

/** Base64 standard canonique de 32 octets : 43 caractères + un `=`. */
const BASE64_32 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const KEYGEN_HINT = 'générez-en une avec `openssl rand -base64 32`';

/**
 * Format de `MASTER_KEY` (et `_PREVIOUS`) : exactement 32 octets en base64, ni phrase secrète ni valeur triviale. Même règle de
 * format que SYM ; le chiffrement lui-même (tâche 0.3) réutilise cette valeur.
 */
function masterKeyProblem(value: string): string | undefined {
  if (!BASE64_32.test(value)) return `32 octets en base64 attendus (44 caractères), pas de phrase secrète ; ${KEYGEN_HINT}`;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32) return `${bytes.length} octets décodés au lieu de 32 ; ${KEYGEN_HINT}`;
  if (new Set(bytes).size < 16) return `valeur triviale (trop peu d’octets distincts) ; ${KEYGEN_HINT}`;
  const step = (bytes[1]! - bytes[0]! + 256) % 256;
  if (bytes.every((b, i) => i === 0 || (b - bytes[i - 1]! + 256) % 256 === step)) return `valeur triviale (suite régulière) ; ${KEYGEN_HINT}`;
  return undefined;
}

const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;

function privateHostProblem(entry: string): string | undefined {
  const slash = entry.indexOf('/');
  if (slash === -1) return isIP(entry) !== 0 || HOST_NAME.test(entry) ? undefined : `« ${entry} » n’est ni un nom d’hôte ni une adresse`;
  const family = isIP(entry.slice(0, slash));
  const prefix = entry.slice(slash + 1);
  const max = family === 4 ? 32 : family === 6 ? 128 : 0;
  if (max === 0 || !/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return `CIDR « ${entry} » invalide`;
  return undefined;
}

const isHttpUrl = (value: string, protocols: readonly string[]): boolean => {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.hostname !== '';
  } catch {
    return false;
  }
};

/** Variables dont la présence arrête le nœud (04c § 1.1) : elles désactivent le proxy loopback forcé de Chromium. */
const FORBIDDEN_FOR_NODE = ['PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK'] as const;

export type LoadOptions = {
  /** Mode appliqué quand `SYMB_MODE` est absent (le binaire du nœud vaut `node`). */
  defaultMode?: ServiceMode;
  /** Lecteur fourni (tests du catalogue). */
  reader?: Reader;
};

export function loadConfig(env: Env = process.env, options: LoadOptions = {}): BrowserConfig {
  const reader = options.reader ?? new Reader(env);
  reader.issues.length = 0;
  const fail = (message: string): void => reader.fail(message);

  // Le mode d'abord : il décide quelles variables sont obligatoires.
  const requestedMode = reader.present('SYMB_MODE') ? reader.text('SYMB_MODE') : (options.defaultMode ?? reader.text('SYMB_MODE'));
  if (requestedMode === null || !isServiceMode(requestedMode)) {
    throw new ConfigError([`SYMB_MODE invalide : ${SERVICE_MODES.join(', ')} attendu (reçu « ${requestedMode ?? ''} »).`]);
  }
  const mode = requestedMode;
  reader.mode = mode;
  const runsNode = mode === 'all' || mode === 'node';

  const nodeEnv = reader.oneOf('NODE_ENV', NODE_ENVS) ?? 'production';
  const port = reader.int('PORT', 0, 65535) ?? 3000;
  const shutdownGraceSeconds = reader.int('SHUTDOWN_GRACE_SECONDS', 1, 300) ?? 270;

  const databaseUrl = reader.secret('DATABASE_URL', (value) => (/^postgres(?:ql)?:\/\/\S+$/.test(value) ? undefined : 'URL postgres:// ou postgresql:// attendue'));
  const masterKey = reader.secret('MASTER_KEY', masterKeyProblem);
  const masterKeyPrevious = reader.secret('MASTER_KEY_PREVIOUS', masterKeyProblem);
  const nodeToken = reader.secret('NODE_TOKEN', tokenCheck);

  const publicUrlSet = reader.checked('NODE_PUBLIC_URL', 'URL http ou https attendue', (v) => isHttpUrl(v, ['http:', 'https:']));
  const node = {
    id: reader.checked('NODE_ID', '1 à 63 caractères A-Za-z0-9_.-', (v) => /^[A-Za-z0-9_.-]{1,63}$/.test(v)) ?? hostname(),
    region: reader.checked('NODE_REGION', '1 à 40 caractères a-z0-9_.-', (v) => /^[a-z0-9_.-]{1,40}$/.test(v)) ?? 'default',
    publicUrl: mode === 'all' ? `http://127.0.0.1:${port}` : (publicUrlSet ?? ''),
    maxSessions: reader.int('MAX_SESSIONS', 1, 64),
    warmBrowsers: reader.int('WARM_BROWSERS', 0, 64) ?? 1,
    contextsPerBrowser: reader.int('CONTEXTS_PER_BROWSER', 1, 64),
    recycleAfterSessions: reader.int('RECYCLE_AFTER_SESSIONS', 1) ?? 50,
    recycleAfterMs: reader.int('RECYCLE_AFTER_MS', 1) ?? 3_600_000,
    recycleRssPercent: reader.int('RECYCLE_RSS_PERCENT', 1, 100) ?? 90,
    heartbeatMs: reader.int('HEARTBEAT_MS', 100) ?? 5000,
  };

  const queue = {
    max: reader.int('QUEUE_MAX', 0) ?? 50,
    maxPerTenant: reader.int('QUEUE_MAX_PER_TENANT', 0) ?? 10,
    timeoutMs: reader.int('QUEUE_TIMEOUT_MS', 1) ?? 30_000,
  };

  const absolute = (value: string): boolean => isAbsolute(value);
  const storeKind = reader.oneOf('OBJECT_STORE', ['disk', 's3'] as const) ?? 'disk';
  const objectDir = reader.checked('OBJECT_DIR', 'chemin absolu attendu', absolute) ?? '/data/objects';
  const s3Endpoint = reader.checked('S3_ENDPOINT', 'URL http ou https attendue', (v) => isHttpUrl(v, ['http:', 'https:']));
  const s3Bucket = reader.text('S3_BUCKET');
  const s3Region = reader.text('S3_REGION');
  const s3Access = reader.secret('S3_ACCESS_KEY_ID');
  const s3Secret = reader.secret('S3_SECRET_ACCESS_KEY');
  let objectStore: ObjectStoreConfig = { kind: 'disk', dir: objectDir };
  if (storeKind === 's3') {
    if (mode === 'all') fail('OBJECT_STORE invalide : le mode all stocke sur disque (03 § 4), s3 demande les modes gateway et node.');
    for (const [name, value] of [['S3_BUCKET', s3Bucket], ['S3_ACCESS_KEY_ID', s3Access], ['S3_SECRET_ACCESS_KEY', s3Secret]] as const) {
      if (value === null) fail(`${name} obligatoire avec OBJECT_STORE=s3${name === 'S3_BUCKET' ? '' : ` (ou ${name}_FILE)`}.`);
    }
    if (s3Bucket !== null && s3Access !== null && s3Secret !== null) {
      objectStore = { kind: 's3', endpoint: s3Endpoint, bucket: s3Bucket, region: s3Region, accessKeyId: s3Access, secretAccessKey: s3Secret };
    }
  }

  const dataDir = reader.checked('SYMB_DATA_DIR', 'chemin absolu attendu', absolute) ?? '/data';
  const privateHosts: string[] = [];
  const rawHosts = reader.text('SYMB_PRIVATE_HOSTS');
  for (const entry of (rawHosts ?? '').split(',').map((e) => e.trim()).filter((e) => e !== '')) {
    const problem = privateHostProblem(entry);
    if (problem) fail(`SYMB_PRIVATE_HOSTS invalide : ${problem}.`);
    else privateHosts.push(entry);
  }
  const ipEchoUrl = reader.checked('SYMB_IP_ECHO_URL', 'URL https attendue', (v) => isHttpUrl(v, ['https:']));

  const limits = {
    profileMaxBytes: reader.int('SYMB_PROFILE_MAX_BYTES', 1) ?? 0,
    downloadMaxBytes: reader.int('SYMB_DOWNLOAD_MAX_BYTES', 1) ?? 0,
    sessionDownloadMaxBytes: reader.int('SYMB_SESSION_DOWNLOAD_MAX_BYTES', 1) ?? 0,
    uploadMaxBytes: reader.int('SYMB_UPLOAD_MAX_BYTES', 1) ?? 0,
    cdpMaxMessageBytes: reader.int('SYMB_CDP_MAX_MESSAGE_BYTES', 1) ?? 0,
    recordingMaxBytes: reader.int('SYMB_RECORDING_MAX_BYTES', 1) ?? 0,
  };
  const retention = {
    traceDays: reader.int('SYMB_RETENTION_TRACE_DAYS', 1) ?? 7,
    harDays: reader.int('SYMB_RETENTION_HAR_DAYS', 1) ?? 7,
    videoDays: reader.int('SYMB_RETENTION_VIDEO_DAYS', 1) ?? 7,
    logDays: reader.int('SYMB_RETENTION_LOG_DAYS', 1) ?? 7,
    downloadHours: reader.int('SYMB_RETENTION_DOWNLOAD_HOURS', 1) ?? 24,
  };

  const logLevel = reader.oneOf('SYMB_LOG_LEVEL', LOG_LEVELS) ?? 'info';
  const metricsToken = reader.secret('SYMB_METRICS_TOKEN', tokenCheck);
  const bootstrapToken = reader.secret('SYMB_BOOTSTRAP_TOKEN', tokenCheck);
  const bootstrapApiKey = reader.secret('SYMB_BOOTSTRAP_API_KEY', tokenCheck);

  // Drapeaux de test : leur présence hors NODE_ENV=test arrête le démarrage (04b § 11, 04c § 1.2).
  const flag = (name: 'SYMB_TEST_MODE' | 'SYMB_TEST_ALLOW_PRIVATE'): boolean => {
    const value = reader.text(name);
    if (value === null) return false;
    if (nodeEnv !== 'test') {
      fail(`${name} n’est permise que sous NODE_ENV=test : retirez-la (NODE_ENV vaut ${nodeEnv}).`);
      return false;
    }
    if (value !== '1') fail(`${name} invalide : 1 attendu (reçu « ${value} »).`);
    return value === '1';
  };
  const test = { mode: flag('SYMB_TEST_MODE'), allowPrivate: flag('SYMB_TEST_ALLOW_PRIVATE') };

  if (runsNode) {
    for (const name of FORBIDDEN_FOR_NODE) {
      if (env[name] !== undefined) fail(`${name} est définie : le nœud refuse de démarrer (le proxy loopback forcé de Chromium doit rester actif, 04c § 1.1) ; retirez-la.`);
    }
  }

  if (reader.issues.length > 0) throw new ConfigError([...reader.issues]);
  // Sans erreur, les valeurs obligatoires sont présentes (le lecteur a signalé l'absence sinon).
  const warning = unknownReservedVariablesWarning(env);
  return {
    mode,
    port,
    nodeEnv,
    shutdownGraceSeconds,
    databaseUrl: databaseUrl as Secret,
    masterKey: masterKey as Secret,
    masterKeyPrevious,
    nodeToken,
    node,
    queue,
    objectStore,
    dataDir,
    privateHosts,
    ipEchoUrl,
    limits,
    retention,
    logLevel,
    metricsToken,
    bootstrapToken,
    bootstrapApiKey,
    test,
    warnings: warning === null ? [] : [warning],
  };
}

/** Résumé sans secret, pour `--check-config` et le journal de démarrage. */
export function describeConfig(config: BrowserConfig): string {
  const store = config.objectStore.kind === 'disk' ? `disque ${config.objectStore.dir}` : `s3 ${config.objectStore.bucket}`;
  return `mode ${config.mode}, port ${config.port}, NODE_ENV ${config.nodeEnv}, stockage ${store}, répertoire de travail ${config.dataDir}, journal ${config.logLevel}`;
}
