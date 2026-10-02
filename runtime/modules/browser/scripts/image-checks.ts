// SPDX-License-Identifier: AGPL-3.0-only
// Sondes de l'image SYM Browser, rejouées par scripts/ci-local.ts (job `browser` de la CI) et testées par
// tests/image-checks.unit.test.ts : non root, filtre seccomp actif, aucun nouveau privilège ni capacité, aucun setuid.

/** Options de `docker run` : profil seccomp du module, no-new-privileges, toutes les capacités retirées. */
export const RUN_FLAGS: readonly string[] = [
  '--security-opt',
  'seccomp=modules/browser/deploy/seccomp-chromium.json',
  '--security-opt',
  'no-new-privileges',
  '--cap-drop',
  'ALL',
];

/** Identité du processus du conteneur : uid, puis l'état du filtre et des privilèges lu dans /proc/self/status. */
export const IDENTITY_PROBE: readonly string[] = ['sh', '-c', "id -u; grep -E '^(Seccomp|NoNewPrivs|CapEff):' /proc/self/status"];

/** Fichiers setuid ou setgid de l'image (erreurs de lecture ignorées : pwuser ne lit pas tout le système de fichiers). */
export const SETUID_PROBE: readonly string[] = ['sh', '-c', 'find / -xdev -perm /6000 -type f 2>/dev/null; true'];

/** Motif d'échec de la sonde d'identité, ou `undefined` si le conteneur est confiné comme attendu. */
export function checkIdentity(out: string): string | undefined {
  const [uid = '', ...rest] = out.trim().split('\n');
  if (!/^\d+$/.test(uid.trim()) || Number(uid.trim()) === 0) return `uid attendu non nul, obtenu « ${uid.trim()} »`;
  const field = (name: string) => rest.map((line) => new RegExp(`^${name}:\\s*(\\S+)$`).exec(line.trim())?.[1]).find((v) => v !== undefined);
  // Seccomp: 2 = mode filtre (profil appliqué) ; 0 = aucun filtre (unconfined).
  if (field('Seccomp') !== '2') return `filtre seccomp inactif (Seccomp: ${field('Seccomp') ?? 'absent'}, 2 attendu)`;
  if (field('NoNewPrivs') !== '1') return `no-new-privileges absent (NoNewPrivs: ${field('NoNewPrivs') ?? 'absent'}, 1 attendu)`;
  const caps = field('CapEff');
  if (caps === undefined || !/^0+$/.test(caps)) return `capacités effectives non nulles (CapEff: ${caps ?? 'absent'})`;
  return undefined;
}

/** Motif d'échec de la sonde setuid : la liste des fichiers trouvés, ou `undefined` si aucun. */
export function checkNoSetuid(out: string): string | undefined {
  const found = out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return found.length === 0 ? undefined : `binaires setuid ou setgid dans l'image : ${found.join(', ')}`;
}
