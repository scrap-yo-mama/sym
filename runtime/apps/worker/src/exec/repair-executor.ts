// SPDX-License-Identifier: AGPL-3.0-only
// Réparation dans le même run (tâche 2.3, 04 §5, figure de 04 §6 : `reparation`). Appelée SEULEMENT à travers la garde
// de classification (`invokeAgentGuarded`) : jamais après un refus, un défi, une connexion requise ou un 429 (INV6).
// 1. Bail de réparation en table (`apis.repair_lease_*`) : une seule réparation à la fois par API ; vN+1 est enregistrée
//    (`commit`) AVANT la libération du bail ; un run concurrent attend (dans la limite de `leaseWaitMs`), puis rejoue vN+1.
//    Le bail est vérifié (et prolongé) avant chaque proposition et avant l'enregistrement : perdu, la réparation s'arrête
//    là, sans vN+1 (`repair_lease_lost`), et le run attend comme s'il l'avait trouvé tenu.
// 2. Rôle `repair` (`proposeRepair`) : patch JSON BORNÉ (RFC 6902) sur `sources`, `fields`, `pagination` ; validé par
//    `validateRepairPatch` (jamais `request.allowed_hosts`, `request.session` ni `output_schema` : `output_schema` n'est
//    JAMAIS modifié par une réparation), puis rejoué avec TOUTES les gardes du run (essai journalisé, INV2, INV4).
// 3. Validation de la sortie réparée : chaque item contre le schéma (même seuil de casse qu'un run, D-49) ET contre les
//    champs stables des dernières sorties saines (`checkAgainstHealthy`) ; sinon la proposition est refusée.
// 4. Arrêt : 3 propositions ou `repair_budget_usd` épuisés, ou le MÊME correctif proposé deux fois (`repeated_patch`) :
//    l'API passe en `erreur` (13), la stratégie précédente est conservée.
// 5. Escalade selon 04 §3.3 à partir du couple courant : exécutions déclaratives plus chères, MÊME réseau (X3 : un échec
//    d'extraction ne change jamais d'IP). Une issue qui exigerait un agent à chaque run n'est pas retenue (`instructed_mode`
//    n'existe pas avant 2.13 : traité comme faux).
// Le prompt ne reçoit que des squelettes (preuves minimisées) et des raisons sans valeur ; il n'est jamais journalisé.
// Règles Markdown (tâche 2.10, 18 §2) : réparer, c'est recompiler depuis la source À JOUR : les règles résolues de l'API
// (propriétaire et instance) sont injectées dans le préfixe du prompt `repair`, les skills lus par `read_skill` ; vN+1
// enregistre sa source (`source.rules`, `strategy_version_rules`).
// Tâche 2.12 : le dossier de mémoire du catalogue (19 §2, valeurs du même domaine seulement, masqué) entre dans le prompt
// à sa place fixe, avant les preuves ; le juge consultatif donne son avis avant que vN+1 devienne courante, sans rien
// bloquer (19 §3).
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildCatalogDossier,
  checkAgainstHealthy,
  escalationExecutions,
  profileItems,
  registrableDomain,
  renderCatalogMemory,
  healthyProfile,
  maskTextForLlm,
  patchKey,
  RepairLedger,
  validateDeclarativeSpec,
  validateRepairPatch,
  type DeclarativeSpec,
  type HealthyProfile,
  type JsonPatchOperation,
  type RepairStopCause,
  type RunContext as RunCtx,
  jsonSha256,
  renderRulesPrompt,
  SkillReader,
  sourceRuleRows,
  type ResolvedRules,
} from '@runtime/core';
import { assertPromptSafe, ClassificationGuardError, type AgentEvidence, type ExecFailure } from '@runtime/core/exec';
import { proposeRepair, readSkillsPhase, renderSkillBodies, repairCallCeilingUsd, repairMessages, repairPromptVersion } from '@runtime/agent';
import { acquireRepairLease, buildStrategySource, inputHash, readBaselineItem, readCatalogMemory, readCurrentStrategyVersion, readHealthyItems, readSourceBase, releaseRepairLease, renewRepairLease, resolveRulesForApi, saveRunJudge, type CatalogMemory } from '@runtime/db';
import { LlmError, roleTarget, toFailureClass, type LlmClient, type LlmConfig } from '@runtime/llm';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import { flaggedFields, judgeItems, settingsQualityPorts, type QualityPorts } from './quality-job.js';
import type { CandidateCheck, RepairedStrategy, RepairOutcome, RepairPort } from './strategy-executor.js';

export type RepairEngineDeps = {
  readonly pool: pg.Pool;
  /** Rôle `repair` : configuration relue à chaque réparation, client par réparation (compteur de coût). Absent : escalade seule. */
  readonly llm?: { readonly config: () => Promise<LlmConfig | null>; readonly client: (config: LlmConfig) => LlmClient };
  /** Chromium disponible (E2, E3 dans l'escalade). */
  readonly browser: boolean;
  /** 3 propositions et `repair_budget_usd` (à valider). */
  readonly maxAttempts?: number;
  readonly budgetUsd?: number;
  /** Attente du bail tenu par une autre réparation (ms). */
  readonly leaseWaitMs?: number;
  readonly leaseTtlSeconds?: number;
  readonly logger?: Logger;
  /** Mémoire du catalogue (2.12) ; défaut : `readCatalogMemory`. */
  readonly memory?: { readonly read: (args: { ownerId: string; apiId: string | null; domain: string }) => Promise<CatalogMemory> };
  /** Juge consultatif (2.12) ; défaut : réglages `settings.llm`. Configuration du rôle `judge` : `judgeLlm`. */
  readonly quality?: QualityPorts;
  readonly judgeLlm?: { readonly config: () => Promise<LlmConfig | null>; readonly client: (config: LlmConfig) => LlmClient };
};

const DECLARATIVE = new Set(['fetch', 'fetch_in_page', 'playwright']);
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Prix du rôle `repair` (USD par million de jetons) ; `undefined` : rôle absent, `null` : prix inconnu. */
function repairPrice(config: LlmConfig | null): { in: number; out: number } | null | undefined {
  if (config === null) return undefined;
  const target = roleTarget(config, 'repair');
  if (target === undefined) return undefined;
  const price = 'price' in target.model ? target.model.price : undefined;
  return price === undefined ? null : { in: price.in, out: price.out };
}

/** Garde du budget de réparation avant un appel LLM (levée par `beforeCall`, jamais réessayée). */
class RepairBudgetGuard extends Error {
  override name = 'RepairBudgetGuard';
}

export function createRepairPort(deps: RepairEngineDeps): RepairPort {
  const logger = deps.logger ?? pino({ enabled: false });
  const leaseTtl = deps.leaseTtlSeconds ?? 90;
  const leaseWaitMs = deps.leaseWaitMs ?? 60_000;
  const quality = deps.quality ?? settingsQualityPorts(deps.pool);

  /**
   * Avis consultatif sur la sortie réparée, avant que vN+1 devienne courante : il ne bloque rien (19 §3). Plafond : le
   * budget de réparation restant (`repair_budget_usd`) ; échantillon avec un item de la baseline validée s'il y en a une.
   * Rend le coût du jugement (imputé au run), `0` sans jugement.
   */
  const judgeRepair = async (ctx: RunCtx, schema: unknown, items: readonly unknown[], maxUsd: number): Promise<number | null> => {
    if (deps.judgeLlm === undefined || !(await quality.judgeEnabled().catch(() => false))) return 0;
    try {
      const config = await deps.judgeLlm.config().catch(() => null);
      if (config === null) return 0;
      const baselineItem = await readBaselineItem(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, inputHash: inputHash(ctx.input) }).catch(() => null);
      const out = await judgeItems({ config, client: deps.judgeLlm.client, trigger: 'repair', schema, profile: profileItems(items, schema), items, baselineItem, maxUsd, signal: ctx.signal });
      if (out === null) return 0;
      await ctx.chargeCost?.({ llm_usd: out.costUsd, tokens: { ...out.tokens, estimated: false } });
      await saveRunJudge(deps.pool, { runId: ctx.runId, ownerId: ctx.ownerId, judge: out.judge, costUsd: 0 });
      if (out.judge.flag) await ctx.log('info', 'judge_flag', { trigger: 'repair', fields: flaggedFields(out.judge), seed: out.seed });
      return out.costUsd;
    } catch {
      await ctx.log('warn', 'judge_failed', { trigger: 'repair' });
      return 0;
    }
  };

  /**
   * Dossier de mémoire de la réparation (même propriétaire, structurel) ; `description` : la demande DÉJÀ masquée
   * (couches 1 et 2), qui sert à l'étage 3 (plein texte).
   */
  const repairMemory = async (ctx: RunCtx, spec: DeclarativeSpec, description: string): Promise<string> => {
    try {
      const domain = registrableDomain(spec.request.url);
      const memory = await (deps.memory?.read ?? ((a) => readCatalogMemory(deps.pool, a)))({ ownerId: ctx.ownerId, apiId: ctx.apiId, domain });
      const dossier = buildCatalogDossier({ ownerId: ctx.ownerId, apiId: ctx.apiId, domain, description, mode: 'repair', refusals: memory.refusals, now: new Date() }, memory.entries);
      if (dossier.refs.length > 0) await ctx.log('info', 'catalog_memory', { entries: dossier.refs.length, tokens: dossier.tokens, truncated: dossier.truncated, sha256: dossier.sha256 });
      return renderCatalogMemory(dossier);
    } catch {
      return '';
    }
  };

  /** Attente du bail d'une autre réparation : vN+1 si elle a abouti, sinon échec (la stratégie reste celle du run). */
  const waitForOtherRepair = async (ctx: RunCtx, strategyVersion: number): Promise<RepairOutcome> => {
    const deadline = Date.now() + leaseWaitMs;
    while (Date.now() < deadline && !ctx.signal.aborted) {
      await sleep(250, undefined, { signal: ctx.signal }).catch(() => undefined);
      const { rows } = await deps.pool.query<{ busy: boolean }>('SELECT (repair_lease_owner IS NOT NULL AND repair_lease_until >= now()) AS busy FROM apis WHERE id = $1', [ctx.apiId]);
      if (rows[0]?.busy !== true) break;
    }
    const current = await readCurrentStrategyVersion(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId });
    await ctx.log('info', 'repair_lease_waited', { from_version: strategyVersion, current_version: current });
    if (current !== null && current !== strategyVersion) return { kind: 'superseded', version: current };
    return { kind: 'failed', cause: 'budget_exhausted', detail: 'repair_lease_busy' };
  };

  return async (request) => {
    const { ctx, target, strategy } = request;
    if (!DECLARATIVE.has(strategy.execution) || strategy.scriptRef !== null || strategy.network === 'tunnel') {
      // Patch borné : stratégies déclaratives seulement (04b §2) ; script E3 et E4-E6 : régénération hors de 2.3. En tunnel
      // (session de l'utilisateur), aucune réparation automatique ici : niveau 1 seulement, relève de 2.13 (19 §4).
      await ctx.log('info', 'repair_unsupported', { execution: strategy.execution, network: strategy.network });
      return { kind: 'failed', cause: 'budget_exhausted', detail: 'repair_unsupported' };
    }
    const checked = validateDeclarativeSpec(strategy.spec, { outputSchema: target.api.outputSchema });
    if (!checked.ok) return { kind: 'failed', cause: 'budget_exhausted', detail: 'invalid_strategy_spec' };
    const spec: DeclarativeSpec = checked.spec;

    // 1. Bail : une seule réparation à la fois par API.
    const leaseOwner = `run:${ctx.runId}`;
    if (!(await acquireRepairLease(deps.pool, ctx.apiId, leaseOwner, leaseTtl))) return waitForOtherRepair(ctx, strategy.version);
    // Bail perdu (expiré puis pris par un autre) : plus aucune proposition ni vN+1 ; le run fait comme s'il avait trouvé le
    // bail tenu (attente, puis vN+1 de l'autre réparation, ou échec).
    let lost = false;
    const holds = async (): Promise<boolean> => {
      if (!lost && !(await renewRepairLease(deps.pool, ctx.apiId, leaseOwner, leaseTtl))) lost = true;
      return !lost;
    };
    const renew = setInterval(() => {
      renewRepairLease(deps.pool, ctx.apiId, leaseOwner, leaseTtl)
        .then((held) => {
          if (!held) lost = true;
        })
        .catch((error: unknown) => logger.warn({ runId: ctx.runId, err: error instanceof Error ? error.name : 'error' }, 'bail de réparation : renouvellement impossible'));
    }, Math.max(1_000, (leaseTtl * 1000) / 3));
    try {
      return await repairUnderLease(ctx, request, spec, holds);
    } finally {
      clearInterval(renew);
      await releaseRepairLease(deps.pool, ctx.apiId, leaseOwner).catch(() => undefined);
    }
  };

  async function repairUnderLease(ctx: RunCtx, request: Parameters<RepairPort>[0], spec: DeclarativeSpec, holds: () => Promise<boolean>): Promise<RepairOutcome> {
    const { target, strategy, failure } = request;
    const leaseLost = async (): Promise<RepairOutcome> => {
      await ctx.log('warn', 'repair_lease_lost', { from_version: strategy.version });
      return waitForOtherRepair(ctx, strategy.version);
    };
    /** vN+1 enregistrée SOUS le bail (vérifié et prolongé juste avant), avant sa libération. */
    // Règles à jour de l'API (18 §4.3) : résolues comme son propriétaire ; plafonds journalisés.
    let resolved: ResolvedRules | null = null;
    try {
      resolved = (await resolveRulesForApi(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, role: 'repair' })).resolved;
    } catch (error) {
      logger.warn({ runId: ctx.runId, err: error instanceof Error ? error.name : 'error' }, 'réparation : règles illisibles');
    }
    if (resolved !== null && resolved.truncated.length > 0) await ctx.log('warn', 'rules_truncated', { removed: resolved.truncated.map((r) => r.ref), budget_tokens: resolved.budget.rules });
    if (resolved !== null && resolved.skillsListingTruncated) await ctx.log('warn', 'skills_listing_truncated', { without_description: resolved.skillsWithoutDescription, budget_tokens: resolved.budget.skills });
    const reader = new SkillReader(resolved?.skills ?? []);
    const rulesPrompt = resolved === null ? '' : renderRulesPrompt(resolved);
    let skillsPrompt = '';
    let skillsRead = false;
    // Source de vN+1 (18 §2, §4.6) : demande et décisions reprises de la source de vN (ou de la demande d'enquête de
    // l'API) ; seules les règles et la raison changent.
    const base = await readSourceBase(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, version: strategy.version }).catch(() => null);
    const sourceOf = (): Pick<RepairedStrategy, 'source' | 'rules'> => {
      if (resolved === null) return {};
      const rows = sourceRuleRows(resolved, reader.reads);
      const spec = strategy.spec as { request?: { url?: unknown }; start_url?: unknown } | null;
      const specUrl = typeof spec?.request?.url === 'string' ? spec.request.url : typeof spec?.start_url === 'string' ? spec.start_url : '';
      return {
        source: buildStrategySource({
          reason: 'repair',
          description: base?.request.description ?? '',
          url: base?.request.url ?? specUrl,
          exampleOutputRef: base?.request.example_output_ref ?? null,
          outputSchemaSha256: jsonSha256(target.api.outputSchema),
          investigationId: base?.investigation_id ?? null,
          decisions: base?.decisions ?? [],
          rows,
        }),
        rules: rows,
      };
    };
    const committed = async (repaired: RepairedStrategy, check: CandidateCheck): Promise<RepairOutcome> => {
      if (!(await holds())) return leaseLost();
      const judgeUsd = await judgeRepair(ctx, target.api.outputSchema, check.partition.conform, ledger.remainingUsd);
      if (judgeUsd !== 0) ledger.spend(judgeUsd);
      const saved = await request.commit({ ...repaired, ...sourceOf() });
      return { kind: 'repaired', strategy: repaired, check, saved };
    };
    const ledger = new RepairLedger({ ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }), ...(deps.budgetUsd === undefined ? {} : { budgetUsd: deps.budgetUsd }) });
    // Référence : items livrés des derniers runs réussis (chemins et types seulement entrent dans le prompt).
    // Schéma COURANT : après une ré-enquête `output_schema_changed`, un champ retiré ou retypé n'est plus exigé.
    const healthy: HealthyProfile = healthyProfile(await readHealthyItems(deps.pool, { apiId: ctx.apiId, ownerId: ctx.ownerId, excludeRunId: ctx.runId }), { outputSchema: target.api.outputSchema });
    const evidence: readonly AgentEvidence[] = request.evidence;
    // Aucune page de défi n'entre dans un prompt (04b §6) : un texte refusé arrête la réparation comme un refus.
    try {
      for (const e of evidence) assertPromptSafe(typeof e === 'string' ? e : e.body);
    } catch (error) {
      if (error instanceof ClassificationGuardError) return { kind: 'refused', failure: error.failure };
      throw error;
    }
    const refused: string[] = [];
    await ctx.log('info', 'repair_started', { from_version: strategy.version, failure_class: failure.failure_class, detail: failure.detail, healthy_items: healthy.items, stable_fields: Object.keys(healthy.stable).length });

    /** Une candidate rejouée : conforme au schéma (seuil de casse) ET aux champs stables, sinon la raison du refus. */
    const judge = async (check: CandidateCheck): Promise<string> => {
      if (!check.trial.result.ok) return `trial_${check.failure?.failure_class ?? 'failed'}`;
      if (check.verdict === 'break') return 'repair_not_validated';
      const verdict = checkAgainstHealthy(healthy, check.partition.conform);
      if (!verdict.ok) {
        await ctx.log('info', 'repair_false_success', { missing: verdict.missing, type_changed: verdict.type_changed });
        return 'repair_false_success';
      }
      return 'ok';
    };

    // 2. Propositions du rôle `repair`.
    let config: LlmConfig | null;
    try {
      config = (await deps.llm?.config()) ?? null;
    } catch {
      config = null;
    }
    const price = repairPrice(config);
    if (deps.llm !== undefined && config !== null && price === null) await ctx.log('warn', 'llm_price_missing', { role: 'repair' });
    if (deps.llm !== undefined && config !== null && price !== null && price !== undefined) {
      const client = deps.llm.client({ ...config, roles: { repair: config.roles.repair! } });
      const model = config.roles.repair?.model ?? null;
      // Masquage des couches 1 et 2 (19 §3, rôle `repair`) : la demande ne part jamais en clair, ni au prompt ni à l'étage 3.
      const description = maskTextForLlm(target.api.description ?? '');
      const catalogMemory = await repairMemory(ctx, spec, description);
      for (;;) {
        if (!(await holds())) return leaseLost();
        const base = { description, spec, outputSchema: target.api.outputSchema, failure, evidence, healthy, reasons: request.reasons, refused, rules: rulesPrompt, ...(catalogMemory === '' ? {} : { catalogMemory }) };
        const args = skillsPrompt === '' ? base : { ...base, skills: skillsPrompt };
        const ceiling = repairCallCeilingUsd(args, price);
        if (!ledger.canPropose(ceiling)) break;
        const before = client.meter.snapshot().cost_usd_known ?? 0;
        let patch: JsonPatchOperation[] | null = null;
        let llmFailure: ExecFailure | null = null;
        const beforeCall = () => {
          if ((client.meter.snapshot().cost_usd_known ?? 0) - before + ceiling > ledger.remainingUsd + 1e-9) throw new RepairBudgetGuard();
        };
        try {
          // Chargement progressif des skills (18 §4.4), une fois par réparation.
          if (!skillsRead) {
            skillsRead = true;
            const bodies = await readSkillsPhase(client, 'repair', { messages: repairMessages(args), reader, signal: ctx.signal, beforeCall });
            for (const read of reader.reads) await ctx.log('info', 'skill_read', { ref: read.ref, sha256: read.sha256 });
            if (bodies.length > 0) skillsPrompt = renderSkillBodies(bodies);
          }
          const out = await proposeRepair(client, { ...args, ...(skillsPrompt === '' ? {} : { skills: skillsPrompt }), signal: ctx.signal, beforeCall });
          patch = out.patch;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          if (error instanceof RepairBudgetGuard) llmFailure = { failure_class: 'run_budget_exceeded', retryable: false, detail: 'repair_budget_usd' };
          else if (error instanceof LlmError) llmFailure = { failure_class: toFailureClass(error.class), retryable: false, detail: `llm_${error.class}` };
          else llmFailure = { failure_class: 'extraction', retryable: false, detail: 'repair_proposal_unreadable' };
        }
        const usage = client.meter.snapshot();
        const callUsd = usage.cost_usd === null ? null : round6(usage.cost_usd - before);
        ledger.spend(callUsd);
        await ctx.chargeCost?.({ llm_usd: callUsd, tokens: { in: usage.tokens_in, cached: usage.tokens_cached, out: usage.tokens_out, reasoning: usage.tokens_reasoning, estimated: usage.usage_estimated } });
        await ctx.log('info', 'repair_call', { model, prompt_version: repairPromptVersion, llm_usd: callUsd, attempt: ledger.attempts + 1 });
        if (llmFailure !== null) {
          ledger.propose(null);
          refused.push(llmFailure.detail);
          // Un LLM sans repli (refus, clé, quota) ou un budget atteint : plus de proposition.
          if (llmFailure.failure_class !== 'extraction') break;
          continue;
        }
        if (patch === null) {
          ledger.propose(null);
          refused.push('repair_proposal_unreadable');
          continue;
        }
        // Liste vide : le modèle dit qu'aucun patch ne répare ; l'escalade prend le relais.
        if (patch.length === 0) {
          ledger.propose(null);
          await ctx.log('info', 'repair_no_patch', {});
          break;
        }
        const key = patchKey(patch);
        if (!ledger.propose(key)) {
          await ctx.log('warn', 'repair_repeated_patch', { patch_key: key });
          return { kind: 'failed', cause: 'repeated_patch', detail: 'repair_repeated_patch' };
        }
        const valid = validateRepairPatch(spec, patch, { outputSchema: target.api.outputSchema });
        if (!valid.ok) {
          const codes = [...new Set(valid.rejections.map((r) => r.code))];
          refused.push(...codes);
          await ctx.log('info', 'repair_patch_refused', { patch_key: key, codes });
          continue;
        }
        const check = await request.trial({ ...strategy, spec: valid.spec }, 'repair_patch');
        ledger.spend(check.costUsd);
        if (check.refusal !== null) return { kind: 'refused', failure: check.refusal };
        const verdict = await judge(check);
        await ctx.log('info', 'repair_candidate', { patch_key: key, verdict, conform: check.partition.conform.length, rejected: check.partition.rejected.length });
        if (verdict === 'ok') return committed({ execution: strategy.execution, network: strategy.network, spec: valid.spec, patch, estCostUsd: strategy.estCostUsd }, check);
        refused.push(verdict);
      }
    }

    // 3. Escalade (04 §3.3) : exécutions déclaratives plus chères sur le même réseau, stratégie d'origine.
    for (const execution of escalationExecutions(strategy.execution, { browser: deps.browser })) {
      if (ledger.remainingUsd <= 0) break;
      if (!(await holds())) return leaseLost();
      const check = await request.trial({ ...strategy, execution, estCostUsd: null }, 'repair_escalation');
      ledger.spend(check.costUsd);
      if (check.refusal !== null) return { kind: 'refused', failure: check.refusal };
      const verdict = await judge(check);
      await ctx.log('info', 'repair_escalation', { execution, network: strategy.network, verdict });
      if (verdict === 'ok') return committed({ execution, network: strategy.network, spec, patch: null, estCostUsd: null }, check);
    }
    const cause: RepairStopCause = ledger.finish();
    await ctx.log('warn', 'repair_failed', { cause, attempts: ledger.attempts, spent_usd: ledger.spentUsd, refused: [...new Set(refused)].slice(0, 10) });
    return { kind: 'failed', cause, detail: cause === 'repeated_patch' ? 'repair_repeated_patch' : 'repair_budget_exhausted' };
  }
}
