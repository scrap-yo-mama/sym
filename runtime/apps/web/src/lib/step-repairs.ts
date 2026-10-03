// SPDX-License-Identifier: AGPL-3.0-only
// Reprise par étape (19 § 4, r2 R12, tâche 2.13) : lecture des essais de reprise d'un run (`RunAttempt.step_*`) et mise
// en lignes du diff de l'étape (patch RFC 6902). Aucune décision ici : la console montre ce que le serveur a journalisé.
// Les valeurs du patch (rôle et nom d'un élément lus sur une page) sont du texte non fiable : affichées comme texte brut.
import type { components } from '@runtime/client';

export type Run = components['schemas']['Run'];
export type RunAttempt = components['schemas']['RunAttempt'];
export type StepPatchOperation = components['schemas']['StepPatchOperation'];
export type InstructedSteps = components['schemas']['InstructedSteps'];
export type StepPost = components['schemas']['StepPost'];

/** Essai de reprise : un essai dont l'étape est connue. */
export type StepAttempt = RunAttempt & { step_id: string };

/** Essais de reprise d'un run, dans l'ordre des essais (une ligne par essai dont `step_id` est non nul). */
export function stepAttempts(run: Pick<Run, 'attempts'>): StepAttempt[] {
  return run.attempts.filter((attempt): attempt is StepAttempt => typeof attempt.step_id === 'string' && attempt.step_id !== '').sort((a, b) => a.index - b.index);
}

/** Ligne du diff d'une étape : signe (+ ajout, − retrait, ~ remplacement), chemin et valeur en texte brut. */
export type PatchLine = { sign: '+' | '−' | '~'; op: StepPatchOperation['op']; path: string; value: string | null };

const SIGNS: Record<StepPatchOperation['op'], PatchLine['sign']> = { add: '+', remove: '−', replace: '~' };

/** Valeur d'une opération en texte (JSON compact) ; jamais interprétée. */
function valueText(operation: StepPatchOperation): string | null {
  if (operation.op === 'remove' || !('value' in operation) || operation.value === undefined) return null;
  return typeof operation.value === 'string' ? JSON.stringify(operation.value) : (JSON.stringify(operation.value) ?? 'null');
}

/** Lignes du diff de l'étape ; liste vide quand l'essai n'a rien changé. */
export function patchLines(patch: readonly StepPatchOperation[] | null | undefined): PatchLine[] {
  return (patch ?? []).map((operation) => ({ sign: SIGNS[operation.op], op: operation.op, path: operation.path, value: valueText(operation) }));
}

/** Total des jetons d'un essai (entrée, sortie et raisonnement ; le cache est compris dans l'entrée), null sans mesure. */
export function attemptTokens(attempt: RunAttempt): { in: number; out: number; estimated: boolean } | null {
  const tokens = attempt.tokens;
  if (!tokens) return null;
  return { in: tokens.in, out: tokens.out + tokens.reasoning, estimated: tokens.estimated };
}

/** Coût total des reprises d'un run (somme des coûts connus ; null si aucun n'est connu). */
export function repairsCost(attempts: readonly RunAttempt[]): number | null {
  const known = attempts.map((attempt) => attempt.cost_usd).filter((cost): cost is number => typeof cost === 'number');
  return known.length === 0 ? null : Math.round(known.reduce((sum, cost) => sum + cost, 0) * 1e6) / 1e6;
}

/** Étapes instruites confirmées par un humain (date et auteur présents). */
export function instructedConfirmed(instructed: Pick<InstructedSteps, 'confirmed_by' | 'confirmed_at'> | null | undefined): boolean {
  return Boolean(instructed && instructed.confirmed_by && instructed.confirmed_at);
}

/**
 * Section « agent instruit » de la fiche : seulement pour une API non compilable qui a des étapes instruites, jamais sur
 * une API bloquée (aucune reprise après un blocage, ni tunnel ni agent instruit) ni pour l'admin en métadonnées seules.
 */
export function instructedOffered(detail: { status: string; metadata_only: boolean; instructed?: InstructedSteps | null }): boolean {
  return detail.status !== 'bloquee' && !detail.metadata_only && detail.instructed?.compilable === 'no' && detail.instructed.steps.length > 0;
}

/** Texte d'une condition de sortie (`post`), en code stable et valeurs brutes : `kind`, puis rôle, nom ou valeur. */
export function postParts(post: StepPost): { kind: StepPost['kind']; detail: string | null } {
  if (post.kind === 'element_present' || post.kind === 'element_absent') return { kind: post.kind, detail: [post.role, post.name].filter(Boolean).join(' · ') || null };
  if (post.kind === 'url_contains' || post.kind === 'text_present') return { kind: post.kind, detail: post.value ?? null };
  return { kind: post.kind, detail: null };
}
