// SPDX-License-Identifier: AGPL-3.0-only
// assert_landing_csp_strict, volet origine (22 § 2.9) : le `'self'` de la CSP vaut `https://<propriétaire>.github.io`, partagé par tous les
// sites Pages du propriétaire. Échoue si un AUTRE dépôt du propriétaire publie un site Pages (sharedPagesOrigin). Lecture seule de l'API
// publique de GitHub (jeton facultatif GITHUB_TOKEN, en lecture) ; tourne dans pages.yml avant la mise en ligne et chaque semaine dans
// landing-production.yml, jamais en CI de PR ni dans ci:local (aucune connexion sortante).
//   node scripts/landing-pages-origin.ts
import { sharedPagesOrigin } from '../src/landing/checks.ts';
import { publicRepository } from '../src/landing/identity.ts';

const repository = publicRepository();
const owner = repository.split('/')[0] ?? '';
const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'scrapyomama-landing-build' };
if (process.env['GITHUB_TOKEN']) headers['authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;

const repos: { full_name: string; has_pages?: boolean }[] = [];
for (let page = 1; page <= 50; page += 1) {
  // Dépôts publics du propriétaire (utilisateur ou organisation). Sur l'offre gratuite, seul un dépôt public publie un site Pages ; sur une
  // offre payante, un dépôt privé le peut aussi et ce jeton ne le voit pas : à vérifier à la main dans les réglages de l'organisation.
  const response = await fetch(`https://api.github.com/users/${owner}/repos?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`API GitHub : ${response.status} sur la liste des dépôts de ${owner} ; contrôle impossible, mise en ligne refusée`);
  const batch = (await response.json()) as { full_name: string; has_pages?: boolean }[];
  repos.push(...batch);
  if (batch.length < 100) break;
}
const others = sharedPagesOrigin(repos, repository);
console.log(`${repos.length} dépôt(s) de ${owner} lus ; autre(s) site(s) Pages sur https://${owner.toLowerCase()}.github.io : ${others.length === 0 ? 'aucun' : others.join(', ')}.`);
if (others.length > 0) console.log(`  Ces sites partagent l'origine de la landing : 'self' de sa CSP autorise leurs scripts. Désactiver leur site Pages ou leur donner un domaine personnalisé avant la mise en ligne.`);
process.exitCode = others.length === 0 ? 0 : 1;
