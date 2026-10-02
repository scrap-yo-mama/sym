// SPDX-License-Identifier: AGPL-3.0-only
// Tous les contrôles statiques de la vitrine, pour `scripts/vitrine/check.mjs` (job CI `vitrine`) : même code que les tests nommés.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetMarksProblems, bannerProblems, licensesListedProblems, secretProblems, sizeProblems, socialPreviewProblems, svgFileProblems } from './assets.ts';
import { brandDrift } from './brand-sync.ts';
import { claimProblems, claimsMarkdown, foreignClaimsDisplayed, imageDescription, imageDescriptionProblems, loadClaims, repoProofContext, unreviewedDisplayed } from './claims.ts';
import { readTestCorpus } from './corpus.ts';
import { identityOf, identityProblems, publicRepository, verifyBlock } from './identity.ts';
import { loadThirdPartyRepos, ownerReferenceFiles, ownerReferenceProblems } from './owners.ts';
import { githubDir, repoRoot, runtimeDir } from './paths.ts';
import {
  altProblems, badgeProblems, bannerAltProblems, bannerTexts, claimsProblems, copyProblems, imageResolveProblems, lengthProblems, loadBudgets, marksProblems, parityProblems, pictureProblems, quickstartProblems,
  README_FILES, readReadme, repoLinkProblems, sectionProblems, verifyBlockProblems, type Lang,
} from './readme.ts';
import { formProblems, labelProblems, licenseProblems, mediaProblems, readForms, readLabels, readLicenseFiles, readRepoMetadata, repoMetadataProblems, tapeProblems, charterColors } from './surface.ts';
import { verifySnippetProblems, dockerfileLabels, imageLabelProblems } from './verify.ts';

export type CheckResult = { name: string; problems: string[] };

export function runAllChecks(): CheckResult[] {
  const budgets = loadBudgets();
  const identity = identityOf(publicRepository());
  const claims = loadClaims();
  const results: CheckResult[] = [];
  const add = (name: string, problems: string[]): void => void results.push({ name, problems });
  const langs: Lang[] = ['en', 'fr'];
  const texts = { en: readReadme('en'), fr: readReadme('fr') };

  // Forme seulement : le job tourne aussi sur le dépôt de travail privé (D-44) ; l'égalité avec GITHUB_REPOSITORY est exigée par la release.
  add('identité publique', identityProblems(process.env, readFileSync(join(githubDir, 'PUBLIC_REPOSITORY'), 'utf8'), { enforceRunningRepository: false }));
  for (const lang of langs) {
    const text = texts[lang];
    const tag = `${README_FILES[lang]}`;
    add(`${tag} : longueur (assert_readme_length_budget)`, lengthProblems(text, budgets));
    add(`${tag} : sections (assert_readme_sections_present)`, sectionProblems(text, lang));
    add(`${tag} : badges (assert_readme_badges_budget)`, badgeProblems(text, budgets));
    add(`${tag} : allégations (assert_readme_claims_registered)`, [...claimsProblems(text, lang, claims), ...unreviewedDisplayed(claims, text), ...foreignClaimsDisplayed(claims, text, 'readme')]);
    add(`${tag} : lexique (assert_readme_no_bypass_copy)`, copyProblems(text, claims, { whitelistRegistry: true }));
    add(`${tag} : marques tierces (assert_readme_no_third_party_marks)`, marksProblems(text));
    add(`${tag} : quickstart (assert_readme_quickstart_matches_ci)`, quickstartProblems(text));
    add(`${tag} : images (assert_readme_images_resolve)`, imageResolveProblems(text, budgets));
    add(`${tag} : alt (assert_readme_alt_text)`, altProblems(text));
    add(`${tag} : picture (assert_readme_picture_dark_variants)`, pictureProblems(text));
    add(`${tag} : alt du bandeau (assert_readme_alt_text)`, bannerAltProblems(text, bannerTexts()));
    add(`${tag} : liens du dépôt`, repoLinkProblems(text, identity));
    add(`${tag} : bloc Verify (assert_verify_snippet_works)`, [...verifyBlockProblems(text, identity), ...verifySnippetProblems(verifyBlock(identity), identity)]);
  }
  add('README en / fr : parité (assert_readme_i18n_parity)', parityProblems(texts.en, texts.fr));

  add('visuels : poids (assert_readme_assets_size_budget)', [...sizeProblems(budgets), ...bannerProblems(budgets)]);
  add('aperçu social (assert_social_preview_spec)', socialPreviewProblems(budgets));
  add('SVG sûrs (assert_svg_safe)', svgFileProblems());
  add('licences des visuels (assert_assets_licenses_listed)', licensesListedProblems());
  add('visuels sans secret (assert_assets_no_secret)', secretProblems());
  add('visuels sans marque tierce', assetMarksProblems());
  add('copie de la marque vers le site de doc (pnpm brand:sync)', brandDrift().map((name) => `${name} périmé ou absent dans apps/docs/content/public/brand/`));

  results.push(...runClaimsChecks());

  const { root, copy } = readLicenseFiles();
  add('LICENSE (assert_license_detected_agpl)', licenseProblems(root, copy));
  const meta = readRepoMetadata();
  add('description et sujets (assert_repo_metadata)', repoMetadataProblems(meta, budgets));
  add('description et sujets : lexique', copyProblems([meta.description, ...meta.topics].join('\n'), claims, { whitelistRegistry: false }));
  const forms = readForms();
  add('formulaires d\'issues', formProblems(forms));
  add('formulaires d\'issues : lexique', copyProblems(Object.values(readFileSyncForms()).join('\n'), claims, { whitelistRegistry: false }));
  add('étiquettes', labelProblems(readLabels(), Object.values(forms).flatMap((form) => form.labels ?? []), charterColors()));
  const template = readFileSync(join(githubDir, 'release-notes-template.md'), 'utf8');
  add('gabarit des notes de version : lexique', copyProblems(template, claims, { whitelistRegistry: false }));
  const version = (JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8')) as { version: string }).version;
  add('index des vidéos (assert_media_index_current)', mediaProblems(version, readFileSync(join(githubDir, 'assets/MEDIA.md'), 'utf8')));
  add('script VHS', tapeProblems(readFileSync(join(githubDir, 'assets/demo/quickstart.tape'), 'utf8')));
  const labels = dockerfileLabels(readFileSync(join(runtimeDir, 'deploy/Dockerfile'), 'utf8'), identity.repository);
  const labelDescription = labels['org.opencontainers.image.description'] ?? '';
  add('étiquettes OCI du Dockerfile (assert_image_labels)', imageLabelProblems(labels, identity, imageDescription(meta, claims)));
  add('description de l\'étiquette OCI : registre (relue) et lexique', [
    ...imageDescriptionProblems(labelDescription, meta, claims),
    ...copyProblems(labelDescription, claims, { whitelistRegistry: false }),
  ]);
  add('doc, guides et modèles : dépôt et image de PUBLIC_REPOSITORY (assert_verify_snippet_works)', ownerReferenceFiles().flatMap((file) =>
    ownerReferenceProblems(readFileSync(join(repoRoot, file), 'utf8'), identity, loadThirdPartyRepos()).map((problem) => `${file} : ${problem}`)));
  add('gabarit des notes de version : bloc Verify (22 §3.4)', verifyBlockProblems(template, identity));
  return results;
}

/** Registre des allégations et CLAIMS.md : joué à chaque PR, sans filtre par chemin (`check.mjs claims`). */
export function runClaimsChecks(): CheckResult[] {
  const claims = loadClaims();
  const claimsMd = readFileSync(join(githubDir, 'CLAIMS.md'), 'utf8');
  return [
    { name: 'registre des allégations', problems: claimProblems(claims, repoProofContext(readTestCorpus)) },
    { name: 'CLAIMS.md généré à jour', problems: claimsMd === claimsMarkdown(claims) ? [] : ['CLAIMS.md périmé : lancer `pnpm vitrine:claims`'] },
    { name: 'CLAIMS.md : lexique (assert_readme_no_bypass_copy)', problems: copyProblems(claimsMd, claims, { whitelistRegistry: true, limitTermsInRegistry: true, stripIdentifiers: true }) },
  ];
}

function readFileSyncForms(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['bug', 'feature', 'documentation', 'config']) out[name] = readFileSync(join(githubDir, 'ISSUE_TEMPLATE', `${name}.yml`), 'utf8');
  return out;
}
