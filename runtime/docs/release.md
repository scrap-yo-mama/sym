# Releases : versions, canaux, vérification

Chaîne de la tâche 4.9 (16 §3, 08b §5, 14 §6). Rien n'est publié tant que le propriétaire du dépôt n'a pas approuvé une exécution de `release.yml` dans l'environnement `release`.

## Versions et canaux

- **SemVer `0.y.z`** avant la 1.0 : un changement cassant monte la MINOR, une fonction monte la MINOR, un correctif monte le PATCH. Une seule version pour tout le monorepo (`runtime/package.json` et chaque paquet du workspace, mis à jour ensemble par release-please).
- **Commits conventionnels** (`type(portée)!: description`, vérifiés en CI sur le titre de la PR) : release-please calcule la version et le journal des changements. Un changement cassant porte `!` ou un pied `BREAKING CHANGE:`, le label `breaking` et une entrée du guide de migration.
- **Canaux** : `stable` (branche `main`, étiquette `vX.Y.Z`) et `beta` (branche `beta`, étiquette `vX.Y.Z-beta.N`, pré-version semver).
- **Tags d'image** : stable = `X.Y.Z`, `X.Y`, `X`, `stable` ; beta = `X.Y.Z-beta.N`, `beta`. **Jamais de tag `latest`.** Les modèles Railway, Render et `docker-compose.prod.yml` épinglent `X.Y.Z`, ou mieux l'empreinte (`@sha256:…`).

## Ce que produit une release

| Artefact | Signature et preuves |
|---|---|
| Image `ghcr.io/<propriétaire>/<dépôt>` (linux/amd64, non root) | signature cosign sans clé, SBOM CycloneDX de l'image attesté, provenance (attestation GitHub, SLSA Build L2 visé) |
| `scrapyomama-extension-X.Y.Z.zip` | SHA-256 (`SHA256SUMS`), signature (`.bundle`), provenance |
| `sbom-lockfile.cdx.json`, `sbom-image.cdx.json` | CycloneDX, signés |

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

La clé de test est créée dans un dossier temporaire et supprimée ensuite. Rien ne part vers GHCR ni vers aucun registre ; cosign n'utilise aucun journal de transparence en mode à blanc.

## Prérequis côté dépôt (propriétaire)

Ces réglages ne se font pas depuis le code :

1. Secret `RELEASE_PLEASE_TOKEN` (jeton fin : contents et pull-requests en écriture). Sans lui, l'étiquette créée par release-please ne déclenche pas `release.yml`.
2. Environnement `release` : relecteurs obligatoires, étiquettes `v*` seules autorisées.
3. Étiquettes `v*` et branches `main` et `beta` protégées ; paquet GHCR lié au dépôt, visibilité publique au moment de la première release.
4. Branche `beta` créée à partir de `main` (canal beta).
