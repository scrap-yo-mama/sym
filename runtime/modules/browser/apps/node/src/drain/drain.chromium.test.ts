// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.7 sur de vrais Chromium 153, processus nœud réel (`src/testing/drain-node.ts`) : livrable de 06-taches et P11 de
// 04b (`drain_on_sigterm`), recette étape 21, volet SIGTERM de assert_session_teardown (BINV3, 04c C9) et mesure K11.
//   Given 10 sessions actives (5 dedicated, 5 shared sur 2 clients) / When SIGTERM au processus nœud /
//   Then /readyz 503 `draining` et plus aucune nouvelle session, à l'échéance de la grâce les 10 sessions `ended` raison
//   `node_shutdown`, nœud `draining` puis `down`, sortie code 0, 0 processus restant, 0 répertoire `sessions/{id}`.
// Utilisateur non root exigé. Sécurité : SIGTERM est envoyé uniquement au processus nœud lancé ici, par son objet
// ChildProcess ; le nettoyage d'un échec cible ce même objet, puis seulement les pid exacts des processus restés dans un
// groupe de Chromium que ce nœud a lui-même enregistré et annoncé.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readProcessTable } from '../pool/index.js';

const SESSIONS = 10;
const GRACE_SECONDS = 3;
const isRoot = process.getuid?.() === 0;
const CHILD = fileURLToPath(new URL('../testing/drain-node.ts', import.meta.url));
const HOOK = new URL('../testing/ts-resolve.ts', import.meta.url).href;

type Line = { drainNode?: boolean; event?: string; [key: string]: unknown };

let child: ChildProcess | undefined;
let dataDir: string;
let announcedGroups: number[] = [];
const lines: Line[] = [];
let stderr = '';
let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

const survivors = (): number[] => readProcessTable().filter((p) => announcedGroups.includes(p.pgid) && p.state !== 'Z').map((p) => p.pid);

function nextEvent(event: string, ms = 120_000): Promise<Line> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = (): void => {
      const found = lines.find((line) => line.drainNode === true && line.event === event);
      if (found) return resolve(found);
      if (Date.now() > deadline || child?.exitCode !== null) return reject(new Error(`événement ${event} absent ; stderr : ${stderr.slice(-2000)}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

beforeAll(async () => {
  if (isRoot) throw new Error('tests Chromium : lance-les sous un utilisateur non root (le bac à sable de Chromium refuse root, 03 § 7).');
  dataDir = mkdtempSync(join(tmpdir(), 'symb-2-7-'));
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? tmpdir(),
    ...(process.env['PLAYWRIGHT_BROWSERS_PATH'] === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'] }),
    SYMB_MODE: 'node',
    PORT: '0',
    // Clé jetable tirée à chaque exécution ; la base n'est pas jointe (magasin mémoire dans le processus nœud).
    MASTER_KEY: randomBytes(32).toString('base64'),
    DATABASE_URL: 'postgres://symb:ci@db.invalid:5432/symb',
    NODE_TOKEN: randomBytes(24).toString('hex'),
    NODE_PUBLIC_URL: 'http://127.0.0.1:1',
    SHUTDOWN_GRACE_SECONDS: String(GRACE_SECONDS),
    SYMB_LOG_LEVEL: 'info',
    SYMB_DATA_DIR: dataDir,
    SYMB_DRAIN_SESSIONS: String(SESSIONS),
  };
  child = spawn(process.execPath, ['--import', HOOK, CHILD], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  exited = new Promise((resolve) => child?.once('exit', (code, signal) => resolve({ code, signal })));
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        lines.push(JSON.parse(raw) as Line);
      } catch {
        // ligne non JSON : ignorée
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = await nextEvent('ready', 180_000);
  announcedGroups = ready['ownedGroups'] as number[];
});

afterAll(async () => {
  // Échec en cours de route seulement : le nœud lancé ici est arrêté par son objet ChildProcess, puis les processus restés
  // dans les groupes qu'il a annoncés sont tués par leur pid exact.
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  for (const pid of survivors()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // déjà sorti
    }
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('drain_on_sigterm (P11, recette 21, K11)', () => {
  test(`Given ${SESSIONS} sessions actives / When SIGTERM au nœud / Then plus de nouvelle session, ${SESSIONS} sessions ended node_shutdown, état down, 0 processus restant`, async () => {
    const ready = lines.find((line) => line.event === 'ready')!;
    const sessions = ready['sessions'] as string[];
    expect(sessions).toHaveLength(SESSIONS);
    expect(announcedGroups.length).toBeGreaterThanOrEqual(SESSIONS / 2 + 1);
    expect(survivors().length).toBeGreaterThan(0);
    const port = ready['port'] as number;
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);

    const sigtermAt = Date.now();
    expect(child!.kill('SIGTERM')).toBe(true);

    // Plus aucune nouvelle session : /readyz 503 `draining` et refus du superviseur, pendant que les sessions vivent encore.
    const deadline = Date.now() + 2_000;
    let readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
    while (readyz.status !== 503 && Date.now() < deadline) readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readyz.status).toBe(503);
    expect(await readyz.json()).toEqual({ status: 'draining' });
    child!.stdin!.write('start drain-new\n');
    const refused = await nextEvent('start', 5_000);
    expect(refused['outcome']).toEqual({ ok: false, code: 'draining' });
    expect(survivors().length).toBeGreaterThan(0);

    const exit = await exited;
    const elapsedMs = Date.now() - sigtermAt;
    expect(exit).toEqual({ code: 0, signal: null });
    const drained = lines.find((line) => line.event === 'drained');
    expect(drained, stderr.slice(-2000)).toBeDefined();

    const states = drained!['sessions'] as Record<string, { state: string; endReason?: string }>;
    expect(Object.keys(states).sort()).toEqual([...sessions].sort());
    for (const id of sessions) expect(states[id], id).toMatchObject({ state: 'ended', endReason: 'node_shutdown' });
    expect((drained!['report'] as { endedOnShutdown: string[] }).endedOnShutdown.sort()).toEqual([...sessions].sort());
    expect(drained!['nodeStates']).toEqual(['draining', 'down']);
    expect(drained!['errors']).toEqual([]);
    // Le battement continue pendant la grâce (sinon la passerelle déclarerait le nœud perdu, `node_lost`).
    expect(drained!['beats'] as number).toBeGreaterThanOrEqual(GRACE_SECONDS);
    expect(drained!['ownedGroups']).toEqual([]);

    // 0 processus restant (Chromium, rendus, GPU, zygote de chaque groupe annoncé), 0 répertoire de session.
    expect(survivors()).toEqual([]);
    expect(readdirSync(join(dataDir, 'sessions'))).toEqual([]);

    // K11 : drainage dans la grâce, destruction comprise (fenêtre de destruction de l'hôte de service).
    expect(elapsedMs).toBeGreaterThanOrEqual(GRACE_SECONDS * 1000);
    expect(elapsedMs).toBeLessThan(GRACE_SECONDS * 1000 + 25_000);
    console.log(`K11 : ${SESSIONS} sessions drainées en ${elapsedMs} ms (grâce ${GRACE_SECONDS} s)`);
  });
});
