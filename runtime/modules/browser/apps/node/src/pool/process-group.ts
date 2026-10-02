// SPDX-License-Identifier: AGPL-3.0-only
// Groupes de processus des Chromium du pool (04b § 4) : le kill forcé cible le groupe du Chromium, rendu en 2 s ; le
// balayage (au démarrage et toutes les 60 s) tue les processus restés dans le groupe d'un Chromium retiré.
// Playwright lance Chromium détaché (`setsid`) : le pid du processus principal est l'identifiant de son groupe, où vivent
// aussi ses processus de rendu, GPU et zygote. Garde-fou : seul un groupe ENREGISTRÉ au lancement par ce nœud peut être
// signalé ; jamais 0, 1, -1, le pid ni le groupe du nœud (pas de `kill 0` ni `kill -1`, aucun balayage par nom).
// Limite connue : un Chromium orphelin d'un nœud précédent (redémarrage du conteneur) n'est pas dans ce registre ; il
// relève de l'utilisateur dédié aux Chromium (à poser avec l'image, tâche 1.4 ou 2.7), pas d'un balayage par nom.
import { readdirSync, readFileSync } from 'node:fs';

export type ProcessInfo = { pid: number; ppid: number; pgid: number; state: string; comm: string };

/** Table des processus lue dans /proc (Linux) ; vide ailleurs. Un processus disparu pendant la lecture est ignoré. */
export function readProcessTable(procRoot = '/proc'): ProcessInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const table: ProcessInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procRoot}/${entry}/stat`, 'utf8');
    } catch {
      continue;
    }
    // « pid (comm) state ppid pgrp … » : comm peut contenir espaces et parenthèses, d'où la dernière parenthèse fermante.
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    table.push({ pid: Number(entry), comm: stat.slice(stat.indexOf('(') + 1, close), state: fields[0] ?? '', ppid: Number(fields[1]), pgid: Number(fields[2]) });
  }
  return table;
}

export type OwnedProcessGroupsOptions = {
  /** Envoi d'un signal (défaut `process.kill`, ESRCH ignoré). */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  table?: () => readonly Pick<ProcessInfo, 'pid' | 'pgid' | 'state'>[];
  /** Délai pour que le groupe disparaisse après SIGKILL (04b § 4 : 2 s). */
  graceMs?: number;
  pollMs?: number;
};

const defaultSignal = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

export class OwnedProcessGroups {
  readonly #signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly #table: () => readonly Pick<ProcessInfo, 'pid' | 'pgid' | 'state'>[];
  readonly #graceMs: number;
  readonly #pollMs: number;
  /** Groupes lancés par ce nœud ; vrai : Chromium retiré (fermé), le groupe doit se vider. */
  readonly #groups = new Map<number, boolean>();

  constructor(options: OwnedProcessGroupsOptions = {}) {
    this.#signal = options.signal ?? defaultSignal;
    this.#table = options.table ?? (() => readProcessTable());
    this.#graceMs = options.graceMs ?? 2_000;
    this.#pollMs = options.pollMs ?? 50;
  }

  /** Enregistre le groupe d'un Chromium que ce nœud vient de lancer. */
  add(pgid: number): void {
    const own = this.#table().find((p) => p.pid === process.pid)?.pgid;
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === own) {
      throw new RangeError(`groupe de processus refusé : ${pgid} (ni 0, ni 1, ni le groupe du nœud)`);
    }
    this.#groups.set(pgid, false);
  }

  /** Chromium fermé proprement : son groupe doit se vider ; le balayage tue ce qui reste. */
  retire(pgid: number): void {
    if (this.#groups.has(pgid)) this.#groups.set(pgid, true);
  }

  owned(): number[] {
    return [...this.#groups.keys()];
  }

  /** Processus vivants du groupe (zombies exclus : déjà morts, en attente de récolte). */
  members(pgid: number): number[] {
    return this.#table()
      .filter((p) => p.pgid === pgid && p.state !== 'Z')
      .map((p) => p.pid)
      .sort((a, b) => a - b);
  }

  /** SIGKILL au groupe (s'il est enregistré), puis attente de sa disparition ; vrai si le groupe est vide. */
  async kill(pgid: number): Promise<boolean> {
    if (!this.#groups.has(pgid)) return false;
    if (this.members(pgid).length > 0) this.#signal(-pgid, 'SIGKILL');
    const deadline = Date.now() + this.#graceMs;
    while (this.members(pgid).length > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
    }
    this.#groups.delete(pgid);
    return true;
  }

  /** Balayage : les groupes retirés encore peuplés sont tués, les groupes vides oubliés. Renvoie les groupes tués. */
  async sweep(): Promise<number[]> {
    const killed: number[] = [];
    for (const [pgid, retired] of [...this.#groups]) {
      if (!retired) continue;
      if (this.members(pgid).length === 0) {
        this.#groups.delete(pgid);
        continue;
      }
      killed.push(pgid);
      await this.kill(pgid);
    }
    return killed;
  }
}
