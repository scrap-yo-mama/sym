// SPDX-License-Identifier: AGPL-3.0-only
// Capacité d'un nœud (cdc/sym-browser 04b § 3, tâche 1.1) : limite mémoire du cgroup (v2 `memory.max`, puis v1 ; sans
// limite, la mémoire de la machine), slots = max(1, floor((limite − base) / budget par slot)), `MAX_SESSIONS` prioritaire.
// Un slot porte une session ; chaque type de session pèse un poids en slots (unités entières : un slot = SLOT_UNITS).
// Même lecture du cgroup que le worker de SYM (runtime/apps/worker/src/browser/cgroup.ts), reprise ici : la frontière du
// module interdit de l'importer. Aucune I/O hors des fichiers de /sys lus ci-dessous.
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

const GIB = 1024 ** 3;

export type SessionType = 'shared' | 'dedicated';

export type CapacityConstants = {
  /** Mémoire du nœud hors Chromium, en octets. */
  readonly baseBytes: number;
  /** Budget mémoire d'un slot (un Chromium dédié), en octets. */
  readonly slotBytes: number;
  /** Poids d'une session en slots, de 0 (exclu) à 1. */
  readonly weights: Readonly<Record<SessionType, number>>;
  /** Contextes `shared` simultanés par Chromium chaud (`CONTEXTS_PER_BROWSER` sans valeur posée). */
  readonly contextsPerBrowser: number;
  /** Rapport de mesure dont viennent les valeurs ; `null` : valeurs provisoires. */
  readonly measuredBy: string | null;
};

/**
 * PROVISOIRE, À REMPLACER PAR LA TÂCHE 0.6 (rapport `docs/mesures-capacite.md`, 30 mesures par cas, médiane et p95).
 * Valeurs de départ de 04b § 3, reprises de SYM (14 § 11) :
 * - base 0,5 Go, budget par slot 1,5 Go : un Chromium dédié headless fait 690 Mo à 1 094 Mo de pic au repos selon le mode de
 *   lancement (mesure publiée du 2025-06-06, docs/sym-browser-protocole-deploiement/08-hebergeurs-un-clic.md) ;
 * - poids `dedicated` 1 (défaut de l'API, CDC v1.2) ; poids `shared` 1 par prudence : la spec le borne à ≤ 1 (un contexte
 *   dans un Chromium chaud), aucune mesure ne permet encore de le baisser sans risquer de surcharger le nœud ;
 * - 4 contextes par Chromium chaud : valeur arbitraire prudente en attendant la mesure du coût d'un contexte.
 * La 0.6 remplace cet objet (et `measuredBy`) ; `CONTEXTS_PER_BROWSER` et `MAX_SESSIONS` restent prioritaires.
 */
export const PROVISIONAL_CAPACITY: CapacityConstants = Object.freeze({
  baseBytes: 0.5 * GIB,
  slotBytes: 1.5 * GIB,
  weights: Object.freeze({ dedicated: 1, shared: 1 }),
  contextsPerBrowser: 4,
  measuredBy: null,
});

/** Unités d'un slot : les poids fractionnaires (`shared` < 1 après 0.6) restent des entiers, sans erreur d'arrondi. */
export const SLOT_UNITS = 1000;

export function sessionWeightUnits(type: SessionType, constants: CapacityConstants = PROVISIONAL_CAPACITY): number {
  const weight = constants.weights[type];
  if (!(weight > 0 && weight <= 1)) throw new RangeError(`poids de session ${type} invalide : ]0, 1] attendu (reçu ${weight})`);
  return Math.max(1, Math.round(weight * SLOT_UNITS));
}

export const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
export const CGROUP_V2_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current';
export const CGROUP_V2_MEMORY_STAT = '/sys/fs/cgroup/memory.stat';
export const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
export const CGROUP_V1_MEMORY_USAGE = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
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

export type MemoryProbe = { read?: FileReader; totalMemBytes?: number; freeMemBytes?: number };

function bytesOf(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 && n < V1_UNLIMITED ? n : undefined;
}

function statValue(raw: string | undefined, key: string): number | undefined {
  for (const line of (raw ?? '').split('\n')) {
    const [name, value] = line.trim().split(/\s+/);
    if (name === key && value !== undefined && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Limite mémoire du cgroup du processus, en octets ; `undefined` sans limite. */
export function cgroupMemoryLimitBytes(read: FileReader = readSysFile): number | undefined {
  return bytesOf(read(CGROUP_V2_MEMORY_MAX)) ?? bytesOf(read(CGROUP_V1_MEMORY_LIMIT));
}

/**
 * Mémoire de travail : consommation du cgroup moins le cache de pages inactif (que le noyau récupère sous pression), comme le
 * « working set » de kubelet ; sans cgroup, mémoire de la machine (totale moins libre). Limite : celle du cgroup, sinon la
 * mémoire de la machine.
 */
export function memoryUsage(probe: MemoryProbe = {}): { workingSetBytes: number; limitBytes: number } {
  const read = probe.read ?? readSysFile;
  const total = probe.totalMemBytes ?? totalmem();
  const limitBytes = cgroupMemoryLimitBytes(read) ?? total;
  const v2 = bytesOf(read(CGROUP_V2_MEMORY_CURRENT));
  if (v2 !== undefined) return { workingSetBytes: Math.max(0, v2 - (statValue(read(CGROUP_V2_MEMORY_STAT), 'inactive_file') ?? 0)), limitBytes };
  const v1 = bytesOf(read(CGROUP_V1_MEMORY_USAGE));
  if (v1 !== undefined) return { workingSetBytes: Math.max(0, v1 - (statValue(read(CGROUP_V1_MEMORY_STAT), 'total_inactive_file') ?? 0)), limitBytes };
  return { workingSetBytes: Math.max(0, total - (probe.freeMemBytes ?? freemem())), limitBytes };
}

/** Sonde du recyclage par mémoire : vrai si la mémoire de travail atteint `percent` % de la limite (`RECYCLE_RSS_PERCENT`). */
export function memoryHighProbe(percent: number, probe: MemoryProbe = {}): () => boolean {
  return () => {
    const { workingSetBytes, limitBytes } = memoryUsage(probe);
    return workingSetBytes * 100 >= percent * limitBytes;
  };
}

/** Slots pour une mémoire donnée : max(1, floor((limite − base) / budget par slot)). */
export function slotsForMemory(limitBytes: number, constants: CapacityConstants = PROVISIONAL_CAPACITY): number {
  return Math.max(1, Math.floor((limitBytes - constants.baseBytes) / constants.slotBytes));
}

export type ResolvedCapacity = { slotsTotal: number; source: 'env' | 'cgroup' | 'host'; limitBytes: number };

/** `MAX_SESSIONS` si posée (déjà validée de 1 à 64 par la configuration), sinon le cgroup, sinon la machine. */
export function resolveCapacity(
  node: { maxSessions: number | null },
  probe: { read?: FileReader; totalMemBytes?: number; constants?: CapacityConstants } = {},
): ResolvedCapacity {
  const cgroup = cgroupMemoryLimitBytes(probe.read ?? readSysFile);
  const limitBytes = cgroup ?? probe.totalMemBytes ?? totalmem();
  if (node.maxSessions !== null) return { slotsTotal: node.maxSessions, source: 'env', limitBytes };
  return { slotsTotal: slotsForMemory(limitBytes, probe.constants ?? PROVISIONAL_CAPACITY), source: cgroup === undefined ? 'host' : 'cgroup', limitBytes };
}
