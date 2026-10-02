// SPDX-License-Identifier: AGPL-3.0-only
// Rotation de la clé maîtresse et contrôle de démarrage (BINV6, schéma de SYM : runtime/packages/db/src/secrets.ts).
// Logique pure sur un port `RekeyStore` : l'adaptateur PostgreSQL (schéma de la tâche 0.2) fournit lots, transactions et
// verrou exclusif ; ici, l'ordre des étapes, la reprise et les refus. Une valeur que l'ancienne clé n'ouvre pas est
// marquée illisible (gardée sous sa version d'origine, jamais effacée en silence).
import { kekFor, rotate, SecretDecryptError, type SealedValue } from './envelope.js';
import { createKeyCheck, verifyKeyCheck, type KeyCheckRecord } from './key-check.js';
import type { KekPurpose, Keyring, MasterKey } from './master-key.js';

export class KeyCheckError extends Error {
  override name = 'KeyCheckError';
}

/** Rotation en cours, persistée avant le premier lot : une relance reprend vers la même clé. */
export type RekeyState = { from: number; to: number; fromFingerprint: string; toFingerprint: string };

/** Valeur scellée telle que lue par l'adaptateur ; `aad` est recalculée depuis la ligne, jamais lue d'une colonne. */
export type StoredSealed = { id: string; aad: string; sealed: SealedValue; purpose?: KekPurpose };

/**
 * Port de stockage du rekey. L'adaptateur tient un verrou exclusif (aucun service ne tourne pendant la rotation) et rend
 * chaque `commit` et `finish` atomiques (une transaction chacun).
 */
export interface RekeyStore {
  readKeyCheck(): Promise<KeyCheckRecord | undefined>;
  readState(): Promise<RekeyState | undefined>;
  writeState(state: RekeyState): Promise<void>;
  /** Au plus `limit` valeurs lisibles (non marquées illisibles) encore sous `version`, dans un ordre stable. */
  pending(version: number, limit: number): Promise<StoredSealed[]>;
  /** Un lot, en une transaction : valeurs re-scellées, et valeurs marquées illisibles (conservées). */
  commit(batch: { rotated: { id: string; sealed: SealedValue }[]; unreadable: string[] }): Promise<void>;
  /** Fin, en une transaction : témoin réécrit et état supprimé ; refuse s'il reste une valeur lisible sous `from`. */
  finish(record: KeyCheckRecord, from: number): Promise<void>;
}

export type RekeyResult = { status: 'done' | 'already_done'; from: number; to: number; rotated: number; unreadable: number };

const RESUME = 'relancez le rekey avec MASTER_KEY (nouvelle) et MASTER_KEY_PREVIOUS (ancienne)';

/**
 * Contrôle de démarrage : aucune rotation en cours, et la clé courante ouvre le témoin. Témoin absent : base neuve, à
 * créer par l'appelant (`version` indéfinie). Échec : `KeyCheckError` nommant les empreintes, jamais une clé.
 */
export function assertKeyCheck(
  record: KeyCheckRecord | undefined,
  state: RekeyState | undefined,
  current: MasterKey,
): { version: number | undefined; fingerprint: string } {
  if (state) {
    throw new KeyCheckError(
      `rotation de clé inachevée (version ${state.from} → ${state.to}, empreinte ${state.fromFingerprint} → ${state.toFingerprint}) : ${RESUME}.`,
    );
  }
  if (!record) return { version: undefined, fingerprint: current.fingerprint };
  if (!verifyKeyCheck(record, current)) {
    throw new KeyCheckError(
      `MASTER_KEY ne correspond pas à cette base (empreinte attendue ${record.fingerprint}, reçue ${current.fingerprint}). ` +
        'Aucun secret n’a été lu ni écrit. Remettez la clé d’origine ; pour changer de clé, utilisez le rekey avec MASTER_KEY_PREVIOUS.',
    );
  }
  return { version: record.version, fingerprint: current.fingerprint };
}

/**
 * Rekey : re-scelle chaque valeur de la version de `MASTER_KEY_PREVIOUS` vers `MASTER_KEY` (nouvelle DEK, nouveaux
 * nonces), par lots atomiques. Reprenable : l'état est persisté avant le premier lot ; une relance reprend les valeurs
 * restantes, vers la même clé seulement. À la fin, plus aucune valeur lisible sous l'ancienne version, témoin réécrit sous
 * la nouvelle : `MASTER_KEY_PREVIOUS` peut être retirée.
 */
export async function rekey(
  store: RekeyStore,
  keyring: Keyring,
  opts: { batchSize?: number; afterBatch?: (rotated: number) => void | Promise<void> } = {},
): Promise<RekeyResult> {
  const batchSize = opts.batchSize ?? 100;
  if (!(Number.isSafeInteger(batchSize) && batchSize > 0)) throw new Error(`taille de lot invalide : ${batchSize}`);
  const { current, previous } = keyring;
  if (!previous) throw new KeyCheckError('MASTER_KEY_PREVIOUS (ou MASTER_KEY_PREVIOUS_FILE) requise : c’est l’ancienne clé à remplacer.');
  if (previous.fingerprint === current.fingerprint) throw new KeyCheckError('MASTER_KEY et MASTER_KEY_PREVIOUS sont identiques : rien à faire.');

  const record = await store.readKeyCheck();
  let state = await store.readState();
  if (!record) throw new KeyCheckError('témoin key_check absent : démarrez d’abord l’instance avec l’ancienne clé.');
  if (!state && verifyKeyCheck(record, current)) {
    return { status: 'already_done', from: record.version, to: record.version, rotated: 0, unreadable: 0 };
  }
  if (!verifyKeyCheck(record, previous)) {
    throw new KeyCheckError(`MASTER_KEY_PREVIOUS ne correspond pas à cette base (empreinte attendue ${record.fingerprint}, reçue ${previous.fingerprint}).`);
  }
  if (state && (state.toFingerprint !== current.fingerprint || state.fromFingerprint !== previous.fingerprint)) {
    throw new KeyCheckError(`rotation déjà commencée vers l’empreinte ${state.toFingerprint} : relancez avec cette MASTER_KEY (reçue ${current.fingerprint}).`);
  }
  if (!state) {
    state = { from: record.version, to: record.version + 1, fromFingerprint: previous.fingerprint, toFingerprint: current.fingerprint };
    await store.writeState(state);
  }

  const seen = new Set<string>();
  let rotated = 0;
  let unreadable = 0;
  for (;;) {
    const rows = await store.pending(state.from, batchSize);
    if (rows.length === 0) break;
    const batch: Parameters<RekeyStore['commit']>[0] = { rotated: [], unreadable: [] };
    for (const row of rows) {
      if (seen.has(row.id)) throw new Error(`dépôt incohérent : valeur ${row.id} rendue deux fois (lot précédent non appliqué).`);
      seen.add(row.id);
      if (row.sealed.kekVersion !== state.from) throw new Error(`dépôt incohérent : valeur ${row.id} sous la version ${row.sealed.kekVersion}, ${state.from} attendue.`);
      const purpose = row.purpose ?? 'secrets';
      try {
        batch.rotated.push({ id: row.id, sealed: rotate(row.sealed, kekFor(previous, state.from, purpose), kekFor(current, state.to, purpose), row.aad) });
      } catch (error) {
        if (!(error instanceof SecretDecryptError)) throw error;
        batch.unreadable.push(row.id);
      }
    }
    await store.commit(batch);
    rotated += batch.rotated.length;
    unreadable += batch.unreadable.length;
    await opts.afterBatch?.(rotated);
  }
  await store.finish(createKeyCheck(current, state.to), state.from);
  return { status: 'done', from: state.from, to: state.to, rotated, unreadable };
}
