---
title: "Le robot Scrapyomama"
description: "Jeton produit, User-Agent, comment le bloquer, qui contacter : à l'usage des webmasters."
---

# Le robot Scrapyomama

Cette page s'adresse aux **webmasters** dont un site a reçu la visite d'une instance Scrapyomama Runtime.

## Ce que c'est

Scrapyomama Runtime est un logiciel libre qu'on installe soi-même : **chaque instance est indépendante**, exploitée par quelqu'un qui l'a déployée. Le projet qui publie le logiciel n'exploite pas les instances, n'en voit pas le trafic et ne reçoit aucune donnée d'elles. Ce n'est donc pas un seul robot, mais autant de robots que d'instances.

## Comment il se présente

- **Jeton produit** : `Scrapyomama`. C'est lui que le robot cherche dans votre `robots.txt`, qu'il soit envoyé ou non dans son User-Agent.
- **User-Agent par défaut** : celui, réel, du Chromium embarqué, sans le marqueur `HeadlessChrome`, par exemple `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36`. Le client HTTP du robot envoie la même chaîne, avec les en-têtes `Accept` et `Accept-Language` d'un navigateur. La chaîne ne change pas d'un passage à l'autre (elle change quand le Chromium de l'image est mis à jour) : aucune rotation.
- **Identification de l'instance, si son opérateur l'a activée** (réglage `identify_instance`, désactivé par défaut) : le User-Agent se termine par `(compatible; Scrapyomama/<version>; +<contact>)` et, si le contact est une adresse électronique, chaque requête du client HTTP porte l'en-tête `From`. Après une redirection vers une autre origine, `From` ne suit pas (seuls `Accept`, `Accept-Language`, `User-Agent`, `Cache-Control` et `Pragma` passent d'une origine à l'autre) ; le jeton du User-Agent, lui, suit. Le **contact est celui de l'opérateur de l'instance**, pas celui du projet : c'est à lui qu'il faut écrire.
- Le produit n'emploie **aucune technique de furtivité** : pas de rotation de User-Agent, pas d'empreinte falsifiée, `navigator.webdriver` reste tel que le navigateur le fournit.

## Comment le robot se comporte

::: info Disponibilité
Cette version de développement ne livre pas encore tout ce qui suit. Est **en préparation** : l'affichage du rapport d'accès dans l'enquête et la console (tâches 2.1 et 3.1). Sont livrés : la lecture de `robots.txt` avant toute requête et à chaque redirection, le respect de `Crawl-delay`, la production du rapport d'accès (signaux d'usage, voies officielles) et le User-Agent réel du moteur, avec identification de l'instance en option (module d'accès, tâche 1.11), l'arrêt devant un refus ou un défi de vérification (tâche 1.7), la cadence par domaine qui ne fait que ralentir (tâche 1.9) et l'absence de changement d'adresse IP après un refus (tâche 1.4). Cette page décrit le comportement visé, que les tests de ces tâches vérifient.
:::

- Il lit **`/robots.txt` avant toute requête de contenu**, le respecte (RFC 9309) et ne propose aucune option pour l'ignorer. Un chemin interdit reçoit **zéro requête**, y compris quand un chemin permis y redirige : chaque redirection est contrôlée avant d'être suivie.
- Si `robots.txt` répond 4xx (429 compris), il le traite comme l'absence de règle ; s'il répond 5xx ou ne répond pas, il **s'abstient** par précaution. S'il redirige, même vers un autre domaine, le robot suit la redirection (cinq au plus).
- Il **respecte `Crawl-delay`** comme plancher de cadence.
- Sa cadence est fixée **par domaine** (1,5 seconde minimum entre deux requêtes par défaut) et ne fait que ralentir quand le site répond 429 ou `Retry-After`. Il ne change pas d'adresse IP après un refus.
- Il s'arrête devant un refus (401, 403) ou un défi de vérification : il ne tente ni de le résoudre ni de le franchir. Voir [Hors périmètre](./hors-perimetre.md).
- Il lit et **affiche** les signaux d'usage que vous publiez (`Content-Signal`, `tdm-reservation`, `Content-Usage`, `llms.txt`) à l'opérateur, qui les voit dans son rapport d'accès avant de collecter. Ces signaux ne sont pas encore appliqués automatiquement : ils sont une information pour l'opérateur.

## Comment le bloquer

Dans votre `robots.txt` :

```text
User-agent: Scrapyomama
Disallow: /
```

Le robot s'y conforme. Vous pouvez aussi n'interdire que certains chemins (`Disallow: /prive`). Le robot respecte à la fois le groupe `*` et tout groupe qui nomme `Scrapyomama` : un chemin interdit par l'un ou l'autre ne reçoit aucune requête. Si une instance qui s'identifie vous gêne malgré cela, écrivez à l'adresse indiquée dans son User-Agent.

## Qui contacter

- **Pour une instance précise** : le contact de son User-Agent, quand l'opérateur a activé l'identification. C'est l'opérateur, et lui seul peut agir.
- **Pour un abus du logiciel lui-même** ou une faille de sécurité : le signalement privé décrit dans `SECURITY.md`, jamais une discussion publique.
- Le projet ne peut ni consulter ni arrêter une instance qu'il n'exploite pas.

## Proposer une voie officielle

Si vous préférez que les données soient obtenues autrement (API officielle, flux, accord), publiez-la : le rapport d'accès cherche les voies déclarées (API officielle, flux, plan du site, `llms.txt`) et propose d'abord l'API officielle quand elle existe, parce qu'elle est plus claire et moins chère pour tout le monde.
