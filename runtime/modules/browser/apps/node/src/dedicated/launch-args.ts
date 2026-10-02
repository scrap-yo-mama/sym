// SPDX-License-Identifier: AGPL-3.0-only
// `launchArgs` des sessions dedicated (cdc/sym-browser 04 § 3, 04b § 2) : liste fermée de noms, figée par la tâche 1.4,
// traduite en drapeaux Chromium par cette table seule. Aucun argument libre n'atteint Chromium : ni `--no-sandbox`, ni
// débogage distant, ni profil, ni proxy (ceux-là sont figés par le nœud). Un nom inconnu refuse la session (invalid_option).
import { LAUNCH_ARGS, type LaunchArg } from '@sym/contracts/browser';

export const DEDICATED_LAUNCH_FLAGS: Readonly<Record<LaunchArg, string>> = Object.freeze({
  'mute-audio': '--mute-audio',
  'hide-scrollbars': '--hide-scrollbars',
  'disable-gpu': '--disable-gpu',
  'force-color-profile-srgb': '--force-color-profile=srgb',
  'disable-smooth-scrolling': '--disable-smooth-scrolling',
});

export class InvalidLaunchArgError extends Error {
  override name = 'InvalidLaunchArgError';
  readonly arg: string;
  constructor(arg: string) {
    super(`argument de lancement refusé : « ${arg} » ; liste fermée : ${LAUNCH_ARGS.join(', ')}`);
    this.arg = arg;
  }
}

export function isLaunchArg(value: string): value is LaunchArg {
  return (LAUNCH_ARGS as readonly string[]).includes(value);
}

/** Drapeaux Chromium des noms demandés, sans doublon, dans l'ordre de la liste fermée. */
export function dedicatedLaunchFlags(names: readonly string[]): string[] {
  for (const name of names) if (!isLaunchArg(name)) throw new InvalidLaunchArgError(name);
  return LAUNCH_ARGS.filter((name) => names.includes(name)).map((name) => DEDICATED_LAUNCH_FLAGS[name]);
}
