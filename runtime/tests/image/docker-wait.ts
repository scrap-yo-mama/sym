// SPDX-License-Identifier: AGPL-3.0-only
// Attentes de l'étape image (tests/image) : sondage borné, et attente de PostgreSQL qui survit à une VM Docker chargée.
// Constat de la gate W2 : quand une autre suite lourde charge la même VM Docker (3,8 Go), le conteneur PostgreSQL du test
// peut s'arrêter ; `pg_isready` n'aboutit plus et son nom ne se résout plus sur le réseau du test. On le redémarre alors une
// fois (même nom, même réseau, même volume) et, à défaut, l'échec donne l'état du conteneur au lieu d'un simple délai.

export type DockerRun = (args: string[], timeoutMs?: number) => { status: number; stdout: string; stderr: string };

export type WaitClock = { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sonde `check` toutes les `pollMs` jusqu'à `timeoutMs` ; échoue par « délai dépassé : <what> ». */
export async function until(what: string, check: () => boolean, timeoutMs: number, clock: WaitClock & { readonly pollMs?: number } = {}): Promise<void> {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? realSleep;
  const deadline = now() + timeoutMs;
  while (!check()) {
    if (now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await sleep(clock.pollMs ?? 500);
  }
}

/** Délai par défaut de l'attente de PostgreSQL : le double de l'ancien (90 s), pour une VM partagée. */
const PG_READY_TIMEOUT_MS = 180_000;

/** `running oomKilled exitCode` du conteneur (`docker inspect`), ou `absent`. */
function stateOf(docker: DockerRun, name: string): { running: boolean; text: string } {
  const r = docker(['inspect', '-f', '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}', name], 30_000);
  if (r.status !== 0) return { running: false, text: 'absent' };
  const [running = '?', oom = '?', exit = '?'] = r.stdout.trim().split(/\s+/);
  return { running: running === 'true', text: `running=${running} oom_killed=${oom} exit_code=${exit}` };
}

/**
 * Attend que PostgreSQL accepte les connexions dans le conteneur `name`. Si le conteneur s'est arrêté (par exemple tué faute
 * de mémoire), il est redémarré UNE fois. Échec : délai dépassé, avec l'état du conteneur et la cause probable.
 */
export async function waitForPostgres(docker: DockerRun, name: string, opts: WaitClock & { readonly timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? PG_READY_TIMEOUT_MS;
  let restarted = false;
  const ready = () => {
    if (docker(['exec', name, 'pg_isready', '-U', 'runtime', '-d', 'runtime'], 30_000).status === 0) return true;
    if (!restarted && !stateOf(docker, name).running) {
      restarted = true;
      docker(['start', name], 60_000);
    }
    return false;
  };
  try {
    await until('PostgreSQL prêt', ready, timeoutMs, opts);
  } catch (error) {
    const state = stateOf(docker, name).text;
    throw new Error(
      `${(error as Error).message} (${name} : ${state}${restarted ? ', redémarré une fois' : ''}). Cause probable : VM Docker saturée par une autre suite lourde ; rejouer l'étape image seule.`,
      { cause: error },
    );
  }
}
