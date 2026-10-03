// SPDX-License-Identifier: AGPL-3.0-only
// `/metrics` de l'hôte de service (cdc/sym-browser 04d § 3.1, tâche 3.7) : chaque rôle expose ses métriques et celles
// du processus ; accès par `Authorization: Bearer <SYMB_METRICS_TOKEN>`, fermé sans jeton configuré ; jamais de jeton
// dans un journal.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig, startService, type ServiceHandle } from '../index.js';

const TOKEN = 'zz_test_metrics_token_0123456789abcdef';
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  MASTER_KEY: randomBytes(32).toString('base64'),
  DATABASE_URL: 'postgres://symb:secret@db.invalid:5432/symb',
  PORT: '0',
  ...extra,
});

const running: ServiceHandle[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.close()));
});

async function start(extra: Record<string, string>, lines: string[] = []): Promise<ServiceHandle> {
  const service = await startService(loadConfig(env(extra)), { log: (level, msg, fields) => lines.push(JSON.stringify({ level, msg, ...fields })) });
  running.push(service);
  return service;
}

const scrape = (service: ServiceHandle, authorization?: string) =>
  fetch(`http://127.0.0.1:${service.port}/metrics`, authorization === undefined ? {} : { headers: { authorization } });

describe('/metrics de l’hôte de service', () => {
  test.each([
    ['node', { SYMB_MODE: 'node', NODE_TOKEN: 'n'.repeat(32), NODE_PUBLIC_URL: 'http://node-1.internal:3000', NODE_ID: 'node-1' }, 'symb_slots_free', 'symb_queue_length'],
    ['gateway', { SYMB_MODE: 'gateway', NODE_TOKEN: 'n'.repeat(32) }, 'symb_queue_length', 'symb_slots_free'],
  ] as const)('mode %s : 200 avec le jeton, métriques du rôle et du processus', async (_mode, extra, present, absent) => {
    const service = await start({ ...extra, SYMB_METRICS_TOKEN: TOKEN });
    const res = await scrape(service, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await res.text();
    expect(text).toContain(`# TYPE ${present} `);
    expect(text).not.toContain(`# TYPE ${absent} `);
    expect(text).toContain('# TYPE process_resident_memory_bytes gauge');
  });

  test('mode all : les 16 métriques symb_ servies par un seul processus', async () => {
    const service = await start({ SYMB_METRICS_TOKEN: TOKEN });
    const text = await (await scrape(service, `Bearer ${TOKEN}`)).text();
    expect(text.match(/^# TYPE symb_\S+ /gm)).toHaveLength(16);
  });

  test('sans jeton, jeton faux, ou aucun jeton configuré : 401, et le jeton n’apparaît dans aucun journal', async () => {
    const lines: string[] = [];
    const service = await start({ SYMB_METRICS_TOKEN: TOKEN }, lines);
    expect((await scrape(service)).status).toBe(401);
    expect((await scrape(service, 'Bearer faux')).status).toBe(401);
    const closed = await start({});
    expect((await scrape(closed, `Bearer ${TOKEN}`)).status).toBe(401);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
