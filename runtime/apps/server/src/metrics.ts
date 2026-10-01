// `/metrics` (14 § 3) : texte Prometheus, préfixe `scrapyomama_`, étiquettes bornées (jamais run_id, api_id, domaine,
// URL ni message d'erreur). Le `server` calcule les mesures partagées DEPUIS LA BASE à chaque scrape ; le worker n'a pas de
// port : ses mesures passent par `worker_heartbeats`. Registre propre (pas le registre global) : rien n'est exposé par
// accident. Les métriques restent locales (INV9) : aucune poussée, le scrape est à l'initiative de l'admin.
import { createHash } from 'node:crypto';
import { secretValues } from '@runtime/core';
import { listWorkers, queueDepth } from '@runtime/db';
import type pg from 'pg';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

const PREFIX = 'scrapyomama_';

/** Identifiant de worker opaque : `worker_id` contient le nom d'hôte, qui ne sort jamais (14 § 3). */
export const opaqueWorkerId = (workerId: string): string => createHash('sha256').update(workerId).digest('hex').slice(0, 10);

/** Les valeurs calculées sont partagées par les métriques d'un même scrape (un seul jeu de requêtes par seconde au plus). */
function memo<T>(load: () => Promise<T>, ttlMs = 1000): () => Promise<T> {
  let at = 0;
  let value: Promise<T> | undefined;
  return () => {
    const now = Date.now();
    if (!value || now - at > ttlMs) {
      at = now;
      value = load();
      value.catch(() => (value = undefined));
    }
    return value;
  };
}

type Rows<T> = { rows: T[] };

export function createMetricsRegistry(pool: Pick<pg.Pool, 'query'>): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: PREFIX });

  const runs = memo(async () => {
    const [byState, cost, tokens, failures, apis] = await Promise.all([
      pool.query('SELECT state, coalesce(outcome, \'none\') AS outcome, trigger, count(*)::float8 AS n FROM runs GROUP BY 1, 2, 3') as Promise<Rows<{ state: string; outcome: string; trigger: string; n: number }>>,
      pool.query('SELECT coalesce(sum(cost_llm_usd), 0)::float8 AS llm, coalesce(sum(cost_proxy_usd), 0)::float8 AS proxy FROM runs') as Promise<Rows<{ llm: number; proxy: number }>>,
      pool.query('SELECT coalesce(sum(tokens_in), 0)::float8 AS "in", coalesce(sum(tokens_cached), 0)::float8 AS cached, coalesce(sum(tokens_out), 0)::float8 AS "out", coalesce(sum(tokens_reasoning), 0)::float8 AS reasoning FROM runs') as Promise<Rows<Record<string, number>>>,
      pool.query('SELECT failure_class, count(*)::float8 AS n FROM runs WHERE failure_class IS NOT NULL GROUP BY 1') as Promise<Rows<{ failure_class: string; n: number }>>,
      pool.query('SELECT status, count(*)::float8 AS n FROM apis GROUP BY 1') as Promise<Rows<{ status: string; n: number }>>,
    ]);
    return { byState: byState.rows, cost: cost.rows[0], tokens: tokens.rows[0], failures: failures.rows, apis: apis.rows };
  });
  const workers = memo(async () => ({ list: await listWorkers(pool), depth: await queueDepth(pool) }));
  const transitions = memo(async () => (await pool.query('SELECT coalesce(from_status, \'none\') AS "from", to_status AS "to", count(*)::float8 AS n FROM status_events GROUP BY 1, 2')) as Rows<{ from: string; to: string; n: number }>);

  // Compteurs recalculés depuis la base : remis à zéro puis posés à la valeur lue (le compteur de la base est la vérité).
  new Counter({
    name: `${PREFIX}runs_total`,
    help: 'Runs par état, issue et déclencheur.',
    labelNames: ['state', 'outcome', 'trigger'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const r of (await runs()).byState) this.inc({ state: r.state, outcome: r.outcome, trigger: r.trigger }, r.n);
    },
  });
  new Counter({
    name: `${PREFIX}run_cost_usd_total`,
    help: 'Coût cumulé des runs en USD, par nature.',
    labelNames: ['kind'],
    registers: [registry],
    async collect() {
      this.reset();
      const { cost } = await runs();
      this.inc({ kind: 'llm' }, cost?.llm ?? 0);
      this.inc({ kind: 'proxy' }, cost?.proxy ?? 0);
    },
  });
  new Counter({
    name: `${PREFIX}llm_tokens_total`,
    help: 'Jetons LLM cumulés des runs, par sens.',
    labelNames: ['direction'],
    registers: [registry],
    async collect() {
      this.reset();
      const { tokens } = await runs();
      for (const direction of ['in', 'cached', 'out', 'reasoning'] as const) this.inc({ direction }, tokens?.[direction] ?? 0);
    },
  });
  new Counter({
    name: `${PREFIX}failures_total`,
    help: 'Runs échoués par classe d’échec.',
    labelNames: ['failure_class'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const r of (await runs()).failures) this.inc({ failure_class: r.failure_class }, r.n);
    },
  });
  new Counter({
    name: `${PREFIX}status_transitions_total`,
    help: 'Transitions de statut des API (INV3).',
    labelNames: ['from', 'to'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const r of (await transitions()).rows) this.inc({ from: r.from, to: r.to }, r.n);
    },
  });
  new Gauge({
    name: `${PREFIX}apis`,
    help: 'API par statut.',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const r of (await runs()).apis) this.set({ status: r.status }, r.n);
    },
  });
  new Gauge({
    name: `${PREFIX}queue_jobs`,
    help: 'Runs en file ou en cours.',
    labelNames: ['queue', 'state'],
    registers: [registry],
    async collect() {
      const { depth } = await workers();
      this.set({ queue: 'run', state: 'queued' }, depth.queued);
      this.set({ queue: 'run', state: 'running' }, depth.running);
    },
  });
  new Gauge({
    name: `${PREFIX}queue_oldest_job_age_seconds`,
    help: 'Âge du plus ancien run en file.',
    registers: [registry],
    async collect() {
      this.set((await workers()).depth.oldestQueuedAgeSeconds ?? 0);
    },
  });
  new Gauge({
    name: `${PREFIX}worker_last_heartbeat_age_seconds`,
    help: 'Âge du dernier battement de chaque worker.',
    labelNames: ['worker'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const w of (await workers()).list) this.set({ worker: opaqueWorkerId(w.workerId) }, w.ageSeconds);
    },
  });
  new Gauge({
    name: `${PREFIX}workers_alive`,
    help: 'Workers dont le battement a moins de 45 s.',
    registers: [registry],
    async collect() {
      this.set((await workers()).list.filter((w) => w.alive).length);
    },
  });
  new Gauge({
    name: `${PREFIX}browser_contexts_active`,
    help: 'Contextes de navigateur ouverts (somme des workers vivants).',
    registers: [registry],
    async collect() {
      this.set((await workers()).list.filter((w) => w.alive).reduce((sum, w) => sum + w.browserContexts, 0));
    },
  });
  return registry;
}

/** Texte Prometheus passé par le filtre de masquage (INV8 couvre les métriques) avant d'être servi. */
export async function renderMetrics(registry: Registry): Promise<string> {
  return secretValues.redactText(await registry.metrics());
}
