// SPDX-License-Identifier: AGPL-3.0-only
// Juge LLM CONSULTATIF (tâche 2.12, 19 §3, arbitrage n° 3, r4 R6 à R10) : rôle `judge`, désactivé par défaut, activé par
// l'admin (« juge non étalonné, avis consultatif »). Il SIGNALE (`judge_flag` sur la fiche du run) et ne bloque RIEN : ni
// statut, ni version, ni schéma, ni règle (`applyJudgement` ne rend que l'avis et la raison). Entrée par liste blanche :
// schéma, fiche de qualité, items MASQUÉS (couches 1 et 2) dans `<untrusted_items_TOKEN>` ; sortie fermée validée ici
// (raison de 200 caractères au plus) ; prompt jamais journalisé. Échantillon choisi par le code : 3 à 5 items (pires
// scores, tirage à graine journalisée, dernier item, un item de baseline), 200 caractères par champ.
import { createHash } from 'node:crypto';
import { maskItemsForLlm, maskTextForLlm } from '../privacy/llm-mask.js';
import { SENTINEL_VALUES, shapeOf, type RunProfile } from './profile.js';

export const JUDGE_VERDICTS = ['ok', 'wrong', 'unsure'] as const;
export type JudgeVerdict = { readonly field: string; readonly verdict: (typeof JUDGE_VERDICTS)[number]; readonly indices: readonly number[]; readonly reason: string };
export type Judgement = { readonly flag: boolean; readonly verdicts: readonly JudgeVerdict[] };
export type JudgeTrigger = 'investigation' | 'repair' | 'anomaly';
export type RunJudge = Judgement & { readonly trigger: JudgeTrigger };

/** Réponse fermée du rôle `judge`. */
export const JUDGE_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'verdict', 'indices', 'reason'],
        properties: {
          field: { type: 'string', maxLength: 64 },
          verdict: { enum: [...JUDGE_VERDICTS] },
          indices: { type: 'array', maxItems: 5, items: { type: 'integer', minimum: 0, maximum: 99 } },
          reason: { type: 'string', maxLength: 200 },
        },
      },
    },
  },
} as const;

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Réponse relue par le code (en plus d'Ajv dans la couche LLM) ; `null` : illisible, aucun avis. */
export function parseJudgement(value: unknown): Judgement | null {
  if (!isRecord(value) || !Array.isArray(value['verdicts']) || Object.keys(value).some((k) => k !== 'verdicts') || value['verdicts'].length > 40) return null;
  const verdicts: JudgeVerdict[] = [];
  for (const raw of value['verdicts']) {
    if (!isRecord(raw) || Object.keys(raw).some((k) => !['field', 'verdict', 'indices', 'reason'].includes(k))) return null;
    const { field, verdict, indices, reason } = raw;
    if (typeof field !== 'string' || !FIELD.test(field)) return null;
    if (typeof verdict !== 'string' || !(JUDGE_VERDICTS as readonly string[]).includes(verdict)) return null;
    if (!Array.isArray(indices) || indices.length > 5 || !indices.every((i) => Number.isInteger(i) && i >= 0 && i <= 99)) return null;
    if (typeof reason !== 'string' || reason.length > 200) return null;
    verdicts.push({ field, verdict: verdict as JudgeVerdict['verdict'], indices: indices as number[], reason });
  }
  return { flag: verdicts.some((v) => v.verdict === 'wrong'), verdicts };
}

/**
 * Seul effet d'un jugement : l'avis posé sur la fiche du run et la raison `judge_flag` (signal informatif). Aucun champ
 * pour un statut, une version, un schéma ou une règle : le type l'interdit.
 */
export function applyJudgement(args: { readonly trigger: JudgeTrigger; readonly judgement: Judgement }): { readonly judge: RunJudge; readonly reasons: readonly 'judge_flag'[] } {
  return { judge: { flag: args.judgement.flag, verdicts: args.judgement.verdicts, trigger: args.trigger }, reasons: args.judgement.flag ? ['judge_flag'] : [] };
}

/** Désactivé par défaut ; à l'enquête et à la réparation chaque fois ; sur anomalie, un jugement par API et par 24 h. */
export function judgeDecision(args: { readonly enabled: boolean; readonly trigger: JudgeTrigger; readonly lastJudgedAt: Date | null; readonly now: Date }): boolean {
  if (!args.enabled) return false;
  if (args.trigger !== 'anomaly') return true;
  return args.lastJudgedAt === null || args.now.getTime() - args.lastJudgedAt.getTime() >= 86_400_000;
}

/** Tirage déterministe à graine (journalisée par l'appelant). */
function seeded(seed: string, i: number): number {
  return createHash('sha256').update(`${seed}:${i}`).digest().readUInt32BE(0) / 0x1_0000_0000;
}

/** Score d'anomalie d'un item contre la fiche : champs absents, sentinelles, motif hors du dominant. */
function itemScore(item: unknown, profile: RunProfile): number {
  if (!isRecord(item)) return 10;
  let score = 0;
  for (const [name, f] of Object.entries(profile.fields)) {
    const v = item[name];
    if (v === undefined || v === null || (typeof v === 'string' && SENTINEL_VALUES.includes(v.trim()))) score += 1;
    else if (f.top_pattern !== null && shapeOf(typeof v === 'string' ? v : JSON.stringify(v)) !== f.top_pattern) score += 0.5;
  }
  return score;
}

export function selectJudgeSample(items: readonly unknown[], profile: RunProfile, opts: { readonly seed: string; readonly size?: number }): { readonly indices: number[]; readonly seed: string } {
  const size = Math.max(3, Math.min(5, opts.size ?? 4));
  if (items.length <= size) return { indices: items.map((_, i) => i), seed: opts.seed };
  const picked = new Set<number>([items.length - 1]);
  const worst = items.map((it, i) => ({ i, s: itemScore(it, profile) })).sort((a, b) => b.s - a.s || a.i - b.i);
  for (const w of worst.slice(0, 2)) if (picked.size < size - 1) picked.add(w.i);
  for (let k = 0; picked.size < size && k < 100; k += 1) picked.add(Math.floor(seeded(opts.seed, k) * items.length));
  return { indices: [...picked].sort((a, b) => a - b), seed: opts.seed };
}

const MAX_FIELD_CHARS = 200;

function projectAndBound(item: unknown, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(item)) return out;
  for (const n of names) {
    const v = item[n];
    if (typeof v === 'string') out[n] = v.slice(0, MAX_FIELD_CHARS);
    else if (v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean') out[n] = v ?? null;
    else out[n] = JSON.stringify(v).slice(0, MAX_FIELD_CHARS);
  }
  return out;
}

/**
 * Message `[user]` du juge : SCHÉMA, FICHE, JETON, puis les items masqués dans l'enveloppe. Rien d'autre (ni demande, ni
 * URL, ni retour, ni valeur personnelle). Les items sont réduits aux champs du schéma.
 */
export function judgeUserContent(args: { readonly schema: unknown; readonly profile: RunProfile; readonly items: readonly unknown[]; readonly token: string }): string {
  const tag = `untrusted_items_${args.token}`;
  const props = isRecord(args.schema) && isRecord(args.schema['properties']) ? args.schema['properties'] : {};
  const names = Object.keys(props).filter((n) => FIELD.test(n));
  const masked = maskItemsForLlm(args.items.map((it) => projectAndBound(it, names)), args.schema).items;
  const neutral = (text: string) => text.replace(/untrusted_items/gi, 'untrusted-items');
  return [
    `OUTPUT SCHEMA: ${JSON.stringify(args.schema).slice(0, 8_000)}`,
    `QUALITY PROFILE: ${neutral(maskTextForLlm(JSON.stringify(args.profile))).slice(0, 8_000)}`,
    `TOKEN: ${args.token}`,
    `<${tag}>`,
    neutral(masked.map((m, i) => `${i} ${JSON.stringify(m)}`).join('\n')),
    `</${tag}>`,
  ].join('\n');
}
