import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { generateMasterKey, loadKeyring, MasterKey, MasterKeyError } from './master-key.js';

const b64 = (bytes: Buffer) => bytes.toString('base64');

describe('MASTER_KEY stricte', () => {
  test('keygen : 44 caractères base64, 32 octets, acceptée', () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(MasterKey.parse(key).fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(generateMasterKey()).not.toBe(key);
  });

  test.each([
    ['31 octets', b64(randomBytes(31))],
    ['33 octets', b64(randomBytes(33))],
    // Tirage jusqu'à obtenir au moins un « + » ou « / » : sinon (≈ 25 % des cas) la forme base64url
    // est identique à la base64 canonique et le test échouerait sans défaut du code.
    ['base64url', withUrlChars().replace(/\+/g, '-').replace(/\//g, '_')],
    ['sans remplissage', b64(randomBytes(32)).replace(/=$/, '')],
    ['hex', randomBytes(32).toString('hex')],
    ['phrase secrète', 'correct horse battery staple, très long et mémorisable'],
    ['vide', ''],
  ])('refus : %s, message nommant runtime keygen', (_label, value) => {
    expect(() => MasterKey.parse(value)).toThrow(MasterKeyError);
    expect(() => MasterKey.parse(value)).toThrow(/runtime keygen/);
  });

  test.each([
    ['zéros', Buffer.alloc(32)],
    ['octet répété', Buffer.alloc(32, 0x41)],
    ['suite 0..31', Buffer.from([...Array(32).keys()])],
    ['phrase ASCII encodée', Buffer.from('ma-phrase-secrete-de-32-octets!!')],
  ])('refus des valeurs triviales : %s', (_label, bytes) => {
    expect(() => MasterKey.parse(b64(bytes))).toThrow(/valeur triviale/);
  });

  test('aucun message d’erreur ne contient la valeur refusée', () => {
    const value = b64(randomBytes(31));
    try {
      MasterKey.parse(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  test('la clé ne se sérialise pas : JSON, String, inspect ne montrent que l’empreinte', () => {
    const raw = generateMasterKey();
    const key = MasterKey.parse(raw);
    for (const shown of [JSON.stringify({ key }), String(key), inspect(key), inspect({ key })]) {
      expect(shown).not.toContain(raw);
      expect(shown).toContain(key.fingerprint);
    }
  });

  test('KEK : une par usage, déterministe', () => {
    const key = MasterKey.parse(generateMasterKey());
    expect(key.kek('secrets').equals(key.kek('secrets'))).toBe(true);
    expect(key.kek('secrets').equals(key.kek('sessions'))).toBe(false);
  });
});

describe('loadKeyring : _FILE et _PREVIOUS', () => {
  const files: Record<string, string> = {};
  const readFile = (p: string) => {
    const content = files[p];
    if (content === undefined) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return content;
  };
  const fileMode = () => 0o100600;
  const opts = { readFile, fileMode, warn: () => {} };

  test('MASTER_KEY manquante : message nommant la variable et keygen', () => {
    expect(() => loadKeyring({}, opts)).toThrow(/MASTER_KEY manquante.*runtime keygen/);
  });

  test('MASTER_KEY_FILE lu, blancs finaux retirés', () => {
    const key = generateMasterKey();
    files['/run/secrets/mk'] = `${key}\n`;
    const ring = loadKeyring({ MASTER_KEY_FILE: '/run/secrets/mk' }, opts);
    expect(ring.current.fingerprint).toBe(MasterKey.parse(key).fingerprint);
    expect(ring.previous).toBeUndefined();
  });

  test('MASTER_KEY et MASTER_KEY_FILE ensemble : refus', () => {
    expect(() => loadKeyring({ MASTER_KEY: generateMasterKey(), MASTER_KEY_FILE: '/x' }, opts)).toThrow(/n'en gardez qu'une/);
  });

  test('fichier illisible : refus avec le code, sans contenu', () => {
    expect(() => loadKeyring({ MASTER_KEY_FILE: '/absent' }, opts)).toThrow(/MASTER_KEY_FILE illisible.*ENOENT/);
  });

  test('MASTER_KEY_PREVIOUS et _FILE lues seulement sur demande (rekey)', () => {
    const [a, b] = [generateMasterKey(), generateMasterKey()];
    const withPrev = { ...opts, previous: true };
    expect(loadKeyring({ MASTER_KEY: a, MASTER_KEY_PREVIOUS: b }, opts).previous).toBeUndefined();
    expect(loadKeyring({ MASTER_KEY: a, MASTER_KEY_PREVIOUS: 'trop-court' }, opts).previous).toBeUndefined();
    expect(loadKeyring({ MASTER_KEY: a, MASTER_KEY_PREVIOUS: b }, withPrev).previous?.fingerprint).toBe(MasterKey.parse(b).fingerprint);
    files['/prev'] = b;
    expect(loadKeyring({ MASTER_KEY: a, MASTER_KEY_PREVIOUS_FILE: '/prev' }, withPrev).previous?.fingerprint).toBe(
      MasterKey.parse(b).fingerprint,
    );
    expect(() => loadKeyring({ MASTER_KEY: a, MASTER_KEY_PREVIOUS: 'trop-court' }, withPrev)).toThrow(/MASTER_KEY_PREVIOUS invalide/);
  });

  test('8 : variables MASTER_KEY* retirées de l’environnement après chargement', () => {
    const env: NodeJS.ProcessEnv = { MASTER_KEY: generateMasterKey(), MASTER_KEY_PREVIOUS: generateMasterKey(), MASTER_KEY_PREVIOUS_FILE: '', OTHER: '1' };
    loadKeyring(env, opts);
    expect(Object.keys(env)).toEqual(['OTHER']);
  });

  test('8 : un processus enfant lancé après le chargement n’hérite pas de MASTER_KEY', () => {
    const saved = { ...process.env };
    process.env.MASTER_KEY = generateMasterKey();
    process.env.MASTER_KEY_PREVIOUS = generateMasterKey();
    try {
      loadKeyring(process.env, opts);
      const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(Object.keys(process.env).filter((k) => k.startsWith("MASTER_KEY")).join(","))'], {
        encoding: 'utf8',
      });
      expect(child.stdout).toBe('');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    }
  });

  test('8 : avertissement si le fichier _FILE est lisible par le groupe ou les autres', () => {
    files['/k'] = generateMasterKey();
    const warnings: string[] = [];
    loadKeyring({ MASTER_KEY_FILE: '/k' }, { readFile, fileMode: () => 0o100644, warn: (m) => warnings.push(m) });
    expect(warnings.join('')).toMatch(/MASTER_KEY_FILE.*0644.*chmod 600/);
    warnings.length = 0;
    loadKeyring({ MASTER_KEY_FILE: '/k' }, { readFile, fileMode: () => 0o100600, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});

function withUrlChars(): string {
  for (;;) {
    const k = b64(randomBytes(32));
    if (/[+/]/.test(k)) return k;
  }
}
