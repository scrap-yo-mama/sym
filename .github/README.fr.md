<div align="center">

# Scrapyomama (SYM 👻)

**Décris la donnée. SYM 👻 s'occupe du reste.**

[English](https://github.com/scrap-yo-mama/sym/blob/main/.github/README.md) · Français

</div>

Tu demandes à ton IA, via MCP, les données que tu veux. SYM enquête sur le site en commençant par le moins cher (un simple fetch, puis un vrai navigateur, puis un agent seulement si c'est nécessaire), te montre le schéma trouvé et attend ton feu vert. Ensuite il compile une API rejouable qui tourne sans aucun LLM et se répare toute seule quand le site change.

Il s'auto-héberge et tu apportes ton propre modèle. Ton instance, tes clés, tes données.

> SYM 👻 : tu dis ce qu'il te faut, je fais les fouilles. Tu valides avant que quoi que ce soit soit construit.

> [!WARNING]
> **Statut : pré-version, travail en cours. Pas prêt pour la production.**
> Il n'y a pas encore de version stable, les interfaces et le schéma de base de données vont changer, et rien n'a été éprouvé en conditions réelles. Fouille, lance-le en local, dis-nous ce qui casse. Mais ne construis rien de critique dessus aujourd'hui.

## Comment ça marche

1. **Demande.** Dis à ton IA quelles données tu veux, et sur quel site.
2. **Enquête.** SYM cherche le chemin le moins cher vers ces données et te dit ce qu'il a trouvé.
3. **Validation.** Tu relis le schéma proposé et tu dis oui, ou tu demandes des changements.
4. **Rejeu.** SYM compile une API que tu appelles à la demande ou selon un calendrier, sans LLM.
5. **Réparation.** Si le site dérive, SYM s'en aperçoit et répare l'API.

## Ce que fait SYM

- **Enquête du moins cher au plus cher.** Fetch, puis navigateur, puis agent. L'étape coûteuse ne tourne que si les moins chères ne suffisent pas.
- **Te montre le schéma et attend ton feu vert.** Aucune API ne surgit dans ton dos.
- **Compile une API rejouable.** Une fois validée, les exécutions sont déterministes et n'ont pas besoin de LLM : rapides, peu coûteuses, reproductibles.
- **Se répare toute seule.** Quand un site change, SYM s'en aperçoit et répare l'API au lieu de renvoyer du bruit en silence.
- **Parle MCP et REST.** Branche-le à ton IA, ou appelle-le comme n'importe quelle API.
- **Reste à toi.** Auto-hébergé, ton propre modèle, aucune télémétrie envoyée aux mainteneurs.

## Ce que SYM sait gérer

- **Les pages riches en JS.** Un vrai navigateur ouvre la page quand un simple fetch ne suffit pas.
- **Les sites avec compte.** L'extension Chrome connecte un site via ta propre session de navigateur : SYM travaille avec le compte que tu as déjà.
- **L'auto-réparation, étape par étape.** Quand un rejeu casse, SYM propose un correctif borné, le vérifie contre le schéma d'origine et n'escalade que si nécessaire.
- **Les sites retors.** Un agent pilote le navigateur de bout en bout, puis sa trace réussie est compilée en une API qui tourne sans LLM dès que c'est possible.

## Ce que contient le dépôt

Tout est sous [`runtime/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime) :

- `apps/server` et `apps/worker` : le service REST et MCP, et le worker qui enquête et exécute.
- `apps/web`, `apps/extension`, `apps/cli` : la console, l'extension Chrome et la ligne de commande.
- `packages/client` et `packages/schemas` : le client et les schémas partagés, sous licence MIT.

## Démarrage rapide

La documentation est dans [`runtime/docs/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime/docs) et les fichiers de déploiement dans [`runtime/deploy/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime/deploy). Pour commencer :

- [Guide de déploiement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/deploiement.md)
- [Exploitation](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/exploitation.md)
- [Variables d'environnement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/variables-env.md)
- [Fichiers de déploiement](https://github.com/scrap-yo-mama/sym/blob/main/runtime/deploy/README.md)

### Déployer sur Render

Un Blueprint en un clic ([`render.yaml`](https://github.com/scrap-yo-mama/sym/blob/main/render.yaml)) installe Postgres, un service web et un worker de 2 Go (le navigateur a besoin de place). Compte environ **38 USD par mois**.

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
