// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.9 : version que release-please calculera pour chaque canal, à partir des fichiers de configuration du dépôt.
// Portage fidèle des stratégies de version de release-please 17.6.0 (celle qu'embarque release-please-action v5.0.0) :
// src/factories/versioning-strategy-factory.ts (`options.type || 'default'`), src/versioning-strategies/default.ts,
// src/versioning-strategies/prerelease.ts, src/versioning-strategy.ts, src/version.ts. release-please n'est pas une
// dépendance du dépôt (≈ 140 paquets, octokit compris) : le portage est recoupé avec la bibliothèque réelle hors du dépôt.
// Sans `"versioning": "prerelease"`, release-please prend la stratégie par défaut, qui ignore `prerelease-type` : la
// branche beta produirait alors une version simple `X.Y.Z`, publiée en STABLE par release.yml.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planRelease, ReleaseTagError } from './plan.ts';

export type ReleasePleaseConfig = {
  versioning?: string;
  prerelease?: boolean;
  'prerelease-type'?: string;
  'bump-minor-pre-major'?: boolean;
  'bump-patch-for-minor-pre-major'?: boolean;
  'include-v-in-tag'?: boolean;
};

/** Nature d'un lot de commits conventionnels : le plus fort l'emporte (cassant > fonction > correctif). */
export type Change = 'fix' | 'feat' | 'breaking';

type Version = { major: number; minor: number; patch: number; pre?: string | undefined; build?: string | undefined };

const VERSION = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(-(?<pre>[^+]+))?(\+(?<build>.*))?/;

function parse(text: string): Version {
  const g = VERSION.exec(text)?.groups;
  if (!g) throw new Error(`version illisible : ${text}`);
  return { major: Number(g['major']), minor: Number(g['minor']), patch: Number(g['patch']), pre: g['pre'], build: g['build'] };
}

const format = (v: Version) => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ''}${v.build ? `+${v.build}` : ''}`;

type Updater = (v: Version) => Version;

// Stratégie par défaut : la pré-version courante est conservée telle quelle.
const major: Updater = (v) => ({ ...v, major: v.major + 1, minor: 0, patch: 0 });
const minor: Updater = (v) => ({ ...v, minor: v.minor + 1, patch: 0 });
const patch: Updater = (v) => ({ ...v, patch: v.patch + 1 });

/** Incrémente le DERNIER nombre de la pré-version (`beta.1` → `beta.2`) ; sans nombre, ajoute `.1`. */
function bumpPrerelease(pre: string): string {
  const match = /(?<number>\d+)(?=\D*$)/.exec(pre);
  const digits = match?.groups?.['number'];
  if (digits === undefined) return `${pre}.1`;
  return pre.replace(/(\d+)(?=\D*$)/, `${Number(digits) + 1}`.padStart(digits.length, '0'));
}

const prePatch = (type: string | undefined): Updater => (v) =>
  v.pre ? { ...v, pre: bumpPrerelease(v.pre) } : { ...v, patch: v.patch + 1, pre: type };
const preMinor = (type: string | undefined): Updater => (v) => {
  if (v.pre) return v.patch === 0 ? { ...v, pre: bumpPrerelease(v.pre) } : minor(v);
  return { ...v, minor: v.minor + 1, patch: 0, pre: type };
};
const preMajor = (type: string | undefined): Updater => (v) => {
  if (v.pre) return v.patch === 0 && v.minor === 0 ? { ...v, pre: bumpPrerelease(v.pre) } : major(v);
  return { ...v, major: v.major + 1, minor: 0, patch: 0, pre: type };
};

/** Prochaine version, comme `strategy.bump(version, commits)` de release-please (sans `Release-As`). */
export function nextVersion(config: ReleasePleaseConfig, current: string, changes: readonly Change[]): string {
  const type = config.versioning ?? 'default';
  if (type !== 'default' && type !== 'prerelease') throw new Error(`stratégie de version « ${type} » non modélisée`);
  const v = parse(current);
  const preOne = v.major < 1;
  const bumpMinorPreMajor = config['bump-minor-pre-major'] === true;
  const bumpPatchForMinorPreMajor = config['bump-patch-for-minor-pre-major'] === true;
  const kind = changes.includes('breaking') ? 'breaking' : changes.includes('feat') ? 'feat' : 'fix';
  if (type === 'default') {
    const up = kind === 'breaking' ? (preOne && bumpMinorPreMajor ? minor : major) : kind === 'feat' ? (preOne && bumpPatchForMinorPreMajor ? patch : minor) : patch;
    return format(up(v));
  }
  const pre = config['prerelease-type'];
  const up = kind === 'breaking'
    ? (preOne && bumpMinorPreMajor ? preMinor(pre) : preMajor(pre))
    : kind === 'feat' ? (preOne && bumpPatchForMinorPreMajor ? prePatch(pre) : preMinor(pre)) : prePatch(pre);
  const bumped = up(v);
  // `prerelease: false` avec la stratégie prerelease : release-please retire la pré-version.
  return format(config.prerelease === true ? bumped : { major: bumped.major, minor: bumped.minor, patch: bumped.patch });
}

const CHANGES: Change[] = ['fix', 'feat', 'breaking'];

/**
 * Canal de chaque version que la configuration peut produire, depuis des versions de départ représentatives : chaque
 * étiquette doit être acceptée par planRelease (donc par le filtre de release.yml) et tomber dans le canal attendu.
 * La stable part d'une version stable ; la beta part d'une stable (première beta) et des betas qu'elle a produites.
 */
export function checkChannelConfig(label: string, config: ReleasePleaseConfig, channel: 'stable' | 'beta'): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let frontier = ['0.1.0', '0.1.1', '1.2.3'];
  for (let depth = 0; depth < 3; depth += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const change of CHANGES) {
        const version = nextVersion(config, from, [change]);
        if (seen.has(`${from}>${version}`)) continue;
        seen.add(`${from}>${version}`);
        const tag = `${config['include-v-in-tag'] === false ? '' : 'v'}${version}`;
        try {
          const plan = planRelease(tag);
          if (plan.channel !== channel) problems.push(`${label} : ${from} + ${change} → ${tag}, canal ${plan.channel} au lieu de ${channel}`);
        } catch (error) {
          if (!(error instanceof ReleaseTagError)) throw error;
          problems.push(`${label} : ${from} + ${change} → ${tag}, étiquette refusée par release.yml (attendu vX.Y.Z ou vX.Y.Z-beta.N)`);
        }
        if (channel === 'beta') next.push(version);
      }
    }
    if (channel === 'stable') break;
    frontier = next;
  }
  return [...new Set(problems)];
}

/** Les deux configurations du dépôt : stable sur `main`, beta sur `beta`. */
export function checkReleasePleaseConfigs(repoDir: string): string[] {
  const read = (name: string) => JSON.parse(readFileSync(join(repoDir, name), 'utf8')) as ReleasePleaseConfig;
  return [
    ...checkChannelConfig('release-please-config.json', read('release-please-config.json'), 'stable'),
    ...checkChannelConfig('release-please-config.beta.json', read('release-please-config.beta.json'), 'beta'),
  ];
}
