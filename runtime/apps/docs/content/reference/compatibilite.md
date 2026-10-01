---
title: "Compatibilité des versions"
description: "GET /api/version, versions d'extension acceptées, PostgreSQL, Node et politique de support."
---

# Compatibilité des versions

## `GET /api/version`

Route publique, servie **localement** : l'instance n'interroge aucun serveur distant pour répondre (voir [Télémétrie](../explications/telemetrie.md)). Elle renvoie exactement quatre champs, aucune version de dépendance, aucun nom d'hôte. Exemple de réponse (les valeurs dépendent de l'instance) :

```json
{ "server": "0.0.0", "schema": 11, "min_extension": "0.0.0", "mcp_spec": "2026-07-28" }
```

| Champ | Sens |
|---|---|
| `server` | version de l'instance (SemVer), posée à la construction de l'image par la chaîne de release (`RUNTIME_VERSION`). Une image construite à la main sans cette valeur annonce `0.0.0` |
| `schema` | version du schéma de base que ce code attend |
| `min_extension` | version minimale de l'extension Chrome acceptée à l'appairage |
| `mcp_spec` | version de la spécification MCP servie |

L'extension envoie sa version à l'appairage. En dessous de `min_extension`, l'instance répond **426** (`extension_outdated`) avec un message qui nomme la version requise, sans consommer le code d'appairage. Mettez l'extension à jour, puis réessayez.

## Versions des composants

| Composant | Version | Remarque |
|---|---|---|
| PostgreSQL | 15 ou plus ; 16 recommandé | la CI couvre 16, 17 et 18 ; 15 perd son support en novembre 2027. Une version inférieure est refusée avec la version trouvée |
| Node.js | 24 (LTS) dans l'image | le bac à sable fonctionne aussi sur Node 26, vérifié par une matrice de CI ; l'image n'est livrée qu'en Node 24 |
| Chromium | celui de l'image Playwright épinglée | le worker l'utilise en non-root, avec son propre bac à sable |
| Architecture de l'image | `linux/amd64` | `arm64` viendra après test de l'image et du bac à sable |
| Spécification MCP | `2026-07-28` | brouillon au moment de la rédaction, à revérifier |

## Versions de l'instance

- **SemVer `0.y.z`** avant la 1.0 : un changement cassant ou une fonction monte la version mineure, un correctif monte le correctif.
- **Une seule version** pour tout le dépôt (image, extension, paquets).
- **Canaux** : `stable` (étiquette `vX.Y.Z`) et `beta` (`vX.Y.Z-beta.N`). Il n'existe pas de canal « nightly » ni de tag `latest`. Épinglez `X.Y.Z`, ou mieux l'empreinte de l'image.
- **Support** : avant la 1.0, la dernière version mineure seule, sans rétroportage. Après la 1.0 : la version majeure courante et la précédente pendant six mois. La fin de vie est annoncée dans les notes de release, la documentation et la console. Ces durées sont **à valider**.
- **Montée** : de N-1 à N, sans intervention. Voir [Mettre à jour et revenir en arrière](../guides/mise-a-jour.md).

## Vérifier une release

Chaque release publie : l'image (signée sans clé avec cosign, SBOM CycloneDX attesté, provenance), l'archive de l'extension avec ses empreintes SHA-256 (`SHA256SUMS`) et sa signature, et les SBOM du fichier de verrouillage et de l'image. L'identité de signature est celle du workflow de release pour l'étiquette installée :

```bash
cosign verify \
  --certificate-identity https://github.com/<propriétaire>/<dépôt>/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<propriétaire>/<dépôt>@sha256:<empreinte>
```

Remplacez `<propriétaire>/<dépôt>` et `vX.Y.Z`. Une image non signée, ou signée par une autre identité, est refusée. Les mêmes principes valent pour l'archive de l'extension (`cosign verify-blob` et `sha256sum --check SHA256SUMS`). La provenance dit **qui** a construit et **d'où**, pas que l'artefact est sain : elle s'ajoute au délai de sept jours sur les dépendances et à l'absence de scripts d'installation.

## Ce qui n'est pas publié ici

Aucune version n'est publiée par ce site. Les numéros d'exemple (`0.0.0`, `X.Y.Z`) deviennent réels à la première release.
