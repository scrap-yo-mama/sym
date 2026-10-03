// SPDX-License-Identifier: AGPL-3.0-only
// promptfoo en image Docker, sans téléversement (15 §11). promptfoo orchestre les cas (tâche × modèle × répétition), les
// assertions et la sortie JSON ; le travail réel (enquête, réparation, injection sur les fixtures, avec le fournisseur BYO)
// est fait par le harnais du banc sur l'hôte, derrière un point d'accès HTTP que promptfoo appelle (fournisseur `http`).
// Le conteneur tourne sur un réseau Docker INTERNE : aucune route hors de l'hôte, seule la passerelle (point d'accès du banc)
// est joignable. Variables vérifiées dans dist/ de l'image 0.122.2 (point « à valider » de 15 §13) ; l'image ne s'installe
// pas par npm : rien à ajouter au catalogue, version épinglée par empreinte (sortie le 2026-08-28, plus de 7 jours).
import { stringify } from 'yaml';
import type { BenchTask } from './catalog.ts';
import { parseBenchRecord, type BenchLevel, type BenchRecord } from './records.ts';

export const PROMPTFOO_IMAGE = 'ghcr.io/promptfoo/promptfoo:0.122.2@sha256:e0eb45e5fd4ae8243f01c307b455285eb4ce9b420134bdc43a573c667e80e709';

/** Télémétrie, partage, contrôle de version, génération distante (red team) : coupés. */
export const PROMPTFOO_ENV: Readonly<Record<string, string>> = {
  PROMPTFOO_DISABLE_TELEMETRY: '1',
  PROMPTFOO_DISABLE_SHARING: '1',
  PROMPTFOO_DISABLE_SHARE_WARNING: '1',
  PROMPTFOO_DISABLE_UPDATE: '1',
  PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true',
  PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
  PROMPTFOO_SELF_HOSTED: '1',
};

export interface PromptfooRunOptions {
  /** Réseau Docker interne (`docker network create --internal`). */
  network: string;
  configDir: string;
  outDir: string;
  repeat: number;
}

/** Arguments de `docker run` : réseau interne, configuration en lecture seule, aucun partage, aucune écriture dans ~/.promptfoo. */
export function promptfooDockerArgs(options: PromptfooRunOptions): string[] {
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new RangeError('repeat : entier ≥ 1');
  const env = Object.entries(PROMPTFOO_ENV).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
  return [
    'run',
    '--rm',
    '--network',
    options.network,
    ...env,
    '-v',
    `${options.configDir}:/bench:ro`,
    '-v',
    `${options.outDir}:/out`,
    '--entrypoint',
    'node',
    PROMPTFOO_IMAGE,
    'dist/src/main.js',
    'eval',
    '-c',
    '/bench/promptfooconfig.yaml',
    '--no-share',
    '--no-write',
    '--no-cache',
    '--no-table',
    '--no-progress-bar',
    '-j',
    '1',
    '--repeat',
    String(options.repeat),
    '-o',
    '/out/promptfoo.json',
  ];
}

export interface PromptfooConfig {
  sharing: false;
  /** Contenu de promptfooconfig.yaml. */
  yaml: string;
}

/**
 * Configuration : un fournisseur `http` par modèle (POST /case sur le point d'accès du banc), un test par tâche. L'assertion
 * porte sur l'issue rapportée par le harnais (conformité à la référence) ; l'enregistrement complet revient dans la sortie.
 */
export function promptfooConfig(options: { tasks: readonly Pick<BenchTask, 'id' | 'description'>[]; endpoint: string; level: BenchLevel; models: readonly string[] }): PromptfooConfig {
  const config = {
    description: `Banc d’évaluation de l’agent (${options.level})`,
    sharing: false,
    prompts: ['{{task_id}}'],
    providers: options.models.map((model) => ({
      id: 'http',
      label: model,
      config: {
        url: `${options.endpoint}/case`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { task_id: '{{task_id}}', model_id: model, level: options.level },
        transformResponse: 'json',
      },
    })),
    tests: options.tasks.map((task) => ({
      description: `${task.id} — ${task.description}`,
      vars: { task_id: task.id },
      assert: [{ type: 'javascript', value: 'output.success === true && output.false_success === false' }],
    })),
  };
  return { sharing: false, yaml: stringify(config) };
}

interface PromptfooResult {
  vars?: { task_id?: unknown };
  provider?: { label?: unknown };
  response?: { output?: unknown };
}

/** Sortie JSON de promptfoo → enregistrements du banc, renumérotés par (modèle, tâche) dans l'ordre de la sortie. */
export function parsePromptfooOutput(output: unknown): BenchRecord[] {
  const results = (output as { results?: { results?: PromptfooResult[] } }).results?.results;
  if (!Array.isArray(results)) throw new Error('sortie promptfoo : results.results absent');
  const counters = new Map<string, number>();
  return results.map((result) => {
    const raw = typeof result.response?.output === 'string' ? (JSON.parse(result.response.output) as unknown) : result.response?.output;
    const record = parseBenchRecord(raw);
    if (record.task_id !== result.vars?.task_id || record.model_id !== result.provider?.label) throw new Error(`sortie promptfoo : enregistrement ${record.task_id}/${record.model_id} hors de son cas`);
    const key = `${record.model_id}\u0000${record.task_id}`;
    const repetition = counters.get(key) ?? 0;
    counters.set(key, repetition + 1);
    return { ...record, repetition };
  });
}
