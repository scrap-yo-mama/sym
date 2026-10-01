---
title: "Comptes, rôles et clés d'API"
description: "Premier démarrage, rôles owner, admin et member, clés d'API à portées, isolement entre utilisateurs."
---

# Comptes, rôles et clés d'API

Une instance est faite pour être partagée avec une équipe sans que ses membres se voient les uns les autres. Cette page explique comment le premier compte naît, ce que chaque rôle peut faire, et comment une clé d'API reste bornée.

## Premier démarrage : le compte propriétaire

Il n'existe **aucun compte par défaut**. Tant qu'aucun propriétaire n'a été créé, toutes les routes répondent « non initialisé » (503), sauf les deux sondes de santé et l'assistant de premier démarrage.

1. Le déploiement fournit `ADMIN_BOOTSTRAP_TOKEN` (32 caractères au moins, jamais écrit dans les journaux). `ADMIN_EMAIL`, facultatif, restreint l'adresse que l'assistant accepte.
2. L'assistant (`POST /api/setup`) demande le jeton, une adresse et un mot de passe. Le jeton est comparé à temps constant, et les tentatives ratées sont limitées par adresse IP (5 échecs sur 15 minutes).
3. Une fois le propriétaire créé, l'assistant répond **404 pour toujours** et le jeton est ignoré. Il n'est ni stocké, ni réaffiché.
4. La réponse rappelle l'empreinte de la clé maîtresse et l'obligation de la **sauvegarder hors de la plateforme**.

Le [démarrage rapide](../tutoriels/quickstart.md#_4-creer-le-compte-proprietaire) déroule ces étapes avec `curl`. Il ne peut exister **qu'un seul** propriétaire.

## Les trois rôles

Les rôles sont fixes et définis dans le code ; il n'y a pas de rôles personnalisés.

| Rôle | Peut |
|---|---|
| `owner` | tout ce que fait un administrateur, plus : changer le rôle d'un compte (nommer ou retirer un administrateur), transférer la propriété, régler la sécurité de l'instance (durées de session, double authentification obligatoire) et l'authentification unique, exporter le journal d'audit |
| `admin` | inviter, lister, désactiver et supprimer des comptes, fermer les sessions d'un membre, régler le modèle IA, les proxys et le courrier sortant, consulter le journal d'audit et les métadonnées des runs, **révoquer** (sans jamais lire) les jetons d'extension et les clés d'autrui |
| `member` | créer, modifier et lancer **ses** API, voir les API que l'instance partage et les siennes, gérer ses clés, ses sessions de site, son extension et ses planifications |

Ce qu'**aucun** rôle ne peut faire, propriétaire compris : lire les cookies, les sorties de run ou les jeux de données d'un autre utilisateur, ou agir sous son identité. Un administrateur voit des **métadonnées** (statut, coût, durée, nombre d'items) quand un run a utilisé une session de site, jamais le contenu. C'est ce qu'on appelle « pas d'impersonation ».

## L'isolement entre utilisateurs

Chaque table de contenu porte un propriétaire. L'isolement est appliqué deux fois : dans le code de chaque route, et dans PostgreSQL (sécurité au niveau des lignes), avec un rôle de base qui ne possède pas les tables. Un test paramétré parcourt chaque route et vérifie qu'un utilisateur B ne peut ni lire ni modifier les objets d'un utilisateur A.

::: warning Ce que l'isolement ne couvre pas
L'**opérateur** de l'instance, celui qui a la base de données et `MASTER_KEY`, n'est pas couvert : il peut tout lire. L'isolement protège les utilisateurs entre eux et des administrateurs applicatifs, pas de l'hébergeur. Choisissez votre hébergeur en conséquence.
:::

## Connexion et mots de passe

- Mot de passe de 12 caractères au moins, 64 acceptés, aucune règle de composition imposée, collage autorisé. Les mots de passe les plus courants sont refusés par une liste **locale** : aucun service externe n'est interrogé.
- Les mots de passe sont stockés hachés (argon2id).
- La session d'interface est un cookie `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS (préfixe `__Host-`). Toute action d'interface exige un en-tête `Origin` identique à `PUBLIC_URL`.
- Au-delà de 10 échecs de connexion en 15 minutes sur un compte, la connexion est temporairement refusée.
- L'inscription publique est fermée : on entre par invitation.

::: info Disponibilité
Les invitations, la double authentification (TOTP), l'authentification unique OIDC, la liste de ses sessions et l'écran de gestion des utilisateurs sont spécifiés mais encore « en préparation » dans cette version : voir la [référence REST](../reference/rest.md). Sont livrés : l'assistant de premier démarrage, la connexion, les clés d'API et l'appairage de l'extension.
:::

## Clés d'API

Votre IA et vos scripts s'authentifient par une clé d'API, jamais par votre session.

| Propriété | Règle |
|---|---|
| Format | `sy_live_` suivi d'un préfixe lisible et d'un secret de 32 octets aléatoires |
| Stockage | seule l'empreinte SHA-256 est conservée ; la clé n'est affichée **qu'une fois**, à la création |
| Expiration | obligatoire : 90 jours par défaut, 365 au plus |
| Portées | `apis:read`, `apis:run`, `apis:write`, `runs:read`, `datasets:read`, `schedules:write`, `sites:read` |
| Jamais accordables | tout ce qui touche aux utilisateurs, aux réglages, à l'audit, aux clés elles-mêmes, à l'écriture des sites et au tunnel |
| Création | exige de retaper votre mot de passe, et une session d'interface (pas une clé) |
| Révocation | immédiate, par vous ; un administrateur peut aussi la révoquer, jamais la lire |

Une clé porte l'identité de son propriétaire : il n'existe pas de clé « pour quelqu'un d'autre ». Ses portées limitent les **actions**, son propriétaire limite les **données** : `apis:run` ne permet pas de lancer l'API à session d'un autre utilisateur. Une clé n'est valable que tant que son propriétaire est actif ; à la désactivation du compte, ses clés tombent.

## Plusieurs membres ne sont pas plusieurs comptes

Chaque membre se connecte avec **son** compte et connecte **ses** sessions de site. Partager un **résultat** (une API visible par l'instance, un jeu de données exporté) est normal. Partager ou faire tourner une **session** entre plusieurs comptes pour échapper à une limite est exclu : voir [Hors périmètre](../explications/hors-perimetre.md).

## Langue et fuseau

Chaque compte a une langue (`en` ou `fr`) et, facultativement, un fuseau horaire, modifiables dans **Mon compte**. La langue du compte l'emporte sur celle du navigateur, qui ne sert qu'une fois, au premier démarrage et sur les pages avant connexion. Le fuseau (lu dans le navigateur à la première connexion) sert aux heures écrites dans vos e-mails et dans les messages de votre client IA. La langue de l'interface n'est **jamais** envoyée à un site : le moteur envoie la langue réelle de son propre navigateur.

La langue, le fuseau et la langue d'une invitation sont des données personnelles : l'export et l'effacement d'une personne (`export_subject`, `erase_subject`) les couvrent, et la suppression d'un compte les efface. Le fuseau n'apparaît dans aucun journal, aucun webhook ni aucune requête vers un site. La variable `DEFAULT_LOCALE` fixe la langue de l'instance, jamais celle d'une personne.

## Journal d'audit

Les événements sensibles (connexion, changement de rôle, clé créée ou révoquée, appairage, réglage modifié, accès refusé à un objet d'autrui) sont inscrits dans un journal en ajout seul : le rôle applicatif ne peut ni modifier ni effacer une ligne. Les réglages sont journalisés par **nom de champ**, jamais par valeur ; aucun secret, cookie ou contenu de run n'y entre. La rétention est de 12 mois par défaut.
