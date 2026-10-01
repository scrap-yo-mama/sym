// SPDX-License-Identifier: AGPL-3.0-only
// Signaux d'accès (tâche 1.11, 17 §2) : AIPREF (`Content-Usage`), TDMRep (`tdm-reservation`, `tdm-policy`), Content
// Signals (`Content-Signal`), lus dans les en-têtes de la réponse et dans robots.txt. Ils sont DÉTECTÉS et AFFICHÉS,
// sans bloquer (`on_ai_signal: warn`, seule valeur V1) : vocabulaires non stabilisés. Un signal est une donnée, jamais
// une consigne : sa valeur est bornée, réduite à l'ASCII imprimable, et n'entre dans aucun prompt (`report.ts`).
// Réponse 402 (`payment_required`) : l'offre (`crawler-price`) est lisible ; aucun paiement en V1 (`payment.mode: never`).
import type { RobotsSignalLine } from './robots.js';

export type AccessSignalKind = 'content_signal' | 'content_usage' | 'tdm_reservation' | 'tdm_policy';

export type AccessSignal = {
  readonly kind: AccessSignalKind;
  /** Valeur telle que publiée par le site (bornée, ASCII imprimable) : à afficher, jamais à suivre. */
  readonly value: string;
  readonly source: 'header' | 'robots';
};

const MAX_VALUE = 256;
const MAX_SIGNALS = 16;

/** Valeur affichable d'un signal : ASCII imprimable seulement, blancs réduits, bornée. `null` si vide. */
export function sanitizeSignalValue(raw: string): string | null {
  const cleaned = raw
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VALUE);
  return cleaned === '' ? null : cleaned;
}

const HEADER_SIGNALS: readonly [string, AccessSignalKind][] = [
  ['content-signal', 'content_signal'],
  ['content-usage', 'content_usage'],
  ['tdm-reservation', 'tdm_reservation'],
  ['tdm-policy', 'tdm_policy'],
];

/** Signaux d'accès d'une réponse (en-têtes, noms en minuscules) et des lignes de robots.txt applicables. */
export function detectAccessSignals(headers: Readonly<Record<string, string>>, robotsLines: readonly RobotsSignalLine[] = []): AccessSignal[] {
  const out: AccessSignal[] = [];
  const push = (signal: AccessSignal) => {
    if (out.length >= MAX_SIGNALS) return;
    if (out.some((s) => s.kind === signal.kind && s.value === signal.value && s.source === signal.source)) return;
    out.push(signal);
  };
  for (const line of robotsLines) {
    const value = sanitizeSignalValue(line.value);
    if (value !== null) push({ kind: line.key === 'content-signal' ? 'content_signal' : 'content_usage', value, source: 'robots' });
  }
  for (const [name, kind] of HEADER_SIGNALS) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const value = sanitizeSignalValue(raw);
    if (value !== null) push({ kind, value, source: 'header' });
  }
  return out;
}

export type PaymentOffer = {
  /** Offre affichable (`USD 0.01`), `null` si l'en-tête est absent ou illisible. */
  readonly display: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
};

/**
 * Offre d'une réponse 402 (`crawler-price`, ex. `USD 0.01`). Lecture seule : rien n'est payé, rien n'est accepté en
 * V1 (`payment.mode: never`).
 */
export function parsePaymentOffer(headers: Readonly<Record<string, string>>): PaymentOffer {
  const raw = headers['crawler-price'];
  if (raw === undefined) return { display: null, amount: null, currency: null };
  const value = sanitizeSignalValue(raw);
  if (value === null) return { display: null, amount: null, currency: null };
  const m = /^([A-Za-z]{3})\s+(\d{1,12}(?:\.\d{1,8})?)$/.exec(value) ?? /^(\d{1,12}(?:\.\d{1,8})?)\s*([A-Za-z]{3})$/.exec(value);
  if (m === null) return { display: value.slice(0, 64), amount: null, currency: null };
  const [currency, amount] = /^\d/.test(m[1] as string) ? [m[2] as string, m[1] as string] : [m[1] as string, m[2] as string];
  return { display: `${currency.toUpperCase()} ${amount}`, amount, currency: currency.toUpperCase() };
}
