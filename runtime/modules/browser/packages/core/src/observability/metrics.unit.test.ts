// SPDX-License-Identifier: AGPL-3.0-only
// Métriques Prometheus (cdc/sym-browser 04d § 3.1, tâche 3.7) : registre au format d'exposition texte 0.0.4, préfixe
// `symb_`, cardinalité bornée (étiquettes déclarées, valeurs listées ou au format d'un nœud, jamais un identifiant de
// session, de clé ou de client), métriques du processus, `/metrics` sous `Authorization: Bearer <SYMB_METRICS_TOKEN>`.
// Test nommé metrics_complete (D7) : les 16 métriques de 04d § 3.1, avec leur type et leurs étiquettes.
import { describe, expect, test } from 'vitest';
import { Secret } from '../crypto/redact.js';
import { createBrowserMetrics, METRIC_DEFINITIONS } from './catalog.js';
import { metricsResponse } from './http.js';
import { MetricLabelError, MetricsRegistry, registerProcessMetrics } from './registry.js';

/** Échantillons d'une exposition : `nom{étiquettes}` → valeur. */
function samples(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.lastIndexOf(' ');
    out.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return out;
}

describe('MetricsRegistry : format d’exposition 0.0.4', () => {
  test('compteur, jauge et histogramme : HELP, TYPE, échantillons, étiquettes échappées et triées', async () => {
    const r = new MetricsRegistry();
    const c = r.counter('symb_test_total', 'Compteur de test.', { kind: ['a', 'b'] });
    const g = r.gauge('symb_test_gauge', 'Jauge "de" test.\nSur deux lignes.', {});
    const h = r.histogram('symb_test_seconds', 'Histogramme de test.', { kind: ['a'] }, [0.5, 1, 5]);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    g.set({}, 7.5);
    h.observe({ kind: 'a' }, 0.2);
    h.observe({ kind: 'a' }, 3);
    const text = await r.render();
    expect(text).toContain('# HELP symb_test_total Compteur de test.\n# TYPE symb_test_total counter\nsymb_test_total{kind="a"} 3\n');
    expect(text).toContain('# HELP symb_test_gauge Jauge "de" test.\\nSur deux lignes.\n# TYPE symb_test_gauge gauge\nsymb_test_gauge 7.5\n');
    const s = samples(text);
    expect(s.get('symb_test_seconds_bucket{kind="a",le="0.5"}')).toBe(1);
    expect(s.get('symb_test_seconds_bucket{kind="a",le="1"}')).toBe(1);
    expect(s.get('symb_test_seconds_bucket{kind="a",le="5"}')).toBe(2);
    expect(s.get('symb_test_seconds_bucket{kind="a",le="+Inf"}')).toBe(2);
    expect(s.get('symb_test_seconds_sum{kind="a"}')).toBeCloseTo(3.2);
    expect(s.get('symb_test_seconds_count{kind="a"}')).toBe(2);
    expect(text.endsWith('\n')).toBe(true);
  });

  test('séries listées présentes à 0 dès la déclaration (valeurs énumérées) ; compteur jamais décrémenté', async () => {
    const r = new MetricsRegistry();
    const c = r.counter('symb_zero_total', 'Zéro.', { kind: ['a', 'b'] });
    const s = samples(await r.render());
    expect(s.get('symb_zero_total{kind="a"}')).toBe(0);
    expect(s.get('symb_zero_total{kind="b"}')).toBe(0);
    expect(() => c.inc({ kind: 'a' }, -1)).toThrow(RangeError);
  });

  test('cardinalité bornée : étiquette non déclarée, valeur hors liste, identifiant (UUID, clé) refusés', () => {
    const r = new MetricsRegistry();
    const c = r.counter('symb_card_total', 'Cardinalité.', { kind: ['a'] });
    const g = r.gauge('symb_card_nodes', 'Nœuds.', { node: 'node' });
    expect(() => c.inc({ kind: 'z' })).toThrow(MetricLabelError);
    expect(() => c.inc({ kind: 'a', sessionId: 'x' } as never)).toThrow(MetricLabelError);
    expect(() => c.inc({} as never)).toThrow(MetricLabelError);
    for (const value of ['3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13', 'symb_abcdefghijklmnopqrstuvwxyz012345', 'a b', '', 'x'.repeat(64)]) {
      expect(() => g.set({ node: value }, 1), value).toThrow(MetricLabelError);
    }
    g.set({ node: 'node-a.internal_1' }, 1);
    expect(() => r.counter('symb_card_total', 'Doublon.', {})).toThrow(/déjà/);
    expect(() => r.counter('autre_total', 'Sans préfixe.', {})).toThrow(/symb_/);
  });

  test('collecteurs appelés à chaque rendu ; un collecteur en échec n’empêche pas les autres', async () => {
    const r = new MetricsRegistry();
    const g = r.gauge('symb_collected', 'Collectée.', {});
    let n = 0;
    r.onCollect(() => g.set({}, ++n));
    r.onCollect(() => {
      throw new Error('collecteur cassé');
    });
    expect(samples(await r.render()).get('symb_collected')).toBe(1);
    expect(samples(await r.render()).get('symb_collected')).toBe(2);
  });

  test('métriques du processus (équivalent de collectDefaultMetrics) : mémoire, CPU, tas, démarrage', async () => {
    const r = new MetricsRegistry();
    registerProcessMetrics(r);
    const s = samples(await r.render());
    for (const name of ['process_resident_memory_bytes', 'process_cpu_seconds_total', 'process_start_time_seconds', 'nodejs_heap_size_used_bytes', 'nodejs_heap_size_total_bytes']) {
      expect(s.get(name), name).toBeGreaterThan(0);
    }
  });
});

/** 04d § 3.1 : nom, type, étiquettes, source. */
const SPEC: [string, 'counter' | 'gauge' | 'histogram', string[], ('node' | 'gateway')[]][] = [
  ['symb_sessions', 'gauge', ['state', 'type'], ['node', 'gateway']],
  ['symb_sessions_created_total', 'counter', ['type', 'result'], ['gateway']],
  ['symb_slots_total', 'gauge', ['node'], ['node']],
  ['symb_slots_free', 'gauge', ['node'], ['node']],
  ['symb_queue_length', 'gauge', [], ['gateway']],
  ['symb_queue_wait_seconds', 'histogram', [], ['gateway']],
  ['symb_session_start_seconds', 'histogram', ['type'], ['node']],
  ['symb_session_duration_seconds', 'histogram', ['type', 'reason'], ['node']],
  ['symb_browser_rss_bytes', 'gauge', ['node', 'kind'], ['node']],
  ['symb_recycles_total', 'counter', ['reason'], ['node']],
  ['symb_egress_bytes_total', 'counter', ['direction'], ['node']],
  ['symb_egress_blocked_total', 'counter', ['reason'], ['node']],
  ['symb_ws_connections', 'gauge', ['protocol'], ['gateway']],
  ['symb_recordings_total', 'counter', ['type'], ['node']],
  ['symb_usage_drift_seconds', 'gauge', [], ['gateway']],
  ['symb_node_up', 'gauge', ['node'], ['gateway']],
];

describe('metrics_complete (D7) : les 16 métriques de 04d § 3.1', () => {
  test('catalogue identique à la spécification (nom, type, étiquettes, source)', () => {
    expect(METRIC_DEFINITIONS.map((d) => [d.name, d.type, Object.keys(d.labels), [...d.sources]])).toEqual(SPEC);
  });

  test('valeurs d’étiquettes listées de la spec : recyclages, sens, type de navigateur, protocole', () => {
    const labels = (name: string) => METRIC_DEFINITIONS.find((d) => d.name === name)!.labels;
    expect(labels('symb_recycles_total').reason).toEqual(['runs', 'age', 'memory', 'disconnected', 'close_timeout', 'shutdown', 'dedicated']);
    expect(labels('symb_egress_bytes_total').direction).toEqual(['in', 'out']);
    expect(labels('symb_browser_rss_bytes').kind).toEqual(['shared', 'dedicated']);
    expect(labels('symb_ws_connections').protocol).toEqual(['playwright', 'cdp', 'live']);
  });

  test('nœud et passerelle : chacun expose ses métriques ; ensemble, les 16 sont présentes (mode all : toutes)', async () => {
    const exposed = async (role: 'node' | 'gateway' | 'all') => {
      const r = new MetricsRegistry();
      const m = createBrowserMetrics(r, role, { nodeId: 'node-a' });
      // Une observation par histogramme pour que ses séries existent.
      m.queueWaitSeconds.observe({}, 1);
      m.sessionStartSeconds.observe({ type: 'dedicated' }, 1);
      m.sessionDurationSeconds.observe({ type: 'shared', reason: 'released' }, 30);
      m.slotsTotal.set({ node: 'node-a' }, 4);
      m.slotsFree.set({ node: 'node-a' }, 3);
      m.browserRssBytes.set({ node: 'node-a', kind: 'dedicated' }, 1);
      m.nodeUp.set({ node: 'node-a' }, 1);
      const text = await r.render();
      return SPEC.filter(([name]) => text.includes(`# TYPE ${name} `)).map(([name]) => name);
    };
    const node = await exposed('node');
    const gateway = await exposed('gateway');
    expect(node).toEqual(SPEC.filter(([, , , s]) => s.includes('node')).map(([n]) => n));
    expect(gateway).toEqual(SPEC.filter(([, , , s]) => s.includes('gateway')).map(([n]) => n));
    expect(new Set([...node, ...gateway]).size).toBe(16);
    expect(await exposed('all')).toHaveLength(16);
  });

  test('aucun identifiant de session, de clé ni de client dans les étiquettes', async () => {
    const r = new MetricsRegistry();
    const m = createBrowserMetrics(r, 'all', { nodeId: 'node-a' });
    expect(() => m.slotsFree.set({ node: '3f2b6c1e-8d4a-4f7b-9a1c-2e5d7f9b0c13' }, 1)).toThrow(MetricLabelError);
    m.sessionsCreated.inc({ type: 'dedicated', result: 'started' });
    const text = await r.render();
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toMatch(/sessionId|tenantId|apiKey/);
  });
});

describe('/metrics protégé par SYMB_METRICS_TOKEN (04d § 3.1)', () => {
  const token = new Secret('zz_test_metrics_token_0123456789abcdef');
  const registry = new MetricsRegistry();
  createBrowserMetrics(registry, 'gateway');

  test('jeton exact : 200, text/plain version 0.0.4, sans cache', async () => {
    const res = await metricsResponse(registry, token, `Bearer ${token.reveal()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('# TYPE symb_queue_length gauge');
  });

  test.each([undefined, '', 'Bearer', 'Bearer x', `Basic ${token.reveal()}`, `Bearer ${token.reveal()}x`, `bearer  ${token.reveal().slice(1)}`])('refus 401 sans corps de métriques (%s)', async (header) => {
    const res = await metricsResponse(registry, token, header);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).not.toContain('symb_');
  });

  test('aucun jeton configuré : /metrics fermé (401), jamais ouvert par défaut', async () => {
    expect((await metricsResponse(registry, null, 'Bearer ')).status).toBe(401);
    expect((await metricsResponse(registry, null, undefined)).status).toBe(401);
  });
});
