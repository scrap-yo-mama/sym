// SPDX-License-Identifier: AGPL-3.0-only
// Métriques de la passerelle (cdc/sym-browser 04d § 3.1, tâche 3.7), sur PostgreSQL réel : sessions par état et type,
// créations par résultat, longueur et attente de la file, nœuds vivants (battement de moins de 15 s), connexions WSS et
// écart de réconciliation déclarés ; `/metrics` sous `Authorization: Bearer <SYMB_METRICS_TOKEN>`, hors OpenAPI publique.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    maxConcurrentSessions: 50,
    nodes: [
      { id: 'node-a', region: 'frankfurt', slotsTotal: 8 },
      { id: 'node-old', region: 'frankfurt', slotsTotal: 8 },
    ],
    queueTimeoutMs: 10_000,
  });
  // node-old ne bat plus depuis 20 s : vu down par la métrique avant même le balayeur.
  await h.pool.query("UPDATE nodes SET last_beat_at = now() - interval '20 seconds' WHERE id = 'node-old'");
});
afterAll(async () => h.close());

async function metrics(authorization: string | undefined = `Bearer ${h.metricsToken}`): Promise<{ status: number; text: string; type: string | undefined }> {
  const res = await h.app.inject({ method: 'GET', url: '/metrics', headers: authorization === undefined ? {} : { authorization } });
  return { status: res.statusCode, text: res.body, type: res.headers['content-type']?.toString() };
}

function value(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('/metrics de la passerelle', () => {
  test('401 sans le jeton (ni corps de métriques), 200 text/plain avec', async () => {
    for (const header of [undefined, 'Bearer faux', `Bearer ${h.keys.a}`]) {
      const res = await metrics(header);
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('symb_');
    }
    const ok = await metrics();
    expect(ok.status).toBe(200);
    expect(ok.type).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  test('sessions par état et type, créations par résultat, file et attente, nœuds vivants', async () => {
    const created = await h.call({ method: 'POST', url: '/v1/sessions', body: {} });
    expect(created.status).toBe(201);
    const shared = await h.call({ method: 'POST', url: '/v1/sessions', body: { type: 'shared' } });
    expect(shared.status).toBe(201);
    // node-a : 8 unités ; dedicated 4 + shared 3 = 7 → une dedicated de plus attend en file.
    const queued = await h.call({ method: 'POST', url: '/v1/sessions?wait=false', body: {} });
    expect(queued.status).toBe(202);
    const outside = await h.call({ method: 'POST', url: '/v1/sessions', body: { region: 'tokyo' } });
    expect(outside.status).toBe(503);

    let text = (await metrics()).text;
    expect(value(text, 'symb_sessions{state="running",type="dedicated"}')).toBe(1);
    expect(value(text, 'symb_sessions{state="running",type="shared"}')).toBe(1);
    expect(value(text, 'symb_sessions{state="pending",type="dedicated"}')).toBe(1);
    expect(value(text, 'symb_queue_length')).toBe(1);
    expect(value(text, 'symb_sessions_created_total{result="started",type="dedicated"}')).toBe(1);
    expect(value(text, 'symb_sessions_created_total{result="started",type="shared"}')).toBe(1);
    expect(value(text, 'symb_sessions_created_total{result="accepted",type="dedicated"}')).toBe(1);
    expect(value(text, 'symb_sessions_created_total{result="no_node",type="dedicated"}')).toBe(1);
    expect(value(text, 'symb_node_up{node="node-a"}')).toBe(1);
    expect(value(text, 'symb_node_up{node="node-old"}')).toBe(0);
    expect(value(text, 'symb_ws_connections{protocol="cdp"}')).toBe(0);
    expect(value(text, 'symb_usage_drift_seconds')).toBe(0);

    // Libération : la session en file part, son attente est mesurée.
    await h.call({ method: 'DELETE', url: `/v1/sessions/${created.body.id}` });
    for (let i = 0; i < 100 && (await h.call({ method: 'GET', url: `/v1/sessions/${queued.body.id}` })).body.state !== 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    text = (await metrics()).text;
    expect(value(text, 'symb_queue_length')).toBe(0);
    expect(value(text, 'symb_queue_wait_seconds_count')).toBe(1);
    expect(value(text, 'symb_sessions{state="ended",type="dedicated"}')).toBe(1);
  });

  test('refus de quota comptés par résultat ; aucun identifiant de session, de clé ou de client dans les étiquettes', async () => {
    await h.pool.query('UPDATE tenants SET monthly_minutes = 0 WHERE id = $1', [h.tenantA]);
    expect((await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).status).toBe(429);
    await h.pool.query('UPDATE tenants SET monthly_minutes = 600 WHERE id = $1', [h.tenantA]);
    const text = (await metrics()).text;
    expect(value(text, 'symb_sessions_created_total{result="quota_exceeded",type="dedicated"}')).toBe(1);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain(h.keys.a);
    expect(text).not.toContain(h.metricsToken);
  });

  test('/metrics n’entre pas dans l’OpenAPI publiée', async () => {
    const res = await h.call({ method: 'GET', url: '/v1/openapi.json', key: null });
    expect(JSON.stringify(res.body)).not.toContain('/metrics');
  });
});
