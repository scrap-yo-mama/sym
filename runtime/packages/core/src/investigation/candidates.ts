// SPDX-License-Identifier: AGPL-3.0-only
// Plan d'essai de l'enquête (tâche 2.1, 04 §3.3) : pour chaque stratégie déclarative issue de la proposition (un
// gisement de données), les niveaux E1-E3 que le worker peut servir, et les voies agentiques E4 (mise en forme par le
// LLM d'une page obtenue en E1) et E6 (agent de bout en bout, serveur seulement, ADR 0001) quand leur rôle LLM est
// configuré ; croisés avec les réseaux AUTORISÉS (politique de l'API et proxys de l'admin, jamais élargis), chiffrés
// (`estimateCostUsd`) et triés (`orderTrials`). E5 n'est pas essayé directement : il naît de la compilation d'une trace
// E6 réussie (04 §3.1). Le tunnel ne sert que s'il est dans la politique réseau de l'API, jamais E6 ni un script.
import type { Execution, Network } from '../model/enums.js';
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

/** Caractères d'entrée de la mise en forme E4 (`limits.max_input_chars` par défaut de 2.4). */
const E4_MAX_INPUT_CHARS = 60_000;

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
      const spec = { schema_version: 1, kind: 'agent_fetch', request: { url: input.pageUrl, allowed_hosts: allowedHosts }, via: 'fetch', instruction: input.instruction };
      add('agent_fetch', network, 'page', spec, false, input.documentBytes, input.agentic.extract, Math.ceil(Math.min(input.documentBytes, E4_MAX_INPUT_CHARS) / 4));
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

/** Version retenue au terme de l'enquête, ou refus (`not_compilable`). */
export type RetainedStrategy =
  | { readonly ok: true; readonly execution: Execution; readonly network: Network; readonly spec: unknown; readonly estCostUsd: number | null }
  | { readonly ok: false; readonly reason: 'not_compilable' };

/**
 * Stratégie gardée pour le couple conforme (04 §3.1) : E6 (`agent`) ne devient JAMAIS courant sans « agent instruit »
 * (2.13) ; sa trace compilée en E5 (`hybrid`, rejouée sans LLM) est gardée, au coût mesuré de ses exécutions hors LLM.
 * Sans compilation : `not_compilable` (transition 2 ; code de raison dédié avec 2.13). Les autres niveaux : tels quels.
 */
export function retainedStrategy(entry: Pick<PlanEntry, 'execution' | 'network' | 'spec' | 'est_cost_usd'>, compiled: unknown, measuredUsd: number | null): RetainedStrategy {
  if (entry.execution !== 'agent') return { ok: true, execution: entry.execution, network: entry.network, spec: entry.spec, estCostUsd: entry.est_cost_usd };
  if (compiled === undefined || compiled === null) return { ok: false, reason: 'not_compilable' };
  return { ok: true, execution: 'hybrid', network: entry.network, spec: compiled, estCostUsd: measuredUsd };
}
