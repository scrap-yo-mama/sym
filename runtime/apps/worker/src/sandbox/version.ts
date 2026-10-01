// SPDX-License-Identifier: AGPL-3.0-only
// Borne basse d'isolated-vm (08 §3, avis GHSA-864f-rcv7-6rh4 : versions <= 7.0.0 affectées, corrigées en 7.0.1 et 6.2.0).
// Le worker refuse de démarrer sous la borne, ou si la branche installée ne porte pas le binaire de ce Node.
import { createRequire } from 'node:module';

type Version = [number, number, number];

function parse(version: string): Version {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`version illisible : « ${version} »`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] as number) !== (min[i] as number)) return (v[i] as number) > (min[i] as number);
  }
  return true;
}

/**
 * Refuse une combinaison isolated-vm × Node non sûre ou non prise en charge :
 * - 6.x : 6.2.0 au moins (correctif rétroporté), Node 22 ou 24 seulement (pas de binaire ABI 147 pour Node 26) ;
 * - 7.x : 7.0.1 au moins, Node 24 ou plus ;
 * - toute autre branche : refus.
 */
export function checkIsolatedVmVersion(ivmVersion: string, nodeVersion: string): void {
  const ivm = parse(ivmVersion);
  const node = parse(nodeVersion);
  const refuse = (why: string) => {
    throw new Error(`bac à sable : isolated-vm ${ivmVersion} refusé sur Node ${nodeVersion} (${why})`);
  };
  if (ivm[0] === 6) {
    if (!atLeast(ivm, [6, 2, 0])) refuse('GHSA-864f-rcv7-6rh4 : 6.2.0 au moins');
    if (node[0] > 24) refuse('la branche 6.x ne porte pas Node 26 : 7.0.1 au moins');
    return;
  }
  if (ivm[0] === 7) {
    if (!atLeast(ivm, [7, 0, 1])) refuse('GHSA-864f-rcv7-6rh4 : 7.0.1 au moins');
    if (node[0] < 24) refuse('Node 24 au moins');
    return;
  }
  refuse('branche non validée');
}

/** Version installée d'isolated-vm (lecture de son package.json, sans charger le module natif). */
export function installedIsolatedVmVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('isolated-vm/package.json') as { version: string }).version;
}

/** Test de démarrage du worker : lève si la version installée est sous la borne. */
export function assertSandboxSupported(): void {
  checkIsolatedVmVersion(installedIsolatedVmVersion(), process.versions.node);
}
