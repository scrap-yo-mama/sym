// SPDX-License-Identifier: AGPL-3.0-only
// Sessions `dedicated` (cdc/sym-browser 04 § 3, 03 § 3, 04f § 1, tâche 1.4) : liste fermée `launchArgs`, bascule
// automatique vers `dedicated` (défaut de l'API) selon les options.
import { LAUNCH_ARGS } from '@sym/contracts/browser';
import { describe, expect, test } from 'vitest';
import { DEDICATED_LAUNCH_FLAGS, dedicatedLaunchFlags, InvalidLaunchArgError } from './launch-args.js';
import { resolveSessionType } from './session-type.js';

describe('launchArgs : liste fermée (figée par la tâche 1.4)', () => {
  test('exactement les noms du contrat, chacun traduit en un seul drapeau Chromium', () => {
    expect(Object.keys(DEDICATED_LAUNCH_FLAGS).sort()).toEqual([...LAUNCH_ARGS].sort());
    expect(DEDICATED_LAUNCH_FLAGS).toEqual({
      'mute-audio': '--mute-audio',
      'hide-scrollbars': '--hide-scrollbars',
      'disable-gpu': '--disable-gpu',
      'force-color-profile-srgb': '--force-color-profile=srgb',
      'disable-smooth-scrolling': '--disable-smooth-scrolling',
    });
    expect(dedicatedLaunchFlags(['mute-audio', 'disable-gpu'])).toEqual(['--mute-audio', '--disable-gpu']);
    expect(dedicatedLaunchFlags([])).toEqual([]);
  });

  test('doublons fusionnés, ordre de la liste fermée', () => {
    expect(dedicatedLaunchFlags(['disable-gpu', 'mute-audio', 'disable-gpu'])).toEqual(['--mute-audio', '--disable-gpu']);
  });

  test('tout autre argument refusé avant le lancement (bac à sable, débogage, profil, proxy, nom inconnu)', () => {
    for (const arg of [
      '--no-sandbox',
      'no-sandbox',
      'remote-debugging-port',
      '--remote-debugging-address=0.0.0.0',
      'user-data-dir',
      'proxy-server',
      'mute-audio=1',
      '--mute-audio',
      'MUTE-AUDIO',
      '',
      'toString',
      '__proto__',
    ]) {
      expect(() => dedicatedLaunchFlags([arg]), arg).toThrow(InvalidLaunchArgError);
    }
    try {
      dedicatedLaunchFlags(['mute-audio', '--no-sandbox']);
    } catch (error) {
      expect((error as InvalidLaunchArgError).arg).toBe('--no-sandbox');
      expect((error as Error).message).toContain('mute-audio');
    }
  });
});

describe('type de session : défaut dedicated, bascule selon les options', () => {
  test('sans type : dedicated (défaut de l’API depuis le CDC v1.2)', () => {
    expect(resolveSessionType({})).toEqual({ type: 'dedicated', switched: false });
  });

  test('type explicite conservé quand aucune option ne l’exige', () => {
    expect(resolveSessionType({ type: 'shared' })).toEqual({ type: 'shared', switched: false });
    expect(resolveSessionType({ type: 'shared', launchArgs: [] })).toEqual({ type: 'shared', switched: false });
    expect(resolveSessionType({ type: 'dedicated', launchArgs: ['mute-audio'] })).toEqual({ type: 'dedicated', switched: false });
  });

  test('shared + launchArgs ou profil : bascule automatique en dedicated, raison donnée', () => {
    expect(resolveSessionType({ type: 'shared', launchArgs: ['mute-audio'] })).toEqual({ type: 'dedicated', switched: true, reason: 'launchArgs' });
    expect(resolveSessionType({ type: 'shared', profile: { id: 'p1', mode: 'read' } })).toEqual({ type: 'dedicated', switched: true, reason: 'profile' });
    expect(resolveSessionType({ type: 'shared', profile: { id: 'p1', mode: 'write' }, launchArgs: ['disable-gpu'] })).toMatchObject({ type: 'dedicated', switched: true });
  });
});
