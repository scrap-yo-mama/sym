// SPDX-License-Identifier: AGPL-3.0-only
// Compatibilité des versions (16 §3, tâche 4.9). `GET /api/version` est servi localement : la V1.0 n'interroge aucun
// serveur distant (INV9). L'extension envoie sa version à l'appairage ; sous `MIN_EXTENSION_VERSION`, l'instance refuse.

/** Version minimale de l'extension acceptée à l'appairage. À monter quand le protocole extension ↔ instance casse. */
export const MIN_EXTENSION_VERSION = '0.0.0';

/** Version de la spécification MCP servie (05, spec sans état, Streamable HTTP). */
export const MCP_SPEC_VERSION = '2026-07-28';

/** Version affichée par une image construite sans `--build-arg RUNTIME_VERSION` : un placeholder, jamais une version réelle. */
export const PLACEHOLDER_VERSION = '0.0.0';

/** Un commit Git lisible : 7 à 64 caractères hexadécimaux (aucune branche, aucun chemin, aucune valeur libre). */
const COMMIT = /^[0-9a-f]{7,64}$/i;

export type BuildInfo = { version: string; commit?: string };

/**
 * Identité publiée par `/api/version`, `/api/health` et `serverInfo` (U4.1, UX-10). Version : `RUNTIME_VERSION` posée par la
 * release, sinon la version du paquet (`packageVersion`) quand l'image est construite sans argument (staging Render, build
 * depuis le dépôt) ; le placeholder `0.0.0` ne reste que si rien d'autre n'est lisible. Commit : `RUNTIME_COMMIT`, sinon
 * `RENDER_GIT_COMMIT` (posée par Render) ; une valeur qui n'est pas un commit hexadécimal est ignorée.
 */
export function resolveBuildInfo(env: Record<string, string | undefined>, packageVersion: string | undefined): BuildInfo {
  const fromEnv = env['RUNTIME_VERSION'];
  const version = fromEnv && fromEnv !== PLACEHOLDER_VERSION ? fromEnv : (packageVersion ?? PLACEHOLDER_VERSION);
  const commit = [env['RUNTIME_COMMIT'], env['RENDER_GIT_COMMIT']].find((c) => c !== undefined && COMMIT.test(c));
  return commit === undefined ? { version } : { version, commit };
}

export type Semver = { major: number; minor: number; patch: number; pre: string[] };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `X.Y.Z` ou `X.Y.Z-pré.version` ; `undefined` pour toute autre forme (aucune métadonnée de build, aucun préfixe `v`). */
export function parseSemver(version: string): Semver | undefined {
  const m = SEMVER.exec(version);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split('.') };
}

const isNumeric = (s: string) => /^\d+$/.test(s);

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1; // la pré-version précède la version
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNumeric(x) && isNumeric(y)) return Number(x) < Number(y) ? -1 : 1;
    if (isNumeric(x) !== isNumeric(y)) return isNumeric(x) ? -1 : 1; // un identifiant numérique précède un identifiant texte
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Ordre SemVer 2.0 : -1, 0 ou 1. Lève sur une version illisible. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`version SemVer illisible : ${x ? b : a}`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre) as -1 | 0 | 1;
}

/**
 * Vrai si l'extension est sous le minimum, si sa version est illisible (refus par prudence), ou si elle ne la donne pas
 * alors que le minimum dépasse 0.0.0 : sans cela, un client qui omet le champ contournerait le refus.
 */
export function extensionTooOld(version: string | undefined, min: string): boolean {
  if (version === undefined) return compareSemver(min, '0.0.0') > 0;
  return parseSemver(version) === undefined || compareSemver(version, min) < 0;
}
