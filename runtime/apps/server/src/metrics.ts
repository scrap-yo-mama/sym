// SPDX-License-Identifier: AGPL-3.0-only
// `/metrics` (14 § 3) : texte Prometheus (format d'exposition 0.0.4), préfixe `scrapyomama_`, étiquettes bornées (jamais
// run_id, api_id, domaine, URL ni message d'erreur). Le `server` calcule les mesures partagées DEPUIS LA BASE à chaque
// scrape ; le worker n'a pas de port : ses mesures passent par `worker_heartbeats`. Les métriques restent locales (INV9) :
// aucune poussée, le scrape est à l'initiative de l'admin.
//
// Écrit à la main, sans prom-client : prom-client 15 fait `require('@opentelemetry/api')` à son chargement, ce qui
// chargerait l'API OTel dans tout `server`, même OTel coupé (assert_otel_off_by_default). Aucune métrique « par défaut »
// n'expose de version (ni Node, ni dépendance) : seules des mesures de processus sans identité sont publiées.
import { createHash } from 'node:crypto';
import { secretValues } from '@runtime/core';
import { listWorkers, queueDepth } from '@runtime/db';
import type pg from 'pg';

const PREFIX = 'scrapyomama_';
const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Métriques (ou étiquettes) de 14 § 3 sans source de données à ce stade : reportées vers la tâche qui la produira.
 * Le test « 14 § 3 » exige que toute métrique clé soit exposée ou listée ici, et qu'une entrée d'ici ne soit pas exposée.
 */
export const DEFERRED_METRICS: readonly { metric: string; labels?: readonly string[]; task: string; reason: string }[] = [
  { metric: 'llm_requests_total', task: '2.1', reason: 'aucun appel LLM n’est encore persisté par rôle (les rôles arrivent avec l’enquête)' },
  { metric: 'llm_tokens_total', labels: ['role'], task: '2.1', reason: 'jetons connus par run (runs.tokens_*), pas encore par rôle' },
  { metric: 'browser_crashes_total', task: '1.6', reason: 'Chromium arrive avec les exécuteurs E2/E3 (battement à étendre)' },
  { metric: 'sandbox_violations_total', task: '1.5', reason: 'violations relevées par le bac à sable (à remonter par le battement ou run_logs)' },
  { metric: 'tunnel_connected', task: '2.7', reason: 'passerelle tunnel WSS' },
];

/** Bornes de l'histogramme des durées de run, en secondes. */
const DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800] as const;

/** Identifiant de worker opaque : `worker_id` contient le nom d'hôte, qui ne sort jamais (14 § 3). */
export const opaqueWorkerId = (workerId: string): string => createHash('sha256').update(workerId).digest('hex').slice(0, 10);

type Labels = Record<string, string>;
type Sample = { labels?: Labels; value: number; suffix?: '_bucket' | '_sum' | '_count' };
type Family = { name: string; help: string; type: 'counter' | 'gauge' | 'histogram'; samples: Sample[] };

export type MetricsCollector = { contentType: string; collect(): Promise<Family[]> };

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const formatValue = (v: number) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : String(v));

function renderFamily(f: Family): string {
  const name = `${PREFIX}${f.name}`;
  const lines = [`# HELP ${name} ${escapeHelp(f.help)}`, `# TYPE ${name} ${f.type}`];
  for (const s of f.samples) {
    const labels = Object.entries(s.labels ?? {});
    const text = labels.length > 0 ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
    lines.push(`${name}${s.suffix ?? ''}${text} ${formatValue(s.value)}`);
  }
  return lines.join('\n');
}

type Rows<T> = { rows: T[] };
type DurationRow = { execution: string; network: string; n: number; sum: number } & Record<`b${number}`, number>;

function processFamilies(): Family[] {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return [
    { name: 'process_cpu_user_seconds_total', help: 'Temps CPU utilisateur du processus server.', type: 'counter', samples: [{ value: cpu.user / 1e6 }] },
    { name: 'process_cpu_system_seconds_total', help: 'Temps CPU système du processus server.', type: 'counter', samples: [{ value: cpu.system / 1e6 }] },
    { name: 'process_resident_memory_bytes', help: 'Mémoire résidente du processus server.', type: 'gauge', samples: [{ value: memory.rss }] },
    { name: 'process_heap_used_bytes', help: 'Tas JavaScript utilisé par le processus server.', type: 'gauge', samples: [{ value: memory.heapUsed }] },
    {
      name: 'process_start_time_seconds',
      help: 'Démarrage du processus server (secondes depuis l’époque Unix).',
      type: 'gauge',
      samples: [{ value: Math.round(Date.now() / 1000 - process.uptime()) }],
    },
  ];
}

export function createMetricsRegistry(pool: Pick<pg.Pool, 'query'>): MetricsCollector {
  const bucketColumns = DURATION_BUCKETS.map((b, i) => `count(*) FILTER (WHERE r.duration_ms <= ${b * 1000})::float8 AS b${i}`).join(', ');
  return {
    contentType: METRICS_CONTENT_TYPE,
    async collect() {
      const [byState, cost, tokens, failures, apis, transitions, durations, workers, depth] = await Promise.all([
        pool.query("SELECT state, coalesce(outcome, 'none') AS outcome, trigger, count(*)::float8 AS n FROM runs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3") as Promise<
          Rows<{ state: string; outcome: string; trigger: string; n: number }>
        >,
        pool.query('SELECT coalesce(sum(cost_llm_usd), 0)::float8 AS llm, coalesce(sum(cost_proxy_usd), 0)::float8 AS proxy FROM runs') as Promise<Rows<{ llm: number; proxy: number }>>,
        pool.query(
          'SELECT coalesce(sum(tokens_in), 0)::float8 AS "in", coalesce(sum(tokens_cached), 0)::float8 AS cached, coalesce(sum(tokens_out), 0)::float8 AS "out", coalesce(sum(tokens_reasoning), 0)::float8 AS reasoning FROM runs',
        ) as Promise<Rows<Record<'in' | 'cached' | 'out' | 'reasoning', number>>>,
        pool.query('SELECT failure_class, count(*)::float8 AS n FROM runs WHERE failure_class IS NOT NULL GROUP BY 1 ORDER BY 1') as Promise<Rows<{ failure_class: string; n: number }>>,
        pool.query('SELECT status, count(*)::float8 AS n FROM apis GROUP BY 1 ORDER BY 1') as Promise<Rows<{ status: string; n: number }>>,
        pool.query('SELECT coalesce(from_status, \'none\') AS "from", to_status AS "to", count(*)::float8 AS n FROM status_events GROUP BY 1, 2 ORDER BY 1, 2') as Promise<
          Rows<{ from: string; to: string; n: number }>
        >,
        // Durée des runs terminés par couple (exécution, réseau) de la version de stratégie utilisée.
        pool.query(
          `SELECT coalesce(sv.execution, 'none') AS execution, coalesce(sv.network, 'none') AS network, count(*)::float8 AS n,
                  (sum(r.duration_ms) / 1000.0)::float8 AS sum, ${bucketColumns}
           FROM runs r LEFT JOIN strategy_versions sv ON sv.api_id = r.api_id AND sv.version = r.strategy_version
           WHERE r.duration_ms IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`,
        ) as Promise<Rows<DurationRow>>,
        listWorkers(pool),
        queueDepth(pool),
      ]);
      const alive = workers.filter((w) => w.alive);
      const t = tokens.rows[0];
      return [
        {
          name: 'runs_total',
          help: 'Runs par état, issue et déclencheur.',
          type: 'counter',
          samples: byState.rows.map((r) => ({ labels: { state: r.state, outcome: r.outcome, trigger: r.trigger }, value: r.n })),
        },
        {
          name: 'run_duration_seconds',
          help: 'Durée des runs terminés, par exécution et réseau.',
          type: 'histogram',
          samples: durations.rows.flatMap((r) => {
            const labels = { execution: r.execution, network: r.network };
            return [
              ...DURATION_BUCKETS.map((b, i) => ({ suffix: '_bucket' as const, labels: { le: String(b), ...labels }, value: r[`b${i}`] ?? 0 })),
              { suffix: '_bucket' as const, labels: { le: '+Inf', ...labels }, value: r.n },
              { suffix: '_sum' as const, labels, value: r.sum },
              { suffix: '_count' as const, labels, value: r.n },
            ];
          }),
        },
        {
          name: 'run_cost_usd_total',
          help: 'Coût cumulé des runs en USD, par nature.',
          type: 'counter',
          samples: [
            { labels: { kind: 'llm' }, value: cost.rows[0]?.llm ?? 0 },
            { labels: { kind: 'proxy' }, value: cost.rows[0]?.proxy ?? 0 },
          ],
        },
        {
          name: 'llm_tokens_total',
          help: 'Jetons LLM cumulés des runs, par sens (étiquette role : tâche 2.1).',
          type: 'counter',
          samples: (['in', 'cached', 'out', 'reasoning'] as const).map((direction) => ({ labels: { direction }, value: t?.[direction] ?? 0 })),
        },
        {
          name: 'failures_total',
          help: 'Runs échoués par classe d’échec.',
          type: 'counter',
          samples: failures.rows.map((r) => ({ labels: { failure_class: r.failure_class }, value: r.n })),
        },
        {
          name: 'status_transitions_total',
          help: 'Transitions de statut des API (INV3).',
          type: 'counter',
          samples: transitions.rows.map((r) => ({ labels: { from: r.from, to: r.to }, value: r.n })),
        },
        { name: 'apis', help: 'API par statut.', type: 'gauge', samples: apis.rows.map((r) => ({ labels: { status: r.status }, value: r.n })) },
        {
          name: 'queue_jobs',
          help: 'Runs en file ou en cours.',
          type: 'gauge',
          samples: [
            { labels: { queue: 'run', state: 'queued' }, value: depth.queued },
            { labels: { queue: 'run', state: 'running' }, value: depth.running },
          ],
        },
        { name: 'queue_oldest_job_age_seconds', help: 'Âge du plus ancien run en file.', type: 'gauge', samples: [{ value: depth.oldestQueuedAgeSeconds ?? 0 }] },
        {
          name: 'worker_last_heartbeat_age_seconds',
          help: 'Âge du dernier battement de chaque worker.',
          type: 'gauge',
          samples: workers.map((w) => ({ labels: { worker: opaqueWorkerId(w.workerId) }, value: w.ageSeconds })),
        },
        {
          name: 'worker_rss_mb',
          help: 'Mémoire résidente de chaque worker vivant (Mo, battement).',
          type: 'gauge',
          samples: alive.filter((w) => w.rssMb !== null).map((w) => ({ labels: { worker: opaqueWorkerId(w.workerId) }, value: w.rssMb ?? 0 })),
        },
        { name: 'workers_alive', help: 'Workers dont le battement a moins de 45 s.', type: 'gauge', samples: [{ value: alive.length }] },
        {
          name: 'browser_contexts_active',
          help: 'Contextes de navigateur ouverts (somme des workers vivants).',
          type: 'gauge',
          samples: [{ value: alive.reduce((sum, w) => sum + w.browserContexts, 0) }],
        },
        ...processFamilies(),
      ];
    },
  };
}

/** Texte Prometheus passé par le filtre de masquage (INV8 couvre les métriques) avant d'être servi. */
export async function renderMetrics(collector: MetricsCollector): Promise<string> {
  const families = await collector.collect();
  return secretValues.redactText(`${families.map(renderFamily).join('\n\n')}\n`);
}
