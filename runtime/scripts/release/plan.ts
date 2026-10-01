// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.9 : plan de release à partir d'une étiquette (16 §3, 14 §6). SemVer 0.y.z avant la 1.0, canaux `stable` et
// `beta` (pré-version semver), tags d'image `X.Y.Z`, `X.Y`, `X`, `stable` (stable) ou `X.Y.Z-beta.N`, `beta` (beta).
// Jamais de tag `latest` flottant : les modèles d'hébergement épinglent `X.Y.Z` (ou l'empreinte).
import { appendFileSync, readFileSync } from 'node:fs';

type Channel = 'stable' | 'beta';

export type ReleasePlan = {
  tag: string;
  version: string;
  channel: Channel;
  /** Tags d'image, du plus précis au plus large. Ne contient jamais `latest`. */
  imageTags: string[];
  /** Avant la 1.0 : les changements cassants montent la MINOR (SemVer 0.y). */
  preOne: boolean;
};

const NUM = '(0|[1-9]\\d*)';
const TAG = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}(?:-beta\\.${NUM})?$`);

export class ReleaseTagError extends Error {}

/** Étiquette `vX.Y.Z` (stable) ou `vX.Y.Z-beta.N` (beta). Toute autre forme est refusée (aucun `latest`, aucun `rc`). */
export function planRelease(tag: string): ReleasePlan {
  const match = TAG.exec(tag);
  if (!match) throw new ReleaseTagError(`étiquette « ${tag} » refusée : attendu vX.Y.Z (stable) ou vX.Y.Z-beta.N (beta)`);
  const [, major = '', minor = '', patch = '', beta] = match;
  const base = `${major}.${minor}.${patch}`;
  const channel: Channel = beta === undefined ? 'stable' : 'beta';
  const version = beta === undefined ? base : `${base}-beta.${beta}`;
  const imageTags = channel === 'stable' ? [base, `${major}.${minor}`, major, 'stable'] : [version, 'beta'];
  if (imageTags.includes('latest')) throw new ReleaseTagError('le tag « latest » est interdit');
  return { tag, version, channel, imageTags, preOne: major === '0' };
}

/** La version du package.json de la racine (unique pour le monorepo) doit être celle de l'étiquette. */
export function checkTagMatchesPackage(plan: ReleasePlan, packageJson: string): string[] {
  const version = (JSON.parse(packageJson) as { version?: string }).version;
  return version === plan.version ? [] : [`étiquette ${plan.tag} : runtime/package.json porte la version ${version ?? '(absente)'}, attendu ${plan.version}`];
}

/** Références d'image `registre/nom:tag` pour `docker/build-push-action`. */
export function imageReferences(plan: ReleasePlan, repository: string): string[] {
  return plan.imageTags.map((tag) => `${repository}:${tag}`);
}

if (import.meta.main) {
  const [tag, repository] = process.argv.slice(2);
  if (tag === undefined || repository === undefined) {
    console.error('usage : node scripts/release/plan.ts <étiquette> <registre/nom>');
    process.exit(2);
  }
  try {
    const plan = planRelease(tag);
    const problems = checkTagMatchesPackage(plan, readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (problems.length > 0) throw new ReleaseTagError(problems.join('\n'));
    const lines = [`version=${plan.version}`, `channel=${plan.channel}`, `tags=${imageReferences(plan, repository.toLowerCase()).join(',')}`];
    const out = process.env['GITHUB_OUTPUT'];
    if (out) appendFileSync(out, `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
