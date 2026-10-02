// SPDX-License-Identifier: AGPL-3.0-only
// Sondes de l'image rejouées par scripts/ci-local.ts (job `browser`) : le conteneur tourne non root, sous le profil seccomp
// actif (mode filtre), sans nouveaux privilèges ni capacité effective, et l'image ne contient aucun binaire setuid ou setgid.
import { describe, expect, test } from 'vitest';
import { checkIdentity, checkNoSetuid, IDENTITY_PROBE, RUN_FLAGS, SETUID_PROBE } from '../scripts/image-checks.ts';

const status = (lines: Record<string, string>) => Object.entries(lines).map(([key, value]) => `${key}:\t${value}`).join('\n');
const healthy = `1001\n${status({ Seccomp: '2', NoNewPrivs: '1', CapEff: '0000000000000000' })}\n`;

describe('sondes de l’image SYM Browser', () => {
  test('docker run : profil seccomp du module, no-new-privileges, aucune capacité', () => {
    const flags = RUN_FLAGS.join(' ');
    expect(flags).toContain('--security-opt seccomp=modules/browser/deploy/seccomp-chromium.json');
    expect(flags).toContain('--security-opt no-new-privileges');
    expect(flags).toContain('--cap-drop ALL');
  });

  test('sonde d’identité : uid et état du filtre lus dans /proc/self/status', () => {
    expect(IDENTITY_PROBE.join(' ')).toMatch(/id -u/);
    expect(IDENTITY_PROBE.join(' ')).toMatch(/\/proc\/self\/status/);
    expect(checkIdentity(healthy)).toBeUndefined();
  });

  test.each([
    ['uid 0', `0\n${status({ Seccomp: '2', NoNewPrivs: '1', CapEff: '0000000000000000' })}`],
    ['seccomp inactif (unconfined)', `1001\n${status({ Seccomp: '0', NoNewPrivs: '1', CapEff: '0000000000000000' })}`],
    ['seccomp absent de la sortie', `1001\n${status({ NoNewPrivs: '1', CapEff: '0000000000000000' })}`],
    ['nouveaux privilèges permis', `1001\n${status({ Seccomp: '2', NoNewPrivs: '0', CapEff: '0000000000000000' })}`],
    ['capacités effectives', `1001\n${status({ Seccomp: '2', NoNewPrivs: '1', CapEff: '00000000a80425fb' })}`],
    ['sortie vide', ''],
  ])('sonde d’identité refusée : %s', (_name, out) => {
    expect(checkIdentity(out)).toBeDefined();
  });

  test('sonde setuid : aucun fichier listé', () => {
    expect(SETUID_PROBE.join(' ')).toMatch(/-perm \/6000/);
    expect(checkNoSetuid('')).toBeUndefined();
    expect(checkNoSetuid('\n')).toBeUndefined();
    expect(checkNoSetuid('/usr/bin/su\n/usr/bin/passwd\n')).toContain('/usr/bin/su');
  });
});
