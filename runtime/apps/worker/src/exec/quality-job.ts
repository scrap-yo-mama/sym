// SPDX-License-Identifier: AGPL-3.0-only
// Juge consultatif dans le worker (tâche 2.12, 19 §3, arbitrage n° 3) : à l'enquête (avant `sain`), à la réparation (avant
// que vN+1 devienne courante) et sur anomalie du profil d'un rejeu — dans ce dernier cas par un job SÉPARÉ, après le run :
// le rejeu lui-même fait 0 appel LLM. Le juge ne fait que poser `runs.judge` (et la raison informative `judge_flag` au
// journal du run, noms de champs seulement) : aucun statut, aucune version, aucun schéma, aucune règle ne change. Désactivé
// par défaut (`settings.llm.judge.enabled` et un modèle au rôle `judge`). Prompt et réponse jamais journalisés.
// Revue 2.12 : chaque jugement a un plafond connu avant l'envoi (budget restant de l'enquête ou de la réparation, plafond
// fixe `ANOMALY_JUDGE_MAX_USD` sur anomalie) ; l'échantillon porte un item de la baseline validée quand elle existe ; le
// jugement sur anomalie est un job pg-boss (`quality-judge`, un par run), qui survit au redémarrage du worker.
import { applyJudgement, judgeDecision, judgeSampleItems, type JudgeTrigger, type RunJudge, type RunProfile } from '@runtime/core';
import { judgeCallCeilingUsd, proposeJudgement } from '@runtime/agent';
import { inputHash, lastAnomalyJudgedAt, readBaselineItem, readLlmSettings, readRunForJudge, saveRunJudge } from '@runtime/db';
import { qualitySettings, roleTarget, type LlmClient, type LlmConfig } from '@runtime/llm';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export type QualityPorts = {
  /** Juge activé par l'admin (défaut : `settings.llm.judge.enabled` et un modèle au rôle `judge`). */
  readonly judgeEnabled: () => Promise<boolean>;
  /** Jugement sur anomalie d'un rejeu : job pg-boss séparé (`quality-judge`, un par run), traité après le run. */
  readonly scheduleJudge?: (job: { readonly runId: string; readonly ownerId: string }) => Promise<unknown> | void;
};

export function settingsQualityPorts(pool: pg.Pool): QualityPorts {
  return { judgeEnabled: async () => qualitySettings(await readLlmSettings(pool)).judgeEnabled };
}

/** Plafond d'un jugement sur anomalie (USD) : hors de tout budget de run, il est fixe. */
const ANOMALY_JUDGE_MAX_USD = 0.05;

/** Run pas encore clos au moment du job : pg-boss le reprendra (retryLimit de la file). */
class RunNotClosedError extends Error {
  override name = 'RunNotClosedError';
}

export type JudgementOutcome = { readonly judge: RunJudge; readonly reasons: readonly 'judge_flag'[]; readonly costUsd: number | null; readonly tokens: { in: number; cached: number; out: number; reasoning: number }; readonly seed: string };

/**
 * Un jugement : échantillon choisi par le code (graine journalisée par l'appelant), plafond de coût connu avant l'envoi
 * (`maxUsd`), avis relu par le code. `null` : rôle non configuré, prix inconnu, plafond insuffisant ou réponse illisible.
 */
export async function judgeItems(args: {
  readonly config: LlmConfig;
  readonly client: (config: LlmConfig) => LlmClient;
  readonly trigger: JudgeTrigger;
  readonly schema: unknown;
  readonly profile: RunProfile;
  readonly items: readonly unknown[];
  /** Item de la baseline validée (19 §3), ajouté en dernier à l'échantillon. */
  readonly baselineItem?: unknown;
  readonly maxUsd?: number;
  readonly signal?: AbortSignal;
}): Promise<JudgementOutcome | null> {
  const target = roleTarget(args.config, 'judge');
  if (target === undefined || args.items.length === 0) return null;
  const price = 'price' in target.model ? target.model.price : undefined;
  if (price === undefined) return null;
  const seed = randomBytes(8).toString('hex');
  const { items } = judgeSampleItems(args.items, args.profile, { seed, ...(args.baselineItem === undefined || args.baselineItem === null ? {} : { baselineItem: args.baselineItem }) });
  if (args.maxUsd !== undefined && judgeCallCeilingUsd({ schema: args.schema, profile: args.profile, items }, price) > args.maxUsd) return null;
  const client = args.client({ ...args.config, roles: { judge: args.config.roles.judge! } });
  const out = await proposeJudgement(client, { schema: args.schema, profile: args.profile, items, ...(args.signal === undefined ? {} : { signal: args.signal }) });
  const usage = client.meter.snapshot();
  if (out.judgement === null) return null;
  const applied = applyJudgement({ trigger: args.trigger, judgement: out.judgement });
  return { ...applied, costUsd: usage.cost_usd, tokens: { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning }, seed };
}

/** Champs signalés (noms seulement, jamais une valeur ni la raison du juge). */
export const flaggedFields = (judge: RunJudge): string[] => judge.verdicts.filter((v) => v.verdict === 'wrong').map((v) => v.field);

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Job de jugement sur anomalie, après le run : au plus un par API et par 24 h ; attend que le run soit fermé. Écrit
 * `runs.judge` et impute le coût au run (INV4) ; ne touche ni au statut ni à la version (aucune ligne `status_events`).
 */
export function createJudgeJob(deps: { readonly pool: pg.Pool; readonly llm: { readonly config: () => Promise<LlmConfig | null>; readonly client: (config: LlmConfig) => LlmClient }; readonly quality: QualityPorts; readonly now?: () => Date; readonly sleep?: (ms: number) => Promise<void> }) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (job: { readonly runId: string; readonly ownerId: string; readonly trigger?: JudgeTrigger }): Promise<RunJudge | null> => {
    const trigger = job.trigger ?? 'anomaly';
    let run = await readRunForJudge(deps.pool, { runId: job.runId, ownerId: job.ownerId });
    for (let i = 0; run !== null && !TERMINAL.has(run.state) && i < 20; i += 1) {
      await sleep(500);
      run = await readRunForJudge(deps.pool, { runId: job.runId, ownerId: job.ownerId });
    }
    if (run !== null && !TERMINAL.has(run.state)) throw new RunNotClosedError('run non clos');
    if (run === null || run.profile === null || run.state !== 'succeeded') return null;
    const enabled = await deps.quality.judgeEnabled();
    const last = trigger === 'anomaly' ? await lastAnomalyJudgedAt(deps.pool, { apiId: run.apiId, ownerId: job.ownerId }) : null;
    if (!judgeDecision({ enabled, trigger, lastJudgedAt: last, now: now() })) return null;
    const config = await deps.llm.config().catch(() => null);
    if (config === null) return null;
    const baselineItem = await readBaselineItem(deps.pool, { apiId: run.apiId, ownerId: job.ownerId, inputHash: inputHash(run.input) }).catch(() => null);
    const out = await judgeItems({ config, client: deps.llm.client, trigger, schema: run.outputSchema, profile: run.profile, items: run.items, baselineItem, maxUsd: ANOMALY_JUDGE_MAX_USD }).catch(() => null);
    if (out === null) return null;
    await saveRunJudge(deps.pool, { runId: job.runId, ownerId: job.ownerId, judge: out.judge, costUsd: out.costUsd, tokens: out.tokens });
    return out.judge;
  };
}

