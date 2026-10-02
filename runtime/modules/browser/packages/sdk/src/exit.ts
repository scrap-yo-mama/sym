// SPDX-License-Identifier: MIT
// Fermeture automatique (04 § 10) : les sessions créées par le SDK et encore vivantes sont libérées à la sortie du process.
// - `SIGINT`, `SIGTERM` : libération (bornée par `EXIT_RELEASE_TIMEOUT_MS`), puis, si personne d'autre n'écoute ce signal,
//   sortie avec le code d'usage (130, 143) ; sinon l'application garde la main ;
// - `beforeExit` : boucle d'événements vide avec des sessions encore suivies (script terminé sans libérer) : libération,
//   puis sortie normale.
// Les écouteurs ne sont posés que tant qu'au moins une session est suivie : sans session vivante, le SDK ne change rien au
// comportement du process. Aucun signal n'est envoyé à un autre process.

/** Délai maximal d'une libération pendant la sortie du process. */
export const EXIT_RELEASE_TIMEOUT_MS = 5_000;

export type Releasable = { release(): Promise<unknown> };

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
type ExitSignal = keyof typeof SIGNAL_EXIT_CODES;

const tracked = new Set<Releasable>();
let installed = false;
let releasing: Promise<void> | undefined;

function releaseAll(): Promise<void> {
  releasing ??= (async () => {
    const pending = [...tracked];
    tracked.clear();
    await Promise.allSettled(
      pending.map((entry) => {
        let timer: NodeJS.Timeout | undefined;
        return Promise.race([entry.release(), new Promise<void>((resolve) => (timer = setTimeout(resolve, EXIT_RELEASE_TIMEOUT_MS)))]).finally(() => clearTimeout(timer));
      }),
    );
  })().finally(() => {
    releasing = undefined;
  });
  return releasing;
}

function onSignal(signal: ExitSignal): void {
  void releaseAll().finally(() => {
    uninstall();
    if (process.listenerCount(signal) === 0) process.exit(SIGNAL_EXIT_CODES[signal]);
  });
}

const onSigint = (): void => onSignal('SIGINT');
const onSigterm = (): void => onSignal('SIGTERM');
const onBeforeExit = (): void => {
  if (tracked.size > 0) void releaseAll().finally(() => (tracked.size === 0 ? uninstall() : undefined));
  else uninstall();
};

function install(): void {
  if (installed) return;
  installed = true;
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('beforeExit', onBeforeExit);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('beforeExit', onBeforeExit);
}

/** Suit une session à libérer à la sortie du process. */
export function trackForExit(entry: Releasable): void {
  tracked.add(entry);
  install();
}

/** Session libérée (ou suivie ailleurs) : plus rien à faire pour elle à la sortie. */
export function untrackForExit(entry: Releasable): void {
  tracked.delete(entry);
  if (tracked.size === 0 && releasing === undefined) uninstall();
}
