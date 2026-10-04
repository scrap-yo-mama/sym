// SPDX-License-Identifier: AGPL-3.0-only
// Plan d'essai de l'enquête (tâche 2.1, 04 §3.3) : pour chaque stratégie déclarative issue de la proposition (un
// gisement de données), les niveaux E1-E3 que le worker peut servir, et les voies agentiques E4 (mise en forme par le
// LLM d'une page obtenue en E1) et E6 (agent de bout en bout, serveur seulement, ADR 0001) quand leur rôle LLM est
// configuré ; croisés avec les réseaux AUTORISÉS (politique de l'API et proxys de l'admin, jamais élargis), chiffrés
// (`estimateCostUsd`) et triés (`orderTrials`). E5 n'est pas essayé directement : il naît de la compilation d'une trace
// E6 réussie (04 §3.1). De même, une stratégie déclarative à source `html` n'est pas un couple du plan : elle naît de la
// compilation d'un essai E4 conforme, vérifiée sans LLM (html-compile.ts, UX-20). Le tunnel ne sert que s'il est dans la
// politique réseau de l'API, jamais E6 ni un script.
import type { AgentTraceStep } from '../agent/engine.js';
import { E4_SAMPLE_INPUT_CHARS, E4_SAMPLE_ITEMS, type HybridSpec } from '../agent/specs.js';
import type { Execution, Network } from '../model/enums.js';
import { compileHybridToSteps } from '../steps/compile.js';
import type { StepSource } from '../steps/spec.js';
import { estimateCostUsd, orderTrials, type TokenPrice, type TrialPair } from './plan.js';
import type { BuiltStrategy } from './proposal.js';

/** Réseau essayable : mode et prix au Go (0 pour `direct` et `tunnel`). */
export type PlanNetwork = { readonly mode: Network; readonly perGbUsd: number };

export type PlanAgentic = {
  /** Prix du rôle `extract` (E4) : `undefined` si le rôle n'est pas configuré, `null` si son prix est inconnu. */
  readonly extract?: TokenPrice | null;
  /** Prix du rôle `agent` (E6). */
  readonly agent?: TokenPrice | null;
};

export type PlanEntry = TrialPair & {
  /** Spécification de la stratégie candidate (04b §2 pour E1-E3, `specs.ts` de 2.4 pour E4 et E6). */
  readonly spec: Record<string, unknown>;
  readonly paginated: boolean;
};

export type BuildPlanInput = {
  readonly strategies: readonly BuiltStrategy[];
  readonly networks: readonly PlanNetwork[];
  /** Chromium disponible (E2, E3, E6) ; faux sous `DISABLE_BROWSER`. */
  readonly browser: boolean;
  readonly agentic: PlanAgentic;
  /** Page de la demande (voies agentiques) et son hôte. */
  readonly pageUrl: string;
  readonly pageHost: string;
  /** Consigne des voies agentiques : la demande de l'utilisateur (jamais un texte du site). */
  readonly instruction: string;
  /** Octets du document de la page et de toute la passe de reconnaissance (sous-ressources). */
  readonly documentBytes: number;
  readonly totalBytes: number;
};


/** Couples essayables, chiffrés et triés par coût croissant (puis E, puis N, puis l'ordre des gisements). */
export function buildTrialPlan(input: BuildPlanInput): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const add = (execution: Execution, network: PlanNetwork, source: string, spec: Record<string, unknown>, paginated: boolean, bytes: number, llm: TokenPrice | null, tokensIn?: number) => {
    const est = estimateCostUsd(execution, network.mode, { bytes, pages: 1, perGbUsd: network.perGbUsd, llmPrice: llm, ...(tokensIn === undefined ? {} : { tokensIn }) });
    entries.push({ execution, network: network.mode, source, est_cost_usd: est, spec, paginated });
  };
  for (const network of input.networks) {
    const tunnel = network.mode === 'tunnel';
    for (const s of input.strategies) {
      const spec = s.spec as unknown as Record<string, unknown>;
      add('fetch', network, s.candidate.id, spec, s.paginated, s.candidate.bytes, null);
      if (input.browser || tunnel) {
        add('fetch_in_page', network, s.candidate.id, spec, s.paginated, input.documentBytes + s.candidate.bytes, null);
        // E3 déclaratif : requêtes GET seulement (navigation).
        if (s.candidate.request.method === 'GET') add('playwright', network, s.candidate.id, spec, s.paginated, Math.max(input.totalBytes, s.candidate.bytes), null);
      }
    }
    const allowedHosts = [input.pageHost];
    if (input.agentic.extract !== undefined && !tunnel) {
      // Essai d'enquête en échantillon (banc R06, R08) : les premiers éléments de la page 1 seulement, entrée bornée ; la liste
      // entière est relue par la stratégie compilée, sans LLM. Retiré de la version retenue (`retainedStrategy`).
      const spec = { schema_version: 1, kind: 'agent_fetch', request: { url: input.pageUrl, allowed_hosts: allowedHosts }, via: 'fetch', instruction: input.instruction, limits: { sample_items: E4_SAMPLE_ITEMS } };
      add('agent_fetch', network, 'page', spec, false, input.documentBytes, input.agentic.extract, Math.ceil(Math.min(input.documentBytes, E4_SAMPLE_INPUT_CHARS) / 4));
    }
    // E6 limité au serveur (0.6b, ADR 0001) : jamais en tunnel.
    if (input.agentic.agent !== undefined && input.browser && !tunnel) {
      const spec = { schema_version: 1, kind: 'agent', start_url: input.pageUrl, allowed_hosts: allowedHosts, instruction: input.instruction };
      add('agent', network, 'page', spec, false, input.totalBytes * 3, input.agentic.agent);
    }
  }
  const order = [...input.strategies.map((s) => s.candidate.id), 'page'];
  return orderTrials(entries, order) as PlanEntry[];
}

/** Spec E4 sans l'échantillon de l'essai d'enquête : la version retenue extrait toute la page à chaque run. */
function withoutSample(spec: unknown): unknown {
  if (typeof spec !== 'object' || spec === null) return spec;
  const limits = (spec as { limits?: unknown }).limits;
  if (typeof limits !== 'object' || limits === null || !('sample_items' in limits)) return spec;
  const { sample_items: _sample, ...rest } = limits as Record<string, unknown>;
  return { ...spec, limits: rest };
}

/** Version retenue au terme de l'enquête, ou refus (`not_compilable`). */
export type RetainedStrategy =
  | {
      readonly ok: true;
      readonly execution: Execution;
      readonly network: Network;
      readonly spec: unknown;
      readonly estCostUsd: number | null;
      /** E5 compilée d'une trace E6 (2.13) : `compilable = yes`. */
      readonly compilable?: 'yes';
      /** Source des étapes (intent, pre, post) quand l'E5 compilée est au format `steps` (2.13, 19 §4). */
      readonly sourceSteps?: readonly StepSource[];
    }
  | { readonly ok: false; readonly reason: 'not_compilable' };

/** Contexte de la compilation au grain de l'étape : modèle de l'agent, date, trace de l'E6 (URL avant / après chaque action). */
export type StepsCompileContext = { readonly modelId: string | null; readonly at: string; readonly trace?: readonly AgentTraceStep[] };

/**
 * Stratégie gardée pour le couple conforme (04 §3.1) : E6 (`agent`) ne devient JAMAIS courant sans « agent instruit »
 * (2.13) ; sa trace compilée en E5 (`hybrid`, rejouée sans LLM) est gardée, au coût mesuré de ses exécutions hors LLM,
 * AU FORMAT `steps` (2.13, 19 §4 : « E5 adopte un format kind: "steps" ») avec la source de ses étapes, pour que la
 * reprise par étape s'applique aux API nées d'une enquête ; repli sur le hybride seulement si la conversion échoue
 * (étape ou extraction déléguée à l'agent). Sans compilation : `not_compilable` (transition 2). Les autres niveaux : tels quels.
 */
export function retainedStrategy(
  entry: Pick<PlanEntry, 'execution' | 'network' | 'spec' | 'est_cost_usd'>,
  compiled: unknown,
  measuredUsd: number | null,
  context: StepsCompileContext = { modelId: null, at: new Date().toISOString() },
): RetainedStrategy {
  if (entry.execution === 'agent_fetch') return { ok: true, execution: entry.execution, network: entry.network, spec: withoutSample(entry.spec), estCostUsd: entry.est_cost_usd };
  if (entry.execution !== 'agent') return { ok: true, execution: entry.execution, network: entry.network, spec: entry.spec, estCostUsd: entry.est_cost_usd };
  if (compiled === undefined || compiled === null) return { ok: false, reason: 'not_compilable' };
  let steps: ReturnType<typeof compileHybridToSteps>;
  try {
    steps = compileHybridToSteps(compiled as HybridSpec, context);
  } catch {
    steps = null;
  }
  if (steps === null) return { ok: true, execution: 'hybrid', network: entry.network, spec: compiled, estCostUsd: measuredUsd, compilable: 'yes' };
  return { ok: true, execution: 'hybrid', network: entry.network, spec: steps.spec, estCostUsd: measuredUsd, compilable: 'yes', sourceSteps: steps.source };
}

/** Octets supposés d'une page de données importée (aucune reconnaissance n'a mesuré la réponse) : chiffre les proxys. */
const IMPORTED_BYTES_ESTIMATE = 200_000;

/**
 * Plan d'essai d'une stratégie IMPORTÉE (tâche 3.12, 16 § 6) : son niveau d'exécution, croisé avec les réseaux AUTORISÉS
 * par la politique de l'API importée (jamais élargis), chiffré et trié par coût croissant (INV2). JAMAIS le tunnel, même
 * si la politique l'admet : la spécification (URL, en-têtes, paramètres) vient d'un fichier écrit par un tiers, et le
 * tunnel la jouerait avec les cookies et l'identité de l'utilisateur (INV5). Sans Chromium, E2 et E3 n'ont donc aucun
 * essai. Source `import`.
 */
export function buildImportedPlan(input: { readonly execution: Execution; readonly spec: Record<string, unknown>; readonly networks: readonly PlanNetwork[]; readonly browser: boolean }): PlanEntry[] {
  const pagination = input.spec['pagination'];
  const paginated = typeof pagination === 'object' && pagination !== null && (pagination as { type?: unknown }).type !== 'none';
  const entries: PlanEntry[] = input.networks
    .filter((n) => n.mode !== 'tunnel' && (input.execution === 'fetch' || input.browser))
    .map((n) => ({
      execution: input.execution,
      network: n.mode,
      source: 'import',
      est_cost_usd: estimateCostUsd(input.execution, n.mode, { bytes: IMPORTED_BYTES_ESTIMATE, pages: 1, perGbUsd: n.perGbUsd, llmPrice: null }),
      spec: input.spec,
      paginated,
    }));
  return orderTrials(entries, ['import']) as PlanEntry[];
}
