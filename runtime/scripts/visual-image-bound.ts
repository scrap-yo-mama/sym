// SPDX-License-Identifier: AGPL-3.0-only
// Borne de durée du conteneur de `pnpm visual:image` (D-88) : sans elle, un conteneur bloqué gardait un verrou de tests des
// heures durant (et, sur GitHub, consommerait le runner jusqu'à sa limite). Le conteneur porte un nom propre au processus ;
// la commande docker reçoit une durée maximale ; à l'expiration, le client docker est tué, le conteneur supprimé de force
// (`docker rm -f`, le tuer suffit à libérer le verrou) et la commande échoue. `timeout`/`gtimeout` n'existent pas sous macOS :
// la borne vit donc ici, en Node, quel que soit le poste. Le script joué dans le conteneur (visualContainerScript) est ici aussi.

/** Durée maximale par défaut : 25 minutes (installation, build et suite visuelle dans l'image tiennent en moins de 10). */
export const DEFAULT_VISUAL_TIMEOUT_MS = 25 * 60 * 1000;

/** Code de sortie à l'expiration, celui de `timeout(1)`. */
export const TIMED_OUT_STATUS = 124;

/** Durée maximale du conteneur : `SYM_VISUAL_TIMEOUT_MS` (entier positif, en millisecondes) ou 25 minutes. */
export function visualTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['SYM_VISUAL_TIMEOUT_MS'];
  if (raw === undefined) return DEFAULT_VISUAL_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`visual:image : SYM_VISUAL_TIMEOUT_MS doit être un entier positif de millisecondes (reçu « ${raw} »).`);
  return Number(raw);
}

/** Nom du conteneur, propre au processus qui le lance : c'est par lui qu'on le supprime. */
export function visualContainerName(pid: number): string {
  return `sym-visual-${pid}`;
}

/** Sous-ensemble de `spawnSync` utilisé (injectable pour les tests). */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: 'inherit' | 'ignore'; timeout?: number; killSignal?: NodeJS.Signals },
) => { status: number | null; signal: NodeJS.Signals | null; error?: Error };

/**
 * `docker run --name <name> <args…>` borné à `timeoutMs` ; à l'expiration, `docker rm -f <name>` puis échec (code 124).
 * Un client docker tué par un signal sans expiration échoue aussi, conteneur supprimé.
 */
export function runBoundedContainer(spawn: SpawnLike, args: readonly string[], options: { name: string; timeoutMs: number }): { status: number; timedOut: boolean } {
  const result = spawn('docker', ['run', '--name', options.name, ...args], { stdio: 'inherit', timeout: options.timeoutMs, killSignal: 'SIGKILL' });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (timedOut || result.status === null) {
    spawn('docker', ['rm', '-f', options.name], { stdio: 'ignore' });
    if (timedOut) console.error(`visual:image : conteneur ${options.name} arrêté après ${Math.round(options.timeoutMs / 1000)} s (SYM_VISUAL_TIMEOUT_MS) et supprimé.`);
    return { status: timedOut ? TIMED_OUT_STATUS : 1, timedOut };
  }
  return { status: result.status, timedOut: false };
}

/** Dossiers exclus de la copie de runtime/ dans le conteneur (dépendances et builds de l'hôte, d'une autre plateforme). */
const EXCLUDED = ['node_modules', 'dist', 'coverage', 'test-results', 'blob-report', 'playwright-report', '.wxt', '.output', '.vitepress/cache', '.vitepress/dist', '*.tsbuildinfo'];

/**
 * Script joué dans le conteneur : copie de runtime/ (monté en lecture seule), installation, build, suite visuelle, puis
 * copie dans /out des instantanés (`update`) et des captures d'écart (en échec seulement). Le conteneur tourne en root : /out est
 * rendu à `owner` (« uid:gid » de l'hôte) avant la sortie, sinon le coureur GitHub, non root, ne peut plus supprimer le dossier.
 */
export function visualContainerScript(options: { update: boolean; owner: string | null }): string {
  return [
    'set -eu',
    'mkdir -p /work',
    `tar -C /src ${EXCLUDED.map((name) => `--exclude=${name}`).join(' ')} -cf - . | tar -C /work -xf -`,
    'cd /work',
    'corepack enable >/dev/null',
    'pnpm install --frozen-lockfile --filter "@runtime/web..." --store-dir /pnpm-store --reporter=append-only',
    'pnpm --filter "@runtime/web^..." build',
    'cd apps/web',
    `status=0; pnpm exec playwright test --project ui-en --project ui-fr --project ui-pseudo${options.update ? ' --update-snapshots=all' : ''} || status=$?`,
    options.update ? 'if [ "$status" -eq 0 ]; then cp -R e2e/__visual__/linux /out/linux; fi' : 'true',
    'if [ "$status" -ne 0 ] && [ -d test-results ]; then cp -R test-results /out/test-results; fi',
    ...(options.owner === null ? [] : [`chown -R ${options.owner} /out || true`]),
    'exit $status',
  ].join('\n');
}
