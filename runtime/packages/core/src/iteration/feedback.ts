// SPDX-License-Identifier: AGPL-3.0-only
// Retour d'utilisateur (tâche 3.14, 19 §6, r3 R3) : entre dans la source du brouillon (`source.feedback[]`), section
// `<user_feedback>` distincte de `<trusted_rules>`. Le texte n'entre QUE dans le dossier de sa propre API ; pour toute autre
// API, même domaine compris, seuls `kind` et `field` normalisés passent, sans texte. Il ne peut jamais élargir une garde :
// `wideningWarnings` l'en informe, et la protection reste dans le code (`assert_feedback_cannot_widen`).
import { wideningWarnings, type WideningWarning } from '../rules/widening.js';

export const FEEDBACK_KINDS = ['wrong_value', 'missing_field', 'extra_items', 'schema', 'step'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_TEXT_MAX = 2_000;
/** Retours gardés dans la source d'une version : au-delà, les plus anciens sortent (la source reste bornée). */
export const FEEDBACK_KEEP = 20;

export type FeedbackEntry = {
  readonly at: string;
  readonly author_id: string;
  readonly origin: 'mcp' | 'ui';
  readonly kind: FeedbackKind;
  readonly field: string | null;
  readonly text: string;
  readonly expected_ref: null;
};

const FIELD = /^[A-Za-z0-9_.[\]-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

export const cleanFeedbackText = (raw: string): string => raw.replace(CONTROL, ' ').trim().slice(0, FEEDBACK_TEXT_MAX);

export function buildFeedback(input: { text: string; kind?: FeedbackKind; field?: string | null; origin: 'mcp' | 'ui'; authorId: string; at: Date }): { entry: FeedbackEntry; widening_warnings: WideningWarning[] } | null {
  const text = cleanFeedbackText(input.text);
  if (text === '') return null;
  const field = input.field !== undefined && input.field !== null && FIELD.test(input.field) ? input.field : null;
  const entry: FeedbackEntry = { at: input.at.toISOString(), author_id: input.authorId, origin: input.origin, kind: input.kind ?? 'wrong_value', field, text, expected_ref: null };
  return { entry, widening_warnings: wideningWarnings(text) };
}

/** Ce qu'une autre API peut apprendre d'un retour : `kind` et `field` normalisés, jamais le texte (une valeur d'item peut y figurer). */
export function feedbackSignal(entries: readonly FeedbackEntry[]): { kind: FeedbackKind; field: string | null }[] {
  return entries.map((e) => ({ kind: e.kind, field: e.field }));
}

/** Section du prompt de la propre API (texte non fiable, entre balises ; jamais une règle de confiance). */
export function renderUserFeedback(entries: readonly FeedbackEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.slice(-FEEDBACK_KEEP).map((e) => `- [${e.kind}${e.field === null ? '' : `:${e.field}`}] ${e.text.replace(/<\/?user_feedback>/gi, '')}`);
  return `<user_feedback>\n${lines.join('\n')}\n</user_feedback>`;
}

/** Ajoute un retour à la liste de la source, bornée. */
export const appendFeedback = (existing: readonly FeedbackEntry[], entry: FeedbackEntry): FeedbackEntry[] => [...existing, entry].slice(-FEEDBACK_KEEP);
