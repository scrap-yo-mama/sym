---
title: "Démarrage rapide"
description: "Installer une instance, créer le compte propriétaire, obtenir une clé d'API et connecter son IA."
---

# Démarrage rapide

Ce tutoriel mène de zéro à une instance qui répond, avec un compte propriétaire et une clé d'API. Comptez une dizaine de minutes, dont la construction de l'image Docker. Il ne contacte aucun site : tout reste sur votre machine.

::: info Ce tutoriel est rejoué par la CI
Chaque commande des étapes 1 à 7 est extraite de cette page et exécutée par un test sur une instance vierge (`tests/quickstart.integration.test.ts`), avec la preuve qu'aucune connexion ne part hors de la machine. Si une commande de cette page cesse de fonctionner, la CI échoue. Le critère humain, « un tiers installe avec la seule documentation en moins de 30 minutes », est mesuré à part, en recette.
:::

## Ce qu'il vous faut

- Docker avec Compose v2, et environ 4 Go de mémoire pour Docker (l'image embarque Chromium).
- `openssl` et `curl`.
- Le dépôt, cloné. Les commandes se lancent depuis son dossier `runtime/`.

Avant la première release, l'image se construit depuis le dépôt. Ensuite, les modèles de déploiement épingleront une version `X.Y.Z` de l'image publiée (jamais un tag `latest`).

## 1. Créer les deux secrets

L'instance a besoin de deux valeurs aléatoires. `MASTER_KEY` chiffre tous les secrets en base (clés de modèle, proxys, cookies). `ADMIN_BOOTSTRAP_TOKEN` ouvre l'assistant de premier démarrage, une seule fois.

<!-- quickstart {"id":"secrets","mode":"run"} -->
```bash
export MASTER_KEY="$(openssl rand -base64 32)"
export ADMIN_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
```

::: warning Sauvegardez MASTER_KEY maintenant
Sans cette clé, les secrets enregistrés en base sont définitivement illisibles : personne, éditeur compris, ne peut les récupérer. Rangez-la dans un gestionnaire de mots de passe, **pas** au même endroit que vos sauvegardes de base. Voir [Sauvegarder et restaurer](../guides/sauvegarde.md).
:::

## 2. Démarrer l'instance

<!-- quickstart {"id":"start","mode":"process","replay":"migrations, serveur et worker lancés comme le fait Compose"} -->
```bash
cd runtime
docker compose up --build
```

Compose démarre PostgreSQL 16, applique les migrations (service `migrate`), puis lance le serveur sur le port 3100 et le worker. Laissez ce terminal ouvert. Le premier démarrage construit l'image : comptez plusieurs minutes.

## 3. Vérifier que l'instance est prête

Dans un second terminal :

<!-- quickstart {"id":"ready","mode":"run","expect":["\"status\":\"ready\"","\"initialized\":false"]} -->
```bash
curl -fsS http://localhost:3100/api/ready
```

La réponse contient `"status":"ready"` et `"initialized":false` : la base est migrée, la clé est valide, mais aucun propriétaire n'existe encore. Tant que ce n'est pas fait, toutes les routes répondent « non initialisé », sauf les sondes et l'assistant.

## 4. Créer le compte propriétaire

Choisissez une adresse et un mot de passe d'au moins 12 caractères, sans règle de composition.

<!-- quickstart {"id":"owner-variables","mode":"run"} -->
```bash
export OWNER_EMAIL='vous@example.org'
export OWNER_PASSWORD='une phrase longue et unique pour ce compte'
```

L'assistant de premier démarrage est un seul appel, protégé par le jeton de l'étape 1 :

<!-- quickstart {"id":"setup","mode":"run","expect":"keyFingerprint"} -->
```bash
curl -fsS -X POST http://localhost:3100/api/setup \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$ADMIN_BOOTSTRAP_TOKEN\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
```

La réponse donne l'empreinte de la clé maîtresse (`keyFingerprint`) et le rappel de la sauvegarder. Une fois le propriétaire créé, cette route répond 404 pour toujours et le jeton ne sert plus à rien : vous pouvez le retirer de l'environnement.

## 5. Se connecter

<!-- quickstart {"id":"login","mode":"run","expect":"\"user\""} -->
```bash
curl -fsS -c cookies.txt -X POST http://localhost:3100/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'origin: http://localhost:3100' \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
```

Le cookie de session est écrit dans `cookies.txt`. L'en-tête `origin` est exigé sur toute action d'interface : il doit être identique à l'URL publique de l'instance (`PUBLIC_URL`). Un navigateur l'ajoute tout seul.

<!-- quickstart {"id":"whoami","mode":"run","expect":"\"role\":\"owner\""} -->
```bash
curl -fsS -b cookies.txt http://localhost:3100/api/me
```

## 6. Créer une clé d'API

Votre IA et vos scripts s'authentifient par une clé d'API, jamais par votre session. Elle porte des **portées** (ici : lire et lancer des API, écrire des API, lire runs et jeux de données), expire (90 jours par défaut, 365 au plus) et se révoque à tout moment. Sa création redemande votre mot de passe.

<!-- quickstart {"id":"api-key","mode":"run","expect":"sy_live_"} -->
```bash
curl -fsS -b cookies.txt -X POST http://localhost:3100/api/api-keys \
  -H 'content-type: application/json' -H 'origin: http://localhost:3100' \
  -d "{\"label\":\"mon-ia\",\"scopes\":[\"apis:read\",\"apis:run\",\"apis:write\",\"runs:read\",\"datasets:read\"],\"currentPassword\":\"$OWNER_PASSWORD\"}"
```

La clé (`sy_live_…`) n'apparaît **qu'une fois**, dans cette réponse : copiez-la. Seule son empreinte est conservée. Une clé n'a jamais de portée d'administration.

## 7. Contrôler la version

<!-- quickstart {"id":"version","mode":"run","expect":"min_extension"} -->
```bash
curl -fsS http://localhost:3100/api/version
```

La réponse est calculée localement : l'instance n'interroge aucun serveur pour savoir si une version plus récente existe. Les quatre champs sont expliqués dans [Compatibilité des versions](../reference/compatibilite.md).

Vous avez maintenant une instance saine, un propriétaire et une clé. Les deux étapes suivantes sont le but du produit : demander une donnée à votre IA.

## 8. Connecter votre IA et essayer D0

<!-- quickstart {"id":"d0","mode":"pending","pending":"serveur MCP (3.2), enquête (2.1), mode démo (3.10)"} -->
```bash
claude mcp add --transport http scrapyomama http://localhost:3100/mcp \
  --header "Authorization: Bearer $SCRAPYOMAMA_KEY"
```

Demandez ensuite à votre IA : « Récupère les livres de books.toscrape.com, avec la pagination ». Le cas D0 est le cas de démonstration : un site fait pour s'entraîner au scraping, une pagination simple, et un mode démo rejouable sans clé de modèle. L'IA obtient un récit de l'enquête (rapport d'accès, essais, stratégie la moins chère retenue) et les items conformes au schéma.

## 9. Créer votre première API

<!-- quickstart {"id":"first-api","mode":"pending","pending":"API REST (3.1), enquête (2.1)"} -->
```bash
curl -fsS -b cookies.txt -X POST http://localhost:3100/api/apis \
  -H 'content-type: application/json' -H 'origin: http://localhost:3100' \
  -d '{"description":"Les livres du catalogue, avec titre et prix","url":"http://localhost:4010/"}'
```

L'agent enquête d'abord par un rapport d'accès (`robots.txt`, signaux d'usage, conditions du site), puis essaie les méthodes de la moins chère à la plus chère, et propose un schéma de sortie à valider. Une fois validé, l'API entre au catalogue et se rejoue à coût de code. Voir [Architecture](../explications/architecture.md).

::: details État de ces deux étapes dans cette version
Les étapes 8 et 9 décrivent le parcours visé. Elles dépendent du serveur MCP, de l'API REST et de l'enquête, qui ne sont pas encore livrés dans cette version de développement : la CI vérifie que ces routes sont toujours « en préparation » dans l'OpenAPI et échoue dès qu'elles sont livrées, pour forcer à rejouer ces étapes aussi. Voir la [référence REST](../reference/rest.md) pour l'état exact de chaque route.
:::

## Ce que le tutoriel a prouvé

- L'instance démarre sur une base vierge et refuse de servir sans propriétaire.
- Le premier démarrage ne s'ouvre qu'avec le jeton, une seule fois.
- Aucune connexion n'est sortie de la machine : ni télémétrie, ni contrôle de version. Voir [Télémétrie](../explications/telemetrie.md).

## Suite

- [Déployer une instance](../guides/deploiement.md) pour un hébergement durable.
- [Brancher son modèle IA](../guides/modele-llm.md) : l'enquête a besoin d'un modèle que vous choisissez.
- [Usage responsable](../explications/usage-responsable.md), à lire avant la première collecte.
