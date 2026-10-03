// SPDX-License-Identifier: AGPL-3.0-only
// Tests seulement (tâche 2.7, `drain_on_sigterm`) : processus nœud réel lancé par le test, qui lui envoie SIGTERM par son
// objet ChildProcess. Chaîne complète du nœud sur de vrais Chromium 153 : pool (1.1) → hôte des sessions (1.7) → superviseur
// (1.2) → drainage (2.7), sous l'hôte de service (`runService`, 0.4) et ses vrais gestionnaires de SIGTERM et SIGINT.
// La base est remplacée par le magasin mémoire de @sym-browser/core et l'état du nœud par un journal (le SQL de
// `setNodeState` est couvert par les tests de @sym-browser/db) ; tout le reste est le code de production.
// Entrées (environnement) : configuration du service (`SYMB_MODE=node`, `SHUTDOWN_GRACE_SECONDS`…), `SYMB_DATA_DIR`,
// `SYMB_DRAIN_SESSIONS` (sessions ouvertes au démarrage, moitié dedicated, moitié shared sur deux clients).
// Sorties : une ligne JSON par événement sur stdout (`ready`, `start`, `drained`), à côté des journaux du service.
// Entrée stdin : `start <id>` tente une nouvelle session (refusée pendant le drainage).
import { createInterface } from 'node:readline';
import { createMemorySessionStore, runService } from '@sym-browser/core';
import { dedicatedLauncher } from '../dedicated/dedicated.js';
import { NodeDrain } from '../drain/drain.js';
import { BrowserPool, OwnedProcessGroups, PROVISIONAL_CAPACITY, playwrightLauncher, startClosedLaunchProxy } from '../pool/index.js';
import { startHeartbeat } from '../sessions/heartbeat.js';
import { SessionHost } from '../sessions/host.js';
import { SessionSupervisor } from '../sessions/supervisor.js';

const emit = (event: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify({ drainNode: true, ...event })}\n`);

const dataDir = process.env['SYMB_DATA_DIR'];
if (dataDir === undefined || dataDir === '') throw new Error('SYMB_DATA_DIR requis');
const count = Number(process.env['SYMB_DRAIN_SESSIONS'] ?? '10');
const graceMs = Number(process.env['SHUTDOWN_GRACE_SECONDS'] ?? '270') * 1000;

const proxy = await startClosedLaunchProxy();
const groups = new OwnedProcessGroups();
const pool = new BrowserPool({
  slotsTotal: count + 2,
  warmBrowsers: 1,
  launch: playwrightLauncher({ launchProxyUrl: proxy.url, groups }),
  launchDedicated: dedicatedLauncher({ launchProxyUrl: proxy.url, groups, dataDir, removeSessionDir: false }),
  constants: { ...PROVISIONAL_CAPACITY, contextsPerBrowser: 4 },
  sweep: () => groups.sweep(),
  sweepIntervalMs: 0,
});
await pool.start();
const host = new SessionHost({ pool, dataDir });
const store = createMemorySessionStore();
const errors: string[] = [];
const onError = (error: unknown): void => void errors.push(error instanceof Error ? error.message : String(error));
const supervisor = new SessionSupervisor({ nodeId: 'node-drain', pool: host, store, onError });
const nodeStates: string[] = [];
let beats = 0;
const heartbeat = startHeartbeat({ beat: async () => ((beats += 1), { recovered: false }), isolate: () => supervisor.isolate(), intervalMs: 500, onError });
const drain = new NodeDrain({
  supervisor,
  graceMs,
  setState: async (state) => void nodeStates.push(state),
  closePool: async () => {
    await pool.close();
    await host.sweep();
    await proxy.close();
  },
  stopHeartbeat: () => heartbeat.stop(),
  onError,
});

const sessions: string[] = [];
const service = await runService({
  defaultMode: 'node',
  onDrain: [
    async () => {
      const report = await drain.drain();
      emit({
        event: 'drained',
        report,
        nodeStates,
        beats,
        errors,
        sessions: Object.fromEntries(sessions.map((id) => [id, store.get(id)])),
        ownedGroups: groups.owned(),
      });
    },
  ],
});
if (service === undefined) throw new Error('service non démarré');

async function start(sessionId: string, type: 'shared' | 'dedicated', tenantId: string) {
  const now = Date.now();
  store.create({ sessionId, createdAt: now, expiresAt: now + 600_000, maxDurationSeconds: 3600 });
  return supervisor.start({ sessionId, type, tenantId, expiresAt: now + 600_000, maxExpiresAt: now + 3_600_000, idleTimeoutSeconds: 600 });
}

for (let i = 0; i < count; i += 1) {
  const sessionId = `drain-${String(i).padStart(2, '0')}`;
  const outcome = await start(sessionId, i % 2 === 0 ? 'dedicated' : 'shared', i % 4 < 2 ? 'A' : 'B');
  if (!outcome.ok) throw new Error(`session ${sessionId} : ${outcome.code}`);
  sessions.push(sessionId);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, sessionId] = line.trim().split(/\s+/);
  if (command !== 'start' || sessionId === undefined) return;
  void start(sessionId, 'dedicated', 'A').then((outcome) => emit({ event: 'start', sessionId, outcome }));
});

emit({ event: 'ready', port: service.port, sessions, ownedGroups: groups.owned(), pid: process.pid });
