<a href="README.md">English</a> · <a href="README.fr.md">Français</a>

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/banner-light.png">
  <img alt="Scrapyomama et SYM à côté du logo fantôme de SYM" src="assets/brand/banner-light.png" width="800"></picture></p>

<p align="center"><b>Décris les données. SYM 👻 s'occupe du reste.</b><br>Libre et auto-hébergé : rien à quoi t'inscrire.</p>

<p align="center"><a href="https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/index.md">Docs</a> · <a href="https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/tutoriels/quickstart.md">Quickstart</a> · <a href="https://github.com/scrap-yo-mama/sym/discussions">Discussions</a><br>
<a href="https://github.com/scrap-yo-mama/sym/blob/main/LICENSE"><img alt="Licence : AGPL-3.0" src="https://img.shields.io/github/license/scrap-yo-mama/sym"></a> <a href="https://github.com/scrap-yo-mama/sym/releases"><img alt="Dernière version" src="https://img.shields.io/github/v/release/scrap-yo-mama/sym?include_prereleases"></a> <a href="https://github.com/scrap-yo-mama/sym/actions/workflows/ci.yml"><img alt="État de la CI" src="https://img.shields.io/github/actions/workflow/status/scrap-yo-mama/sym/ci.yml?branch=main"></a></p>

> [!WARNING]
> **Pré-version, pas prête pour la production.** Il n'y a pas encore de version stable et les interfaces vont changer.
> **Pas encore livré :** la réparation, l'API REST des API et des runs, et le serveur MCP. Tant qu'ils ne sont pas là, tu ne peux pas demander de données à ton IA via SYM.

<!-- demo: the terminal GIF (assets/demo/quickstart-en.gif) is added by task 3.11 -->

## Ce que ça fait

- **Reste chez toi.** Auto-hébergé, ton propre modèle, et rien ne part chez nous par défaut.
- **La route la moins chère d'abord.** SYM essaie d'abord l'exécuteur le moins cher (HTTP simple, puis un vrai navigateur, puis un modèle ou un agent) et journalise chaque tentative.
- **Six exécuteurs.** Requête HTTP, page d'un vrai navigateur, scripts en bac à sable, extraction par modèle, étapes script plus agent et agent complet ; un run d'agent réussi se compile en stratégie rejouable.
- **Des garde-fous.** Le code d'une stratégie tourne dans un bac à sable, les requêtes sortantes passent par une garde SSRF, et les requêtes vers chaque domaine sont espacées.
- **Ta session, avec ton accord.** Pour les sites derrière une connexion, une extension de navigateur exécute des étapes avec ta propre session, domaine par domaine, seulement après ton accord.

## Essaie (sans clé de modèle)

SYM 👻 : OK, je m'en occupe. Il te faut Docker avec Compose. Les commandes sont celles que la CI rejoue sur une instance vierge.

```bash
git clone https://github.com/scrap-yo-mama/sym && cd sym/runtime
(
  umask 077
  set -C
  {
    echo "MASTER_KEY=$(openssl rand -base64 32)"
    echo "ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)"
  } > .env
)
docker compose up --build
```

Le premier démarrage construit l'image : compte plusieurs minutes. Le [quickstart](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/tutoriels/quickstart.md) continue à partir de là (compte propriétaire, clé d'API). Le mode démo sans clé arrive avec la première version.

Déployer pour de bon : [guides Render et Docker Compose](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/guides/deploiement.md).

## Branche ton chat IA (MCP)

Pas encore branché : le serveur MCP arrive avec la première version. Voici la forme de la configuration qu'il utilisera, pour tout client MCP qui parle HTTP.

```json
{ "mcpServers": { "sym": { "url": "https://YOUR-INSTANCE/mcp",
  "headers": { "Authorization": "Bearer YOUR-KEY" } } } }
```

## Vérifie ce que tu télécharges

<details>
<summary>Signature, provenance, sommes de contrôle</summary>

Rien n'est publié pour l'instant : il n'y a ni version ni image à vérifier avant la première version. Voici le contrôle que tu feras, avec la version à la place de `X.Y.Z`.

```bash
cosign verify ghcr.io/scrap-yo-mama/sym:X.Y.Z \
  --certificate-identity=https://github.com/scrap-yo-mama/sym/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/scrap-yo-mama/sym:X.Y.Z -R scrap-yo-mama/sym
sha256sum -c SHA256SUMS
```

Les images seront épinglées à `X.Y.Z`, sans `latest` flottant.
</details>

## Comment c'est construit

Une grande partie du code et de la documentation a été écrite avec l'aide d'une IA, puis relue, testée et passée en CI. Si quelque chose cloche, dis-le.

## Licences

| Quoi | Licence |
|---|---|
| Serveur, worker, console, extension, ligne de commande | [AGPL-3.0](https://github.com/scrap-yo-mama/sym/blob/main/LICENSE) |
| `runtime/packages/client`, `runtime/packages/schemas` | MIT |
| Nom et logo | [Politique de marque](https://github.com/scrap-yo-mama/sym/blob/main/runtime/TRADEMARK.md) |

[Usage responsable](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/explications/usage-responsable.md).

## Contribuer

Lis [CONTRIBUTING.md](https://github.com/scrap-yo-mama/sym/blob/main/runtime/CONTRIBUTING.md). Signale une faille en privé via [SECURITY.md](https://github.com/scrap-yo-mama/sym/blob/main/runtime/SECURITY.md), jamais dans une issue publique. Questions et idées : [Discussions](https://github.com/scrap-yo-mama/sym/discussions).
