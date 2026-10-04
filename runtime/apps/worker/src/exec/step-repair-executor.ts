// SPDX-License-Identifier: AGPL-3.0-only
// Reprise par étape d'une stratégie `steps` (tâche 2.13, 19 §4), SOUS le bail de réparation de 2.3 (repair-executor.ts).
// L'orchestration est celle du noyau (`repairSteps`) ; ce module fournit ses ports avec les gardes du run :
// - `replay` : la candidate est rejouée par l'exécuteur `steps` (bac à sable, garde de classification, verrou de domaines,
//   effet observé de chaque étape, `post`), SANS LLM, journalisée comme un essai ; V3 contre les champs stables des
//   dernières sorties saines ;
// - `agent` (niveaux 2 et 3) : l'interprète s'arrête AVANT l'étape cassée, puis l'agent d'étape (rôle `agent`, outils
//   fermés, `agent_budget`, intention en indice non fiable) agit par la vue de l'hôte ; sa proposition devient un patch
//   borné (reciblage, et au niveau 3 les clics de navigation insérés), revalidé par le noyau avant tout rejeu. Absent
//   si le rôle `agent` n'est pas configuré, ou avec session / en tunnel (le noyau ne l'appelle jamais alors).
// Le journal par étape est écrit dans `run_attempts` (`step_id`, `step_level`, `step_outcome`, jetons, coût LLM).
import {
  agentToolRegistry,
  checkAgainstHealthy,
  ruleOfTwoHolds,
  healthyProfile,
  patchKey,
  primaryTarget,
  repairSteps,
  RepairLedger,
  validateStepsSource,
  type JsonPatchOperation,
  type StepAgentRequest,
  type StepAgentResult,
  type StepRepairPorts,
  type StepsSpec,
} from '@runtime/core';
import type { ExecFailure } from '@runtime/core/exec';
import { runStepAgent, type StepAgentOutcome } from '@runtime/agent';
import { readHealthyItems } from '@runtime/db';
import { roleTarget, type LlmClient, type LlmConfig } from '@runtime/llm';
import type pg from 'pg';
import { createAgentRequestGate, runRequestValues } from '../browser/agent-request-gate.js';
import type { CandidateCheck, RepairOutcome, RepairPort } from './strategy-executor.js';

type Request = Parameters<RepairPort>[0];

export type StepRepairDeps = {
  readonly pool: pg.Pool;
  readonly llm?: { readonly config: () => Promise<LlmConfig | null>; readonly client: (config: LlmConfig) => LlmClient };
  readonly maxAttempts?: number;
  readonly budgetUsd?: number;
};

/** Un refus servi pendant l'essai de l'agent : la garde l'emporte, plus aucun agent. */
class RefusedDuringAgent extends Error {
  override name = 'RefusedDuringAgent';
  readonly failure: ExecFailure;
  constructor(failure: ExecFailure) {
    super('refused');
    this.failure = failure;
  }
}

/** Bail de réparation perdu pendant la reprise : plus aucune proposition ni vN+1. */
export class StepLeaseLost extends Error {
  override name = 'StepLeaseLost';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BLOCK = /^<untrusted_step_intent>|<\/untrusted_step_intent>$/g;

function agentPrice(config: LlmConfig | null): { in: number; out: number } | null | undefined {
  if (config === null) return undefined;
  const target = roleTarget(config, 'agent');
  if (target === undefined) return undefined;
  const price = 'price' in target.model ? target.model.price : undefined;
  return price === undefined ? null : { in: price.in, out: price.out };
}

export async function repairStepsUnderLease(deps: StepRepairDeps, request: Request, spec: StepsSpec, holds: () => Promise<boolean>): Promise<RepairOutcome> {
  const { ctx, target, strategy } = request;
  const step = request.step!;
  const stepTrial = request.stepTrial!;
  const source = validateStepsSource(strategy.sourceSteps ?? [], spec);
  if (!source.ok) return { kind: 'failed', cause: 'budget_exhausted', detail: 'invalid_steps_source' };
  const input: Record<string, unknown> = isRecord(ctx.input) ? ctx.input : {};
  const runInputs = Object.fromEntries(Object.entries(input).filter((e): e is [string, string | number] => typeof e[1] === 'string' || typeof e[1] === 'number').map(([k, v]) => [k, String(v)]));
  const session = strategy.network === 'tunnel' || target.api.requiresSession;
  // Règle des deux par phase (19 §7), partie « agent » : registre construit par le code, jamais A, B et C complets,
  // aucun pont MCP (avec session ou en tunnel : aucun outil, niveau 1 seulement).
  const registry = agentToolRegistry(session ? 'session_or_tunnel' : 'step_repair');
  if (!ruleOfTwoHolds(registry)) throw new Error('registre d’outils hors règle des deux');
  await ctx.log('info', 'agent_tool_registry', { phase: registry.phase, tools: [...registry.tools], mcp: registry.mcp, legs: registry.legs });
  const healthy = healthyProfile(await readHealthyItems(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, excludeRunId: ctx.runId }));
  const ledger = new RepairLedger({ ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }), ...(deps.budgetUsd === undefined ? {} : { budgetUsd: deps.budgetUsd }) });
  /** Essai de chaque candidate (hors V5) : celui dont les données sont livrées si elle est retenue. */
  const checks = new WeakMap<StepsSpec, CandidateCheck>();

  let config: LlmConfig | null;
  try {
    config = session ? null : ((await deps.llm?.config()) ?? null);
  } catch {
    config = null;
  }
  const price = agentPrice(config);
  if (config !== null && price === null) await ctx.log('warn', 'llm_price_missing', { role: 'agent' });

  const ports: StepRepairPorts = {
    replay: async (candidate, focus) => {
      if (!(await holds())) throw new StepLeaseLost();
      const check = await stepTrial({ ...strategy, spec: candidate });
      if (focus.purpose !== 'v5') checks.set(candidate, check);
      ledger.spend(check.costUsd);
      const info = check.trial.outcome.steps;
      const conform = check.trial.result.ok && check.verdict !== 'break';
      const stable = conform && checkAgainstHealthy(healthy, check.partition.conform).ok;
      return {
        ok: stable && (info?.failure ?? null) === null,
        refusal: check.refusal,
        stepFailure: info?.failure === null || info?.failure === undefined ? null : { index: info.failure.index, failure: check.failure ?? info.failure.failure },
        observedWriteAt: info?.observedWriteAt ?? null,
        schema: stable,
        // V4 : aucun document du run servi depuis un cache ancien ou un service worker.
        freshness: info?.stale !== true,
        costUsd: check.costUsd,
      };
    },
  };
  if (deps.llm !== undefined && config !== null && price !== null && price !== undefined && config.roles.agent !== undefined) {
    const llm = deps.llm;
    const cfg = config;
    ports.agent = async (req: StepAgentRequest): Promise<StepAgentResult> => {
      if (!(await holds())) throw new StepLeaseLost();
      // Segment (niveau 3) : budget doublé, une fois (à valider au banc 2.8).
      const budget = req.level === 3 ? { max_steps: req.budget.max_steps * 2, max_usd: req.budget.max_usd * 2 } : req.budget;
      if (!ledger.canPropose(budget.max_usd)) return { patch: null, costUsd: 0, tokensIn: 0, tokensOut: 0, stop: 'budget' };
      ledger.propose(null);
      const client = llm.client({ ...cfg, roles: { agent: cfg.roles.agent! } });
      let outcome: StepAgentOutcome | null = null;
      // Politique de requêtes de l'agent (19 §7, PA-01) : la reprise d'étape y est soumise comme E5 et E6, pendant la phase de
      // l'agent seulement (le rejeu des étapes garde son régime) ; refus journalisés par code, jamais d'URL ni de valeur.
      const gate = createAgentRequestGate({
        phase: 'step_repair',
        allowedHosts: req.spec.allowed_hosts,
        startUrl: req.spec.start_url,
        templates: req.spec.steps.flatMap((st) => (st.op === 'goto' && st.url !== undefined ? [st.url] : [])),
        allowWriteActions: target.api.allowWriteActions,
        agentActive: false,
        ...runRequestValues(ctx.personal),
        runInputs,
      });
      const check = await stepTrial(
        { ...strategy, spec: req.spec },
        {
          stopBefore: req.stepIndex,
          gate,
          afterPause: async (tools, host) => {
            gate.setAgentActive(true);
            try {
              outcome = await runStepAgent(client, {
                page: host.agentPage(tools, runInputs),
                step: { id: req.step.id, op: req.step.op, oldTarget: req.step.target === undefined ? null : primaryTarget(req.step.target) },
                intent: req.intent.replace(BLOCK, ''),
                pre: req.pre,
                post: req.post,
                runInputs,
                budget,
                price,
                rules: [],
                // Annulation du run ou refus retenu par la garde pendant la phase de l'agent : la boucle s'arrête aussitôt.
                signal: tools.signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, tools.signal]),
              });
            } finally {
              gate.setAgentActive(false);
            }
          },
        },
      );
      const policy = gate.summary();
      if (policy.blocked > 0) await ctx.log('warn', 'agent_request_blocked', { code: 'agent_request_blocked', count: policy.blocked, reasons: [...new Set(policy.reasons)] });
      ledger.spend(check.costUsd);
      const out = outcome as StepAgentOutcome | null;
      // Prix inconnu (null) : le budget de réparation est épuisé, jamais compté 0 (INV4).
      if (out !== null) {
        ledger.spend(out.costUsd);
        pendingAgent.push({ stepId: req.step.id, level: req.level, usd: out.costUsd, tin: out.tokensIn, tout: out.tokensOut });
        if (out.refused.length > 0) await ctx.log('info', 'step_agent_refused', { step_id: req.step.id, level: req.level, codes: [...new Set(out.refused)] });
      }
      if (check.refusal !== null) throw new RefusedDuringAgent(check.refusal);
      if (out === null) return { patch: null, costUsd: 0, tokensIn: 0, tokensOut: 0, stop: 'error' };
      const spent = { costUsd: out.costUsd, tokensIn: out.tokensIn, tokensOut: out.tokensOut };
      if (out.status !== 'done' || out.target === null) return { patch: null, ...spent, stop: out.status === 'done' ? 'invalid' : out.status };
      const old = req.step.target;
      const alternates = old === undefined ? [] : [primaryTarget(old), ...old.alternates].slice(0, 5);
      const patch: JsonPatchOperation[] = [];
      let at = req.stepIndex;
      if (req.level === 3) {
        // Segment : les clics de l'agent avant sa cible deviennent des étapes insérées (bornées par le noyau).
        const done = out.target;
        const clicks = out.actions.filter((a) => a.tool === 'click' && a.target !== undefined && !(a.target.role === done.role && a.target.name === done.name)).slice(0, 3);
        const ids = new Set(req.spec.steps.map((st) => st.id));
        for (const a of clicks) {
          let n = ids.size + 1;
          let id = `r${n}`;
          while (ids.has(id)) id = `r${++n}`;
          ids.add(id);
          patch.push({ op: 'add', path: `/steps/${at}`, value: { id, op: 'click', target: { role: a.target!.role, name: a.target!.name, alternates: [] } } });
          at += 1;
        }
      }
      patch.push({ op: 'replace', path: `/steps/${at}/target`, value: { role: out.target.role, name: out.target.name, alternates } });
      return { patch, ...spent, stop: 'done' };
    };
  }

  /** Appels de l'agent pas encore journalisés : écrits même si la reprise s'arrête sur une exception (INV4). */
  const pendingAgent: { stepId: string; level: 2 | 3; usd: number | null; tin: number; tout: number }[] = [];
  const recordPendingAgent = async (): Promise<void> => {
    for (const a of pendingAgent.splice(0)) {
      await ctx.recordAttempt({ execution: 'hybrid', network: strategy.network, est_cost_usd: null, result: 'extraction', ms: 0, llm_usd: a.usd, tokens: { in: a.tin, out: a.tout }, step: { id: a.stepId, level: a.level, outcome: 'failed' } });
    }
  };
  let outcome;
  try {
    outcome = await repairSteps({ spec, source: source.steps, failure: step, context: { session, tunnel: strategy.network === 'tunnel', runInputs: Object.keys(runInputs) }, ports });
  } catch (error) {
    await recordPendingAgent().catch(() => undefined);
    if (error instanceof RefusedDuringAgent) return { kind: 'refused', failure: error.failure };
    throw error;
  }
  pendingAgent.length = 0; // journalisés ci-dessous, avec leur issue
  // Journal par étape : une ligne par niveau tenté (coût LLM de l'agent ; les rejeux sont des essais à part).
  for (const entry of outcome.journal) {
    await ctx.recordAttempt({
      execution: 'hybrid',
      network: strategy.network,
      est_cost_usd: null,
      result: entry.step_outcome === 'failed' ? 'extraction' : 'ok',
      ms: 0,
      llm_usd: entry.llm_usd,
      tokens: { in: entry.tokens_in, out: entry.tokens_out },
      step: { id: entry.step_id, level: entry.step_level, outcome: entry.step_outcome },
    });
  }
  // Codes stables seulement (aucune cible ni valeur du site au journal du run).
  await ctx.log('info', 'step_repair_journal', { outcome: outcome.kind, entries: outcome.journal.map((e) => ({ step_id: e.step_id, level: e.step_level, outcome: e.step_outcome, detail: e.detail })) });
  switch (outcome.kind) {
    case 'classified':
    case 'refused':
      return { kind: 'refused', failure: outcome.failure };
    case 'write_step_broken':
      return { kind: 'stopped', reason: 'write_step_broken', stepId: outcome.stepId };
    case 'session_step_broken':
      return { kind: 'stopped', reason: 'session_step_broken', stepId: outcome.stepId };
    case 'step_cascade':
      return { kind: 'failed', cause: 'step_cascade', detail: 'step_cascade' };
    case 'failed':
      // Échelle épuisée ; l'escalade de 04 §3.3 depuis E5 ne mène qu'à E6 (agent à chaque run), jamais sans
      // `instructed_mode` : la reprise s'arrête (13), stratégie précédente gardée.
      await ctx.log('info', 'step_repair_escalation', { next: 'none', reason: 'agent_each_run_requires_instructed_mode' });
      return { kind: 'failed', cause: 'budget_exhausted', detail: 'repair_budget_exhausted' };
    case 'repaired': {
      const check = checks.get(outcome.spec);
      if (check === undefined) return { kind: 'failed', cause: 'budget_exhausted', detail: 'repair_check_missing' };
      if (!(await holds())) throw new StepLeaseLost();
      // Un correctif non validé déjà proposé pour cette version (run précédent) : arrêt (13), jamais une boucle de
      // réparations non validées d'un run à l'autre (19 §4, « un correctif proposé deux fois reste un arrêt »).
      if (!outcome.validated && (await request.repairedBefore?.(outcome.patch)) === true) {
        await ctx.log('warn', 'repair_repeated_patch', { patch_key: patchKey(outcome.patch) });
        return { kind: 'failed', cause: 'repeated_patch', detail: 'repair_repeated_patch' };
      }
      const saved = await request.commitSteps!({ spec: outcome.spec, patch: outcome.patch, validated: outcome.validated });
      return {
        kind: 'repaired',
        strategy: { execution: 'hybrid', network: strategy.network, spec: outcome.spec, patch: outcome.patch, estCostUsd: strategy.estCostUsd },
        check,
        saved,
        validated: outcome.validated,
      };
    }
  }
}
