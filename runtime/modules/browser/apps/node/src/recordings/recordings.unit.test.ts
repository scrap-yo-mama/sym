// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 3.3 (04d § 2, 04f § 5) : briques des enregistrements côté nœud, sans navigateur. Options, ffmpeg de Playwright,
// zip (trace), masquage des journaux et du HAR, HAR 1.2 valide, coffre (ObjectStore chiffré, liste, flux, suppression,
// purge à l'horloge de test), plafond par enregistrement.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskBlobStore, MasterKey, ObjectStore } from '@sym-browser/core';
import { describe, expect, test } from 'vitest';
import { InvalidSessionOptionError } from '../sessions/options.js';
import {
  HarBuilder,
  LimitedLog,
  RecordingNotFoundError,
  RecordingVault,
  consoleLine,
  ffmpegPath,
  networkLine,
  readZip,
  recordingOptions,
  sanitizeTraceZip,
  validateHar,
  writeZip,
  type RecordingEvent,
} from './index.js';

const DAY = 24 * 3_600_000;
const SECRET = 'zz_test_secret_value_1234567890';

describe('options recordings (04d § 2.1)', () => {
  test('booléens, tous faux par défaut ; champ inconnu ou non booléen : 422 invalid_option nommé', () => {
    expect(recordingOptions(undefined)).toEqual({ trace: false, har: false, video: false, console: false, network: false });
    expect(recordingOptions({ trace: true, video: true })).toEqual({ trace: true, har: false, video: true, console: false, network: false });
    for (const bad of [{ video: 'oui' }, { screenshots: true }, 'all', [true]]) {
      expect(() => recordingOptions(bad as never)).toThrow(InvalidSessionOptionError);
    }
    try {
      recordingOptions({ har: 1 } as never);
    } catch (error) {
      expect((error as InvalidSessionOptionError).details).toEqual([{ field: 'recordings.har', reason: 'booléen attendu' }]);
    }
  });
});

describe('ffmpeg de Playwright (encodage webm des screencasts)', () => {
  test('révision lue dans browsers.json de playwright-core, sous PLAYWRIGHT_BROWSERS_PATH ou le cache par défaut', () => {
    expect(ffmpegPath({ PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' }, { platform: 'linux' })).toMatch(/^\/ms-playwright\/ffmpeg-\d+\/ffmpeg-linux$/);
    expect(ffmpegPath({ HOME: '/home/pwuser' }, { platform: 'linux' })).toMatch(/^\/home\/pwuser\/\.cache\/ms-playwright\/ffmpeg-\d+\/ffmpeg-linux$/);
  });
});

describe('zip et trace', () => {
  test('aller-retour : noms et contenus conservés, archive lisible', () => {
    const entries: [string, Buffer][] = [['trace.trace', Buffer.from('{"a":1}\n'.repeat(100))], ['resources/x.png', Buffer.from([0, 1, 2, 255])]];
    const zip = writeZip(entries);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    const read = readZip(zip);
    expect([...read.keys()]).toEqual(['trace.trace', 'resources/x.png']);
    expect(read.get('resources/x.png')).toEqual(entries[1]![1]);
    expect(read.get('trace.trace')!.toString()).toBe(entries[0]![1].toString());
  });

  test('sanitizeTraceZip : en-têtes sensibles et paramètres sensibles masqués dans le réseau et les actions de la trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symb-trace-'));
    const network = JSON.stringify({ type: 'resource-snapshot', snapshot: { request: { url: `https://zz.invalid/a?token=${SECRET}&q=1`, headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }, { name: 'Accept', value: '*/*' }] }, response: { headers: [{ name: 'Set-Cookie', value: `sid=${SECRET}` }] } } });
    const path = join(dir, 'trace.zip');
    writeFileSync(path, writeZip([['trace.network', Buffer.from(`${network}\n`)], ['trace.trace', Buffer.from(`${JSON.stringify({ type: 'log', message: `Authorization: Bearer ${SECRET}` })}\n`)], ['resources/r.png', Buffer.from(SECRET)]]));
    sanitizeTraceZip(path);
    const after = readZip(readFileSync(path));
    expect(after.get('trace.network')!.toString()).not.toContain(SECRET);
    expect(after.get('trace.network')!.toString()).toContain('"Accept"');
    expect(after.get('trace.network')!.toString()).toContain('q=1');
    expect(after.get('trace.trace')!.toString()).not.toContain(SECRET);
    // Les ressources binaires (captures) ne sont pas réécrites.
    expect(after.get('resources/r.png')!.toString()).toBe(SECRET);
  });
});

describe('journaux console et réseau (04d § 2.1 : masquage)', () => {
  test('console : type, texte masqué (Bearer, paramètres sensibles), URL sans query', () => {
    const line = JSON.parse(consoleLine({ ts: 1, type: 'log', text: `jeton Bearer ${SECRET} et https://zz.invalid/?api_key=${SECRET}`, url: `https://zz.invalid/p?session=${SECRET}` }));
    expect(line).toMatchObject({ ts: 1, type: 'log', url: 'https://zz.invalid/p' });
    expect(JSON.stringify(line)).not.toContain(SECRET);
  });

  test('réseau : méthode, URL sans query, statut, durée, octets ; échec nommé', () => {
    expect(JSON.parse(networkLine({ ts: 2, method: 'GET', url: `https://u:p@zz.invalid/a/b?token=${SECRET}#f`, status: 200, durationMs: 12.6, bytes: 345 }))).toEqual({ ts: 2, method: 'GET', url: 'https://zz.invalid/a/b', status: 200, durationMs: 13, bytes: 345 });
    expect(JSON.parse(networkLine({ ts: 3, method: 'POST', url: 'https://zz.invalid/x', status: 0, durationMs: 1, bytes: 0, failure: 'net::ERR_TUNNEL_CONNECTION_FAILED' }))).toMatchObject({ status: 0, failure: 'net::ERR_TUNNEL_CONNECTION_FAILED' });
  });

  test('plafond par enregistrement : écriture arrêtée au franchissement, troncature signalée une fois', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symb-log-'));
    const log = new LimitedLog(join(dir, 'console.ndjson'), 50);
    expect(log.write('a'.repeat(30))).toBe(true);
    expect(log.write('b'.repeat(30))).toBe(false);
    expect(log.write('c')).toBe(false);
    log.close();
    expect(log.truncated).toBe(true);
    expect(readFileSync(join(dir, 'console.ndjson'), 'utf8')).toBe(`${'a'.repeat(30)}\n`);
  });
});

describe('HAR 1.2 construit par le nœud (04d § 2.1, 04f § 5)', () => {
  test('entrées valides, en-têtes sensibles et paramètres sensibles masqués', () => {
    const har = new HarBuilder({ name: 'SYM Browser', version: '0.0.0' });
    har.add({
      startedAt: new Date('2026-10-02T10:00:00Z'),
      method: 'GET',
      url: `https://zz.invalid/a?token=${SECRET}&q=1`,
      requestHeaders: { authorization: `Bearer ${SECRET}`, accept: '*/*', cookie: `sid=${SECRET}` },
      status: 200,
      statusText: 'OK',
      responseHeaders: { 'content-type': 'text/html', 'set-cookie': `sid=${SECRET}` },
      mimeType: 'text/html',
      bodySize: 120,
      timings: { send: 1, wait: 20, receive: 3 },
    });
    har.add({ startedAt: new Date('2026-10-02T10:00:01Z'), method: 'GET', url: 'https://zz.invalid/fail', requestHeaders: {}, status: 0, statusText: '', responseHeaders: {}, mimeType: '', bodySize: 0, timings: { send: 0, wait: 0, receive: 0 }, failure: 'net::ERR_FAILED' });
    const text = har.serialize();
    expect(text).not.toContain(SECRET);
    const parsed = JSON.parse(text) as { log: { entries: { request: { queryString: { name: string; value: string }[] }; time: number }[] } };
    expect(validateHar(parsed)).toEqual([]);
    expect(parsed.log.entries).toHaveLength(2);
    expect(parsed.log.entries[0]!.time).toBe(24);
    expect(parsed.log.entries[0]!.request.queryString).toContainEqual({ name: 'q', value: '1' });
  });

  test('validateHar signale les champs manquants', () => {
    expect(validateHar({})).toContain('log absent');
    expect(validateHar({ log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [{ startedDateTime: 'x' }] } }).length).toBeGreaterThan(0);
  });
});

describe('coffre des enregistrements (ObjectStore chiffré, 04d § 2.1 et § 2.2)', () => {
  async function setup(options: { retention?: { video: number } } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'symb-vault-'));
    let now = new Date();
    const store = new ObjectStore({ blobs: new DiskBlobStore(join(root, 'objects')), master: MasterKey.generate(), kekVersion: 1, now: () => now });
    const events: RecordingEvent[] = [];
    const vault = new RecordingVault({ store, now: () => now, onEvent: (e) => events.push(e), ...(options.retention ? { retention: options.retention } : {}) });
    const file = join(root, 'console.ndjson');
    writeFileSync(file, `${JSON.stringify({ text: 'bonjour' })}\n`);
    return { root, store, vault, events, file, setNow: (d: Date) => (now = d), getNow: () => now };
  }

  test('dépôt : objet chiffré (illisible sans la clé), fichier local supprimé, recording.ready ; liste, flux déchiffré, suppression', async () => {
    const { root, store, vault, events, file } = await setup();
    const info = await vault.deposit({ sessionId: 's1', tenantId: 'tenant-a', type: 'console', path: file, name: 'console.ndjson' });
    expect(info).toMatchObject({ type: 'console', name: 'console.ndjson', size: 19 });
    expect(() => readFileSync(file)).toThrow();
    const [object] = await store.list('artifacts/console/');
    expect(object!.key).toBe(`artifacts/console/tenant-a/s1/${info.id}`);
    expect(readFileSync(join(root, 'objects', ...object!.key.split('/'))).toString()).not.toContain('bonjour');
    expect(events).toEqual([{ type: 'recording.ready', sessionId: 's1', recordingId: info.id, recordingType: 'console', size: 19, expiresAt: info.expiresAt.toISOString() }]);
    expect(await vault.list('s1')).toEqual([info]);
    const { stream } = await vault.open('s1', info.id);
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(part as Buffer);
    expect(Buffer.concat(parts).toString()).toContain('bonjour');
    await expect(vault.open('s2', info.id)).rejects.toThrow(RecordingNotFoundError);
    await vault.delete('s1', info.id);
    expect(await vault.list('s1')).toEqual([]);
    expect(await store.list('artifacts/')).toEqual([]);
  });

  test('rétention par type (journaux et trace 7 j) puis purge à l’horloge de test : objets et entrées retirés, et seulement eux', async () => {
    const { vault, store, file, root, setNow, getNow } = await setup({ retention: { video: 30 * DAY } });
    const t0 = getNow();
    const kept = join(root, 'video.webm');
    writeFileSync(kept, 'webm');
    const log = await vault.deposit({ sessionId: 's1', tenantId: 'tenant-a', type: 'console', path: file, name: 'console.ndjson' });
    expect(log.expiresAt.getTime()).toBe(t0.getTime() + 7 * DAY);
    const video = await vault.deposit({ sessionId: 's1', tenantId: 'tenant-a', type: 'video', path: kept, name: 'video-1.webm' });
    setNow(new Date(t0.getTime() + 7 * DAY + 60_000));
    const purged = await vault.purgeExpired();
    expect(purged.deleted).toEqual([`artifacts/console/tenant-a/s1/${log.id}`]);
    expect((await vault.list('s1')).map((r) => r.id)).toEqual([video.id]);
    expect((await store.list('artifacts/')).map((o) => o.key)).toEqual([`artifacts/video/tenant-a/s1/${video.id}`]);
  });

  test('enregistrement tronqué : recording.truncated {type} puis recording.ready', async () => {
    const { vault, events, file } = await setup();
    await vault.deposit({ sessionId: 's1', tenantId: 'tenant-a', type: 'network', path: file, name: 'network.ndjson', truncated: true });
    expect(events.map((e) => e.type)).toEqual(['recording.truncated', 'recording.ready']);
    expect(events[0]).toEqual({ type: 'recording.truncated', sessionId: 's1', recordingType: 'network' });
  });
});
