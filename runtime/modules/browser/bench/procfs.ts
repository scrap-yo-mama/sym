// SPDX-License-Identifier: AGPL-3.0-only
// Lecture de /proc et du cgroup pour le banc de capacité (tâche 0.6). Linux seulement : le banc tourne en conteneur.
import { readdirSync, readFileSync } from 'node:fs';

export type ProcEntry = { pid: number; ppid: number };

/** `pid (comm) état ppid …` : le nom de commande peut contenir espaces et parenthèses, on coupe à la dernière `)`. */
export function parseProcStat(stat: string): ProcEntry {
  const pid = Number.parseInt(stat, 10);
  const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pid, ppid: Number.parseInt(afterComm[1] ?? '0', 10) };
}

/** VmRSS de /proc/<pid>/status, en octets (0 si la ligne est absente : thread noyau, zombie). */
export function parseVmRssBytes(status: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : 0;
}

/** La racine et tous ses descendants. */
export function treeOf(root: number, table: readonly ProcEntry[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i] as number) ?? []));
  return out;
}

export function readProcTable(): ProcEntry[] {
  const table: ProcEntry[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      table.push(parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8')));
    } catch {
      // processus terminé entre la liste et la lecture
    }
  }
  return table;
}

/** Pss de /proc/<pid>/smaps_rollup, en octets (pages partagées réparties entre les processus qui les mappent). */
export function parsePssBytes(rollup: string): number {
  const match = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup);
  return match ? Number(match[1]) * 1024 : 0;
}

/** Somme des RSS de l'arbre de processus d'une racine (compte deux fois les pages partagées : borne haute). */
export function treeRssBytes(root: number): { rssBytes: number; pssBytes: number; processes: number } {
  let rssBytes = 0;
  let pssBytes = 0;
  let processes = 0;
  for (const pid of treeOf(root, readProcTable())) {
    try {
      rssBytes += parseVmRssBytes(readFileSync(`/proc/${pid}/status`, 'utf8'));
      processes++;
    } catch {
      // terminé entre-temps
      continue;
    }
    try {
      pssBytes += parsePssBytes(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    } catch {
      // smaps_rollup illisible : Pss non compté pour ce processus
    }
  }
  return { rssBytes, pssBytes, processes };
}

/** Mémoire cgroup v2 du conteneur : `memory.current` et ses composantes anonymes (RSS réelle sans le cache fichier). */
export function cgroupMemory(): { currentBytes: number; anonBytes: number; fileBytes: number; shmemBytes: number } | undefined {
  try {
    const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const stat = new Map(readFileSync('/sys/fs/cgroup/memory.stat', 'utf8').trim().split('\n').map((l) => [l.split(' ')[0] ?? '', Number(l.split(' ')[1])] as const));
    return { currentBytes: current, anonBytes: stat.get('anon') ?? 0, fileBytes: stat.get('file') ?? 0, shmemBytes: stat.get('shmem') ?? 0 };
  } catch {
    return undefined;
  }
}

export function cgroupLimitBytes(): number | undefined {
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    return raw === 'max' ? undefined : Number(raw);
  } catch {
    return undefined;
  }
}
