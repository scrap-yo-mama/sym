// SPDX-License-Identifier: AGPL-3.0-only
// Fin d'une session dedicated à profil persistant en écriture (cdc/sym-browser 04c § 3.2 et § 4.2, tâche 3.1).
// - `close` (fin normale : libération, délai, arrêt du nœud) : Chromium fermé proprement pour que ses bases (cookies,
//   stockages, IndexedDB) soient écrites sur disque, PUIS sauvegarde (`v{n+1}`, pointeur et verrou ensemble), PUIS
//   destruction (étapes 3 à 6). La sauvegarde précède la suppression du répertoire, comme l'étape 5 précède l'étape 6.
// - `kill` (plantage, délai de fermeture du pool dépassé) : destruction sans sauvegarde, puis verrou libéré ; la dernière
//   version valide reste en place. Un `kill` pendant un `close` qui traîne annule la sauvegarde à venir.
// Écart assumé avec l'ordre de 1.4 (« tuer avant de détacher ») pour ces seules sessions : la fermeture propre détache
// les clients pendant que Chromium s'arrête, sans quoi un SIGKILL perdrait les écritures non vidées.

export type PersistentTeardownSteps = {
  /** Destruction de la session (createDedicatedTeardown) : SIGKILL du groupe, détachement, suppression du répertoire. */
  teardown: () => Promise<void>;
  /** Fermeture propre de Chromium ; une erreur ou un dépassement de délai empêche la sauvegarde. */
  gracefulClose: () => Promise<void>;
  /** Sauvegarde du profil (ProfileStore.save) : publie `v{n+1}` et libère le verrou. */
  save: () => Promise<unknown>;
  /** Libération du verrou sans sauvegarde (ProfileStore.release). */
  abandon: () => Promise<void>;
};

export type PersistentTeardown = { close: () => Promise<void>; kill: () => Promise<void> };

export function createPersistentTeardown(steps: PersistentTeardownSteps): PersistentTeardown {
  let killed = false;
  let closing: Promise<void> | null = null;
  let killing: Promise<void> | null = null;

  const kill = (): Promise<void> => {
    killed = true;
    killing ??= (async () => {
      try {
        await steps.teardown();
      } finally {
        await steps.abandon().catch(() => undefined);
      }
    })();
    return killing;
  };

  const close = (): Promise<void> => {
    if (killed) return kill();
    closing ??= (async () => {
      let flushed = false;
      try {
        await steps.gracefulClose();
        flushed = true;
      } catch {
        // Fermeture ratée : la destruction forcée suit, sans sauvegarde.
      }
      if (!flushed || killed) return kill();
      let saved = false;
      try {
        await steps.save();
        saved = true;
      } catch {
        // Version précédente intacte (ProfileStore.save) ; le verrou est libéré par `abandon` ci-dessous.
      }
      if (saved) {
        killing ??= steps.teardown();
        return killing;
      }
      return kill();
    })();
    return closing;
  };

  return { close, kill };
}
