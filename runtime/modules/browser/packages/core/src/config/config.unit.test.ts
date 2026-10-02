// SPDX-License-Identifier: AGPL-3.0-only
// Configuration de SYM Browser (cdc/sym-browser 04b § 11, tâche 0.4) : catalogue d'environnement, modes, refus de démarrer.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { BROWSER_ENV_CATALOG, ConfigError, loadConfig, Reader, Secret, unknownReservedVariablesWarning } from '../index.js';

const key = (): string => randomBytes(32).toString('base64');
const base = (extra: Record<string, string> = {}): Record<string, string> => ({
  MASTER_KEY: key(),
  DATABASE_URL: 'postgres://symb:motdepasse-de-test@db.invalid:5432/symb',
  ...extra,
});
const without = (env: Record<string, string>, name: string): Record<string, string> => {
  const copy = { ...env };
  delete copy[name];
  return copy;
};
const NODE_ENV_VARS = { NODE_TOKEN: 'n'.repeat(32), NODE_PUBLIC_URL: 'http://node-1.internal:3000' };

function issues(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
  throw new Error('la configuration aurait dû être refusée');
}

describe('modes', () => {
  test('défauts : mode all, port 3000, production, valeurs du catalogue 04b § 11', () => {
    const config = loadConfig(base());
    expect(config.mode).toBe('all');
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('production');
    expect(config.node).toMatchObject({ region: 'default', warmBrowsers: 1, maxSessions: null, recycleAfterSessions: 50, recycleAfterMs: 3_600_000, recycleRssPercent: 90, heartbeatMs: 5000 });
    expect(config.queue).toEqual({ max: 50, maxPerTenant: 10, timeoutMs: 30_000 });
    expect(config.shutdownGraceSeconds).toBe(270);
    expect(config.objectStore).toEqual({ kind: 'disk', dir: '/data/objects' });
    expect(config.dataDir).toBe('/data');
    expect(config.logLevel).toBe('info');
    expect(config.retention).toEqual({ traceDays: 7, harDays: 7, videoDays: 7, logDays: 7, downloadHours: 24 });
    expect(config.limits).toMatchObject({ profileMaxBytes: 100 * 1024 ** 2, recordingMaxBytes: 200 * 1024 ** 2, cdpMaxMessageBytes: 100 * 1024 ** 2, downloadMaxBytes: 500 * 1024 ** 2, sessionDownloadMaxBytes: 2 * 1024 ** 3, uploadMaxBytes: 100 * 1024 ** 2 });
    expect(config.privateHosts).toEqual([]);
    // Point d'écho du test de proxy amont (04c § 2.3), fixé par la tâche 1.6 : HTTPS, réponse JSON `{ip}`.
    expect(config.ipEchoUrl).toBe('https://api.ipify.org/?format=json');
  });

  test('les trois modes sont acceptés ; all n’exige ni NODE_TOKEN ni NODE_PUBLIC_URL', () => {
    expect(loadConfig(base({ SYMB_MODE: 'all' })).mode).toBe('all');
    expect(loadConfig(base({ SYMB_MODE: 'gateway', NODE_TOKEN: 'n'.repeat(32) })).mode).toBe('gateway');
    expect(loadConfig(base({ SYMB_MODE: 'node', ...NODE_ENV_VARS })).mode).toBe('node');
  });

  test('SYMB_MODE inconnu : refusé, la variable et les valeurs permises sont nommées', () => {
    const found = issues(base({ SYMB_MODE: 'worker' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^SYMB_MODE invalide .*all, gateway, node/);
  });

  test('NODE_TOKEN obligatoire en gateway et en node ; NODE_PUBLIC_URL obligatoire en node', () => {
    expect(issues(base({ SYMB_MODE: 'gateway' })).join('\n')).toMatch(/NODE_TOKEN obligatoire en mode gateway/);
    const node = issues(base({ SYMB_MODE: 'node' })).join('\n');
    expect(node).toMatch(/NODE_TOKEN obligatoire en mode node/);
    expect(node).toMatch(/NODE_PUBLIC_URL obligatoire en mode node/);
  });

  test('en mode all, le nœud s’enregistre sur 127.0.0.1 ; NODE_ID par défaut : nom d’hôte', () => {
    expect(loadConfig(base()).node.publicUrl).toBe('http://127.0.0.1:3000');
    expect(loadConfig(base({ PORT: '4100' })).node.publicUrl).toBe('http://127.0.0.1:4100');
    expect(loadConfig(base()).node.id.length).toBeGreaterThan(0);
    expect(loadConfig(base({ NODE_ID: 'noeud-eu-1' })).node.id).toBe('noeud-eu-1');
  });

  test('le mode all refuse OBJECT_STORE=s3 (stockage disque)', () => {
    expect(issues(base({ OBJECT_STORE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a'.repeat(8), S3_SECRET_ACCESS_KEY: 's'.repeat(16) })).join('\n')).toMatch(/OBJECT_STORE .*mode all/);
  });

  test('OBJECT_STORE=s3 en gateway : bucket et identifiants obligatoires', () => {
    const env = (): Record<string, string> => base({ SYMB_MODE: 'gateway', NODE_TOKEN: 'n'.repeat(32), OBJECT_STORE: 's3' });
    const text = issues(env()).join('\n');
    for (const name of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) expect(text).toContain(name);
    const ok = loadConfig({ ...env(), S3_BUCKET: 'sauvegardes', S3_ACCESS_KEY_ID: 'AKIATESTTESTTEST', S3_SECRET_ACCESS_KEY: 'x'.repeat(24), S3_ENDPOINT: 'https://s3.example.org' });
    expect(ok.objectStore.kind).toBe('s3');
  });
});

describe('MASTER_KEY et secrets (assert_config_refuses_invalid)', () => {
  test.each([
    ['absente', undefined],
    ['vide', ''],
    ['trop courte', Buffer.alloc(16, 7).toString('base64')],
    ['pas du base64', 'ceci n’est pas une clé !'],
    ['31 octets', randomBytes(31).toString('base64')],
    ['33 octets', randomBytes(33).toString('base64')],
    ['octets répétés', Buffer.alloc(32, 1).toString('base64')],
    ['phrase secrète', 'correct horse battery staple again!!'],
  ])('MASTER_KEY %s : refusée, message nommant MASTER_KEY', (_label, value) => {
    const env = value === undefined ? without(base(), 'MASTER_KEY') : base({ MASTER_KEY: value });
    const found = issues(env);
    expect(found.some((line) => line.startsWith('MASTER_KEY'))).toBe(true);
    if (value) expect(found.join('\n')).not.toContain(value);
  });

  test('MASTER_KEY_PREVIOUS est validée avec le même format', () => {
    expect(issues(base({ MASTER_KEY_PREVIOUS: 'courte' })).join('\n')).toMatch(/^MASTER_KEY_PREVIOUS invalide/m);
    expect(loadConfig(base({ MASTER_KEY_PREVIOUS: key() })).masterKeyPrevious).toBeInstanceOf(Secret);
  });

  test('NAME_FILE : lit le fichier (blancs finaux retirés) ; les deux posées : refus ; fichier illisible : refus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symb-config-'));
    const k = key();
    writeFileSync(join(dir, 'master_key'), `${k}\n`);
    expect(loadConfig(without(base({ MASTER_KEY_FILE: join(dir, 'master_key') }), 'MASTER_KEY')).masterKey.reveal()).toBe(k);

    expect(issues(base({ MASTER_KEY_FILE: join(dir, 'master_key') })).join('\n')).toMatch(/MASTER_KEY et MASTER_KEY_FILE sont posées toutes les deux/);
    expect(issues(without(base({ MASTER_KEY_FILE: join(dir, 'absent') }), 'MASTER_KEY')).join('\n')).toMatch(/MASTER_KEY_FILE illisible/);
  });

  test('les secrets sont retirés de l’environnement après lecture et ne s’affichent jamais', () => {
    const env = base({ SYMB_METRICS_TOKEN: 'm'.repeat(40) });
    const clear = env['MASTER_KEY'] ?? '';
    const config = loadConfig(env);
    expect(env['MASTER_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['SYMB_METRICS_TOKEN']).toBeUndefined();
    for (const rendered of [JSON.stringify(config), inspect(config, { depth: 8 }), String(config.masterKey)]) {
      expect(rendered).not.toContain(clear);
      expect(rendered).not.toContain('motdepasse-de-test');
      expect(rendered).not.toContain('m'.repeat(40));
    }
  });

  test('DATABASE_URL : obligatoire, schéma postgres(ql):// ; la valeur n’est jamais répétée', () => {
    expect(issues(without(base(), 'DATABASE_URL')).join('\n')).toMatch(/^DATABASE_URL obligatoire/m);
    const bad = issues(base({ DATABASE_URL: 'mysql://u:secretdb@h/db' })).join('\n');
    expect(bad).toMatch(/^DATABASE_URL invalide/m);
    expect(bad).not.toContain('secretdb');
    expect(loadConfig(base({ DATABASE_URL: 'postgresql://u:p@h/db' })).databaseUrl.reveal()).toBe('postgresql://u:p@h/db');
  });

  test('toutes les variables invalides sont rapportées d’un coup', () => {
    const found = issues(base({ MASTER_KEY: 'x', PORT: 'abc', SYMB_LOG_LEVEL: 'bavard' }));
    expect(found.map((line) => line.split(' ')[0])).toEqual(expect.arrayContaining(['MASTER_KEY', 'PORT', 'SYMB_LOG_LEVEL']));
  });
});

describe('validation des valeurs', () => {
  test.each([
    ['PORT', 'abc'], ['PORT', '70000'], ['PORT', '-1'],
    ['MAX_SESSIONS', '0'], ['MAX_SESSIONS', '65'], ['MAX_SESSIONS', '2.5'],
    ['WARM_BROWSERS', '-1'], ['QUEUE_MAX', 'beaucoup'], ['QUEUE_TIMEOUT_MS', '0'],
    ['RECYCLE_RSS_PERCENT', '0'], ['RECYCLE_RSS_PERCENT', '101'],
    ['HEARTBEAT_MS', '10'], ['SHUTDOWN_GRACE_SECONDS', '301'], ['SHUTDOWN_GRACE_SECONDS', '0'],
    ['OBJECT_STORE', 'ftp'], ['OBJECT_DIR', 'relatif/chemin'], ['SYMB_DATA_DIR', 'data'],
    ['SYMB_LOG_LEVEL', 'bavard'], ['NODE_ENV', 'staging'],
    ['SYMB_RETENTION_TRACE_DAYS', '0'], ['SYMB_PROFILE_MAX_BYTES', '12 Mo'],
    ['SYMB_IP_ECHO_URL', 'http://echo.example.org'], ['SYMB_METRICS_TOKEN', 'trop-court'],
    ['SYMB_BOOTSTRAP_TOKEN', 'trop-court'], ['SYMB_BOOTSTRAP_API_KEY', 'trop-court'], ['SYMB_BOOTSTRAP_API_KEY', 'n'.repeat(48)],
    ['SYMB_PRIVATE_HOSTS', '10.0.0.0/33'], ['SYMB_PRIVATE_HOSTS', 'hôte invalide'],
    ['NODE_REGION', 'Région 1'], ['NODE_ID', 'a b'],
  ])('%s=%s : refusée, la variable est nommée', (name, value) => {
    const found = issues(base({ [name]: value }));
    expect(found.some((line) => line.startsWith(name))).toBe(true);
  });

  test('valeurs valides lues telles quelles', () => {
    const config = loadConfig(
      base({
        PORT: '0', MAX_SESSIONS: '12', WARM_BROWSERS: '0', QUEUE_MAX: '5', SHUTDOWN_GRACE_SECONDS: '300', NODE_ENV: 'development',
        SYMB_LOG_LEVEL: 'debug', SYMB_DATA_DIR: '/var/lib/symb', OBJECT_DIR: '/var/lib/symb/objects', SYMB_IP_ECHO_URL: 'https://echo.example.org/ip',
        SYMB_PRIVATE_HOSTS: 'fixtures.internal, 10.1.0.0/16 ,fd00::/8', SYMB_RETENTION_VIDEO_DAYS: '1', CONTEXTS_PER_BROWSER: '4',
      }),
    );
    expect(config).toMatchObject({ port: 0, nodeEnv: 'development', logLevel: 'debug', dataDir: '/var/lib/symb', ipEchoUrl: 'https://echo.example.org/ip' });
    expect(config.node).toMatchObject({ maxSessions: 12, warmBrowsers: 0, contextsPerBrowser: 4 });
    expect(config.privateHosts).toEqual(['fixtures.internal', '10.1.0.0/16', 'fd00::/8']);
    expect(config.retention.videoDays).toBe(1);
    expect(config.shutdownGraceSeconds).toBe(300);
  });

  test('SYMB_BOOTSTRAP_API_KEY : une clé symb_ bien formée (tâche 2.1), jamais recopiée dans le message de refus', () => {
    const valid = `symb_${'A1b2C3d4E5f6'}_${randomBytes(32).toString('base64url')}`;
    expect(loadConfig(base({ SYMB_BOOTSTRAP_API_KEY: valid })).bootstrapApiKey?.reveal()).toBe(valid);
    const invalid = `x${valid}`;
    const found = issues(base({ SYMB_BOOTSTRAP_API_KEY: invalid })).join('\n');
    expect(found).toMatch(/SYMB_BOOTSTRAP_API_KEY .*symb_/);
    expect(found).not.toContain(invalid);
  });

  test('une valeur vide vaut absente (Compose passe souvent NOM=)', () => {
    expect(loadConfig(base({ PORT: '', SYMB_LOG_LEVEL: '' })).port).toBe(3000);
  });
});

describe('drapeaux de test et garde-fous', () => {
  test('SYMB_TEST_MODE et SYMB_TEST_ALLOW_PRIVATE : acceptés sous NODE_ENV=test, leur présence arrête le démarrage ailleurs', () => {
    const flags = { SYMB_TEST_MODE: '1', SYMB_TEST_ALLOW_PRIVATE: '1' };
    expect(loadConfig(base({ NODE_ENV: 'test', ...flags })).test).toEqual({ mode: true, allowPrivate: true });
    expect(loadConfig(base({ NODE_ENV: 'test' })).test).toEqual({ mode: false, allowPrivate: false });
    for (const nodeEnv of ['production', 'development']) {
      const found = issues(base({ NODE_ENV: nodeEnv, ...flags })).join('\n');
      expect(found).toMatch(/SYMB_TEST_MODE .*NODE_ENV=test/);
      expect(found).toMatch(/SYMB_TEST_ALLOW_PRIVATE .*NODE_ENV=test/);
    }
    expect(issues(base({ SYMB_TEST_ALLOW_PRIVATE: '0' })).join('\n')).toMatch(/SYMB_TEST_ALLOW_PRIVATE/);
  });

  test('PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK : le nœud refuse de démarrer (04c § 1.1), la passerelle l’ignore', () => {
    const name = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';
    expect(issues(base({ [name]: '1' })).join('\n')).toContain(name);
    expect(issues(base({ SYMB_MODE: 'node', ...NODE_ENV_VARS, [name]: '1' })).join('\n')).toContain(name);
    expect(loadConfig(base({ SYMB_MODE: 'gateway', NODE_TOKEN: 'n'.repeat(32), [name]: '1' })).mode).toBe('gateway');
  });

  test('variables SYMB_ ou MASTER_ inconnues : avertissement qui nomme la variable sans sa valeur, jamais une erreur', () => {
    const env = base({ SYMB_MODEE: 'node', MASTER_KEY_PRIVIOUS: 'valeur-secrete-xyz' });
    const warning = unknownReservedVariablesWarning(env) ?? '';
    expect(warning).toContain('SYMB_MODEE');
    expect(warning).toContain('MASTER_KEY_PRIVIOUS');
    expect(warning).not.toContain('valeur-secrete-xyz');
    expect(loadConfig(env).warnings).toEqual([warning]);
    expect(unknownReservedVariablesWarning(base({ SYMB_MODE: 'all', MASTER_KEY_FILE: '/x' }))).toBeNull();
    expect(unknownReservedVariablesWarning(base({ NODE_OPTIONS: '--x' }))).toBeNull();
  });
});

describe('catalogue d’environnement (assert_env_catalog)', () => {
  const names = BROWSER_ENV_CATALOG.map((variable) => variable.name);

  test('noms uniques ; chaque entrée documentée et rattachée à un rôle', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const variable of BROWSER_ENV_CATALOG) {
      expect(variable.description.length, variable.name).toBeGreaterThan(10);
      expect(variable.roles.length, variable.name).toBeGreaterThan(0);
    }
  });

  test('contient toutes les variables de 04b § 11 et aucune variable de SYM (BROWSER_URL…)', () => {
    const spec = [
      'SYMB_MODE', 'PORT', 'DATABASE_URL', 'MASTER_KEY', 'MASTER_KEY_PREVIOUS', 'NODE_TOKEN', 'NODE_PUBLIC_URL', 'NODE_ID', 'NODE_REGION', 'MAX_SESSIONS',
      'WARM_BROWSERS', 'CONTEXTS_PER_BROWSER', 'QUEUE_MAX', 'QUEUE_MAX_PER_TENANT', 'QUEUE_TIMEOUT_MS', 'RECYCLE_AFTER_SESSIONS', 'RECYCLE_AFTER_MS',
      'RECYCLE_RSS_PERCENT', 'HEARTBEAT_MS', 'SHUTDOWN_GRACE_SECONDS', 'OBJECT_STORE', 'OBJECT_DIR', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION',
      'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'NODE_ENV', 'SYMB_DATA_DIR', 'SYMB_PRIVATE_HOSTS', 'SYMB_IP_ECHO_URL', 'SYMB_PROFILE_MAX_BYTES',
      'SYMB_DOWNLOAD_MAX_BYTES', 'SYMB_SESSION_DOWNLOAD_MAX_BYTES', 'SYMB_UPLOAD_MAX_BYTES', 'SYMB_CDP_MAX_MESSAGE_BYTES', 'SYMB_RECORDING_MAX_BYTES',
      'SYMB_RETENTION_TRACE_DAYS', 'SYMB_RETENTION_HAR_DAYS', 'SYMB_RETENTION_VIDEO_DAYS', 'SYMB_RETENTION_LOG_DAYS', 'SYMB_RETENTION_DOWNLOAD_HOURS',
      'SYMB_METRICS_TOKEN', 'SYMB_LOG_LEVEL', 'SYMB_BOOTSTRAP_TOKEN', 'SYMB_BOOTSTRAP_API_KEY', 'SYMB_TEST_MODE', 'SYMB_TEST_ALLOW_PRIVATE',
    ];
    expect(names.slice().sort()).toEqual(spec.slice().sort());
    expect(names.some((name) => name.startsWith('BROWSER_'))).toBe(false);
  });

  test('secrets : exactement ceux-ci acceptent NAME_FILE', () => {
    const secrets = BROWSER_ENV_CATALOG.filter((variable) => variable.secret).map((variable) => variable.name).sort();
    expect(secrets).toEqual(['DATABASE_URL', 'MASTER_KEY', 'MASTER_KEY_PREVIOUS', 'NODE_TOKEN', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'SYMB_BOOTSTRAP_API_KEY', 'SYMB_BOOTSTRAP_TOKEN', 'SYMB_METRICS_TOKEN']);
  });

  test('le chargeur lit chaque variable du catalogue (aucune documentée mais ignorée) et seulement elles', () => {
    const all = { ...base({ MASTER_KEY_PREVIOUS: key(), SYMB_MODE: 'node', NODE_ENV: 'test' }), ...NODE_ENV_VARS };
    const reader = new Reader(all);
    loadConfig(all, { reader });
    expect([...reader.touched].sort()).toEqual(names.slice().sort());
  });

  test('le Reader refuse une variable hors catalogue (faute de programmation)', () => {
    expect(() => new Reader({}).text('SYMB_INCONNUE')).toThrow(/catalogue/);
  });
});
