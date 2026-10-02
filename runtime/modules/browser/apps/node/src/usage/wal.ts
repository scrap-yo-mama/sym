// SPDX-License-Identifier: AGPL-3.0-only
// Journal local des clôtures `usage.wal` (cdc/sym-browser 04d § 4.1, tâche 2.6) : ajout seul, une clôture JSON par ligne,
// `fsync` avant le retour d'`append` ; écrit AVANT la base. Rejoué au redémarrage du nœud (`replayUsageWal`) et lu par la
// réconciliation : il remplace les valeurs reconstruites par les valeurs mesurées. Une ligne déchirée par un arrêt brutal
// est ignorée ; l'ajout suivant commence sur une ligne neuve.
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecordUsageOutcome, SessionStore, UsageClosure } from '@sym-browser/core';

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseClosure(line: string): UsageClosure | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v['sessionId'] !== 'string' || typeof v['nodeId'] !== 'string') return undefined;
    if (![v['startedAt'], v['browserMs'], v['bytesIn'], v['bytesOut']].every(isCount)) return undefined;
    return { sessionId: v['sessionId'], nodeId: v['nodeId'], startedAt: v['startedAt'] as number, browserMs: v['browserMs'] as number, bytesIn: v['bytesIn'] as number, bytesOut: v['bytesOut'] as number };
  } catch {
    return undefined;
  }
}

export class UsageWal {
  readonly path: string;
  readonly #file: FileHandle;
  #newlineFirst: boolean;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, file: FileHandle, newlineFirst: boolean) {
    this.path = path;
    this.#file = file;
    this.#newlineFirst = newlineFirst;
  }

  /** Ouvre (ou crée, droits 0600) le journal en ajout seul. */
  static async open(path: string): Promise<UsageWal> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'a+', 0o600);
    const { size } = await file.stat();
    let newlineFirst = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      newlineFirst = last[0] !== 0x0a;
    }
    return new UsageWal(path, file, newlineFirst);
  }

  /** Ajoute une clôture ; rendu après `fsync`. Les ajouts concurrents sont écrits l'un après l'autre. */
  append(closure: UsageClosure): Promise<void> {
    const line = `${this.#newlineFirst ? '\n' : ''}${JSON.stringify({ sessionId: closure.sessionId, nodeId: closure.nodeId, startedAt: closure.startedAt, browserMs: closure.browserMs, bytesIn: closure.bytesIn, bytesOut: closure.bytesOut })}\n`;
    const write = this.#queue.then(async () => {
      await this.#file.appendFile(line, 'utf8');
      this.#newlineFirst = false;
      await this.#file.sync();
    });
    this.#queue = write.catch(() => undefined);
    return write;
  }

  /** Clôtures complètes, dans l'ordre d'écriture (lignes illisibles ignorées). */
  async read(): Promise<UsageClosure[]> {
    await this.#queue;
    const text = await readFile(this.path, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(parseClosure)
      .filter((c): c is UsageClosure => c !== undefined);
  }

  async close(): Promise<void> {
    await this.#queue;
    await this.#file.close();
  }
}

export type ReplayReport = { inserted: number; replaced: number; unchanged: number; notFound: number };

/** Redémarrage du nœud : chaque clôture du journal est réécrite en base (idempotent ; remplace une reconstruction). */
export async function replayUsageWal(wal: UsageWal, store: Pick<SessionStore, 'recordUsage'>): Promise<ReplayReport> {
  if (!store.recordUsage) throw new Error('magasin sans recordUsage : rejeu de usage.wal impossible');
  const report: ReplayReport = { inserted: 0, replaced: 0, unchanged: 0, notFound: 0 };
  const key: Record<RecordUsageOutcome, keyof ReplayReport> = { inserted: 'inserted', replaced: 'replaced', unchanged: 'unchanged', not_found: 'notFound' };
  for (const closure of await wal.read()) report[key[await store.recordUsage(closure)]] += 1;
  return report;
}
