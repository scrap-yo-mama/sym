// SPDX-License-Identifier: AGPL-3.0-only
// Bac à sable du code généré (INV7, 08 §3, tâche 1.5) : types et interfaces seulement, aucune implémentation.
// Implémentations : `apps/worker/src/sandbox/` (processus enfant à environnement vide + isolated-vm ; spike QuickJS).

/** Moteurs d'isolat. `quickjs` : spike (plan B), jamais le défaut sans mesures (08 §3). */
export type SandboxEngineId = 'isolated-vm' | 'quickjs';

/** Plafonds d'une exécution. La limite d'isolat est indicative : le plafond qui compte est celui du processus. */
export interface SandboxLimits {
  /** Temps total (mur) de l'exécution ; au-delà, le processus enfant est tué (SIGKILL). */
  readonly timeoutMs: number;
  /** Mémoire de l'isolat, en Mo (128 par défaut, à valider). */
  readonly memoryMb: number;
  /** Plafond RSS du processus enfant, en Mo (défaut : dérivé de `memoryMb`). */
  readonly processMemoryMb?: number;
  /** Taille maximale du résultat sérialisé en JSON, en octets. */
  readonly maxResultBytes?: number;
  /**
   * Budget d'octets reçus de l'enfant sur tout le run (journal, éléments, requêtes, résultat), en octets ; au-delà,
   * violation `output_limit` et enfant tué. Défaut : 128 Mio.
   */
  readonly maxIpcBytes?: number;
  /** Plafond de temps CPU du processus enfant (RLIMIT_CPU), en secondes. Défaut : 2 × `timeoutMs` + 5 s. */
  readonly cpuLimitSeconds?: number;
}

/** Requête `ctx.fetch` telle que validée par l'hôte (schéma, taille, domaine). */
export interface SandboxFetchRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Réponse renvoyée au script : valeurs JSON seulement (aucun objet de l'hôte). */
export interface SandboxFetchResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Vrai si le corps a été coupé au plafond. */
  readonly truncated: boolean;
}

/** Raisons de `sandbox_violation` (journalisées, jamais montrées au script au-delà du code). */
export type SandboxViolationReason =
  | 'domain_not_allowed'
  | 'ssrf_blocked'
  | 'method_not_allowed'
  | 'forbidden_header'
  | 'forbidden_global'
  | 'forbidden_import'
  | 'invalid_bridge_call'
  | 'bridge_quota'
  | 'time_limit'
  | 'memory_limit'
  | 'output_limit'
  | 'env_not_empty'
  | 'protocol'
  | 'child_crashed';

export interface SandboxViolation {
  readonly reason: SandboxViolationReason;
  /** Détail court (nom de domaine, global touché) ; jamais de secret. */
  readonly detail?: string;
}

/**
 * Ponts passés au script (08 §3) : uniquement des fonctions côté hôte, valeurs reçues **non fiables** (JSON parsé)
 * et validées par chaque pont (schéma, taille, domaine). Un refus lève une erreur dont `code` est une raison de
 * violation ; le moteur la relaie au script (code seul) et la signale par `violation`.
 */
export interface SandboxBridges {
  fetch(request: unknown): Promise<SandboxFetchResponse>;
  log(args: unknown): void;
  emit(item: unknown): void;
  /**
   * `ctx.page.*` (E3, tâche 1.6, D-29) : sous-ensemble de Playwright relayé, liste fermée d'opérations validées par
   * l'hôte (`{ op, args }` en JSON). Absent hors navigateur : l'appel est refusé (`page_unavailable`).
   */
  page?(request: unknown): Promise<unknown>;
  /** Puits unique des violations : journalise `sandbox_violation`. */
  violation(violation: SandboxViolation): void;
  /** Fin d'exécution : annule les requêtes en vol. */
  close?(): void;
}

export type SandboxOutcome = 'ok' | 'script_error' | 'timeout' | 'memory' | 'violation' | 'crashed';

export interface SandboxResult {
  readonly engine: SandboxEngineId;
  readonly outcome: SandboxOutcome;
  /** Valeur de retour du script (JSON), si `outcome` = `ok`. */
  readonly value?: unknown;
  /** Message d'erreur du script, tronqué ; contenu non fiable. */
  readonly error?: string;
  readonly violations: readonly SandboxViolation[];
  readonly durationMs: number;
  /** Vrai si le processus enfant a été tué avant d'avoir rendu son résultat. */
  readonly killed: boolean;
  /** Délai entre l'échéance (temps ou mémoire) et la fin effective du processus, mesuré sur le processus. */
  readonly killLatencyMs?: number;
  /** RSS maximale observée du processus enfant, en Mo (échantillonnée). */
  readonly peakRssMb?: number;
}

export interface SandboxRunOptions {
  /** Entrée du script (JSON), visible sous `input`. */
  readonly input?: unknown;
  /** Annulation du run (annulé, bail perdu, arrêt du worker) : l'enfant est tué (`crashed`, `aborted`). */
  readonly signal?: AbortSignal;
  /**
   * Violations constatées par l'hôte HORS d'un appel de pont (tâche 1.6 : requête de la page coupée par la politique
   * de domaines pendant ou après un `ctx.page.evaluate`). Le moteur passe son puits : chaque appel journalise la
   * violation et tue l'enfant aussitôt, comme une violation de pont.
   */
  readonly watch?: (violate: (violation: SandboxViolation) => void) => void;
}

/** `SandboxEngine { run(code, bridges, limits) }` (08 §3). */
export interface SandboxEngine {
  readonly id: SandboxEngineId;
  run(code: string, bridges: SandboxBridges, limits: SandboxLimits, options?: SandboxRunOptions): Promise<SandboxResult>;
}
