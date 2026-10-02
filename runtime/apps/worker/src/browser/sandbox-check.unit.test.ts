// SPDX-License-Identifier: AGPL-3.0-only
// assert_chromium_sandbox_reported (revue 4.1b) : vérification au démarrage du worker de ce dont le bac à sable de Chromium
// a besoin (espaces de noms utilisateur, réseau et pid, sous l'uid du worker) ; régime seccomp lu dans /proc/self/status.
import { describe, expect, test } from 'vitest';
import { CHROMIUM_SANDBOX_PROBE, chromiumSandboxCheck, seccompMode } from './sandbox-check.js';

describe('assert_chromium_sandbox_reported — vérification du bac à sable de Chromium', () => {
  test('commande : espace de noms utilisateur, puis réseau et pid dedans, comme le bac à sable de Chromium', () => {
    expect(CHROMIUM_SANDBOX_PROBE).toEqual(['/usr/bin/unshare', ['--user', '--map-root-user', '--net', '--pid', '--fork', '/bin/true']]);
  });

  test('commande en échec ou absente : indisponible, avec le diagnostic ; commande réussie : disponible', async () => {
    expect(await chromiumSandboxCheck(['/bin/sh', ['-c', 'echo "unshare: unshare failed: Operation not permitted" >&2; exit 1']])).toEqual({
      available: false,
      detail: 'unshare: unshare failed: Operation not permitted',
    });
    expect(await chromiumSandboxCheck(['/zz-test/absent/unshare', []])).toMatchObject({ available: false, detail: expect.stringMatching(/ENOENT/) });
    expect(await chromiumSandboxCheck(['/bin/sh', ['-c', 'exit 0']])).toEqual({ available: true });
  });

  test('régime seccomp : champ Seccomp de /proc/self/status (Linux), sinon indéfini', () => {
    const mode = seccompMode();
    if (process.platform === 'linux') expect(['0', '1', '2']).toContain(mode);
    else expect(mode).toBeUndefined();
    expect(seccompMode('Name:\tnode\nSeccomp:\t2\nSeccomp_filters:\t1\n')).toBe('2');
  });
});
