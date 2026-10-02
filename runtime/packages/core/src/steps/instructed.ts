// SPDX-License-Identifier: AGPL-3.0-only
// Mode « agent instruit » (19 §4, r2 R13, arbitrage n° 5, tâche 2.13) : pour une API NON compilable seulement, choisi
// explicitement API par API, jamais par défaut ni proposé après un blocage. Les `instructed_steps[]` (intentions et
// `post`, sans `target`) viennent de la compilation E6 : non fiables tant qu'un HUMAIN ne les a pas confirmées (console ou
// élicitation, Figure 1 de 19). La confirmation porte l'empreinte des étapes affichées : toute modification l'invalide.
// Sans opt-in, aucune issue « agent à chaque run » : l'enquête finit `not_compilable` (2 ou 21), la réparation s'arrête
// (13), stratégie précédente gardée.
import { createHash } from 'node:crypto';
import type { StatusEventInput } from '../status/types.js';
import { sanitizeStepIntent } from './intent.js';
import { STEP_REPAIR_DEFAULTS, validatePostList, type StepAgentBudget, type StepPost } from './spec.js';

export type InstructedStep = { readonly id: string; readonly intent: string; readonly post: readonly StepPost[] };
export type InstructedConfirmation = { readonly by: string | null; readonly at: string | null; readonly sha256: string };
export type Compilable = 'yes' | 'unknown' | 'no';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_INSTRUCTED = 30;

/** Étapes instruites validées ; intentions nettoyées comme la mémoire (invisibles, balises, 200 caractères). */
export function validateInstructedSteps(input: unknown): { ok: true; steps: InstructedStep[] } | { ok: false; errors: readonly string[] } {
  if (!Array.isArray(input) || input.length > MAX_INSTRUCTED) return { ok: false, errors: [`instructed_steps : liste de ${MAX_INSTRUCTED} étapes au plus attendue`] };
  const errors: string[] = [];
  const steps: InstructedStep[] = [];
  input.forEach((raw, i) => {
    const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const extra = Object.keys(r).filter((k) => !['id', 'intent', 'post'].includes(k));
    if (extra.length > 0) errors.push(`instructed_steps[${i}] : champ non autorisé`);
    const id = typeof r['id'] === 'string' && ID_RE.test(r['id']) ? r['id'] : null;
    if (id === null) errors.push(`instructed_steps[${i}].id : identifiant attendu`);
    const intent = sanitizeStepIntent(r['intent']);
    if (intent === '') errors.push(`instructed_steps[${i}].intent : intention non vide attendue`);
    const post = validatePostList(r['post'], `instructed_steps[${i}].post`);
    if (!post.ok) errors.push(...post.errors);
    steps.push({ id: id ?? '', intent, post: post.ok ? post.post : [] });
  });
  if (new Set(steps.map((s) => s.id)).size !== steps.length) errors.push('instructed_steps : identifiants uniques attendus');
  return errors.length === 0 ? { ok: true, steps } : { ok: false, errors };
}

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : typeof v === 'object' && v !== null ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : (JSON.stringify(v) ?? 'null');

/** Empreinte des étapes affichées à l'utilisateur : c'est elle qu'il confirme. */
export function instructedStepsSha256(steps: readonly InstructedStep[]): string {
  return createHash('sha256').update(canonical(steps)).digest('hex');
}

export type InstructedActivation = { ok: true } | { ok: false; reason: 'compilable' | 'no_instructed_steps' | 'instructed_steps_unconfirmed' };

/** Le mode s'active-t-il ? Jamais sans confirmation humaine des étapes EXACTES, ni sur une API compilable. */
export function canActivateInstructedMode(args: { compilable: Compilable; steps: readonly InstructedStep[] | null; confirmation: InstructedConfirmation | null }): InstructedActivation {
  if (args.compilable === 'yes') return { ok: false, reason: 'compilable' };
  if (args.steps === null || args.steps.length === 0) return { ok: false, reason: 'no_instructed_steps' };
  const c = args.confirmation;
  if (c === null || c.by === null || c.at === null || c.sha256 !== instructedStepsSha256(args.steps)) return { ok: false, reason: 'instructed_steps_unconfirmed' };
  return { ok: true };
}

/** Issue quand seule une stratégie « agent à chaque run » reste. */
export function nonCompilableOutcome(args: { instructedMode: boolean; phase: 'investigation' | 'repair' }): { kind: 'instructed' } | { kind: 'not_compilable'; status: StatusEventInput } {
  if (args.instructedMode) return { kind: 'instructed' };
  return {
    kind: 'not_compilable',
    status: args.phase === 'investigation' ? { type: 'investigation_failed', cause: 'not_compilable' } : { type: 'repair_failed', cause: 'not_compilable' },
  };
}

/** Coût estimé d'un run instruit, affiché avant chaque lancement : somme des budgets d'étape (plafond, pas une moyenne). */
export function estimateInstructedRunUsd(steps: readonly { readonly id?: string; readonly agent_budget?: StepAgentBudget }[]): number {
  const sum = steps.reduce((n, s) => n + (s.agent_budget ?? STEP_REPAIR_DEFAULTS.agentBudget).max_usd, 0);
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * Consigne d'un run instruit (19 §4) : la consigne de l'API, puis les étapes instruites CONFIRMÉES par un humain (seules
 * admises ici : l'appelant a vérifié `canActivateInstructedMode`), nettoyées, numérotées avec leur `post`, bornées.
 */
export function instructedInstruction(base: string, steps: readonly InstructedStep[], max = 2000): string {
  const lines = steps.map((s, i) => `${i + 1}. ${sanitizeStepIntent(s.intent)}${s.post.length === 0 ? '' : ` (attendu : ${JSON.stringify(s.post)})`}`);
  const out = `${base.trim()}\nÉtapes confirmées par l’utilisateur :\n${lines.join('\n')}`;
  return out.length <= max ? out : out.slice(0, max);
}
