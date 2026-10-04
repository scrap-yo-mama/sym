---
title: "Le robot Scrapyomama"
description: "Jeton produit, User-Agent, comment le bloquer, qui contacter : à l'usage des webmasters."
---

# Le robot Scrapyomama

Cette page s'adresse aux **webmasters** dont un site a reçu la visite d'une instance Scrapyomama Runtime.

## Ce que c'est

Scrapyomama Runtime est un logiciel libre qu'on installe soi-même : **chaque instance est indépendante**, exploitée par quelqu'un qui l'a déployée. Le projet qui publie le logiciel n'exploite pas les instances, n'en voit pas le trafic et ne reçoit aucune donnée d'elles. Ce n'est donc pas un seul robot, mais autant de robots que d'instances.

## Comment il se présente

- **Jeton produit** : `Scrapyomama`. Il figure dans le User-Agent quand l'opérateur de l'instance active l'identification (ci-dessous).
- **User-Agent par défaut** : celui, réel, du Chromium embarqué, sans le marqueur `HeadlessChrome`, par exemple `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36`. Le client HTTP du robot envoie la même chaîne, avec l'en-tête `Accept` d'un navigateur ; comme un Chromium vierge de l'image, il n'envoie aucun `Accept-Language` (celui qu'une stratégie poserait est retiré). La chaîne ne change pas d'un passage à l'autre (elle change quand le Chromium de l'image est mis à jour) : aucune rotation.
- **Identification de l'instance, si son opérateur l'a activée** (réglage `identify_instance`, désactivé par défaut) : le User-Agent se termine par `(compatible; Scrapyomama/<version>; +<contact>)` et, si le contact est une adresse électronique, chaque requête du client HTTP porte l'en-tête `From`. Après une redirection vers une autre origine, `From` ne suit pas (seuls `Accept`, `Accept-Language`, `User-Agent`, `Cache-Control` et `Pragma` passent d'une origine à l'autre) ; le jeton du User-Agent, lui, suit. Le **contact est celui de l'opérateur de l'instance**, pas celui du projet : c'est à lui qu'il faut écrire. L'administrateur de l'instance (rôle admin ou propriétaire) l'active et saisit ce contact dans **Réglages > Identité du robot** de la console, où le User-Agent réel du moteur s'affiche en lecture seule ; le changement est journalisé dans l'audit et vaut dès le passage suivant. Tant que rien n'y est enregistré, ce sont les variables `IDENTIFY_INSTANCE` et `INSTANCE_CONTACT` du worker qui s'appliquent, et l'écran les montre telles que le worker les lit.
- Le produit n'emploie **aucune technique de furtivité** : pas de rotation de User-Agent, pas d'empreinte falsifiée, `navigator.webdriver` reste tel que le navigateur le fournit.

## Comment le robot se comporte

::: info Disponibilité
Cette version de développement ne livre pas encore tout ce qui suit. Est **en préparation** : l'affichage du rapport d'accès dans l'enquête et la console (tâches 2.1 et 3.1). Sont livrés : la production du rapport d'accès (signaux d'usage, voies officielles) et le User-Agent réel du moteur, avec identification de l'instance en option (module d'accès, tâche 1.11), l'arrêt devant un refus ou un défi de vérification (tâche 1.7), la cadence par domaine qui ne fait que ralentir (tâche 1.9) et l'absence de changement d'adresse IP après un refus (tâche 1.4). Cette page décrit le comportement visé, que les tests de ces tâches vérifient.
:::

- Sa cadence est fixée **par domaine** (1,5 seconde minimum entre deux requêtes par défaut) et ne fait que ralentir quand le site répond 429 ou `Retry-After`. Il ne change pas d'adresse IP après un refus.
- Il s'arrête devant un refus (401, 403) ou un défi de vérification : il ne tente ni de le résoudre ni de le franchir. Voir [Hors périmètre](./hors-perimetre.md).
- Il lit et **affiche** les signaux d'usage que vous publiez (`Content-Signal`, `tdm-reservation`, `Content-Usage`, `llms.txt`) à l'opérateur, qui les voit dans son rapport d'accès avant de collecter. Ces signaux ne sont pas encore appliqués automatiquement : ils sont une information pour l'opérateur.
- Le `robots.txt` est une source d'information que l'agent peut consulter, par exemple pour trouver le sitemap ; il ne conditionne pas la collecte.

## Comment le bloquer

Refusez-lui l'accès : une réponse 403 ou une page de vérification. Le robot s'arrête à la première réponse de ce type, passe l'API en statut « bloquée » et ne revient ni depuis une autre adresse ni avec un autre compte ; une nouvelle tentative n'a lieu que si l'opérateur relance une enquête à la main. Quand l'instance s'identifie, son User-Agent porte le jeton `Scrapyomama` et le contact de l'opérateur : vous pouvez filtrer sur ce jeton, ou écrire à ce contact.

## Qui contacter

- **Pour une instance précise** : le contact de son User-Agent, quand l'opérateur a activé l'identification. C'est l'opérateur, et lui seul peut agir.
- **Pour un abus du logiciel lui-même** ou une faille de sécurité : le signalement privé décrit dans `SECURITY.md`, jamais une discussion publique.
- Le projet ne peut ni consulter ni arrêter une instance qu'il n'exploite pas.

## Proposer une voie officielle

Si vous préférez que les données soient obtenues autrement (API officielle, flux, accord), publiez-la : le rapport d'accès cherche les voies déclarées (API officielle, flux, plan du site, `llms.txt`) et propose d'abord l'API officielle quand elle existe, parce qu'elle est plus claire et moins chère pour tout le monde.
