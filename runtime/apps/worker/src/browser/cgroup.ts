// SPDX-License-Identifier: AGPL-3.0-only
// `BROWSER_CONCURRENCY` déduit de la mémoire du cgroup (14 §11) : max(1, floor((limite − 0,5 Go) / 1,5 Go)), soit
// 2 Go → 1 et 4 Go → 2. Limite lue en cgroup v2 (`memory.max`) puis v1 (`memory.limit_in_bytes`) ; sans limite, la
// mémoire de la machine. Surchargeable par la variable. Aucune I/O hors de ces fichiers de /sys.
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

const GIB = 1024 ** 3;
/** Base du worker hors Chromium (estimation de 14 §11, à valider en recette). */
const BROWSER_BASE_BYTES = 0.5 * GIB;
/** Budget par run navigateur (pic Chromium de 0,7 à 1,1 Go, 14 §11). */
const BROWSER_RUN_BYTES = 1.5 * GIB;
/** Plafond de la valeur surchargée (garde-fou contre une faute de frappe). */
const MAX_BROWSER_CONCURRENCY = 32;

export const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
export const CGROUP_V2_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current';
export const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
export const CGROUP_V1_MEMORY_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
export const CGROUP_V2_MEMORY_STAT = '/sys/fs/cgroup/memory.stat';
export const CGROUP_V1_MEMORY_STAT = '/sys/fs/cgroup/memory/memory.stat';
/** cgroup v1 sans limite : valeur proche de 2^63 arrondie à la page. */
const V1_UNLIMITED = 2 ** 60;

export type FileReader = (path: string) => string | undefined;

const readSysFile: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

function bytesOf(raw: string | undefined): number | undefined {
  const v = raw?.trim();
  if (v === undefined || v === '' || v === 'max' || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < V1_UNLIMITED ? n : undefined;
}

/** Limite mémoire du cgroup du processus, en octets ; `undefined` sans limite. */
export function cgroupMemoryLimitBytes(read: FileReader = readSysFile): number | undefined {
  return bytesOf(read(CGROUP_V2_MEMORY_MAX)) ?? bytesOf(read(CGROUP_V1_MEMORY_LIMIT));
}

/** Mémoire consommée par le cgroup (worker + Chromium), en octets ; `undefined` hors cgroup. */
export function cgroupMemoryCurrentBytes(read: FileReader = readSysFile): number | undefined {
  return bytesOf(read(CGROUP_V2_MEMORY_CURRENT)) ?? bytesOf(read(CGROUP_V1_MEMORY_USAGE));
}

/** Valeur d'une clé de memory.stat (`clé valeur` par ligne). */
function statValue(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) return undefined;
  for (const line of raw.split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key && value !== undefined && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/**
 * Mémoire de travail du cgroup : consommation moins le page cache inactif (`inactive_file`, que le noyau récupère
 * sous pression), comme le « working set » de kubelet. `memory.current` seul compte tout le page cache : sur un
 * conteneur chargé, le seuil de recyclage serait franchi en permanence et Chromium relancé après chaque run.
 * Sans memory.stat lisible, la valeur brute (recyclage plus tôt, jamais plus tard).
 */
export function cgroupMemoryWorkingSetBytes(read: FileReader = readSysFile): number | undefined {
  const v2 = bytesOf(read(CGROUP_V2_MEMORY_CURRENT));
  if (v2 !== undefined) return Math.max(0, v2 - (statValue(read(CGROUP_V2_MEMORY_STAT), 'inactive_file') ?? 0));
  const v1 = bytesOf(read(CGROUP_V1_MEMORY_USAGE));
  if (v1 !== undefined) return Math.max(0, v1 - (statValue(read(CGROUP_V1_MEMORY_STAT), 'total_inactive_file') ?? 0));
  return undefined;
}

/** Runs navigateur simultanés pour une mémoire donnée (formule de 14 §11). */
export function browserConcurrencyForMemory(limitBytes: number): number {
  return Math.max(1, Math.floor((limitBytes - BROWSER_BASE_BYTES) / BROWSER_RUN_BYTES));
}

export class BrowserConcurrencyError extends Error {
  override name = 'BrowserConcurrencyError';
}

/** `BROWSER_CONCURRENCY` si posée (entier de 1 à 32), sinon déduite du cgroup, sinon de la mémoire de la machine. */
export function resolveBrowserConcurrency(
  env: Readonly<Record<string, string | undefined>>,
  probe: { read?: FileReader; totalMemBytes?: number } = {},
): { value: number; source: 'env' | 'cgroup' | 'host' } {
  const raw = env['BROWSER_CONCURRENCY'];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BROWSER_CONCURRENCY) {
      throw new BrowserConcurrencyError(`BROWSER_CONCURRENCY invalide : entier de 1 à ${MAX_BROWSER_CONCURRENCY} attendu.`);
    }
    return { value: n, source: 'env' };
  }
  const limit = cgroupMemoryLimitBytes(probe.read ?? readSysFile);
  if (limit !== undefined) return { value: browserConcurrencyForMemory(limit), source: 'cgroup' };
  return { value: browserConcurrencyForMemory(probe.totalMemBytes ?? totalmem()), source: 'host' };
}
