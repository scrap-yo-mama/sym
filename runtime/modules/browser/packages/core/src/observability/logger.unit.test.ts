// SPDX-License-Identifier: AGPL-3.0-only
// Journaux pino structurés et masqués (cdc/sym-browser 04d § 3.2, tâche 3.7) : JSON sur la sortie, une ligne par
// événement, champs `time`, `level`, `msg`, `requestId`, `sessionId`, `tenantId`, `nodeId`, `event` ; seuil
// `SYMB_LOG_LEVEL`. Partie 3.7 de assert_secrets_protected (BINV6, D8) : journaux d'une session avec proxy authentifié,
// jeton de vue et clé d'API → 0 mot de passe, 0 jeton, 0 clé en clair, par les trois couches de masquage (0.3).
import { describe, expect, test } from 'vitest';
import { REDACTED, Secret, SecretValueRegistry } from '../crypto/redact.js';
import { createLogger } from '../service/service.js';
import { createPinoLogger } from './logger.js';

const PROXY_PASSWORD = 'zz_test_proxy_pass_31a';
const VIEW_TOKEN = 'zz_test_view_token_7d1c0aa9';
const API_KEY = 'symb_zz_test_key_4c9e1f0b2a7d6e5c';
const CONNECT_TOKEN = 'zz_test_connect_token_9e8f';
const COOKIE = 'sid=zz_test_cookie_5f1';

function capture(options: Parameters<typeof createPinoLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = createPinoLogger({ level: 'info', ...options, destination: { write: (line: string) => void lines.push(line) } });
  return { logger, lines, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('journaux pino structurés', () => {
  test('JSON une ligne par événement : time ISO, level en clair, msg, champs de corrélation', () => {
    const { logger, records, lines } = capture({ base: { nodeId: 'node-a' } });
    logger.info({ requestId: 'req_1', sessionId: 's-1', tenantId: 't-1', event: 'session.started' }, 'session démarrée');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const [record] = records();
    expect(record).toMatchObject({ level: 'info', msg: 'session démarrée', requestId: 'req_1', sessionId: 's-1', tenantId: 't-1', nodeId: 'node-a', event: 'session.started' });
    expect(new Date(record!.time as string).toISOString()).toBe(record!.time);
    expect(record).not.toHaveProperty('pid');
    expect(record).not.toHaveProperty('hostname');
  });

  test('seuil SYMB_LOG_LEVEL : sous le seuil, rien ; warn pour l’egress, error pour un plantage', () => {
    const { logger, records } = capture({ level: 'warn' });
    logger.info({ event: 'session.started' }, 'ignoré');
    logger.warn({ event: 'egress.blocked' }, 'refus de l’egress');
    logger.error({ event: 'session.crash', err: new Error('Chromium arrêté') }, 'plantage');
    expect(records().map((r) => [r.level, r.event])).toEqual([
      ['warn', 'egress.blocked'],
      ['error', 'session.crash'],
    ]);
    expect((records()[1]!.err as { message: string }).message).toBe('Chromium arrêté');
  });

  test('createLogger (hôte de service) écrit par pino : mêmes champs, même seuil', () => {
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line));
    log('debug', 'ignoré');
    log('info', 'listening', { mode: 'node', port: 8080 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'listening', mode: 'node', port: 8080 });
  });
});

describe('assert_secrets_protected (3.7, D8) : 0 mot de passe, 0 jeton, 0 clé d’API dans les journaux', () => {
  test('journal d’une session avec proxy authentifié, jeton de vue, clé d’API, cookie : rien en clair', () => {
    const registry = new SecretValueRegistry();
    registry.add(PROXY_PASSWORD);
    const { logger, lines } = capture({ registry, apiKeyPrefixes: ['symb_'] });
    // Couche 1 : Secret ; couche 2 : chemins et sérialiseurs ; couche 3 : valeurs connues et motifs.
    logger.info({ event: 'session.created', proxy: { host: 'proxy.test', username: 'u', password: PROXY_PASSWORD } }, 'session créée');
    logger.info({ event: 'egress.upstream', proxyUrl: `http://u:${PROXY_PASSWORD}@proxy.test:3128` }, 'proxy amont');
    logger.info({ event: 'live.url', url: `https://b.example.com/live/s-1?t=${VIEW_TOKEN}&w=1` }, 'vue en direct');
    logger.info({ event: 'connect', connectUrl: `wss://b.example.com/v1/sessions/s-1/cdp?token=${CONNECT_TOKEN}` }, 'connexion');
    logger.info({ event: 'request', headers: { authorization: `Bearer ${API_KEY}`, cookie: COOKIE, 'x-request-id': 'req_9' } }, 'requête');
    logger.info({ event: 'auth', token: new Secret(API_KEY) }, `clé reçue ${API_KEY} pour Bearer ${CONNECT_TOKEN}`);
    logger.warn({ event: 'egress.blocked', detail: `échec vers http://u:${PROXY_PASSWORD}@proxy.test` }, `mot de passe ${PROXY_PASSWORD}`);
    logger.error({ event: 'session.crash', err: new Error(`proxy refusé : ${PROXY_PASSWORD} (url ?token=${CONNECT_TOKEN})`) }, 'plantage');
    const all = lines.join('');
    for (const secret of [PROXY_PASSWORD, VIEW_TOKEN, API_KEY, CONNECT_TOKEN, 'zz_test_cookie_5f1']) expect(all, secret).not.toContain(secret);
    expect(all).toContain(REDACTED);
    // Le reste reste lisible et chaque ligne reste un JSON valide.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(all).toContain('proxy.test');
    expect(all).toContain('req_9');
    expect(all).toContain('w=1');
  });

  test('createLogger de l’hôte de service : masquage identique (le message est aussi filtré)', () => {
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line));
    log('info', `démarrage, Authorization: Bearer ${API_KEY}`, { url: `https://x.test/?token=${CONNECT_TOKEN}`, password: PROXY_PASSWORD });
    const all = lines.join('');
    for (const secret of [API_KEY, CONNECT_TOKEN, PROXY_PASSWORD]) expect(all, secret).not.toContain(secret);
  });
});
