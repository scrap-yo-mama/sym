// SPDX-License-Identifier: AGPL-3.0-only
// Hôte des sessions du nœud (cdc/sym-browser 04c § 3, 04b § 2, tâche 1.7) : il enveloppe le pool (1.1) pour le superviseur
// (1.2) et porte l'isolation et la destruction complète de chaque session, shared (1.3) ou dedicated (1.4).
// - Acquisition : répertoire de session neuf `SYMB_DATA_DIR/sessions/{id}` (0700, `downloads/` et `uploads/`) pour les deux
//   types, egress propre à la session (tâche 1.5, `egress`), bail du pool ; shared : contexte NEUF avec ses options.
// - Destruction, ordre fixe de 04c § 3.2, déclenchée une seule fois par la première fin (libération, délais, plantage, arrêt
//   du nœud, nœud isolé ; le superviseur écrit l'état final ENSUITE, étape 8) :
//     1. `gate` : plus de nouvelle connexion (relais WSS, tâche 2.3) ;
//     2. `egress_closed` : l'egress coupe ses tunnels et refuse toute nouvelle demande (`egress_closed`), AVANT l'arrêt du
//        navigateur : aucune connexion sortante ne survit à la fin ;
//     3. `browser_stopped` : dedicated, SIGKILL du groupe de processus (bail rendu au pool) ; shared, fermeture du contexte
//        (à délai) puis bail rendu (le pool détruit le Chromium chaud à la dernière session du client, BINV1) ;
//     4. `clients_detached` : connexions des clients fermées (le processus est déjà arrêté) ;
//     5. `objects_saved` : copie des objets demandés vers l'ObjectStore (tâches 1.8, 3.1, 3.3 : `saveObjects`) ;
//     6. `dir_removed` : suppression récursive de `sessions/{id}` (profil temporaire, téléchargements, envois) ;
//     7. `egress_stopped` : arrêt de l'egress, port libéré.
//   Une étape en échec n'arrête pas les suivantes (la destruction va toujours au bout) ; les échecs sont rapportés ensemble
//   (`SessionTeardownError`), le superviseur les journalise puis écrit l'état final.
// - Balayeur : au démarrage et périodiquement, tout répertoire `sessions/*` sans session active est supprimé (nœud planté,
//   destruction interrompue). Les processus Chromium sans session relèvent du balayage des groupes du pool (1.1).
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { sessionDir, type SessionDir } from '../dedicated/dedicated.js';
import type { AcquireRequest, PoolLease, SessionType } from '../pool/index.js';
import { sharedContextOptions } from './options.js';
import type { SessionAcquireRequest } from './supervisor.js';

export const TEARDOWN_STEPS = ['gate', 'egress_closed', 'browser_stopped', 'clients_detached', 'objects_saved', 'dir_removed', 'egress_stopped'] as const;
export type TeardownStep = (typeof TEARDOWN_STEPS)[number];

/** Egress d'une session (tâche 1.5) vu par la destruction : fermeture (étape 2), puis arrêt et libération du port (étape 7). */
export type SessionEgress = {
  /** URL du proxy local de la session, passée au contexte shared (le Chromium dedicated la reçoit de 1.5). */
  readonly proxyUrl?: string;
  close(): Promise<void>;
  stop(): Promise<void>;
};

export type EgressFactory = (session: { sessionId: string; tenantId: string; type: SessionType }) => Promise<SessionEgress>;

/** Connexion d'un client (relais Playwright ou CDP de la tâche 2.3). */
export type ClientConnection = { close(): Promise<void> | void };

export type HostLease = {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly type: SessionType;
  readonly browserId: string;
  readonly wsEndpoint: string;
  readonly cdpEndpoint: string | undefined;
  /** Contexte de la session shared ; dedicated : `undefined` (le client reçoit le navigateur entier). */
  readonly context: BrowserContext | undefined;
  readonly dir: SessionDir;
  /** Interrompu quand le pool met fin à la session (`crash`, `timed_out`, `shutdown`). */
  readonly signal: AbortSignal;
  /** Destruction complète (étapes 1 à 7). Idempotente. */
  release(): Promise<void>;
};

export class SessionTeardownError extends AggregateError {
  override name = 'SessionTeardownError';
  readonly sessionId: string;
  readonly steps: TeardownStep[];
  constructor(sessionId: string, failures: { step: TeardownStep; error: unknown }[]) {
    super(
      failures.map((f) => f.error),
      `destruction de la session ${sessionId} : étapes en échec ${failures.map((f) => f.step).join(', ')} (destruction menée à son terme)`,
    );
    this.sessionId = sessionId;
    this.steps = failures.map((f) => f.step);
  }
}

export type SessionHostOptions = {
  pool: { acquire(request: AcquireRequest): Promise<PoolLease> };
  /** `SYMB_DATA_DIR` (chemin absolu). */
  dataDir: string;
  /** Egress par session (tâche 1.5) ; absent : aucune étape réseau à mener. */
  egress?: EgressFactory;
  /** Copie des objets demandés (enregistrements, téléchargements conservés, profil persistant ; tâches 1.8, 3.1, 3.3). */
  saveObjects?: (lease: HostLease) => Promise<void>;
  /** Délai de fermeture d'un contexte shared (au-delà, le bail est rendu : le pool tue le Chromium à son délai dur). */
  contextCloseTimeoutMs?: number;
  onStep?: (sessionId: string, step: TeardownStep) => void;
};

type Active = {
  lease: HostLease;
  accepting: boolean;
  clients: Set<ClientConnection>;
  ending: Promise<void> | null;
};

export class SessionHost {
  readonly #options: SessionHostOptions;
  readonly #sessions = new Map<string, Active>();
  readonly #starting = new Set<string>();

  constructor(options: SessionHostOptions) {
    this.#options = options;
  }

  /** Sessions tenues (création ou destruction en cours comprises). */
  active(): string[] {
    return [...new Set([...this.#starting, ...this.#sessions.keys()])];
  }

  /** Étape 1 : une session en fin (ou inconnue) n'accepte plus de connexion. */
  accepting(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.accepting === true;
  }

  /** Enregistre la connexion d'un client ; refusée (et fermée aussitôt) si la session n'accepte plus de connexion. */
  attachClient(sessionId: string, connection: ClientConnection): boolean {
    const active = this.#sessions.get(sessionId);
    if (active === undefined || !active.accepting) {
      try {
        void Promise.resolve(connection.close()).catch(() => undefined);
      } catch {
        // fermeture impossible : la connexion n'atteint de toute façon aucun navigateur
      }
      return false;
    }
    active.clients.add(connection);
    return true;
  }

  async acquire(request: SessionAcquireRequest): Promise<HostLease> {
    const { sessionId, tenantId, type } = request;
    // Validation avant toute ressource : une option invalide ne réserve ni répertoire, ni egress, ni slot.
    const dir = sessionDir(this.#options.dataDir, sessionId);
    if (this.#sessions.has(sessionId) || this.#starting.has(sessionId)) throw new RangeError(`session ${sessionId} déjà présente sur ce nœud`);
    this.#starting.add(sessionId);
    let egress: SessionEgress | undefined;
    let pooled: PoolLease | undefined;
    try {
      if (type === 'shared') sharedContextOptions(request.options ?? {});
      await mkdir(join(this.#options.dataDir, 'sessions'), { recursive: true, mode: 0o700 });
      // Le Chromium dedicated crée lui-même `sessions/{id}` (absent exigé) ; pour shared, l'hôte le crée.
      if (type === 'shared') await mkdir(dir.root, { mode: 0o700 });
      egress = await this.#options.egress?.({ sessionId, tenantId, type });
      const acquire: AcquireRequest = { sessionId, type, tenantId };
      if (request.watchdogMs !== undefined) acquire.watchdogMs = request.watchdogMs;
      if (request.launchArgs !== undefined) acquire.launchArgs = request.launchArgs;
      pooled = await this.#options.pool.acquire(acquire);
      for (const sub of [dir.downloads, join(dir.root, 'uploads')]) await mkdir(sub, { recursive: true, mode: 0o700 });
      const context =
        type === 'shared'
          ? await pooled.browser.newContext(sharedContextOptions(request.options ?? {}, egress?.proxyUrl === undefined ? {} : { egressProxyUrl: egress.proxyUrl }))
          : undefined;
      const controller = new AbortController();
      const active: Active = { lease: undefined as unknown as HostLease, accepting: true, clients: new Set(), ending: null };
      const pool = pooled;
      const lease: HostLease = {
        sessionId,
        tenantId,
        type,
        browserId: pool.browserId,
        wsEndpoint: pool.wsEndpoint,
        cdpEndpoint: pool.cdpEndpoint,
        context,
        dir,
        signal: controller.signal,
        release: () => this.#teardown(active, pool, egress),
      };
      active.lease = lease;
      this.#sessions.set(sessionId, active);
      const forward = (): void => controller.abort(pool.signal.reason);
      if (pool.signal.aborted) forward();
      else pool.signal.addEventListener('abort', forward, { once: true });
      return lease;
    } catch (error) {
      await pooled?.release().catch(() => undefined);
      await egress?.close().catch(() => undefined);
      await egress?.stop().catch(() => undefined);
      await rm(dir.root, { recursive: true, force: true });
      throw error;
    } finally {
      this.#starting.delete(sessionId);
    }
  }

  /** Balayeur : supprime les répertoires `sessions/*` sans session tenue ; rend leurs noms. */
  async sweep(): Promise<string[]> {
    const root = join(this.#options.dataDir, 'sessions');
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }
    const held = new Set(this.active());
    const removed: string[] = [];
    for (const name of entries.sort()) {
      if (held.has(name)) continue;
      try {
        sessionDir(this.#options.dataDir, name);
      } catch {
        continue; // nom hors format : jamais créé par le nœud, laissé tel quel
      }
      await rm(join(root, name), { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }

  #teardown(active: Active, pool: PoolLease, egress: SessionEgress | undefined): Promise<void> {
    active.ending ??= (async () => {
      const { lease } = active;
      const failures: { step: TeardownStep; error: unknown }[] = [];
      const step = async (name: TeardownStep, work: () => Promise<void> | void): Promise<void> => {
        try {
          await work();
        } catch (error) {
          failures.push({ step: name, error });
        }
        this.#options.onStep?.(lease.sessionId, name);
      };
      await step('gate', () => {
        active.accepting = false;
      });
      await step('egress_closed', () => egress?.close());
      await step('browser_stopped', async () => {
        if (lease.context === undefined) return pool.release();
        let failure: unknown;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          lease.context.close().catch((error: unknown) => {
            failure = error;
          }),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#options.contextCloseTimeoutMs ?? 10_000))),
        ]);
        clearTimeout(timer);
        await pool.release();
        if (failure !== undefined) throw failure;
      });
      await step('clients_detached', async () => {
        const clients = [...active.clients];
        active.clients.clear();
        const results = await Promise.allSettled(clients.map(async (c) => c.close()));
        const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (rejected) throw rejected.reason;
      });
      await step('objects_saved', () => this.#options.saveObjects?.(lease));
      await step('dir_removed', () => rm(lease.dir.root, { recursive: true, force: true }));
      await step('egress_stopped', () => egress?.stop());
      this.#sessions.delete(lease.sessionId);
      if (failures.length > 0) throw new SessionTeardownError(lease.sessionId, failures);
    })();
    return active.ending;
  }
}
