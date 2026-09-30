// SPDX-License-Identifier: AGPL-3.0-only
// Interface AgentEngine (02 P2, 03 « Moteur agentique ») : types seulement, aucune implémentation.
// Squelette de la tâche 0.6a ; figée par l'ADR 0001 à l'issue du spike (eval/spike-0.6a-decision.md).
// Le canal d'accès au navigateur reprend le contrat `agent_step` du tunnel (07 §3, tâche 0.6b) :
// actions à gros grain, références liées à un `snapshot_id`, refus `stale_ref` sans exécution.

/** Identifiants des moteurs comparés au spike 0.6a. */
export type AgentEngineId = 'home_loop' | 'stagehand';

/** Instantané de page renvoyé par chaque réponse du canal (07 §3). */
export interface AgentSnapshot {
  /** Identifiant opaque ; un `ref` n'est valable que pour l'instantané qui l'a émis. */
  readonly snapshotId: string;
  readonly url: string;
  /** Arbre d'accessibilité tronqué, sérialisé pour le modèle ; contenu non fiable (08 §4). */
  readonly accessibilityTree: string;
  /** Vrai si l'arbre a été coupé au plafond de nœuds. */
  readonly truncated: boolean;
}

/** Référence d'élément : n'a de sens qu'avec le `snapshotId` qui l'a produite. */
export interface AgentElementRef {
  readonly snapshotId: string;
  readonly ref: string;
}

/** Les cinq actions du contrat `agent_step` (07 §3). Aucune action d'écriture hors `allowWriteActions` (08 §4). */
export type AgentStepAction =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'click'; readonly target: AgentElementRef }
  | { readonly kind: 'type'; readonly target: AgentElementRef; readonly text: string }
  | { readonly kind: 'scroll'; readonly snapshotId: string; readonly direction: 'up' | 'down' }
  | { readonly kind: 'read'; readonly snapshotId?: string };

export type AgentStepActionKind = AgentStepAction['kind'];

/** Refus typés du canal. `stale_ref` : la page a changé, rien n'a été exécuté, un nouvel instantané est fourni. */
export type AgentStepErrorCode =
  | 'stale_ref'
  | 'domain_not_allowed'
  | 'method_not_allowed'
  | 'write_action_not_allowed'
  | 'challenge_detected'
  | 'timeout';

export type AgentStepResult =
  | { readonly ok: true; readonly snapshot: AgentSnapshot }
  | { readonly ok: false; readonly error: AgentStepErrorCode; readonly snapshot?: AgentSnapshot };

/**
 * Seul accès d'un moteur compatible `agent_step` au navigateur : exécuteur serveur (Playwright)
 * ou tunnel (extension). Le verrou de domaines et la liste fermée sont appliqués par le canal, pas par le modèle.
 */
export interface AgentStepChannel {
  snapshot(): Promise<AgentSnapshot>;
  execute(action: AgentStepAction): Promise<AgentStepResult>;
}

/** Tâche confiée au moteur. Le schéma est le schéma d'origine de l'utilisateur ; Ajv le vérifie hors du moteur (INV1). */
export interface AgentTask {
  readonly taskId: string;
  readonly instruction: string;
  readonly startUrl: string;
  /** Domaines de l'API ; toute autre navigation est refusée (08 §4, mesure 2). */
  readonly allowedDomains: readonly string[];
  /** JSON Schema de la sortie attendue. */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly allowWriteActions: boolean;
  readonly limits: AgentRunLimits;
}

export interface AgentRunLimits {
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  /** Plafond de coût du run en dollars ; dépassé, le run s'arrête (`run_budget_exceeded`). */
  readonly maxCostUsd: number;
}

/** Réglages du modèle du rôle `agent` (08 §1). La clé n'apparaît jamais ici : le transport la détient (INV8). */
export interface AgentModelSettings {
  readonly modelId: string;
  readonly temperature: number;
  readonly promptVersion: string;
}

/** Usage renvoyé par le fournisseur, cache et raisonnement compris (08 §1, INV4). */
export interface AgentUsage {
  readonly tokensIn: number;
  readonly tokensCached: number;
  readonly tokensOut: number;
  readonly tokensReasoning: number;
  readonly usageEstimated: boolean;
}

/**
 * Une étape de trace. On consigne un sélecteur sémantique (rôle + nom accessible), jamais le seul `ref`,
 * qui change à chaque instantané : c'est ce qui permet la compilation E6 → E5 (04 §3.1).
 */
export interface AgentTraceStep {
  readonly index: number;
  readonly action: AgentStepActionKind | 'done';
  readonly semanticTarget?: { readonly role: string; readonly name: string };
  readonly url: string;
  readonly error?: AgentStepErrorCode;
  readonly durationMs: number;
}

export type AgentRunStatus = 'done' | 'max_steps' | 'timeout' | 'budget_exceeded' | 'error';

export interface AgentRunResult {
  readonly status: AgentRunStatus;
  /** Sortie finale non encore validée ; `null` sans `done`. Un succès exige Ajv et, sur le banc, la référence. */
  readonly output: unknown;
  readonly steps: readonly AgentTraceStep[];
  readonly usage: AgentUsage;
  /** `null` si le prix du modèle est absent : jamais 0 (08 §1). */
  readonly costUsd: number | null;
  readonly durationMs: number;
  /** Classe d'erreur LLM ou du classifieur (08 §1, 04 §7) quand le statut n'est pas `done`. */
  readonly failureClass?: string;
}

export interface AgentEngineCapabilities {
  /** Vrai si le moteur n'accède au navigateur que par `AgentStepChannel` (critère de départage du spike, 07 §3). */
  readonly agentStepCompatible: boolean;
}

export interface AgentRunContext {
  /** Fourni aux moteurs compatibles `agent_step` ; un moteur tiers ne passe jamais par le tunnel (07 §3). */
  readonly channel?: AgentStepChannel;
  readonly model: AgentModelSettings;
  readonly signal?: AbortSignal;
}

export interface AgentEngine {
  readonly id: AgentEngineId;
  /** Version exacte (ex. `3.7.3` pour Stagehand, commit pour la boucle maison). */
  readonly version: string;
  readonly capabilities: AgentEngineCapabilities;
  run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult>;
}
