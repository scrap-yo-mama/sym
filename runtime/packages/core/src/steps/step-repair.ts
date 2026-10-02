// SPDX-License-Identifier: AGPL-3.0-only
// Reprise par étape (19 §4, r2 R1 à R12, tâche 2.13) : orchestration PURE, I/O par ports.
// 1. Garde de classification avant chaque reprise (`stepRepairRoute`) : hors `extraction` et `code_error`, la classe suit
//    04 §7, 0 appel d'agent, aucun rejeu. Étape `write` : `write_step_broken`, jamais réparée seule.
// 2. Seuil de cascade (`StepCascade`) à chaque étape cassée, y compris en cours de reprise : `step_cascade`.
// 3. Échelle, du moins cher au plus cher : niveau 1 (alternates enregistrées, 0 LLM), niveau 2 (agent borné sur l'étape),
//    niveau 3 (segment, une fois). Avec session ou en tunnel : niveau 1 seulement, puis `session_step_broken`.
// 4. Chaque proposition passe par `validateStepPatch` (patch borné, `side_effect` recalculé) AVANT tout rejeu ; une
//    candidate refusée n'est jamais rejouée. La candidate est rejouée avec toutes les gardes (port `replay`) : un refus
//    l'emporte, un effet d'écriture observé donne `write_step_broken`, une cible ambiguë `intent_changed`.
// 5. Portes V0 à V5 sur la candidate qui rejoue tout le run ; V5 : N rejeux sans LLM. Toutes passent : vN+1 courante ;
//    seule V5 échoue : données livrées, vN+1 non validée (`repair_not_validated`).
// L'intention n'arrive à l'agent que dans `<untrusted_step_intent>` ; sa consigne de confiance est `post` et le contrat.
import type { ExecFailure } from '../exec/types.js';
import type { StepOutcome } from '../model/enums.js';
import type { JsonPatchOperation } from '../model/types.js';
import { evaluateGates } from './gates.js';
import { untrustedStepIntent } from './intent.js';
import { validateStepPatch } from './patch.js';
import { StepCascade, stepRepairRoute, type StepRepairLevel } from './policy.js';
import { primaryTarget, type StepAgentBudget, type StepAlternate, type StepDef, type StepPost, type StepPre, type StepSource, type StepsSpec } from './spec.js';

export type StepFailure = { readonly index: number; readonly failure: ExecFailure };

/** Rejeu d'une stratégie candidate, SANS LLM, avec toutes les gardes du run. */
export type StepReplayResult = {
  /** Toutes les étapes passées (`post` comprises) et sortie conforme au schéma (seuil de casse). */
  readonly ok: boolean;
  /** Refus retenu par la garde de classification (V0) : la reprise s'arrête. */
  readonly refusal: ExecFailure | null;
  /** Première étape en échec (cible absente ou ambiguë, `post` non tenue, extraction). */
  readonly stepFailure: StepFailure | null;
  /** Étape dont l'effet observé est une écriture (requête non GET, soumission). */
  readonly observedWriteAt: number | null;
  /** V3 : schéma et champs stables des dernières sorties saines. */
  readonly schema: boolean;
  /** V4 : réponses du run, pas d'un cache antérieur. */
  readonly freshness: boolean;
  readonly costUsd: number | null;
};

export type StepAgentRequest = {
  readonly level: 2 | 3;
  readonly stepIndex: number;
  readonly step: StepDef;
  readonly spec: StepsSpec;
  /** Intention nettoyée, DÉJÀ encadrée par `<untrusted_step_intent>`. */
  readonly intent: string;
  readonly pre: StepPre;
  /** Consigne de confiance (avec le contrat du code). */
  readonly post: readonly StepPost[];
  readonly budget: StepAgentBudget;
  /** Règles à jour (`read_skill`, 2.10) : vides avant sa fusion. */
  readonly rules: readonly string[];
};

export type StepAgentResult = {
  readonly patch: JsonPatchOperation[] | null;
  readonly costUsd: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly stop: 'done' | 'budget' | 'max_steps' | 'invalid' | 'error';
};

export type StepRepairPorts = {
  replay(spec: StepsSpec, focus: { readonly index: number; readonly purpose: 'alternate' | 'agent' | 'v5' }): Promise<StepReplayResult>;
  /** Agent d'étape (niveaux 2 et 3) ; absent : rôle `agent` non configuré, niveau 1 seulement. */
  agent?(request: StepAgentRequest): Promise<StepAgentResult>;
};


/** Une ligne du journal par étape (`run_attempts.step_*`, panneau « Reprises »). */
export type StepJournalEntry = {
  readonly step_id: string;
  readonly step_level: StepRepairLevel | null;
  readonly step_outcome: StepOutcome;
  readonly cost_usd: number | null;
  readonly tokens_in: number;
  readonly tokens_out: number;
  /** Code stable (refus du patch, `intent_changed`, arrêt de l'agent…), jamais un texte du site. */
  readonly detail: string | null;
  /** Diff de l'étape (patch RFC 6902) quand elle a été réparée. */
  readonly patch?: readonly JsonPatchOperation[];
};

export type StepRepairOutcome =
  | { readonly kind: 'classified'; readonly failure: ExecFailure; readonly journal: StepJournalEntry[] }
  | { readonly kind: 'write_step_broken'; readonly stepId: string; readonly journal: StepJournalEntry[] }
  | { readonly kind: 'session_step_broken'; readonly stepId: string; readonly journal: StepJournalEntry[] }
  | { readonly kind: 'step_cascade'; readonly broken: number; readonly journal: StepJournalEntry[] }
  | { readonly kind: 'refused'; readonly failure: ExecFailure; readonly journal: StepJournalEntry[] }
  | { readonly kind: 'failed'; readonly journal: StepJournalEntry[] }
  | {
      readonly kind: 'repaired';
      readonly spec: StepsSpec;
      readonly patch: JsonPatchOperation[];
      /** Faux : V5 a échoué, données livrées, vN+1 archivée non courante. */
      readonly validated: boolean;
      /** Rejeu de la candidate dont les données sont livrées. */
      readonly replay: StepReplayResult;
      readonly journal: StepJournalEntry[];
    };

export type StepRepairContext = {
  /** Run avec la session de l'utilisateur. */
  readonly session: boolean;
  /** Run en tunnel (navigateur de l'utilisateur). */
  readonly tunnel: boolean;
  /** Noms des entrées du run (seules saisies permises). */
  readonly runInputs: readonly string[];
};

const addUsd = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : Math.round((a + b) * 1e9) / 1e9);

type Attempt =
  | { kind: 'done'; spec: StepsSpec; patch: JsonPatchOperation[]; replay: StepReplayResult; validated: boolean }
  | { kind: 'next'; spec: StepsSpec; patch: JsonPatchOperation[]; next: StepFailure }
  | { kind: 'refused'; failure: ExecFailure }
  | { kind: 'write'; index: number }
  | { kind: 'rejected'; detail: string };

export async function repairSteps(args: {
  readonly spec: StepsSpec;
  readonly source: readonly StepSource[];
  readonly failure: StepFailure;
  readonly context: StepRepairContext;
  readonly ports: StepRepairPorts;
  readonly cascade?: StepCascade;
  readonly replaysRequired?: number;
}): Promise<StepRepairOutcome> {
  const journal: StepJournalEntry[] = [];
  const cascade = args.cascade ?? new StepCascade({ totalSteps: args.spec.steps.length });
  const sourceOf = (id: string): StepSource | undefined => args.source.find((s) => s.id === id);
  let current = args.spec;
  const applied: JsonPatchOperation[] = [];
  let pending = args.failure;

  /** Rejoue une candidate validée et applique les portes ; `touched` : étapes que le patch a changées. */
  const attempt = async (candidate: StepsSpec, patch: JsonPatchOperation[], index: number, touched: readonly number[], level: StepRepairLevel, spent: { usd: number | null; tin: number; tout: number }): Promise<Attempt> => {
    const r = await args.ports.replay(candidate, { index, purpose: level === 1 ? 'alternate' : 'agent' });
    const usd = addUsd(spent.usd, r.costUsd);
    const id = current.steps[index]?.id ?? '?';
    const fail = (detail: string): Attempt => {
      journal.push({ step_id: id, step_level: level, step_outcome: 'failed', cost_usd: usd, tokens_in: spent.tin, tokens_out: spent.tout, detail });
      return { kind: 'rejected', detail };
    };
    if (r.refusal !== null) return { kind: 'refused', failure: r.refusal };
    if (r.observedWriteAt !== null) return { kind: 'write', index: r.observedWriteAt };
    const repaired = (): void => {
      journal.push({ step_id: id, step_level: level, step_outcome: level === 1 ? 'alternate' : 'agent_repaired', cost_usd: usd, tokens_in: spent.tin, tokens_out: spent.tout, detail: null, patch });
    };
    if (!r.ok) {
      const f = r.stepFailure;
      if (f === null) return fail('candidate_rejected');
      const last = Math.max(index, ...touched);
      if (f.index <= last) return fail(f.failure.detail === 'target_ambiguous' ? 'intent_changed' : 'step_still_broken');
      // L'étape passe (et sa `post`) : une étape plus loin casse à son tour.
      repaired();
      return { kind: 'next', spec: candidate, patch, next: f };
    }
    // Portes : V0 (aucun refus), V1 et V2 (tenues par le rejeu : `post` de chaque étape, cible unique), V3, V4, puis V5.
    const replays: boolean[] = [];
    const n = args.replaysRequired ?? 2;
    for (let k = 0; k < n; k += 1) {
      const v5 = await args.ports.replay(candidate, { index, purpose: 'v5' });
      if (v5.refusal !== null) return { kind: 'refused', failure: v5.refusal };
      if (v5.observedWriteAt !== null) return { kind: 'write', index: v5.observedWriteAt };
      replays.push(v5.ok);
      if (!v5.ok) break;
    }
    const gates = evaluateGates({ classification: null, post: true, identity: 'ok', schema: r.schema, freshness: r.freshness, llmFreeReplays: replays }, { replaysRequired: n });
    if (gates.decision === 'reject') return fail(!r.schema ? 'repair_false_success' : 'stale');
    if (gates.decision === 'intent_changed') return fail('intent_changed');
    repaired();
    return { kind: 'done', spec: candidate, patch, replay: r, validated: gates.decision === 'promote' };
  };

  for (;;) {
    const index = pending.index;
    const step = current.steps[index];
    if (step === undefined) return { kind: 'failed', journal };
    const route = stepRepairRoute({ failureClass: pending.failure.failure_class, sideEffect: step.side_effect, session: args.context.session, tunnel: args.context.tunnel });
    if (route.kind === 'classifier') return { kind: 'classified', failure: pending.failure, journal };
    if (route.kind === 'write_step_broken') {
      journal.push({ step_id: step.id, step_level: null, step_outcome: 'failed', cost_usd: 0, tokens_in: 0, tokens_out: 0, detail: 'write_step_broken' });
      return { kind: 'write_step_broken', stepId: step.id, journal };
    }
    if (cascade.register(step.id) === 'step_cascade') return { kind: 'step_cascade', broken: cascade.broken, journal };

    let outcome: Attempt | null = null;
    // Niveau 1 : alternates enregistrées, 0 LLM. L'ancienne cible devient une alternate.
    if (route.levels.includes(1) && step.target !== undefined) {
      const old = primaryTarget(step.target);
      for (const alt of step.target.alternates) {
        const rest: StepAlternate[] = [old, ...step.target.alternates.filter((a) => a !== alt)];
        const patch: JsonPatchOperation[] = [{ op: 'replace', path: `/steps/${index}/target`, value: { ...alt, alternates: rest } }];
        const checked = validateStepPatch(current, patch, { runInputs: args.context.runInputs });
        if (!checked.ok) continue;
        const out = await attempt(checked.spec, patch, index, checked.touched, 1, { usd: 0, tin: 0, tout: 0 });
        if (out.kind !== 'rejected') {
          outcome = out;
          break;
        }
      }
    }
    // Niveaux 2 et 3 : agent borné (étape, puis segment une fois). Jamais avec session ni en tunnel.
    for (const level of [2, 3] as const) {
      if (outcome !== null || !route.levels.includes(level) || args.ports.agent === undefined) continue;
      const src = sourceOf(step.id);
      const res = await args.ports.agent({
        level,
        stepIndex: index,
        step,
        spec: current,
        intent: untrustedStepIntent(src?.intent ?? ''),
        pre: src?.pre ?? {},
        post: src?.post ?? [],
        budget: step.agent_budget,
        rules: [],
      });
      const spent = { usd: res.costUsd, tin: res.tokensIn, tout: res.tokensOut };
      if (res.patch === null || res.patch.length === 0) {
        journal.push({ step_id: step.id, step_level: level, step_outcome: 'failed', cost_usd: res.costUsd, tokens_in: res.tokensIn, tokens_out: res.tokensOut, detail: `agent_${res.stop}` });
        continue;
      }
      const checked = validateStepPatch(current, res.patch, { runInputs: args.context.runInputs });
      if (!checked.ok) {
        journal.push({ step_id: step.id, step_level: level, step_outcome: 'failed', cost_usd: res.costUsd, tokens_in: res.tokensIn, tokens_out: res.tokensOut, detail: checked.rejections[0]?.code ?? 'invalid_patch' });
        continue;
      }
      // Index de l'étape réparée après d'éventuelles insertions devant elle.
      const shifted = index + res.patch.filter((op) => op.op === 'add' && /^\/steps\/\d+$/.test(op.path) && Number(op.path.split('/')[2]) <= index).length;
      const out = await attempt(checked.spec, res.patch, shifted, checked.touched, level, spent);
      if (out.kind !== 'rejected') outcome = out;
    }

    if (outcome === null) {
      if (args.context.session || args.context.tunnel) return { kind: 'session_step_broken', stepId: step.id, journal };
      return { kind: 'failed', journal };
    }
    switch (outcome.kind) {
      case 'refused':
        return { kind: 'refused', failure: outcome.failure, journal };
      case 'write': {
        const id = current.steps[outcome.index]?.id ?? step.id;
        journal.push({ step_id: id, step_level: null, step_outcome: 'failed', cost_usd: 0, tokens_in: 0, tokens_out: 0, detail: 'write_step_broken' });
        return { kind: 'write_step_broken', stepId: id, journal };
      }
      case 'done':
        applied.push(...outcome.patch);
        return { kind: 'repaired', spec: outcome.spec, patch: applied, validated: outcome.validated, replay: outcome.replay, journal };
      case 'next':
        applied.push(...outcome.patch);
        current = outcome.spec;
        pending = outcome.next;
        continue;
    }
  }
}
