// SPDX-License-Identifier: AGPL-3.0-only
// Registre de métriques Prometheus (cdc/sym-browser 04d § 3.1, tâche 3.7), au format d'exposition texte 0.0.4.
// Écrit à la main comme celui de SYM (runtime/apps/server/src/metrics.ts) plutôt qu'avec prom-client : prom-client 15
// charge `@opentelemetry/api` de façon statique, et seul un petit sous-ensemble est utile (compteur, jauge, histogramme).
// Cardinalité bornée : chaque métrique déclare ses étiquettes ; une étiquette prend une valeur de sa liste, ou, pour un
// nœud, un identifiant au format `NODE_ID` qui n'a l'allure ni d'un UUID ni d'une clé d'API. Jamais d'identifiant de
// session, de clé ni de client : toute autre étiquette ou valeur est refusée (`MetricLabelError`).
import { cpuUsage, memoryUsage, uptime } from 'node:process';

export class MetricLabelError extends Error {
  override name = 'MetricLabelError';
}

/** Valeurs permises d'une étiquette : liste fermée, ou `node` (identifiant de nœud). */
export type LabelValues = readonly string[] | 'node';
export type LabelSpec = Readonly<Record<string, LabelValues>>;
type Labels<L extends string> = Record<L, string>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const NODE_VALUE = /^[A-Za-z0-9_.-]{1,63}$/;
const UUID_LIKE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const KEY_LIKE = /^symb_[A-Za-z0-9_-]{16,}$/;

const escapeHelp = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeLabel = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const formatValue = (v: number) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : String(v));

abstract class Metric<L extends string> {
  readonly name: string;
  readonly help: string;
  readonly labelSpec: LabelSpec;
  readonly #names: string[];

  constructor(name: string, help: string, labels: LabelSpec) {
    this.name = name;
    this.help = help;
    this.labelSpec = labels;
    this.#names = Object.keys(labels).sort();
    for (const label of this.#names) if (!NAME.test(label) || label === 'le') throw new MetricLabelError(`étiquette invalide : ${label}`);
  }

  abstract readonly type: 'counter' | 'gauge' | 'histogram';

  /** Clé canonique des étiquettes (`a="x",b="y"`), après vérification de la cardinalité. */
  protected key(labels: Labels<L> | Record<string, never>): string {
    const given = Object.keys(labels);
    if (given.length !== this.#names.length || given.some((l) => !(l in this.labelSpec))) {
      throw new MetricLabelError(`${this.name} : étiquettes attendues [${this.#names.join(', ')}], reçues [${given.sort().join(', ')}]`);
    }
    return this.#names
      .map((label) => {
        const value = (labels as Record<string, string>)[label] ?? '';
        const allowed = this.labelSpec[label]!;
        const ok = allowed === 'node' ? NODE_VALUE.test(value) && !UUID_LIKE.test(value) && !KEY_LIKE.test(value) : allowed.includes(value);
        if (!ok) throw new MetricLabelError(`${this.name} : valeur refusée pour l’étiquette ${label}`);
        return `${label}="${escapeLabel(value)}"`;
      })
      .join(',');
  }

  /** Séries à zéro pour toutes les combinaisons des étiquettes listées (aucune si une étiquette est `node`). */
  protected enumerated(): string[] {
    if (this.#names.some((l) => this.labelSpec[l] === 'node')) return [];
    let keys: string[] = [''];
    for (const label of this.#names) {
      const values = this.labelSpec[label] as readonly string[];
      keys = keys.flatMap((k) => values.map((v) => (k === '' ? '' : `${k},`) + `${label}="${escapeLabel(v)}"`));
    }
    return keys;
  }

  abstract samples(): string[];

  render(): string {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.type}\n${this.samples().join('')}`;
  }
}

const series = (name: string, key: string, value: number) => `${name}${key === '' ? '' : `{${key}}`} ${formatValue(value)}\n`;

class Scalar<L extends string> extends Metric<L> {
  readonly type: 'counter' | 'gauge';
  protected readonly values = new Map<string, number>();

  constructor(type: 'counter' | 'gauge', name: string, help: string, labels: LabelSpec) {
    super(name, help, labels);
    this.type = type;
    for (const key of this.enumerated()) this.values.set(key, 0);
  }

  value(labels: Labels<L> | Record<string, never> = {}): number {
    return this.values.get(this.key(labels)) ?? 0;
  }

  samples(): string[] {
    return [...this.values].map(([key, v]) => series(this.name, key, v));
  }
}

export class Counter<L extends string = never> extends Scalar<L> {
  constructor(name: string, help: string, labels: LabelSpec) {
    super('counter', name, help, labels);
  }

  inc(labels: Labels<L> | Record<string, never> = {}, by = 1): void {
    if (!Number.isFinite(by) || by < 0) throw new RangeError(`${this.name} : un compteur ne décroît pas (${by})`);
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  /** Valeur cumulée lue ailleurs (temps CPU du processus) : jamais en baisse. */
  setTotal(labels: Labels<L> | Record<string, never>, total: number): void {
    const key = this.key(labels);
    this.values.set(key, Math.max(this.values.get(key) ?? 0, total));
  }
}

export class Gauge<L extends string = never> extends Scalar<L> {
  constructor(name: string, help: string, labels: LabelSpec) {
    super('gauge', name, help, labels);
  }

  set(labels: Labels<L> | Record<string, never>, value: number): void {
    this.values.set(this.key(labels), value);
  }

  inc(labels: Labels<L> | Record<string, never> = {}, by = 1): void {
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  dec(labels: Labels<L> | Record<string, never> = {}, by = 1): void {
    this.inc(labels, -by);
  }

  /** Remet à zéro les séries énumérées et oublie les autres (jauges recalculées à chaque collecte). */
  reset(): void {
    this.values.clear();
    for (const key of this.enumerated()) this.values.set(key, 0);
  }
}

type HistogramSeries = { counts: number[]; sum: number; count: number };

export class Histogram<L extends string = never> extends Metric<L> {
  readonly type = 'histogram' as const;
  readonly buckets: readonly number[];
  readonly #series = new Map<string, HistogramSeries>();

  constructor(name: string, help: string, labels: LabelSpec, buckets: readonly number[]) {
    super(name, help, labels);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.length === 0 || sorted.some((b, i) => !Number.isFinite(b) || (i > 0 && b === sorted[i - 1]))) throw new RangeError(`${name} : seuils invalides`);
    this.buckets = sorted;
  }

  observe(labels: Labels<L> | Record<string, never>, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = this.key(labels);
    let s = this.#series.get(key);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.#series.set(key, s);
    }
    for (const [i, bound] of this.buckets.entries()) if (value <= bound) s.counts[i]! += 1;
    s.sum += value;
    s.count += 1;
  }

  samples(): string[] {
    const out: string[] = [];
    for (const [key, s] of this.#series) {
      const prefix = key === '' ? '' : `${key},`;
      for (const [i, bound] of this.buckets.entries()) out.push(series(`${this.name}_bucket`, `${prefix}le="${formatValue(bound)}"`, s.counts[i]!));
      out.push(series(`${this.name}_bucket`, `${prefix}le="+Inf"`, s.count));
      out.push(series(`${this.name}_sum`, key, s.sum), series(`${this.name}_count`, key, s.count));
    }
    return out;
  }
}

export type Collector = () => void | Promise<void>;

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric<string>>();
  readonly #collectors: Collector[] = [];

  #add<M extends Metric<string>>(metric: M, prefixed: boolean): M {
    if (!NAME.test(metric.name)) throw new RangeError(`nom de métrique invalide : ${metric.name}`);
    if (prefixed && !metric.name.startsWith('symb_')) throw new RangeError(`métrique ${metric.name} : préfixe symb_ requis`);
    if (this.#metrics.has(metric.name)) throw new RangeError(`métrique ${metric.name} déjà déclarée`);
    this.#metrics.set(metric.name, metric);
    return metric;
  }

  counter<L extends string = never>(name: string, help: string, labels: LabelSpec): Counter<L> {
    return this.#add(new Counter<L>(name, help, labels), true);
  }

  gauge<L extends string = never>(name: string, help: string, labels: LabelSpec): Gauge<L> {
    return this.#add(new Gauge<L>(name, help, labels), true);
  }

  histogram<L extends string = never>(name: string, help: string, labels: LabelSpec, buckets: readonly number[]): Histogram<L> {
    return this.#add(new Histogram<L>(name, help, labels, buckets), true);
  }

  /** Métriques standard du processus (noms de prom-client, sans préfixe). */
  processGauge(name: string, help: string): Gauge {
    return this.#add(new Gauge(name, help, {}), false);
  }

  processCounter(name: string, help: string): Counter {
    return this.#add(new Counter(name, help, {}), false);
  }

  /** Appelé avant chaque rendu (jauges lues sur l'état courant). */
  onCollect(collector: Collector): void {
    this.#collectors.push(collector);
  }

  names(): string[] {
    return [...this.#metrics.keys()];
  }

  async render(): Promise<string> {
    // Un collecteur en échec laisse ses jauges à leur dernière valeur : les autres métriques restent servies.
    await Promise.allSettled(this.#collectors.map(async (c) => c()));
    return [...this.#metrics.values()].map((m) => m.render()).join('');
  }
}

/** Équivalent de `collectDefaultMetrics` de prom-client : mémoire, CPU, tas, heure de démarrage. */
export function registerProcessMetrics(registry: MetricsRegistry): void {
  const rss = registry.processGauge('process_resident_memory_bytes', 'Resident memory size in bytes.');
  const cpu = registry.processCounter('process_cpu_seconds_total', 'Total user and system CPU time spent in seconds.');
  const start = registry.processGauge('process_start_time_seconds', 'Start time of the process since unix epoch in seconds.');
  const heapUsed = registry.processGauge('nodejs_heap_size_used_bytes', 'Process heap size used from Node.js in bytes.');
  const heapTotal = registry.processGauge('nodejs_heap_size_total_bytes', 'Process heap size from Node.js in bytes.');
  const startedAt = Date.now() / 1000 - uptime();
  registry.onCollect(() => {
    const mem = memoryUsage();
    const usage = cpuUsage();
    rss.set({}, mem.rss);
    heapUsed.set({}, mem.heapUsed);
    heapTotal.set({}, mem.heapTotal);
    cpu.setTotal({}, (usage.user + usage.system) / 1e6);
    start.set({}, Math.round(startedAt));
  });
}
