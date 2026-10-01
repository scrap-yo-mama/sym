// SPDX-License-Identifier: AGPL-3.0-only
// Diff brut côte à côte (06 § 2, niveau 3 du diff à trois niveaux). Le serveur calcule la phrase et le tableau des
// champs modifiés ; ici on ne fait que mettre en regard les deux versions, ligne à ligne (plus longue sous-suite
// commune), pour un affichage en lecture. Aucune dépendance.

export type DiffKind = 'same' | 'changed' | 'removed' | 'added';

export type DiffRow = {
  kind: DiffKind;
  left: string | null;
  right: string | null;
  leftNo: number | null;
  rightNo: number | null;
};

/** Au-delà de ce nombre de cases, la table de comparaison est trop grosse : on affiche tout en retrait puis en ajout. */
const MAX_CELLS = 4_000_000;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  }
  return value;
}

/** Lignes d'un JSON à clés triées (affichage stable) ; `null` donne une liste vide. */
export function jsonLines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return JSON.stringify(sortKeys(value), null, 2).split('\n');
}

type Op = { type: 'same' | 'removed' | 'added'; text: string };

function operations(before: string[], after: string[]): Op[] {
  if (before.length * after.length > MAX_CELLS) {
    return [...before.map((text) => ({ type: 'removed' as const, text })), ...after.map((text) => ({ type: 'added' as const, text }))];
  }
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ type: 'same', text: before[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ type: 'removed', text: before[i] ?? '' });
      i += 1;
    } else {
      ops.push({ type: 'added', text: after[j] ?? '' });
      j += 1;
    }
  }
  for (; i < before.length; i += 1) ops.push({ type: 'removed', text: before[i] ?? '' });
  for (; j < after.length; j += 1) ops.push({ type: 'added', text: after[j] ?? '' });
  return ops;
}

/** Lignes en regard : une ligne retirée suivie d'une ligne ajoutée forme une ligne « modifiée ». */
export function sideBySide(before: unknown, after: unknown): DiffRow[] {
  const ops = operations(jsonLines(before), jsonLines(after));
  const rows: DiffRow[] = [];
  let leftNo = 0;
  let rightNo = 0;
  for (let index = 0; index < ops.length; ) {
    const op = ops[index];
    if (!op) break;
    if (op.type === 'same') {
      leftNo += 1;
      rightNo += 1;
      rows.push({ kind: 'same', left: op.text, right: op.text, leftNo, rightNo });
      index += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (ops[index]?.type === 'removed') removed.push(ops[index++]?.text ?? '');
    while (ops[index]?.type === 'added') added.push(ops[index++]?.text ?? '');
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      const left = removed[k] ?? null;
      const right = added[k] ?? null;
      if (left !== null) leftNo += 1;
      if (right !== null) rightNo += 1;
      rows.push({ kind: left !== null && right !== null ? 'changed' : left !== null ? 'removed' : 'added', left, right, leftNo: left === null ? null : leftNo, rightNo: right === null ? null : rightNo });
    }
  }
  return rows;
}
