import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { pino } from 'pino';
import { describe, expect, test } from 'vitest';
import {
  loggerRedaction,
  redact,
  redactArtifactText,
  REDACTED,
  redactUrl,
  Secret,
  SecretValueRegistry,
} from './redact.js';

const canary = (suffix = '') => `zz_test_canary_${randomBytes(8).toString('hex')}${suffix}`;

describe('couche 1 : Secret', () => {
  test('JSON, String, gabarit, inspect : masqué ; reveal() rend la valeur', () => {
    const value = canary();
    const s = new Secret(value);
    for (const shown of [JSON.stringify({ s }), String(s), `${s}`, inspect(s), inspect({ nested: { s } })]) {
      expect(shown).not.toContain(value);
    }
    expect(s.reveal()).toBe(value);
  });
});

describe('couche 3 : balayage par valeur', () => {
  test('forme brute, échappée JSON, encodée URL, base64 ; la plus longue d’abord', () => {
    const reg = new SecretValueRegistry();
    const value = canary('"p@ss/wörd');
    reg.add(value);
    reg.add(value.slice(0, 20));
    const text = [value, JSON.stringify(value), encodeURIComponent(value), Buffer.from(value).toString('base64')].join(' ');
    const out = reg.redactText(text);
    expect(out).not.toContain(value.slice(0, 20));
    expect(out).not.toContain(Buffer.from(value).toString('base64'));
    expect(out.split(REDACTED).length - 1).toBeGreaterThanOrEqual(4);
  });

  test('valeur courte isolée non balayée (seulement après un délimiteur)', () => {
    const reg = new SecretValueRegistry();
    reg.add('abc');
    expect(reg.redactText('tabcd abc')).toBe('tabcd abc');
  });

  test('redact : copie profonde, cycles, erreurs, URL, Secret ; entrée intacte', () => {
    const reg = new SecretValueRegistry();
    const value = canary();
    reg.add(value);
    const err = new Error(`échec avec ${value}`, { cause: { token: value } });
    const input: Record<string, unknown> = {
      msg: `clé=${value}`,
      list: [value, 1, null, new Secret('autre-secret-xyz')],
      url: new URL(`http://user:${value}@proxy.example:8080/?api_key=${value}`),
      err,
      [value]: 'clé porteuse',
    };
    input.self = input;
    const out = redact(input, reg);
    const shown = inspect(out, { depth: 10 }) + JSON.stringify({ ...out, self: undefined });
    expect(shown).not.toContain(value);
    expect(shown).not.toContain('autre-secret-xyz');
    expect((out as Record<string, unknown>).self).toBe(out);
    expect(input.msg).toBe(`clé=${value}`);
    expect(err.message).toContain(value);
  });

  test('redactUrl : userinfo retiré, paramètres sensibles masqués', () => {
    const reg = new SecretValueRegistry();
    expect(redactUrl('http://u:p4ssword@proxy.example:3128/x?token=abc&page=2', reg)).toBe(
      `http://proxy.example:3128/x?token=${REDACTED}&page=2`,
    );
    expect(redactUrl('pas une url', reg)).toBe('pas une url');
  });

  test('artefact HAR : en-têtes Cookie, Set-Cookie, Authorization masqués', () => {
    const har = JSON.stringify({ headers: [{ name: 'Cookie', value: 'sid=abc' }, { name: 'Accept', value: 'text/html' }] });
    const out = redactArtifactText(har, new SecretValueRegistry());
    expect(out).not.toContain('sid=abc');
    expect(out).toContain('text/html');
  });
});

describe('couches 2 et 3 dans pino', () => {
  function capture(reg: SecretValueRegistry) {
    const lines: string[] = [];
    const logger = pino({ level: 'trace', ...loggerRedaction(reg) }, { write: (s: string) => void lines.push(s) });
    return { logger, lines };
  }

  test('assert_no_secret_in_logs (U1) : canari dans message, objet, chemin explicite, erreur, URL → 0 occurrence', () => {
    const reg = new SecretValueRegistry();
    // Canari contenant des caractères et mots réservés du format de journal.
    const value = canary('"level":60,"msg":"x');
    const short = 'pw1'; // trop court pour le balayage : couvert par le chemin explicite `password`
    reg.add(value);
    const { logger, lines } = capture(reg);
    logger.info(`clé ${value}`);
    logger.info({ data: { note: value } }, 'objet');
    logger.warn({ password: short, headers: { authorization: `Bearer ${value}` } }, 'chemins');
    logger.error(new Error(`échec : ${value}`));
    logger.error({ err: new Error(value) }, 'erreur imbriquée');
    logger.info({ url: `http://user:${short}@proxy.example/` }, 'proxy');
    logger.info({ s: new Secret(value) }, 'secret typé');
    logger.info('%s et %o', value, { v: value });
    const all = lines.join('');
    expect(lines).toHaveLength(8);
    expect(all).not.toContain(value);
    expect(all).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(all).not.toContain(short);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(all).toContain(REDACTED);
  });
});

describe('relecture 0.3a : contournements de la couche 3', () => {
  // Canari réaliste : espace, !, ~, ", :, ' et parenthèses.
  const realistic = () => `${canary()} p@ss!~"x:y'(z)`;

  test('3a : en-tête Basic base64(user:pass), aux trois alignements → masqué', () => {
    const reg = new SecretValueRegistry();
    const value = realistic();
    reg.add(value);
    for (const user of ['us', 'use', 'user']) {
      const header = `Authorization: Basic ${Buffer.from(`${user}:${value}`).toString('base64')}`;
      const out = reg.redactText(header);
      expect(out, `préfixe ${user}`).toContain(REDACTED);
      // Aucune fenêtre de 12 caractères base64 issue de la valeur ne survit.
      const b64 = Buffer.from(`${user}:${value}`).toString('base64');
      expect(out).not.toContain(b64.slice(8, 20));
    }
  });

  test('3b : forme form-urlencoded (espace → +, !\'()~ encodés) → masquée', () => {
    const reg = new SecretValueRegistry();
    const value = realistic();
    reg.add(value);
    const form = new URLSearchParams({ q: value }).toString();
    expect(reg.redactText(`body=${form}`)).not.toContain(form.slice(2));
  });

  test('3c : redactUrl ne re-sérialise pas l’URL ; paramètres sensibles par sous-chaîne', () => {
    const reg = new SecretValueRegistry();
    const value = realistic();
    reg.add(value);
    const url = `http://h.example/x?token=t0k&note=${encodeURIComponent(value)}&x_api_key_v2=abc123&passphrase=def456&page=2`;
    const out = redactUrl(url, reg);
    expect(out).not.toContain(encodeURIComponent(value));
    expect(out).not.toContain(new URLSearchParams({ n: value }).toString().slice(2));
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('def456');
    expect(out).toContain(`token=${REDACTED}`);
    expect(out).toContain('&page=2');
  });

  test('4 : chemins pino en casse mixte et imbriqués (Authorization, config, request, body)', () => {
    const reg = new SecretValueRegistry();
    const lines: string[] = [];
    const logger = pino({ ...loggerRedaction(reg) }, { write: (s: string) => void lines.push(s) });
    logger.info({ headers: { Authorization: 'Bearer hv-auth-1', Cookie: 'sid=hv-cookie-2' } }, 'a');
    logger.info({ config: { headers: { authorization: 'hv-cfg-3' } }, request: { headers: { cookie: 'hv-req-4' } } }, 'b');
    logger.info({ body: { password: 'hv-body-5' }, headers: { 'Set-Cookie': 'hv-set-6' } }, 'c');
    const all = lines.join('');
    for (const v of ['hv-auth-1', 'hv-cookie-2', 'hv-cfg-3', 'hv-req-4', 'hv-body-5', 'hv-set-6']) expect(all).not.toContain(v);
  });

  test('5 : valeur courte masquée après un délimiteur, pas au milieu d’un mot', () => {
    const reg = new SecretValueRegistry();
    reg.add('pw1');
    expect(reg.redactText('password=pw1&x=apw1b')).toBe(`password=${REDACTED}&x=apw1b`);
    expect(reg.redactText('Bearer pw1')).toBe(`Bearer ${REDACTED}`);
    expect(reg.redactText('{"secret":"pw1"}')).toBe(`{"secret":"${REDACTED}"}`);
    expect(reg.redactText('http://u:pw1@h')).toBe(`http://u:${REDACTED}@h`);
  });

  test('6 : un Buffer devient « [Buffer n octets] »', () => {
    expect(redact({ b: Buffer.from('xyz') }, new SecretValueRegistry())).toEqual({ b: '[Buffer 3 octets]' });
  });

  test('7 : HAR — cookies[].value (requête, réponse) et postData.text masqués', () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: { cookies: [{ name: 'sid', value: 'har-cookie-req' }], postData: { mimeType: 'x', text: 'user=a&password=har-post' } },
            response: { cookies: [{ name: 'sid', value: 'har-cookie-res' }], headers: [{ name: 'Accept', value: 'text/html' }] },
          },
        ],
      },
    });
    const out = redactArtifactText(har, new SecretValueRegistry());
    for (const v of ['har-cookie-req', 'har-cookie-res', 'har-post']) expect(out).not.toContain(v);
    expect(out).toContain('text/html');
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
