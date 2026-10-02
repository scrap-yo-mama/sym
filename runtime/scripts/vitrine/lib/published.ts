// SPDX-License-Identifier: AGPL-3.0-only
// Tests « après publication » (22 §3.6, 22b §5) : chaque semaine, une fois la vitrine publiée (GO, variable de dépôt
// PUBLISHED), l'API GitHub du dépôt public est comparée au fichier versionné `.github/repo-metadata.json`
// (assert_repo_metadata), à la licence (assert_license_detected_agpl) et au profil de communauté
// (assert_community_profile_complete). Lecture seule : rien n'est réglé, publié ni poussé.
import type { PublicIdentity } from './identity.ts';
import type { Budgets } from './readme.ts';
import { repoMetadataProblems, type RepoMetadata } from './surface.ts';

export type PublishedState = {
  /** GET /repos/{dépôt} */
  repo: { description: string | null; topics: string[]; homepage: string | null; has_discussions: boolean };
  /** GET /repos/{dépôt}/license */
  license: { license: { spdx_id: string } | null };
  /** GET /repos/{dépôt}/community/profile */
  community: { health_percentage: number };
  /** GET /repos/{dépôt}/private-vulnerability-reporting */
  privateReporting: { enabled: boolean };
};

/** Identifiant SPDX que GitHub (licensee) renvoie pour le texte AGPL-3.0 mot pour mot. */
const GITHUB_AGPL_SPDX = 'AGPL-3.0';

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** Lit l'état publié par l'API REST de GitHub. Le jeton n'est jamais affiché ni journalisé. */
export async function fetchPublishedState(identity: PublicIdentity, token: string, fetchImpl: FetchLike = fetch): Promise<PublishedState> {
  const base = `https://api.github.com/repos/${identity.repository}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetchImpl(`${base}${path}`, { headers });
    if (!response.ok) throw new Error(`GET ${base}${path} : HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  const [repo, license, community, privateReporting] = await Promise.all([
    get<PublishedState['repo']>(''),
    get<PublishedState['license']>('/license'),
    get<PublishedState['community']>('/community/profile'),
    get<PublishedState['privateReporting']>('/private-vulnerability-reporting'),
  ]);
  return { repo, license, community, privateReporting };
}

/** Écarts entre le dépôt publié et ce que le fichier versionné promet (liste vide : conforme). */
export function publishedProblems(state: PublishedState, meta: RepoMetadata, budgets: Budgets): string[] {
  const { homepage: _versioned, ...rest } = meta;
  const live: RepoMetadata = {
    ...rest,
    description: state.repo.description ?? '',
    topics: state.repo.topics,
    ...(state.repo.homepage ? { homepage: state.repo.homepage } : {}),
    discussions: state.repo.has_discussions,
    privateVulnerabilityReporting: state.privateReporting.enabled,
  };
  const problems = repoMetadataProblems(live, budgets).map((problem) => `dépôt publié : ${problem}`);
  if (live.description !== meta.description) problems.push(`description publiée « ${live.description} » ≠ repo-metadata.json`);
  if ([...live.topics].sort().join(',') !== [...meta.topics].sort().join(',')) problems.push('sujets publiés ≠ repo-metadata.json');
  if (state.repo.homepage !== (meta.homepage ?? null)) problems.push(`site web publié « ${state.repo.homepage ?? ''} » ≠ repo-metadata.json`);
  const spdx = state.license.license?.spdx_id;
  if (spdx !== GITHUB_AGPL_SPDX) problems.push(`licence détectée « ${spdx ?? 'aucune'} » (attendu ${GITHUB_AGPL_SPDX})`);
  if (state.community.health_percentage !== 100) problems.push(`profil de communauté à ${state.community.health_percentage} % (attendu 100 %)`);
  return problems;
}
