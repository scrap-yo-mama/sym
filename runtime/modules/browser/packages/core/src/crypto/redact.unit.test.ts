// SPDX-License-Identifier: AGPL-3.0-only
// Masquage des journaux à trois couches (cdc/sym-browser 04d § 3.2, BINV6) : (1) `Secret` ; (2) chemins explicites et
// sérialiseurs d'URL et d'erreur (query `t` et `token`) ; (3) balayage par valeur, puis filtre de motifs sur la ligne
// finale (préfixes de clés d'API, `Bearer …`, identifiants dans les URL).
import { randomBytes } from 'node:crypto';
import { format, inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import {
  LOG_REDACT_PATHS,
  loggerRedaction,
  redact,
  redactArtifactText,
  REDACTED,
  redactPatterns,
  redactUrl,
  Secret,
  SecretValueRegistry,
  type RedactionOptions,
} from './redact.js';

const canary = (suffix = '') => `zz_test_canary_${randomBytes(8).toString('hex')}${suffix}`;

/**
 * Banc minimal au comportement de pino (sans dépendance, pino arrive avec le journal du service) : `logMethod`, chemins
 * `redact` (exacts et `*.x`), sérialiseurs par clé, ligne JSON, puis `streamWrite`. Il ne prouve que l'ordre des couches.
 */
function bench(registry: SecretValueRegistry, options?: RedactionOptions) {
  const cfg = loggerRedaction(registry, options);
  const lines: string[] = [];
  const censor = (obj: Record<string, unknown>) => {
    for (const path of cfg.redact.paths) {
      const keys = path.match(/[^.[\]"]+/g) ?? [];
      const apply = (node: unknown, rest: string[]): void => {
        if (node === null || typeof node !== 'object' || rest.length === 0) return;
        const [head = '', ...tail] = rest;
        const record = node as Record<string, unknown>;
        const targets = head === '*' ? Object.keys(record) : [head];
        for (const k of targets) {
          if (!(k in record)) continue;
          if (tail.length === 0) record[k] = cfg.redact.censor;
          else apply(record[k], tail);
        }
      };
      apply(obj, keys);
    }
  };
  const write = (level: number, args: unknown[]) => {
    const [first, ...rest] = args;
    let obj: Record<string, unknown> = {};
    let msgArgs = args;
    if (first instanceof Error) {
      obj = { err: { type: first.name, message: first.message, stack: first.stack } };
      msgArgs = rest.length ? rest : [first.message];
    } else if (first !== null && typeof first === 'object') {
      obj = structuredClone(first as Record<string, unknown>);
      msgArgs = rest;
    }
    for (const [key, serialize] of Object.entries(cfg.serializers)) if (key in obj) obj[key] = serialize(obj[key]);
    censor(obj);
    const line = JSON.stringify({ level, time: 0, ...obj, msg: msgArgs.length ? format(...(msgArgs as [unknown, ...unknown[]])) : undefined });
    lines.push(cfg.hooks.streamWrite(line));
  };
  const at = (level: number) => (...args: unknown[]) => cfg.hooks.logMethod.call(undefined, args, (...redacted: unknown[]) => write(level, redacted));
  return { logger: { info: at(30), warn: at(40), error: at(50) }, lines };
}

describe('couche 1 : Secret', () => {
  test('JSON, String, gabarit, inspect : masqué ; reveal() rend la valeur', () => {
    const value = canary();
    const s = new Secret(value);
    for (const shown of [JSON.stringify({ s }), String(s), `${s}`, inspect(s), inspect({ nested: { s } })]) expect(shown).not.toContain(value);
    expect(s.reveal()).toBe(value);
  });
});

describe('couche 2 : chemins et sérialiseurs', () => {
  test('chemins de la spec 04d § 3.2 présents', () => {
    for (const path of ['*.password', '*.token', 'headers.authorization', 'headers.cookie', 'password', 'token']) expect(LOG_REDACT_PATHS, path).toContain(path);
  });

  test('URL : query `t` et `token` masquées, userinfo retiré, encodage des autres paramètres conservé', () => {
    const reg = new SecretValueRegistry();
    expect(redactUrl('wss://gw.example/live/s1?t=abc.def&mode=ro', reg)).toBe(`wss://gw.example/live/s1?t=${REDACTED}&mode=ro`);
    expect(redactUrl('wss://gw.example/cdp?token=zz&T=1&tt=2', reg)).toBe(`wss://gw.example/cdp?token=${REDACTED}&T=${REDACTED}&tt=2`);
    expect(redactUrl('http://u:p4ssword@proxy.example:3128/x?q=a%20b&page=2', reg)).toBe('http://proxy.example:3128/x?q=a%20b&page=2');
  });

  test('sérialiseurs url, proxyUrl, connectUrl ; erreur copiée et balayée', () => {
    const reg = new SecretValueRegistry();
    const value = canary();
    reg.add(value);
    const { serializers } = loggerRedaction(reg);
    expect(Object.keys(serializers).sort()).toEqual(['connectUrl', 'proxyUrl', 'url']);
    expect(serializers.connectUrl(`wss://gw.example/playwright?token=${value}`)).toBe(`wss://gw.example/playwright?token=${REDACTED}`);
    const err = new Error(`échec ${value}`, { cause: { password: value } });
    const out = redact({ err }, reg);
    expect(inspect(out, { depth: 5 })).not.toContain(value);
    expect(err.message).toContain(value);
  });
});

describe('couche 3 : valeurs connues et motifs', () => {
  test('valeur courte isolée non balayée (seulement après un délimiteur)', () => {
    const reg = new SecretValueRegistry();
    reg.add('abc');
    expect(reg.redactText('tabcd abc')).toBe('tabcd abc');
    expect(reg.redactText('password=abc')).toBe(`password=${REDACTED}`);
  });

  test('registre : delete et clear retirent les valeurs', () => {
    const reg = new SecretValueRegistry();
    const value = canary();
    reg.add(value);
    expect(reg.size).toBe(1);
    reg.delete(value);
    expect(reg.redactText(value)).toBe(value);
    reg.add(value);
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.redactText(value)).toBe(value);
  });

  test('motifs : Bearer, identifiants dans une URL, préfixes de clés d’API', () => {
    const prefixes = ['symb_'];
    expect(redactPatterns('Authorization: Bearer abc.def-ghi', prefixes)).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactPatterns('bearer x', prefixes)).toBe(`bearer ${REDACTED}`);
    expect(redactPatterns('proxy socks5://alice:s3cr3t@10.0.0.1:1080 refusé', prefixes)).toBe(`proxy socks5://${REDACTED}@10.0.0.1:1080 refusé`);
    expect(redactPatterns('clé symb_0123456789abcdefXYZ utilisée', prefixes)).toBe(`clé ${REDACTED} utilisée`);
    // Préfixe affiché (court) : public, conservé ; texte ordinaire intact.
    expect(redactPatterns('clé symb_ab12 utilisée, mail a@b.example', prefixes)).toBe('clé symb_ab12 utilisée, mail a@b.example');
    expect(redactPatterns(`Bearer ${REDACTED}`, prefixes)).toBe(`Bearer ${REDACTED}`);
  });

  test('motifs dans une ligne JSON : la ligne reste du JSON valide', () => {
    const line = JSON.stringify({ msg: 'Bearer abc "x" http://u:p@h/ symb_0123456789abcdef0' });
    const out = redactPatterns(line, ['symb_']);
    expect(() => JSON.parse(out)).not.toThrow();
    for (const v of ['abc', 'u:p', '0123456789abcdef0']) expect(out).not.toContain(v);
  });

  test('préfixe de clé invalide refusé', () => {
    expect(() => loggerRedaction(new SecretValueRegistry(), { apiKeyPrefixes: [''] })).toThrow(/préfixe/);
    expect(() => loggerRedaction(new SecretValueRegistry(), { apiKeyPrefixes: ['a.b'] })).toThrow(/préfixe/);
  });

  test('redact : copie profonde, cycles, Buffer, Secret ; entrée intacte', () => {
    const reg = new SecretValueRegistry();
    const value = canary();
    reg.add(value);
    const input: Record<string, unknown> = { msg: `clé=${value}`, list: [value, new Secret('autre-secret-xyz')], url: new URL(`http://user:${value}@proxy.example/?api_key=${value}`), b: Buffer.from('xyz') };
    input.self = input;
    const out = redact(input, reg) as Record<string, unknown>;
    expect(inspect(out, { depth: 10 })).not.toContain(value);
    expect(inspect(out, { depth: 10 })).not.toContain('autre-secret-xyz');
    expect(out.self).toBe(out);
    expect(out.b).toBe('[Buffer 3 octets]');
    expect(input.msg).toBe(`clé=${value}`);
  });

  test('artefact HAR : en-têtes et cookies masqués, JSON valide', () => {
    const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'Proxy-Authorization', value: 'Basic zz' }, { name: 'Accept', value: 'text/html' }] } }] } });
    const out = redactArtifactText(har, new SecretValueRegistry());
    expect(out).not.toContain('Basic zz');
    expect(out).toContain('text/html');
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe('audit 5.3 S17 (BINV6, assert_secrets_protected) : en-têtes d’authentification applicatifs des HAR', () => {
  test.each(['X-Api-Key', 'X-Auth-Token', 'X-CSRF-Token', 'X-Amz-Security-Token', 'X-Session-Id', 'Api-Secret'])('%s : valeur masquée, Accept gardé', (name) => {
    const har = JSON.stringify({ log: { entries: [{ request: { headers: [{ name, value: 'zz_test_canary_s17' }, { name: 'Accept', value: 'text/html' }] } }] } });
    const out = redactArtifactText(har, new SecretValueRegistry());
    expect(out).not.toContain('zz_test_canary_s17');
    expect(out).toContain('text/html');
  });
});

describe('assert_secrets_protected (BINV6, partie journaux, tâche 0.3)', () => {
  test('mot de passe de proxy, jeton de connexion, clé d’API, jeton de vue : 0 occurrence en clair dans les lignes', () => {
    const reg = new SecretValueRegistry();
    const proxyPassword = canary('"level":60,"msg":"x');
    const connectToken = canary('.sig');
    const apiKey = `symb_${randomBytes(16).toString('hex')}`;
    const viewToken = randomBytes(12).toString('base64url');
    const short = 'pw1';
    reg.add(proxyPassword);
    reg.add(connectToken);
    const { logger, lines } = bench(reg, { apiKeyPrefixes: ['symb_'] });
    logger.info(`egress prêt ${proxyPassword}`);
    logger.info({ data: { note: proxyPassword } }, 'objet');
    logger.warn({ password: short, proxy: { password: short }, headers: { authorization: `Bearer ${connectToken}`, cookie: 'sid=zz' } }, 'chemins');
    logger.error(new Error(`échec : ${proxyPassword}`));
    logger.error({ err: new Error(connectToken) }, 'erreur imbriquée');
    logger.info({ url: `http://user:${short}@proxy.example/` }, 'proxy');
    logger.info({ connectUrl: `wss://gw.example/playwright?token=${connectToken}` }, 'connexion');
    logger.info({ live: `https://gw.example/live/s1?t=${viewToken}&mode=ro` }, `vue https://gw.example/live/s1?t=${viewToken}`);
    logger.info(`requête refusée, Authorization: Bearer ${apiKey}`);
    logger.info(`clé ${apiKey} révoquée, egress socks5://alice:${short}@10.0.0.1:1080`);
    logger.info({ s: new Secret(proxyPassword) }, 'secret typé');
    logger.info('%s et %o', proxyPassword, { v: connectToken });
    const all = lines.join('\n');
    expect(lines).toHaveLength(12);
    for (const secret of [proxyPassword, JSON.stringify(proxyPassword).slice(1, -1), connectToken, apiKey, `t=${viewToken}`, `:${short}@`, 'sid=zz']) {
      expect(all, secret).not.toContain(secret);
    }
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(all).toContain(REDACTED);
  });
});
