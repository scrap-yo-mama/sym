<div align="center">

# Scrapyomama (SYM 👻)

**Décris la donnée. SYM 👻 s'occupe du reste.**

[English](https://github.com/scrap-yo-mama/sym/blob/main/.github/README.md) · Français

</div>

SYM est un runtime de données auto-hébergé, encore en construction. L'objectif de la première version : tu demanderas à ton IA, via MCP, les données que tu veux. SYM enquêtera sur le site en commençant par le moins cher (un simple fetch, puis un vrai navigateur, puis un agent seulement si c'est nécessaire), te montrera le schéma trouvé et attendra ton feu vert. Ensuite il compilera une API rejouable qui tourne sans LLM quand la stratégie le permet, et réparera cette API quand le site change.

Tu l'héberges et tu apportes ton propre modèle. Ton instance, tes clés, tes données.

> SYM 👻 : tu diras ce qu'il te faut, je ferai les fouilles. Tu valides avant que quoi que ce soit soit construit.

> [!WARNING]
> **Statut : pré-version, travail en cours. Pas prêt pour la production.**
> Il n'y a pas encore de version stable, les interfaces et le schéma de base de données vont changer, et rien n'a été éprouvé en conditions réelles. Le parcours central (demande via MCP, enquête, validation, rejeu, réparation) n'est pas encore branché : voir ce qui marche aujourd'hui ci-dessous. Fouille, lance-le en local, dis-nous ce qui casse. Mais ne construis rien de critique dessus aujourd'hui.

## Ce qui marche aujourd'hui

Ces briques sont sur `main` et couvertes par la CI. Le parcours qui les relie n'existe pas encore.

- **Exécuteurs E1 à E6.** Fetch HTTP avec extraction déclarative, fetch dans une vraie page de navigateur, scripts Playwright en bac à sable, extraction mise en forme par le LLM, étapes script + agent et agent complet. Un run d'agent réussi (E6) se compile en stratégie rejouable script + agent (E5).
- **Garde-fous.** Un bac à sable pour le code des stratégies, une garde SSRF sur les requêtes sortantes, une cadence par domaine et un module d'accès qui lit robots.txt et rapporte ce qu'un site autorise.
- **Comptes.** Utilisateurs, invitations, double authentification, clés d'API, authentification unique OIDC et journal d'audit.
- **Console, extension et tunnel.** La console web (anglais et français), et une extension Chrome qui appaire ton navigateur et exécute des étapes dans ta propre session, avec un consentement par domaine.
- **Exploitation.** La ligne de commande `runtime` (migrations, `doctor`, diagnostics, sauvegarde et restauration, export du catalogue) et les modèles de déploiement pour Docker Compose, Render, Railway et Heroku.

**Pas encore livré.** L'enquête (recherche du moins cher au plus cher, validation du schéma), la pagination, la réparation, la reprise par étape, l'API REST des API et des runs, et le serveur MCP. Tant qu'ils ne sont pas là, tu ne peux pas demander des données à ton IA via SYM.

## Comment ça marchera

1. **Demande.** Dis à ton IA quelles données tu veux, et sur quel site.
2. **Enquête.** SYM cherchera le chemin le moins cher vers ces données et te dira ce qu'il a trouvé.
3. **Validation.** Tu reliras le schéma proposé et tu diras oui, ou tu demanderas des changements.
4. **Rejeu.** SYM compilera une API que tu appelleras à la demande ou selon un calendrier, sans LLM quand la stratégie le permet.
5. **Réparation.** Si le site dérive, SYM s'en apercevra et réparera l'API.

## Prévu pour la première version

- **Enquête du moins cher au plus cher.** Fetch, puis navigateur, puis agent. L'étape coûteuse ne tournera que si les moins chères ne suffisent pas.
- **Validation du schéma.** SYM te montrera le schéma et attendra ton feu vert. Aucune API ne surgira dans ton dos.
- **API rejouables.** Une fois validées, les exécutions seront déterministes et n'auront pas besoin de LLM quand la stratégie le permet : rapides, peu coûteuses, reproductibles.
- **Réparation bornée.** Quand un rejeu casse, SYM proposera un correctif borné, le vérifiera contre le schéma validé et n'escaladera que si nécessaire, au lieu de renvoyer du bruit en silence.
- **MCP et REST.** Tu le brancheras à ton IA, ou tu l'appelleras comme n'importe quelle API.
- **Reste à toi.** Auto-hébergé, ton propre modèle, aucune télémétrie envoyée aux mainteneurs. Ce point est vrai dès aujourd'hui.

## Ce que contient le dépôt

Tout est sous [`runtime/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime) :

- `apps/server` et `apps/worker` : le serveur HTTP (comptes, extension, tunnel, santé) et le worker qui exécute les stratégies. L'API REST des API et le point d'accès MCP vivront dans le serveur.
- `apps/web`, `apps/extension`, `apps/cli` : la console, l'extension Chrome et la ligne de commande.
- `packages/client` et `packages/schemas` : le client et les schémas partagés, sous licence MIT.

## Démarrage rapide

La documentation est dans [`runtime/docs/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime/docs) et les fichiers de déploiement dans [`runtime/deploy/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime/deploy). Pour commencer :

- [Guide de déploiement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/deploiement.md)
- [Exploitation](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/exploitation.md)
- [Variables d'environnement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/variables-env.md)
- [Fichiers de déploiement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/deploy/README.md)

### Déployer sur Render

Un Blueprint en un clic ([`render.yaml`](https://github.com/scrap-yo-mama/sym/blob/main/render.yaml)) installe Postgres, un service web et un worker de 2 Go (le navigateur a besoin de place). Le coût mensuel dépend des plans Render qu'il réserve : voir le [guide de déploiement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/deploiement.md#render).

**Arrive avec la première version.** Le Blueprint existe, mais personne ne l'a encore déployé pour de vrai : le bouton n'est donc pas promis fonctionnel aujourd'hui.

## Licence

- **Cœur (serveur, worker, console, extension, CLI) : [AGPL-3.0](https://github.com/scrap-yo-mama/sym/blob/main/LICENSE).**
- **Paquets client et schémas (`runtime/packages/client`, `runtime/packages/schemas`) : MIT.**

Les licences donnent des droits sur le code, pas sur le nom ni le logo : voir la [politique de marque](https://github.com/scrap-yo-mama/sym/blob/main/runtime/TRADEMARK.md). Les textes juridiques (marque, accord de contribution, notice) sont des brouillons en attente de relecture par un avocat.

Usage responsable : voir la [page d'usage responsable](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/explications/usage-responsable.md).

## Communauté

- [Sécurité](https://github.com/scrap-yo-mama/sym/blob/main/runtime/SECURITY.md) : signale les vulnérabilités en privé via le [signalement privé de GitHub](https://github.com/scrap-yo-mama/sym/security/advisories/new), jamais dans une issue publique.
- [Contribuer](https://github.com/scrap-yo-mama/sym/blob/main/runtime/CONTRIBUTING.md) : les contributions ouvrent avec la première version.
- [Code de conduite](https://github.com/scrap-yo-mama/sym/blob/main/runtime/CODE_OF_CONDUCT.md) (en anglais)

## Construit avec l'aide de l'IA

Une bonne partie du code et de la documentation a été écrite avec l'aide d'une IA, puis relue, testée et passée en CI par un humain. Si quelque chose cloche, dis-le.
