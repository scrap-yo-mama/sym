# Releases : versions, canaux, vérification

Chaîne de la tâche 4.9 (16 §3, 08b §5, 14 §6). Rien n'est publié tant que le propriétaire du dépôt n'a pas approuvé une exécution de `release.yml` dans l'environnement `release`.

## Versions et canaux

- **SemVer `0.y.z`** avant la 1.0 : un changement cassant monte la MINOR, une fonction monte la MINOR, un correctif monte le PATCH. Une seule version pour tout le monorepo (`runtime/package.json` et chaque paquet du workspace, mis à jour ensemble par release-please).
- **Commits conventionnels** (`type(portée)!: description`, vérifiés en CI sur le titre de la PR) : release-please calcule la version et le journal des changements. Un changement cassant porte `!` ou un pied `BREAKING CHANGE:`, le label `breaking` et une entrée du guide de migration.
- **Canaux** : `stable` (branche `main`, étiquette `vX.Y.Z`) et `beta` (branche `beta`, étiquette `vX.Y.Z-beta.N`, pré-version semver).
- **Configuration beta** (`release-please-config.beta.json`) : `"versioning": "prerelease"` est indispensable. Sans lui, release-please prend sa stratégie par défaut, qui ignore `prerelease-type` : la branche beta proposerait `X.Y.Z`, publiée en stable. `"prerelease-type": "beta.1"` donne `X.Y.Z-beta.1` dès la première beta, puis `beta.2`, `beta.3`… (avec `"beta"`, la première sortirait en `X.Y.Z-beta`, sans numéro, étiquette refusée par `release.yml`). `pnpm check:release` calcule les versions atteignables des deux configurations et refuse toute étiquette hors de son canal (`scripts/release/release-please.ts`, portage des stratégies de release-please 17.6.0, celle de release-please-action v5.0.0).
- **Passage d'une beta en stable** : si `main` reçoit le manifeste d'une beta (`0.2.0-beta.3`), la stratégie par défaut garde la pré-version ; ajouter un commit `Release-As: 0.2.0` sur `main`.
- **Tags d'image** : stable = `X.Y.Z`, `X.Y`, `X`, `stable` ; beta = `X.Y.Z-beta.N`, `beta`. **Jamais de tag `latest`.** Les modèles Railway, Render et `docker-compose.prod.yml` épinglent `X.Y.Z`, ou mieux l'empreinte (`@sha256:…`).

## Ce que produit une release

| Artefact | Signature et preuves |
|---|---|
| Image `ghcr.io/<propriétaire>/<dépôt>` (linux/amd64, non root) | signature cosign sans clé, SBOM CycloneDX de l'image attesté, provenance (attestation GitHub, SLSA Build L2 visé) |
| `scrapyomama-extension-X.Y.Z.zip` | SHA-256 (`SHA256SUMS`), signature (`.bundle`), provenance |
| `sbom-lockfile.cdx.json`, `sbom-image.cdx.json` | CycloneDX 1.7 (`pnpm sbom` ; syft v1.51.1 épinglé, `cyclonedx-json@1.7`), validés par `scripts/release/sbom.ts`, signés |

Outils épinglés : cosign v3.1.3 (CI, release à blanc et release réelle), syft v1.51.1.

## Portes avant toute release

`release.yml` rejoue les contrôles de la CI sur l'étiquette, dont la garde X6 sur l'index **et sur tout l'historique git** (`pnpm check:x6-history`, extraction complète `fetch-depth: 0` ; un clone superficiel est refusé, faute d'historique à auditer). Un fichier `*.py`, `*.ipynb` ou un nom suspect présent dans un seul commit d'une seule référence bloque la release : l'historique doit être réécrit avant toute publication (_exclusions X6).

La provenance dit **qui** a construit et **d'où**, pas que l'artefact est sain : elle s'ajoute au délai de 7 jours sur les dépendances, à l'absence de scripts d'installation et au filtrage de sortie.

## Vérifier une release

L'identité épinglée est celle du workflow de release, pour l'étiquette installée (remplacer `<propriétaire>/<dépôt>` et `vX.Y.Z`) :

```sh
cosign verify \
  --certificate-identity https://github.com/<propriétaire>/<dépôt>/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<propriétaire>/<dépôt>@sha256:<empreinte>

# SBOM attesté de l'image
cosign verify-attestation --type cyclonedx \
  --certificate-identity https://github.com/<propriétaire>/<dépôt>/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<propriétaire>/<dépôt>@sha256:<empreinte>

# Un fichier joint à la release (archive de l'extension, SBOM, SHA256SUMS)
cosign verify-blob --bundle scrapyomama-extension-X.Y.Z.zip.bundle \
  --certificate-identity https://github.com/<propriétaire>/<dépôt>/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  scrapyomama-extension-X.Y.Z.zip
sha256sum --check SHA256SUMS

# Provenance
gh attestation verify scrapyomama-extension-X.Y.Z.zip --repo <propriétaire>/<dépôt>
```

Une image non signée, ou signée par une autre identité, est refusée par `cosign verify`.

## Release à blanc (locale)

```sh
pnpm release:dry-run                 # extension, SBOM, provenance, signature avec une clé de test jetable, vérification, refus
pnpm release:dry-run --with-image    # construit aussi l'image EN LOCAL (docker build, aucun push) et contrôle l'uid non root
pnpm check:release                   # portes : workflows épinglés, release par étiquette, environnement, sans cache, image non root
```

La clé de test est créée dans un dossier temporaire et supprimée ensuite. Rien ne part vers GHCR ni vers aucun registre ; cosign n'utilise aucun journal de transparence en mode à blanc. Les portes comprennent l'audit X6 de l'historique git. Les contrôles négatifs présentent chaque artefact refusé avec un bundle **valide** (celui de l'archive signée) : le refus vient de la vérification de signature, jamais d'un fichier manquant.

### Écart de la release à blanc

La consigne de la release à blanc interdit tout push d'image, même vers un registre local. `cosign verify` sur une **image** et le refus d'une **image non signée** (16 §8 et 08b §8, contrats IA) ne sont donc pas exercés à blanc : avec `--with-image`, l'image est construite en local et son identifiant (`image.json`) est signé et vérifié comme un fichier (`cosign verify-blob`). La signature d'image, son SBOM attesté (`cosign verify-attestation`) et le refus d'une image non signée se vérifient sur la première release réelle, et la recette 4.4 doit les rejouer avec la commande `cosign verify` ci-dessus (identité du workflow épinglée), plus une image non signée de contrôle.

## Prérequis côté dépôt (propriétaire)

Ces réglages ne se font pas depuis le code :

1. Secret `RELEASE_PLEASE_TOKEN` (jeton fin : contents et pull-requests en écriture). Sans lui, l'étiquette créée par release-please ne déclenche pas `release.yml`.
2. Environnement `release` : relecteurs obligatoires, étiquettes `v*` seules autorisées.
3. Étiquettes `v*` et branches `main` et `beta` protégées ; paquet GHCR lié au dépôt, visibilité publique au moment de la première release (un paquet est **privé** à sa première publication : la dernière étape de `release.yml`, `deploy/check-image-public.sh`, tire le manifeste sans identifiant et échoue tant que le paquet n'est pas public, car aucun hébergeur ne pourrait alors tirer l'image).
4. Branche `beta` créée à partir de `main` (canal beta).
