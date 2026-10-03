// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12, critères « Licence, release, surface » de 22b §3 (u8 R9, R15 à R17) et gardes du job `vitrine` (22 §3.6) : licence, bloc « Verify »,
// étiquettes OCI, description et sujets, formulaires d'issues, étiquettes, registre des allégations, identité publique, filtre par chemin.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { claimProblems, claimsMarkdown, imageDescription, imageDescriptionProblems, loadClaims, repoProofContext, taskCommitPattern, taskDeliveryDate, unreviewedDisplayed, type ClaimsFile, type ProofContext } from '../../scripts/vitrine/lib/claims.ts';
import { vitrineTouched } from '../../scripts/vitrine/lib/changed.ts';
import { COMMUNITY_FILES, communityCopy, communityProblems, communityProfileLocation } from '../../scripts/vitrine/lib/community.ts';
import { readTestCorpus, testCorpusFiles, testTitles } from '../../scripts/vitrine/lib/corpus.ts';
import { loadThirdPartyRepos, ownerReferenceFiles, ownerReferenceProblems } from '../../scripts/vitrine/lib/owners.ts';
import { fetchPublishedState, publishedProblems, type PublishedState } from '../../scripts/vitrine/lib/published.ts';
import { certificateIdentity, identityOf, identityProblems, parseRepository, publicRepository, verifyBlock } from '../../scripts/vitrine/lib/identity.ts';
import { githubDir, repoRoot, runtimeDir, vitrineDir } from '../../scripts/vitrine/lib/paths.ts';
import { copyProblems, loadBudgets, readReadme, verifyBlockProblems } from '../../scripts/vitrine/lib/readme.ts';
import {
  charterColors, formProblems, labelProblems, licenseProblems, readForms, readLabels, readLicenseFiles, readRepoMetadata, repoMetadataProblems, type Label, type RepoMetadata,
} from '../../scripts/vitrine/lib/surface.ts';
import { checksumResult, dockerfileLabels, imageLabelProblems, parseVerifyBlock, verifySnippetProblems } from '../../scripts/vitrine/lib/verify.ts';
import { userVerifyCommand } from '../../scripts/release/sign.ts';

const budgets = loadBudgets();
const claims = loadClaims();
const identity = identityOf(publicRepository());
/** Organisation homonyme dérivée de l'identité (jamais une constante) : cas négatifs des gardes d'identité. */
const homonym = identityOf(`${identity.owner}-homonyme/${identity.name}`);
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'zz_test_vitrine_surface-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('assert_license_detected_agpl : LICENSE racine = texte AGPL-3.0 mot pour mot, identique à LICENSES/AGPL-3.0-only.txt', () => {
  // Empreinte SHA-256 du texte officiel de l'AGPL-3.0 (gnu.org/licenses/agpl-3.0.txt, 661 lignes) : détection par GitHub.
  const OFFICIAL_SHA256 = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';

  test('LICENSE, sa copie REUSE et le texte officiel', () => {
    const { root, copy } = readLicenseFiles();
    expect(licenseProblems(root, copy)).toEqual([]);
    expect(createHash('sha256').update(root).digest('hex')).toBe(OFFICIAL_SHA256);
    expect(read('runtime/LICENSE')).toBe(root);
  });

  test('cas négatifs : copie différente, texte tronqué, texte modifié', () => {
    const { root } = readLicenseFiles();
    expect(licenseProblems(root, `${root} `).join()).toMatch(/diffère/);
    const cut = root.split('\n').slice(0, 600).join('\n');
    expect(licenseProblems(cut, cut).join()).toMatch(/lignes|finit/);
    const edited = root.replace('GNU AFFERO GENERAL PUBLIC LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENCE');
    expect(licenseProblems(edited, edited).join()).toMatch(/ne commence pas/);
    expect(createHash('sha256').update(edited).digest('hex')).not.toBe(OFFICIAL_SHA256);
  });

  test('après publication (hebdomadaire) : l\'API GitHub (license) doit renvoyer l\'identifiant SPDX AGPL-3.0', () => {
    const state = publishedFixture(readRepoMetadata());
    expect(publishedProblems(state, readRepoMetadata(), budgets)).toEqual([]);
    expect(publishedProblems({ ...state, license: { license: { spdx_id: 'NOASSERTION' } } }, readRepoMetadata(), budgets).join()).toMatch(/AGPL-3\.0/);
    expect(publishedProblems({ ...state, license: { license: null } }, readRepoMetadata(), budgets).join()).toMatch(/AGPL-3\.0/);
  });

  test.todo('après publication : l\'API GitHub (licenses) renvoie l\'identifiant SPDX AGPL-3.0 (hebdomadaire, inactif avant le GO)');
});

describe('assert_verify_snippet_works : le bloc « Verify » dit ce que la chaîne de release (4.9) produit pour PUBLIC_REPOSITORY', () => {
  const block = verifyBlock(identity);

  test('identité du certificat, émetteur OIDC, image et dépôt identiques à ceux de userVerifyCommand (4.9) et de release.yml', () => {
    expect(verifySnippetProblems(block, identity)).toEqual([]);
    const release = userVerifyCommand(identity.repository, 'v1.2.3', `${identity.image}:1.2.3`);
    expect(release).toContain(certificateIdentity(identity, 'v1.2.3'));
    expect(verifySnippetProblems(verifyBlock(identity).replaceAll('X.Y.Z', '1.2.3'), identity, '1.2.3')).toEqual([]);
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toMatch(/cosign sign --yes/);
    expect(workflow).toMatch(/attest-build-provenance/);
    expect(workflow).toMatch(/sha256sum scrapyomama-extension-\*\.zip sbom-\*\.cdx\.json > SHA256SUMS/);
    expect(existsSync(join(githubDir, 'workflows/release.yml'))).toBe(true);
  });

  test('cas négatifs : autre propriétaire, autre émetteur, autre dépôt, forme illisible', () => {
    expect(verifySnippetProblems(block.replace(`${identity.repository}/.github`, `${homonym.repository}/.github`), identity).join()).toMatch(/identité du certificat/);
    expect(verifySnippetProblems(block.replace('token.actions.githubusercontent.com', 'issuer.example.org'), identity).join()).toMatch(/émetteur OIDC/);
    expect(verifySnippetProblems(block.replace(`-R ${identity.repository}`, `-R ${homonym.repository}`), identity).join()).toMatch(/gh attestation verify/);
    expect(verifySnippetProblems(block.replace(`${identity.image}:X.Y.Z \\`, `${homonym.image}:X.Y.Z \\`), identity).join()).toMatch(/image/);
    expect(verifySnippetProblems('echo rien', identity).join()).toMatch(/forme attendue/);
    expect(parseVerifyBlock(block)?.checksum).toBe('sha256sum -c SHA256SUMS');
  });

  test('la doc, les guides de déploiement et les modèles citent le seul dépôt et la seule image de PUBLIC_REPOSITORY', () => {
    const files = ownerReferenceFiles();
    expect(files.some((file) => file.endsWith('docs/deploiement.md'))).toBe(true);
    expect(files.some((file) => file.includes('apps/docs/content/'))).toBe(true);
    const thirdParty = loadThirdPartyRepos();
    for (const file of files) expect(ownerReferenceProblems(readFileSync(join(repoRoot, file), 'utf8'), identity, thirdParty), file).toEqual([]);
  });

  test('cas négatifs : organisation homonyme (GitHub et GHCR), autre dépôt du même propriétaire ; marques de réservation et dépôts tiers relus admis', () => {
    const thirdParty = loadThirdPartyRepos();
    const at = (text: string): string => ownerReferenceProblems(text, identity, thirdParty).join();
    expect(at(`docker pull ${homonym.image}:1.2.3`)).toMatch(/GHCR/);
    expect(at(`[Deploy](https://render.com/deploy?repo=${homonym.url})`)).toMatch(/autre dépôt/);
    expect(at(`git clone ${identity.url}-workspace.git`)).toMatch(/autre dépôt/);
    expect(at(`git clone ${identity.url}.git && docker pull ${identity.image}:X.Y.Z. Voir ${identity.url}/security/advisories/new.`)).toBe('');
    expect(at('ghcr.io/<propriétaire>/<dépôt>@sha256:x https://github.com/${PUBLIC_REPOSITORY} ghcr.io/propriétaire/dépôt:X.Y.Z')).toBe('');
    expect(at('https://github.com/mozilla/inclusion')).toBe('');
    expect(ownerReferenceProblems('https://github.com/mozilla/inclusion', identity, []).join()).toMatch(/autre dépôt/);
  });

  test('`sha256sum -c SHA256SUMS` réussit sur les fichiers de la release et échoue sur un fichier altéré', () => {
    writeFileSync(join(scratch, 'scrapyomama-extension-0.1.0.zip'), 'archive');
    writeFileSync(join(scratch, 'SHA256SUMS'), `${createHash('sha256').update('archive').digest('hex')}  scrapyomama-extension-0.1.0.zip\n`);
    expect(checksumResult(scratch).ok).toBe(true);
    writeFileSync(join(scratch, 'scrapyomama-extension-0.1.0.zip'), 'archive altérée');
    expect(checksumResult(scratch).ok).toBe(false);
  });

  const cosign = spawnSync('cosign', ['verify', '--help'], { encoding: 'utf8' });
  test.skipIf(cosign.error !== undefined)('les options du bloc existent dans l\'outil cosign installé', () => {
    const help = `${cosign.stdout}${cosign.stderr}`;
    expect(help).toContain('--certificate-identity');
    expect(help).toContain('--certificate-oidc-issuer');
  });

  test.todo('release publiée : `cosign verify` et `gh attestation verify` réussissent contre l\'image réelle (exige l\'image signée, après le GO ; rejoué par la release à blanc de 4.5)');
});

describe('assert_image_labels : source, description (≤ 512), licenses, io.modelcontextprotocol.server.name dérivés de PUBLIC_REPOSITORY', () => {
  const dockerfile = readFileSync(join(runtimeDir, 'deploy/Dockerfile'), 'utf8');
  const description = imageDescription(readRepoMetadata(), claims);

  test('le Dockerfile déclare les quatre étiquettes, résolues avec l\'identité publique', () => {
    const labels = dockerfileLabels(dockerfile, identity.repository);
    expect(imageLabelProblems(labels, identity, description)).toEqual([]);
    expect(labels['org.opencontainers.image.source']).toBe(identity.url);
    expect(labels['io.modelcontextprotocol.server.name']).toBe(identity.mcpName);
  });

  test('aucune valeur par défaut (jamais une constante) : une construction sans PUBLIC_REPOSITORY ne porte aucune identité ; les constructions contrôlées la passent', () => {
    expect(dockerfile).toMatch(/^ARG PUBLIC_REPOSITORY$/m);
    expect(dockerfile).not.toMatch(/^ARG PUBLIC_REPOSITORY=/m);
    expect(dockerfile.includes(identity.repository)).toBe(false);
    const anonymous = dockerfileLabels(dockerfile, '');
    expect(anonymous['org.opencontainers.image.source']).toBe('');
    expect(anonymous['io.modelcontextprotocol.server.name']).toBe('');
    expect(imageLabelProblems(anonymous, identity, description).join()).toMatch(/source/);
    expect(dockerfileLabels(dockerfile, homonym.repository)['org.opencontainers.image.source']).toBe(homonym.url);
    // Release à blanc et test d'image : PUBLIC_REPOSITORY lu dans la source unique, passé en --build-arg.
    for (const file of ['scripts/release/dry-run.ts', 'tests/image/sandbox-privileges.image.test.ts']) {
      expect(readFileSync(join(runtimeDir, file), 'utf8'), file).toMatch(/'--build-arg', `PUBLIC_REPOSITORY=\$\{(REPOSITORY|publicRepository\(\))\}`/);
    }
  });

  test('la chaîne de release passe PUBLIC_REPOSITORY à la construction et contrôle l\'identité', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).toMatch(/PUBLIC_REPOSITORY=\$\{\{ github\.repository \}\}/);
    expect(workflow).toMatch(/node scripts\/vitrine\/check\.mjs identity/);
  });

  test('cas négatifs : un autre propriétaire dans les étiquettes, une étiquette absente, une description trop longue', () => {
    const labels = dockerfileLabels(dockerfile, homonym.repository);
    expect(imageLabelProblems(labels, identity, description).join()).toMatch(/source/);
    const good = dockerfileLabels(dockerfile, identity.repository);
    const { 'io.modelcontextprotocol.server.name': _removed, ...missing } = good;
    expect(imageLabelProblems(missing, identity, description).join()).toMatch(/absente/);
    expect(imageLabelProblems({ ...good, 'org.opencontainers.image.description': 'x'.repeat(513) }, identity, 'x'.repeat(513)).join()).toMatch(/512/);
  });
});

describe('assert_repo_metadata : description ≤ 160 caractères, 10 à 20 sujets sans sujet interdit, site web, Discussions, signalement privé', () => {
  const meta = readRepoMetadata();

  test('le fichier versionné que le GO applique au dépôt', () => {
    expect(repoMetadataProblems(meta, budgets)).toEqual([]);
    expect(meta.description.length).toBeLessThanOrEqual(160);
    expect(meta.topics).toHaveLength(15);
    expect(copyProblems([meta.description, ...meta.topics].join('\n'), claims, { whitelistRegistry: false })).toEqual([]);
  });

  test('cas négatifs : description longue, trop peu de sujets, sujet interdit ou majuscule, site web absent, Discussions éteintes', () => {
    expect(repoMetadataProblems({ ...meta, description: 'x'.repeat(161) }, budgets).join()).toMatch(/description/);
    expect(repoMetadataProblems({ ...meta, topics: meta.topics.slice(0, 5) }, budgets).join()).toMatch(/sujets/);
    expect(repoMetadataProblems({ ...meta, topics: [...meta.topics.slice(1), 'stealth'] }, budgets).join()).toMatch(/interdit/);
    expect(repoMetadataProblems({ ...meta, topics: [...meta.topics.slice(1), 'Docker'] }, budgets).join()).toMatch(/minuscules/);
    expect(repoMetadataProblems({ ...meta, topics: [...meta.topics.slice(1), 'openai-compatible'] }, budgets).join()).toMatch(/interdit/);
    const { homepage: _homepage, ...withoutSite } = meta;
    expect(repoMetadataProblems(withoutSite, budgets).join()).toMatch(/site web/);
    expect(repoMetadataProblems({ ...meta, discussions: false, privateVulnerabilityReporting: false }, budgets).join()).toMatch(/Discussions/);
  });

  test('la description du dépôt est au registre ; l\'étiquette OCI porte une description relue (celle du dépôt une fois relue)', () => {
    const label = dockerfileLabels(readFileSync(join(runtimeDir, 'deploy/Dockerfile'), 'utf8'), identity.repository)['org.opencontainers.image.description'] ?? '';
    expect(imageDescriptionProblems(label, meta, claims)).toEqual([]);
    const entry = claims.claims.find((c) => c.surfaces.includes('repo') && c.en === meta.description);
    expect(entry).toBeDefined();
    expect(label).toBe(imageDescription(meta, claims));
    if (entry?.status !== 'relu') expect(label).not.toBe(meta.description);
    expect(copyProblems(label, claims, { whitelistRegistry: false })).toEqual([]);
  });

  test('cas négatifs : description du dépôt hors registre, étiquette non relue ou hors registre, description relue non reprise', () => {
    const relu = (file: ClaimsFile): ClaimsFile => ({ ...file, claims: file.claims.map((c) => (c.surfaces.includes('repo') && c.en === meta.description ? { ...c, status: 'relu' as const } : c)) });
    const stale = (file: ClaimsFile): ClaimsFile => ({ ...file, claims: file.claims.map((c) => (c.surfaces.includes('repo') && c.en === meta.description ? { ...c, status: 'à relire' as const } : c)) });
    expect(imageDescriptionProblems(meta.description, meta, stale(claims)).join()).toMatch(/relue/);
    expect(imageDescriptionProblems('Any text at all.', meta, claims).join()).toMatch(/registre/);
    expect(imageDescriptionProblems(imageDescription(meta, stale(claims)), meta, relu(claims)).join()).toMatch(/description du dépôt/);
    expect(imageDescriptionProblems(meta.description, meta, relu(claims))).toEqual([]);
    expect(imageDescriptionProblems(imageDescription(meta, claims), { ...meta, description: 'Unregistered description.' }, claims).join()).toMatch(/pas au registre/);
  });

  test('après publication (hebdomadaire) : l\'API GitHub est comparée au fichier versionné', () => {
    const state = publishedFixture(meta);
    expect(publishedProblems(state, meta, budgets)).toEqual([]);
    expect(publishedProblems({ ...state, repo: { ...state.repo, description: 'autre' } }, meta, budgets).join()).toMatch(/description/);
    expect(publishedProblems({ ...state, repo: { ...state.repo, topics: state.repo.topics.slice(1) } }, meta, budgets).join()).toMatch(/sujets/);
    expect(publishedProblems({ ...state, repo: { ...state.repo, homepage: null } }, meta, budgets).join()).toMatch(/site web/);
    expect(publishedProblems({ ...state, repo: { ...state.repo, has_discussions: false } }, meta, budgets).join()).toMatch(/Discussions/);
    expect(publishedProblems({ ...state, privateReporting: { enabled: false } }, meta, budgets).join()).toMatch(/signalement privé/);
  });

  test.todo('après publication : l\'API GitHub renvoie la description, les sujets, le site web, Discussions actives et le signalement privé (hebdomadaire, inactif avant le GO)');
});

describe('assert_community_profile_complete : le profil de communauté à 100 % repose sur ces fichiers', () => {
  test('README, code de conduite, contribution, licence, sécurité, modèles d\'issues et de PR existent là où GitHub les détecte (racine, .github/ ou docs/)', () => {
    // GitHub ne lit le profil qu'à la racine, dans .github/ ou dans docs/ : runtime/ (sous-dossier) n'est jamais détecté.
    for (const name of ['README', 'CODE_OF_CONDUCT', 'CONTRIBUTING', 'LICENSE', 'SECURITY']) {
      expect(communityProfileLocation(name), name).toBeDefined();
    }
    for (const path of ['.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug.yml']) expect(existsSync(join(repoRoot, path)), path).toBe(true);
    expect(communityProfileLocation('CODE_OF_CONDUCT', (path) => path.startsWith('runtime/') && existsSync(join(repoRoot, path)))).toBeUndefined();
    expect(readRepoMetadata().communityProfile).toContain('LICENSE');
  });

  test('les copies de .github/ (code de conduite, contribution, sécurité) sont celles dérivées de runtime/, liens relatifs résolus', () => {
    expect(communityProblems()).toEqual([]);
    for (const name of COMMUNITY_FILES) expect(read(`.github/${name}`)).toBe(communityCopy(name, read(`runtime/${name}`)));
  });

  test('cas négatifs : copie périmée ou absente, lien relatif cassé ; les liens relatifs de runtime/ sont réécrits vers ../runtime/', () => {
    const stale = (path: string): string => (path === '.github/SECURITY.md' ? 'ancienne politique\n' : read(path));
    expect(communityProblems(stale).join()).toMatch(/SECURITY\.md.*périmée/);
    const absent = (path: string): string | undefined => (path === '.github/CONTRIBUTING.md' ? undefined : read(path));
    expect(communityProblems(absent).join()).toMatch(/CONTRIBUTING\.md.*absente/);
    const copy = communityCopy('CONTRIBUTING.md', 'Voir [Hors périmètre](docs/hors-perimetre.md), [site](https://example.org) et [plus bas](#licences).\n');
    expect(copy).toContain('](../runtime/docs/hors-perimetre.md)');
    expect(copy).toContain('](https://example.org)');
    expect(copy).toContain('](#licences)');
    const broken = (path: string): string => (path === 'runtime/CONTRIBUTING.md' ? `${read(path)}\n[absent](ABSENT.md)\n` : path === '.github/CONTRIBUTING.md' ? communityCopy('CONTRIBUTING.md', `${read('runtime/CONTRIBUTING.md')}\n[absent](ABSENT.md)\n`) : read(path));
    expect(communityProblems(broken).join()).toMatch(/lien relatif introuvable.*ABSENT\.md/);
  });

  test('après publication (hebdomadaire) : community/profile doit renvoyer health_percentage = 100', () => {
    const state = publishedFixture(readRepoMetadata());
    expect(publishedProblems({ ...state, community: { health_percentage: 85 } }, readRepoMetadata(), budgets).join()).toMatch(/85/);
  });

  test.todo('après publication : community/profile renvoie health_percentage = 100 (hebdomadaire, inactif avant le GO)');
});

describe('formulaires d\'issues bilingues et étiquettes aux couleurs de la charte (22 §3.4)', () => {
  test('libellés « en · fr », diagnostic obligatoire, case « hors périmètre » obligatoire', () => {
    expect(formProblems(readForms())).toEqual([]);
  });

  test('cas négatifs : libellé monolingue, diagnostic facultatif, case de périmètre absente', () => {
    const forms = readForms();
    const bug = structuredClone(forms['bug']);
    if (!bug) throw new Error('bug.yml');
    bug.body[1]!.attributes!.label = 'Scope';
    expect(formProblems({ ...forms, bug }).join()).toMatch(/non bilingue/);
    const noDiagnostic = structuredClone(forms['bug']!);
    noDiagnostic.body = noDiagnostic.body.filter((item) => item.id !== 'diagnostic');
    expect(formProblems({ ...forms, bug: noDiagnostic }).join()).toMatch(/diagnostic obligatoire/);
    const noScope = structuredClone(forms['feature']!);
    noScope.body = noScope.body.filter((item) => item.id !== 'perimetre');
    expect(formProblems({ ...forms, feature: noScope }).join()).toMatch(/hors périmètre/);
  });

  test('étiquettes : couleurs de la charte (jetons --sym-*), noms utilisés par les formulaires, descriptions ≤ 100 caractères', () => {
    const labels = readLabels();
    const colors = charterColors();
    expect(colors.size).toBeGreaterThan(8);
    expect(labelProblems(labels, Object.values(readForms()).flatMap((f) => f.labels ?? []), colors)).toEqual([]);
    const off: Label = { name: 'x', color: '123456', description: 'd' };
    expect(labelProblems([off], [], colors).join()).toMatch(/hors de la charte/);
    expect(labelProblems(labels, ['inconnue'], colors).join()).toMatch(/absente de labels\.yml/);
    expect(labelProblems([{ ...off, color: 'FFC727', description: 'd'.repeat(101) }], [], colors).join()).toMatch(/description/);
  });

  test('config.yml : pas d\'issue vierge ; gabarit des notes de version bilingue avec migration et « Verify »', () => {
    expect(parse(read('.github/ISSUE_TEMPLATE/config.yml'))).toMatchObject({ blank_issues_enabled: false });
    const template = read('.github/release-notes-template.md');
    for (const title of ['What changes for you · Ce qui change pour toi', 'Migration notes · Notes de migration', 'Verify what you download · Vérifie ce que tu télécharges']) expect(template).toContain(`## ${title}`);
    expect(copyProblems(template, claims, { whitelistRegistry: false })).toEqual([]);
  });

  test('gabarit des notes de version : bloc « Verify » dérivé de l\'identité publique (22 §3.4), octet pour octet', () => {
    const template = read('.github/release-notes-template.md');
    expect(verifyBlockProblems(template, identity)).toEqual([]);
    expect(template).toContain(`\`\`\`bash\n${verifyBlock(identity)}\n\`\`\``);
    expect(verifyBlockProblems(template, homonym).join()).toMatch(/identité publique/);
    expect(verifyBlockProblems(template.replace(/```bash[\s\S]*?```/, ''), identity).join()).toMatch(/Verify/);
  });
});

describe('registre des allégations : preuve, relecture, statut, CLAIMS.md généré (22 §3.2)', () => {
  const context = repoProofContext(readTestCorpus);

  test('claims.json : chaque entrée a un texte en et fr, une preuve qui existe, une relecture datée, un statut connu', () => {
    expect(claimProblems(claims, context)).toEqual([]);
    expect(claims.claims.length).toBeGreaterThanOrEqual(12);
  });

  test('CLAIMS.md est généré depuis claims.json (jamais édité à la main)', () => {
    expect(read('.github/CLAIMS.md')).toBe(claimsMarkdown(claims));
    expect(claimsMarkdown({ ...claims, claims: claims.claims.slice(0, 1) })).not.toBe(read('.github/CLAIMS.md'));
  });

  test('les engagements publics, hors vitrine (D-46) : quatre entrées (D-91), le User-Agent « bloqué » tant que les client hints ne sont pas arbitrés', () => {
    const engagements = claims.claims.filter((c) => c.surfaces.includes('responsible-use'));
    expect(engagements.map((c) => c.id)).toEqual(expect.arrayContaining(['no-challenge-solving', 'user-agent-engine-real', 'stops-when-refused', 'no-telemetry-by-default']));
    expect(engagements.find((c) => c.id === 'user-agent-engine-real')?.status).toBe('bloqué');
    expect(engagements.find((c) => c.id === 'no-telemetry-by-default')?.task).toBe('4.10');
    for (const claim of engagements) {
      for (const text of [claim.en, claim.fr]) expect(readReadme('en') + readReadme('fr')).not.toContain(text);
    }
  });

  test('cas négatifs : allégation sans preuve, preuve introuvable, statut inconnu, date future, relue avant la dernière release, doublon, entrée non relue affichée', () => {
    const base = claims.claims[0]!;
    const one = (patch: Partial<ClaimsFile['claims'][number]>, ctx: ProofContext = context): string => claimProblems({ version: 1, claims: [{ ...base, ...patch }] }, ctx).join();
    expect(one({ proof: [] })).toMatch(/aucune preuve/);
    expect(one({ proof: [`assert_${'zz'}_absent_test`] })).toMatch(/introuvable/);
    expect(one({ proof: ['INV99'] })).toMatch(/absent de tests\/invariants/);
    expect(one({ proof: ['runtime/absent.md'] })).toMatch(/introuvable/);
    expect(one({ status: 'ok' as never })).toMatch(/statut/);
    expect(one({ reviewed: '2999-01-01' })).toMatch(/futur/);
    expect(one({ en: '' })).toMatch(/manquant/);
    expect(one({ reviewed: '2026-01-01' }, { ...context, lastReleaseDate: '2026-06-01' })).toMatch(/avant la dernière release/);
    expect(one({ status: 'bloqué' })).toMatch(/bloquée dit pourquoi/);
    expect(claimProblems({ version: 1, claims: [base, base] }, context).join()).toMatch(/en double/);
    const stale: ClaimsFile = { version: 1, claims: [{ ...base, status: 'à relire' }] };
    expect(unreviewedDisplayed(stale, `texte ${base.en} suite`).join()).toMatch(/affichée/);
    expect(unreviewedDisplayed({ version: 1, claims: [base] }, `texte ${base.en}`)).toEqual([]);
  });

  test('preuve « assert_… » : un test réel (test, it ou describe), jamais un test.todo, un commentaire ni les tests de la vitrine eux-mêmes', () => {
    const source = [
      "describe('assert_real_describe : x', () => {",
      "  test('assert_real_test', () => {});",
      "  it(\"assert_real_it\", () => {});",
      "  test.skipIf(false)('assert_real_conditional', () => {});",
      "  test.todo('assert_only_todo');",
      "  it.todo('assert_only_it_todo');",
      "  test.skip('assert_only_skipped', () => {});",
      "  // assert_only_comment",
      "  const name = 'assert_only_string';",
      "});",
    ].join('\n');
    const titles = testTitles(source).join('\n');
    for (const name of ['assert_real_describe', 'assert_real_test', 'assert_real_it', 'assert_real_conditional']) expect(titles, name).toContain(name);
    for (const name of ['assert_only_todo', 'assert_only_it_todo', 'assert_only_skipped', 'assert_only_comment', 'assert_only_string']) expect(titles, name).not.toContain(name);
    const base = claims.claims[0]!;
    const ctx: ProofContext = { ...context, testCorpus: titles };
    expect(claimProblems({ version: 1, claims: [{ ...base, proof: ['assert_real_test'] }] }, ctx)).toEqual([]);
    expect(claimProblems({ version: 1, claims: [{ ...base, proof: ['assert_only_todo'] }] }, ctx).join()).toMatch(/introuvable/);
    expect(claimProblems({ version: 1, claims: [{ ...base, proof: ['assert_real'] }] }, ctx).join()).toMatch(/introuvable/);
    expect(testCorpusFiles().some((file) => file.includes('/tests/vitrine/'))).toBe(false);
    expect(testCorpusFiles().some((file) => file.endsWith('invariants.todo.test.ts'))).toBe(true);
  });

  test('« aucune télémétrie par défaut » est liée à 4.10 : l\'entrée repasse « à relire » à la livraison de cette tâche', () => {
    expect(claims.claims.filter((c) => c.task === '4.10').map((c) => c.id).sort()).toEqual(['no-telemetry-by-default', 'stays-yours']);
    const linked = { ...claims.claims.find((c) => c.id === 'stays-yours')!, status: 'relu' as const, reviewed: '2026-10-02' };
    const delivered: ProofContext = { ...context, today: '2026-12-01', lastReleaseDate: undefined, taskDeliveredOn: (task) => (task === '4.10' ? '2026-11-15' : undefined) };
    expect(claimProblems({ version: 1, claims: [linked] }, delivered).join()).toMatch(/tâche 4\.10 livrée le 2026-11-15.*à relire/);
    expect(claimProblems({ version: 1, claims: [{ ...linked, reviewed: '2026-11-15' }] }, delivered)).toEqual([]);
    expect(claimProblems({ version: 1, claims: [{ ...linked, status: 'à relire' }] }, delivered)).toEqual([]);
    const { task: _task, ...unlinked } = linked;
    expect(claimProblems({ version: 1, claims: [unlinked] }, delivered)).toEqual([]);
    expect(claimProblems({ version: 1, claims: [linked] }, { ...delivered, taskDeliveredOn: () => undefined })).toEqual([]);
  });

  test('preuve « page:reference/rest » (page générée, ignorée par git) : ses sources, spécification OpenAPI et générateur, doivent exister', () => {
    const page = { ...claims.claims[0]!, proof: ['page:reference/rest'] };
    const sources = ['packages/client/openapi/openapi.yaml', 'apps/docs/scripts/gen-reference.ts'];
    expect(claimProblems({ version: 1, claims: [page] }, context)).toEqual([]);
    for (const missing of sources) {
      const ctx: ProofContext = { ...context, exists: (path) => path !== missing && context.exists(path) };
      expect(claimProblems({ version: 1, claims: [page] }, ctx).join(), missing).toMatch(new RegExp(`page reference/rest : source ${missing.replace(/\./g, '\\.')} introuvable`));
    }
    const ordinary = { ...page, proof: ['page:reference/absente'] };
    expect(claimProblems({ version: 1, claims: [ordinary] }, context).join()).toMatch(/page reference\/absente introuvable/);
  });

  test('livraison d\'une tâche : date du dernier commit « <tâche> — » de l\'historique git (4.1 ne prend pas 4.12)', () => {
    const date = taskDeliveryDate('4.12');
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(taskDeliveryDate('9.99')).toBeUndefined();
    const pattern = new RegExp(taskCommitPattern('4.1'));
    expect(pattern.test('4.1 — Mise en ligne')).toBe(true);
    expect(pattern.test('4.12 — Vitrine')).toBe(false);
    expect(pattern.test('4x1 — autre')).toBe(false);
    expect(() => taskCommitPattern('4.1; rm -rf /')).toThrow(/identifiant de tâche/);
    expect(context.taskDeliveredOn).toBeDefined();
  });

  test.todo('assert_responsible_use_claims_registered : les engagements de la page « Usage responsable » (fr et en) sont identiques mot pour mot aux entrées relues (page alignée par 4.11, version en par 3.20)');
});

describe('identité publique : une seule source (PUBLIC_REPOSITORY), jamais une constante', () => {
  test('la variable prime sur le fichier versionné ; une valeur invalide est refusée ; tout est dérivé du propriétaire et du dépôt', () => {
    const versioned = read('.github/PUBLIC_REPOSITORY');
    expect(publicRepository({ env: {}, file: versioned })).toBe(versioned.trim());
    expect(publicRepository({ env: { PUBLIC_REPOSITORY: 'autre/depot' }, file: versioned })).toBe('autre/depot');
    expect(publicRepository({ env: { PUBLIC_REPOSITORY: '' }, file: versioned })).toBe(versioned.trim());
    for (const bad of ['', 'sans-barre', 'a/b/c', 'a b/c', '/x']) expect(() => parseRepository(bad), bad).toThrow(/invalide/);
    expect(identityOf('Acme-Org/Tool')).toMatchObject({ image: 'ghcr.io/acme-org/tool', mcpName: 'io.github.Acme-Org/Tool', url: 'https://github.com/Acme-Org/Tool' });
    const [owner, name] = versioned.trim().split('/');
    expect(identity).toMatchObject({ repository: `${owner}/${name}`, owner, name, url: `https://github.com/${owner}/${name}`, mcpName: `io.github.${owner}/${name}` });
  });

  test('sur le dépôt public, PUBLIC_REPOSITORY égale GITHUB_REPOSITORY (garde d\'une organisation homonyme)', () => {
    const file = `${identity.repository}\n`;
    expect(identityProblems({}, file)).toEqual([]);
    expect(identityProblems({ GITHUB_REPOSITORY: identity.repository, PUBLIC_REPOSITORY: identity.repository }, file)).toEqual([]);
    expect(identityProblems({ GITHUB_REPOSITORY: homonym.repository }, file).join()).toMatch(/doit égaler GITHUB_REPOSITORY/);
    expect(identityProblems({ PUBLIC_REPOSITORY: homonym.repository }, file).join()).toMatch(/diffère/);
    expect(identityProblems({}, 'n importe quoi').join()).toMatch(/invalide/);
  });

  test('dépôt de travail privé (D-44) : les contrôles de la vitrine ne comparent pas GITHUB_REPOSITORY, seule la forme ; la release l\'exige', () => {
    const file = `${identity.repository}\n`;
    const workspace = { GITHUB_REPOSITORY: `${identity.repository}-workspace` };
    expect(identityProblems(workspace, file, { enforceRunningRepository: false })).toEqual([]);
    expect(identityProblems({ ...workspace, PUBLIC_REPOSITORY: homonym.repository }, file, { enforceRunningRepository: false }).join()).toMatch(/diffère/);
    expect(identityProblems({}, 'n importe quoi', { enforceRunningRepository: false }).join()).toMatch(/invalide/);
    expect(identityProblems(workspace, file).join()).toMatch(/doit égaler GITHUB_REPOSITORY/);
  });

  test('aucun test, page ni script de la vitrine ne code le propriétaire en dur hors des fichiers d\'exemple et de contrat', () => {
    const lib = readdirLib().filter((f) => !/identity\.ts$/.test(f));
    const tests = readdirSync(join(runtimeDir, 'tests/vitrine')).filter((name) => name.endsWith('.ts')).map((name) => join(runtimeDir, 'tests/vitrine', name));
    for (const file of [...lib, ...tests]) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes(identity.repository) || text.includes(identity.image), file).toBe(false);
    }
  });
});

describe('job CI `vitrine` (22 §3.6) : huitième job, Node seulement, filtré par chemin, sans publication', () => {
  const workflow = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: { run?: string; if?: string; uses?: string }[] }> };

  test('le job existe et rejoue check.mjs et les tests nommés ; aucun .py ; aucun filtre de chemin sur le workflow', () => {
    const job = workflow.jobs['vitrine'];
    expect(job).toBeDefined();
    const runs = job!.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('node scripts/vitrine/check.mjs changed');
    expect(job!.steps.some((s) => s.run === 'node scripts/vitrine/check.mjs')).toBe(true);
    expect(runs).toMatch(/vitest run --project unit tests\/vitrine/);
    expect(runs).not.toMatch(/\.py\b|pip |python/);
    expect(read('.github/workflows/ci.yml')).not.toMatch(/^\s+paths:/m);
    expect(Object.keys(workflow.jobs)).toEqual(expect.arrayContaining(['quality', 'docs', 'unit', 'integration', 'security', 'image', 'vitrine']));
  });

  test('les étapes de contrôle ne tournent que si la PR touche la vitrine (filtre décidé par check.mjs changed)', () => {
    const steps = workflow.jobs['vitrine']!.steps;
    const gated = steps.filter((s) => s.run === 'node scripts/vitrine/check.mjs' || ((s.run ?? '').includes('vitest run') && (s.run ?? '').includes('tests/vitrine')));
    expect(gated.length).toBeGreaterThanOrEqual(2);
    for (const step of gated) expect(step.if).toMatch(/steps\.changed\.outputs\.run == 'true'/);
  });

  test('filtre par chemin : README*, .github/**, apps/docs/** et les fichiers de la vitrine déclenchent ; le reste non', () => {
    for (const file of ['README.md', '.github/README.fr.md', '.github/assets/brand/banner-light.png', 'LICENSE', 'runtime/apps/docs/content/index.md', 'runtime/scripts/vitrine/budgets.json', 'runtime/deploy/Dockerfile']) {
      expect(vitrineTouched([file]), file).toBe(true);
    }
    for (const file of ['runtime/apps/server/src/index.ts', 'runtime/packages/core/src/index.ts', 'runtime/apps/web/src/main.ts', 'runtime/docs-old/x.md']) expect(vitrineTouched([file]), file).toBe(false);
    expect(vitrineTouched([])).toBe(false);
  });

  test('le registre des allégations se contrôle à chaque PR, sans filtre : une preuve supprimée ou renommée fait échouer le job', () => {
    const steps = workflow.jobs['vitrine']!.steps;
    const claimsStep = steps.find((s) => s.run === 'node scripts/vitrine/check.mjs claims');
    expect(claimsStep).toBeDefined();
    expect(claimsStep?.if).toBeUndefined();
    const ok = spawnSync('node', ['scripts/vitrine/check.mjs', 'claims'], { cwd: runtimeDir, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/registre des allégations/);
  });

  test('filtre par chemin : la doc d\'exploitation, les modèles de déploiement et les textes de la racine de runtime/ déclenchent (identité du propriétaire)', () => {
    for (const file of ['runtime/docs/deploiement.md', 'runtime/deploy/railway/template.yaml', 'render.yaml', 'runtime/SECURITY.md']) expect(vitrineTouched([file]), file).toBe(true);
  });

  test('tests après publication : workflow hebdomadaire inactif avant le GO (vars.PUBLISHED), lecture seule, lychee, issue en cas d\'échec', () => {
    const text = read('.github/workflows/vitrine-weekly.yml');
    const weekly = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { if?: string; steps: { run?: string; uses?: string; if?: string; with?: Record<string, unknown> }[] }> };
    expect(weekly.on).toHaveProperty('schedule');
    const jobs = Object.values(weekly.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job.if).toMatch(/vars\.PUBLISHED == 'true'/);
    const steps = jobs.flatMap((job) => job.steps);
    expect(steps.some((s) => s.run === 'node scripts/vitrine/check.mjs published')).toBe(true);
    expect(steps.some((s) => /^lycheeverse\/lychee-action@[0-9a-f]{40}$/.test(s.uses ?? ''))).toBe(true);
    expect(steps.some((s) => s.if === 'failure()' && /gh issue create/.test(s.run ?? ''))).toBe(true);
    expect(weekly.permissions['contents']).toBe('read');
    expect(text).not.toMatch(/git push|gh release|gh repo edit|\.py\b|python/);
  });

  test('check.mjs published : adresses de l\'API GitHub dérivées de l\'identité, jeton jamais affiché', async () => {
    const seen: string[] = [];
    const meta = readRepoMetadata();
    const answers = publishedFixture(meta);
    const fake = async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> => {
      seen.push(url);
      expect(init?.headers?.['Authorization']).toBe('Bearer jeton-de-test');
      const path = new URL(url).pathname;
      const body = path.endsWith('/license') ? answers.license : path.endsWith('/community/profile') ? answers.community : path.endsWith('/private-vulnerability-reporting') ? answers.privateReporting : answers.repo;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const state = await fetchPublishedState(identity, 'jeton-de-test', fake);
    expect(publishedProblems(state, meta, budgets)).toEqual([]);
    const base = `https://api.github.com/repos/${identity.repository}`;
    expect(seen.sort()).toEqual([base, `${base}/community/profile`, `${base}/license`, `${base}/private-vulnerability-reporting`]);
    await expect(fetchPublishedState(identity, 'jeton-de-test', async () => new Response('{}', { status: 404 }))).rejects.toThrow(/404/);
    const unpublished = spawnSync('node', ['scripts/vitrine/check.mjs', 'published'], { cwd: runtimeDir, encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' } });
    expect(unpublished.status).toBe(1);
    expect(unpublished.stderr).toMatch(/jeton/);
  });

  test('budgets : un seul fichier, scripts/vitrine/budgets.json', () => {
    expect(existsSync(join(vitrineDir, 'budgets.json'))).toBe(true);
    expect(budgets.readme.maxLines).toBe(150);
  });

  test('check.mjs (job vitrine) : tous les contrôles statiques sont verts, et un problème fait échouer le code de sortie', () => {
    const ok = spawnSync('node', ['scripts/vitrine/check.mjs'], { cwd: runtimeDir, encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/contrôles verts/);
    const workspace = spawnSync('node', ['scripts/vitrine/check.mjs'], { cwd: runtimeDir, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: `${identity.repository}-workspace`, PUBLIC_REPOSITORY: '' } });
    expect(workspace.status, workspace.stderr).toBe(0);
    const bad = spawnSync('node', ['scripts/vitrine/check.mjs', 'identity'], { cwd: runtimeDir, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'autre/depot', PUBLIC_REPOSITORY: '' } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/GITHUB_REPOSITORY/);
  });
});

function readdirLib(): string[] {
  const dir = join(vitrineDir, 'lib');
  return readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => join(dir, name));
}

/** État du dépôt publié tel que l'API GitHub le renverrait s'il était conforme au fichier versionné. */
function publishedFixture(meta: RepoMetadata): PublishedState {
  return {
    repo: { description: meta.description, topics: [...meta.topics], homepage: meta.homepage ?? null, has_discussions: meta.discussions },
    license: { license: { spdx_id: 'AGPL-3.0' } },
    community: { health_percentage: 100 },
    privateReporting: { enabled: meta.privateVulnerabilityReporting },
  };
}
