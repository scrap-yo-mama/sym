// SPDX-License-Identifier: AGPL-3.0-only
// Bac à sable de Chromium (revue 4.1b) : Chromium tourne AVEC son bac à sable (jamais --no-sandbox), qui crée un espace de
// noms utilisateur, puis réseau et pid dedans. Le profil seccomp par défaut de Docker le refuse sans CAP_SYS_ADMIN, et
// AppArmor peut le restreindre (Ubuntu 24.04) : Chromium s'arrête alors sur « No usable sandbox! » à chaque run navigateur.
// Le worker le vérifie au démarrage, sous son propre uid (celui de Chromium), et le dit clairement (exec/factory.ts).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type ChromiumSandboxStatus = { available: true } | { available: false; detail: string };

/** Ce que le bac à sable de Chromium demande au noyau : espace de noms utilisateur, puis réseau et pid dedans. */
export const CHROMIUM_SANDBOX_PROBE: readonly [string, readonly string[]] = ['/usr/bin/unshare', ['--user', '--map-root-user', '--net', '--pid', '--fork', '/bin/true']];

export function chromiumSandboxCheck(probe: readonly [string, readonly string[]] = CHROMIUM_SANDBOX_PROBE): Promise<ChromiumSandboxStatus> {
  return new Promise((resolve) => {
    execFile(probe[0], [...probe[1]], { env: {}, timeout: 10_000 }, (err, _stdout, stderr) => {
      if (err === null) resolve({ available: true });
      else resolve({ available: false, detail: (String(stderr).trim() || err.message).slice(0, 300) });
    });
  });
}

/** Champ `Seccomp` de /proc/self/status (0 aucun filtre, 1 strict, 2 filtre) ; indéfini hors Linux. */
export function seccompMode(status?: string): string | undefined {
  let text = status;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/self/status', 'utf8');
    } catch {
      return undefined;
    }
  }
  return /^Seccomp:\s*(\d)/m.exec(text)?.[1];
}
