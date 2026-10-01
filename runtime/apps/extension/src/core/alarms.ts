// SPDX-License-Identifier: AGPL-3.0-only
// Alarmes périodiques du service worker (07 § 2, § 4). `alarms.create` remplace une alarme de même nom et remet son
// délai à zéro : l'appeler à chaque réveil du worker (popup, alarme de 30 s de la tâche 2.7) empêcherait l'alarme
// horaire de jamais partir. On ne la crée donc que si elle n'existe pas.

type Alarms = {
  get(name: string): Promise<unknown>;
  create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
};

/** Crée l'alarme périodique `name` si elle n'existe pas ; renvoie vrai si elle vient d'être créée. */
export async function ensurePeriodicAlarm(alarms: Alarms, name: string, periodInMinutes: number): Promise<boolean> {
  if (await alarms.get(name)) return false;
  await alarms.create(name, { periodInMinutes });
  return true;
}
