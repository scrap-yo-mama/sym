// SPDX-License-Identifier: AGPL-3.0-only
// Identité publique de la landing (22b § 1) : le dépôt public est lu à UN seul endroit, la variable `PUBLIC_REPOSITORY`
// (« propriétaire/dépôt »), jamais dans une constante écrite dans une page ou un test. Valeur au 2026-10-01 : `scrap-yo-mama/sym`
// (D-40, D-41 ; dépôt public à historique filtré, D-44). Tout le reste (adresse GitHub Pages, chemin de base, liens) en dérive.

/** Valeur par défaut, au 2026-10-01 : la variable `PUBLIC_REPOSITORY` du dépôt la remplace. */
const DEFAULT_REPOSITORY = 'scrap-yo-mama/sym';

export function publicRepository(env: Record<string, string | undefined> = process.env): string {
  const value = (env['PUBLIC_REPOSITORY'] || DEFAULT_REPOSITORY).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`PUBLIC_REPOSITORY invalide : « ${value} » (attendu : propriétaire/dépôt)`);
  return value;
}

const split = (repository: string): { owner: string; name: string } => {
  const [owner = '', name = ''] = repository.split('/');
  return { owner, name };
};

/** Adresse du dépôt (ou d'un chemin du dépôt) sur GitHub. */
export const repositoryUrl = (repository: string, path = ''): string => `https://github.com/${repository}${path}`;

/** Adresse du site GitHub Pages d'un dépôt de projet : `https://<propriétaire>.github.io` (sans domaine personnalisé). */
export const pagesOrigin = (repository: string): string => `https://${split(repository).owner.toLowerCase()}.github.io`;

/** Chemin de base d'un site de projet GitHub Pages : `/<dépôt>/` (option `base` de VitePress). */
export const pagesBase = (repository: string): string => `/${split(repository).name}/`;

/** Lien de déploiement Render du dépôt (lien stylé : aucune image servie par Render). */
export const renderDeployUrl = (repository: string): string => `https://render.com/deploy?repo=${repositoryUrl(repository)}`;
