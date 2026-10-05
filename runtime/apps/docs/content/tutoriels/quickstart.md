---
title: "Démarrage rapide"
description: "Installer une instance, créer le compte propriétaire, obtenir une clé d'API et connecter son IA."
---

# Démarrage rapide

Ce tutoriel mène de zéro à une instance qui répond, avec un compte propriétaire et une clé d'API. Comptez une dizaine de minutes, dont la construction de l'image Docker. Il ne contacte aucun site : tout reste sur votre machine.

::: info Ce tutoriel est rejoué par la CI
Chaque commande des étapes 1 à 7 est extraite de cette page et exécutée par un test sur une instance vierge (`tests/quickstart.integration.test.ts`), dans le terminal que la page indique (le second ne reçoit rien du premier), avec l'environnement que `docker-compose.yml` donne aux services et la preuve qu'aucune connexion ne part hors de la machine. Si une commande de cette page cesse de fonctionner, la CI échoue. Le critère humain, « un tiers installe avec la seule documentation en moins de 30 minutes », est mesuré à part, en recette.
:::

## Ce qu'il vous faut

- Docker avec Compose v2, et environ 4 Go de mémoire pour Docker (l'image embarque Chromium).
- `openssl` et `curl`.
- Le dépôt, cloné. Les commandes se lancent depuis son dossier `runtime/`, dans les deux terminaux que le tutoriel utilise.

Avant la première release, l'image se construit depuis le dépôt. Ensuite, les modèles de déploiement épingleront une version `X.Y.Z` de l'image publiée (jamais un tag `latest`).

## 1. Créer les deux secrets

L'instance a besoin de deux valeurs aléatoires. `MASTER_KEY` chiffre tous les secrets en base (clés de modèle, proxys, cookies). `ADMIN_BOOTSTRAP_TOKEN` ouvre l'assistant de premier démarrage, une seule fois. Elles vont dans un fichier `.env`, que Compose lit tout seul et que git ignore : elles restent valables d'un terminal à l'autre.

<!-- quickstart {"id":"secrets","mode":"run"} -->
```bash
(
  umask 077
  set -C
  {
    echo "MASTER_KEY=$(openssl rand -base64 32)"
    echo "ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)"
  } > .env
)
```

Le fichier n'est lisible que par vous (`umask 077`), et la commande refuse d'écraser un `.env` existant (`set -C`) : une nouvelle `MASTER_KEY` rendrait illisibles les secrets déjà chiffrés avec l'ancienne.

::: warning Sauvegardez MASTER_KEY maintenant
Sans cette clé, les secrets enregistrés en base sont définitivement illisibles : personne, éditeur compris, ne peut les récupérer. Copiez la ligne `MASTER_KEY=` de `.env` dans un gestionnaire de mots de passe, **pas** au même endroit que vos sauvegardes de base. Voir [Sauvegarder et restaurer](../guides/sauvegarde.md).
:::

## 2. Démarrer l'instance

<!-- quickstart {"id":"start","mode":"process","replay":"la commande est jouée avec un faux docker, puis migrations, serveur et worker sont lancés avec l'environnement que docker-compose.yml leur donne"} -->
```bash
docker compose up --build
```

Compose démarre PostgreSQL 16, applique les migrations (service `migrate`), puis lance le serveur sur le port 3100 et le worker. Laissez ce terminal ouvert. Le premier démarrage construit l'image : comptez plusieurs minutes.

## 3. Vérifier que l'instance est prête

Ouvrez un second terminal, lui aussi dans le dossier `runtime/`. Il ne connaît aucune des variables du premier : tout ce dont il a besoin, il le lit dans `.env` ou le définit lui-même.

<!-- quickstart {"id":"ready","mode":"run","expect":["\"status\":\"ready\"","\"initialized\":false"]} -->
```bash
curl -fsS http://localhost:3100/api/ready
```

La réponse contient `"status":"ready"` et `"initialized":false` : la base est migrée, la clé est valide, mais aucun propriétaire n'existe encore. Tant que ce n'est pas fait, toutes les routes répondent « non initialisé », sauf les sondes et l'assistant.

## 4. Créer le compte propriétaire

Choisissez une adresse et un mot de passe d'au moins 12 caractères, sans règle de composition. La troisième ligne reprend le jeton de l'étape 1 depuis `.env` (et lui seul : `MASTER_KEY` n'a rien à faire dans ce terminal).

<!-- quickstart {"id":"owner-variables","mode":"run"} -->
```bash
export OWNER_EMAIL='vous@example.org'
export OWNER_PASSWORD='une phrase longue et unique pour ce compte'
export ADMIN_BOOTSTRAP_TOKEN="$(sed -n 's/^ADMIN_BOOTSTRAP_TOKEN=//p' .env)"
```

L'assistant de premier démarrage est un seul appel, protégé par le jeton de l'étape 1 :

<!-- quickstart {"id":"setup","mode":"run","expect":"keyFingerprint"} -->
```bash
curl -fsS -X POST http://localhost:3100/api/setup \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$ADMIN_BOOTSTRAP_TOKEN\",\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}"
```

La réponse donne l'empreinte de la clé maîtresse (`keyFingerprint`) et le rappel de la sauvegarder. Une fois le propriétaire créé, cette route répond 404 pour toujours et le jeton ne sert plus à rien : vous pouvez retirer sa ligne de `.env`.

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
RESPONSE="$(curl -fsS -b cookies.txt -X POST http://localhost:3100/api/api-keys \
  -H 'content-type: application/json' -H 'origin: http://localhost:3100' \
  -d "{\"label\":\"mon-ia\",\"scopes\":[\"apis:read\",\"apis:run\",\"apis:write\",\"runs:read\",\"datasets:read\"],\"currentPassword\":\"$OWNER_PASSWORD\"}")"
echo "$RESPONSE"
export SCRAPYOMAMA_KEY="$(printf '%s' "$RESPONSE" | sed -n 's/.*"key":"\(sy_live_[^"]*\)".*/\1/p')"
```

La clé (`sy_live_…`) n'apparaît **qu'une fois**, dans cette réponse : la dernière ligne la garde dans `SCRAPYOMAMA_KEY` pour l'étape 8 ; copiez-la aussi dans votre gestionnaire de mots de passe. Seule son empreinte est conservée. Une clé n'a jamais de portée d'administration.

## 7. Contrôler la version

<!-- quickstart {"id":"version","mode":"run","expect":"min_extension"} -->
```bash
curl -fsS http://localhost:3100/api/version
```

La réponse est calculée localement : l'instance n'interroge aucun serveur pour savoir si une version plus récente existe. Les quatre champs sont expliqués dans [Compatibilité des versions](../reference/compatibilite.md).

Vous avez maintenant une instance saine, un propriétaire et une clé. Les deux étapes suivantes sont le but du produit : demander une donnée à votre IA.

## 8. Connecter votre IA et essayer D0

<!-- quickstart {"id":"d0","mode":"pending","pending":"mode démo sans clé de D0 (3.11)"} -->
```bash
claude mcp add --transport http scrapyomama http://localhost:3100/mcp \
  --header "Authorization: Bearer $SCRAPYOMAMA_KEY"
```

Demandez ensuite à votre IA : « Récupère les livres de books.toscrape.com, avec la pagination ». Le cas D0 est le cas de démonstration : un site fait pour s'entraîner au scraping, une pagination simple, et un mode démo rejouable sans clé de modèle. L'IA obtient un récit de l'enquête (rapport d'accès, essais, stratégie la moins chère retenue) et les items conformes au schéma.

## 9. Créer votre première API

Avant la première enquête, l'instance doit connaître le **contact de son opérateur** (vous) : le robot l'annonce aux sites qu'il consulte. Sans lui, la création d'une API est refusée (`409 instance_contact_missing`). Vous pouvez aussi le saisir dans **Réglages > Identité du robot** de la console.

<!-- quickstart {"id":"robot-contact","mode":"run","expect":"instance_contact"} -->
```bash
curl -fsS -b cookies.txt -X PUT http://localhost:3100/api/settings/identity \
  -H 'content-type: application/json' -H 'origin: http://localhost:3100' \
  -d '{"instance_contact":"mailto:operateur@example.org"}'
```

Puis la création de l'API :

<!-- quickstart {"id":"first-api","mode":"run","expect":"api_id"} -->
```bash
curl -fsS -b cookies.txt -X POST http://localhost:3100/api/apis \
  -H 'content-type: application/json' -H 'origin: http://localhost:3100' \
  -d '{"description":"Les produits du catalogue, avec titre et prix","url":"http://zz_test_ssr.localhost:4010/","auto_validate":false}'
```

Par défaut, SYM valide le schéma lui-même (`auto_validate` vaut `true`, ce qui exige d'avoir coché « j'ai lu » dans [Usage responsable](../explications/usage-responsable.md)) et s'arrête seulement sur une vraie ambiguïté. Ce tutoriel garde la porte du schéma (`"auto_validate":false`) pour que vous le voyiez avant les essais.

L'agent enquête d'abord par un rapport d'accès (signaux d'usage, conditions du site), puis essaie les méthodes de la moins chère à la plus chère, et propose un schéma de sortie à valider. Une fois validé, l'API entre au catalogue et se rejoue à coût de code. Voir [Architecture](../explications/architecture.md).

La réponse (`201`) donne l'identifiant de l'API (`api_id`), son `slug` et le run de l'enquête (`run_id`) ; l'enquête se suit par `GET /api/runs/{run_id}` ou le flux `GET /api/events`, et le schéma proposé se valide par `POST /api/apis/{api_id}/validate-schema`.

::: warning Ce que cette étape prouve, et ce qu'il faut pour que l'enquête aboutisse
Le `201` prouve que l'API est créée et que son enquête est en file : c'est ce que la CI rejoue. L'enquête elle-même tourne ensuite dans le worker, et l'URL de l'exemple vise le **site de test local** du dépôt (`zz_test_ssr`), qui ne répond que si vous l'avez lancé. Sans les trois conditions suivantes, l'enquête finit en échec (`GET /api/runs/{run_id}`) :

1. le site de test tourne : `pnpm fixtures` depuis `runtime/` (port 4010, hôtes `zz_test_<id>.localhost` seulement) ;
2. le worker a le droit de joindre cet hôte privé : la garde SSRF refuse `localhost` par défaut, démarrez-le avec `ALLOWED_PRIVATE_HOSTS=zz_test_ssr.localhost` (et vérifiez que `zz_test_ssr.localhost` se résout vers `127.0.0.1` sur votre poste) ;
3. un modèle IA est branché ([Brancher son modèle IA](../guides/modele-llm.md)) : l'enquête en a besoin pour proposer le schéma.

Pour un vrai site, remplacez l'URL par celle d'une page publique que vous avez le droit de collecter (lisez d'abord [Usage responsable](../explications/usage-responsable.md)) ; aucune variable n'est alors nécessaire.
:::

::: details État de l'étape 8 dans cette version
L'étape 8 décrit le parcours visé. Le serveur MCP (`/mcp`) et ses prompts (dont `first_steps`) sont livrés, mais le mode démo de D0 (rejouable sans clé de modèle) ne l'est pas encore dans cette version de développement : la CI échoue dès qu'il l'est, pour forcer à rejouer cette étape aussi. L'étape 9 (API REST) est rejouée à chaque construction. Voir la [référence REST](../reference/rest.md) pour l'état exact de chaque route.
:::

## Ce que le tutoriel a prouvé

- L'instance démarre sur une base vierge et refuse de servir sans propriétaire.
- Le premier démarrage ne s'ouvre qu'avec le jeton, une seule fois.
- Aucune connexion n'est sortie de la machine : ni télémétrie, ni contrôle de version. Voir [Télémétrie](../explications/telemetrie.md).

## Suite

- [Déployer une instance](../guides/deploiement.md) pour un hébergement durable.
- [Brancher son modèle IA](../guides/modele-llm.md) : l'enquête a besoin d'un modèle que vous choisissez.
- [Usage responsable](../explications/usage-responsable.md), à lire avant la première collecte.
