// SPDX-License-Identifier: AGPL-3.0-only
// Découpage des réponses du tunnel (07 §6, `assert_ws_chunking_maxpayload`) : une réponse de page plus grande que
// `maxPayload` part en morceaux numérotés (`seq`, `last`), chacun sérialisé en ≤ `maxPayload` octets UTF-8, puis est
// réassemblée côté passerelle. Une paire de substitution UTF-16 n'est jamais coupée en deux.
import { TUNNEL_MAX_PAYLOAD, TUNNEL_MAX_RESULT_BYTES, type ResultFrame } from './protocol.js';

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** Première tranche de `text` à partir de `start` dont le message sérialisé tient dans `maxBytes`. */
function sliceFitting(jobId: string, seq: number, text: string, start: number, maxBytes: number, guess: number): { end: number; frame: string } {
  let size = Math.max(1, Math.min(guess, text.length - start));
  for (;;) {
    let end = Math.min(text.length, start + size);
    // Ne coupe jamais une paire de substitution (le morceau serait du JSON valide mais un texte UTF-16 invalide).
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const isLast = end >= text.length;
    const frame = JSON.stringify({ type: 'result', job_id: jobId, seq, last: isLast, data: text.slice(start, end) } satisfies ResultFrame);
    if (byteLength(frame) <= maxBytes) return { end, frame };
    if (end - start <= 1) throw new Error('découpage impossible : un caractère dépasse maxPayload');
    size = Math.max(1, Math.floor((end - start) / 2));
  }
}

/**
 * Messages `result` d'une réponse (JSON de `TunnelResult` déjà sérialisé). Chaque message fait au plus `maxBytes`
 * octets une fois sérialisé ; au moins un message (une réponse vide reste un message `last`).
 */
export function chunkResult(jobId: string, json: string, maxBytes = TUNNEL_MAX_PAYLOAD): string[] {
  const frames: string[] = [];
  // Tranche initiale : marge pour l'enveloppe et l'échappement JSON (jusqu'à 6 octets par unité dans le pire cas).
  const guess = Math.max(1, Math.floor((maxBytes - 256) / 3));
  let start = 0;
  let seq = 0;
  do {
    const { end, frame } = sliceFitting(jobId, seq, json, start, maxBytes, guess);
    frames.push(frame);
    start = end;
    seq += 1;
  } while (start < json.length);
  return frames;
}

export type ReassemblyOutcome = { readonly done: false } | { readonly done: true; readonly text: string } | { readonly done: true; readonly error: 'protocol' | 'too_large' };

/** Réassemblage des morceaux d'UNE réponse : ordre strict (`seq` 0, 1, 2…), taille bornée. */
export class ResultAssembler {
  readonly #maxBytes: number;
  #parts: string[] = [];
  #size = 0;
  #next = 0;
  #closed = false;

  constructor(maxBytes = TUNNEL_MAX_RESULT_BYTES) {
    this.#maxBytes = maxBytes;
  }

  get received(): number {
    return this.#next;
  }

  push(frame: Pick<ResultFrame, 'seq' | 'last' | 'data'>): ReassemblyOutcome {
    if (this.#closed) return { done: true, error: 'protocol' };
    if (frame.seq !== this.#next) {
      this.#closed = true;
      return { done: true, error: 'protocol' };
    }
    this.#next += 1;
    this.#size += frame.data.length;
    if (this.#size > this.#maxBytes) {
      this.#closed = true;
      this.#parts = [];
      return { done: true, error: 'too_large' };
    }
    this.#parts.push(frame.data);
    if (!frame.last) return { done: false };
    this.#closed = true;
    const text = this.#parts.join('');
    this.#parts = [];
    return { done: true, text };
  }
}
