---
title: "Extension Chrome et tunnel"
description: "Appairer l'extension, connecter un site avec votre propre session, exécuter depuis votre navigateur."
---

# Extension Chrome et tunnel

L'extension Chrome relie **votre navigateur** à votre instance. Elle sert à deux choses : capturer **votre** session sur un site qui exige un compte, et exécuter une API **depuis votre navigateur** (votre adresse, vos cookies) quand vous l'avez choisi. Elle n'exécute jamais de code envoyé par le serveur : elle ne connaît qu'un jeu fermé de commandes.

::: warning Ce que le tunnel n'est pas
Le tunnel est un mode que **vous choisissez** pour une API, ou que l'API exige parce qu'elle a besoin de votre identité. Il n'est **jamais proposé après un blocage** : utiliser votre adresse et votre navigateur pour contourner un refus serait précisément ce que le produit exclut. Le panneau « Bloquée » n'a aucun bouton vers le tunnel. En tunnel, un défi de vérification **arrête** le run et vous rend la main, sans qu'aucune commande soit envoyée sur la page de défi. Voir [Hors périmètre](../explications/hors-perimetre.md).
:::

## Installer l'extension

Chaque release publie l'archive de l'extension (`scrapyomama-extension-X.Y.Z.zip`) avec son empreinte SHA-256 et sa signature. Vérifiez l'empreinte, décompressez l'archive, puis dans Chrome ouvrez `chrome://extensions`, activez le mode développeur et chargez le dossier décompressé. Une fiche sur le Chrome Web Store n'est pas encore publiée.

L'extension déclare ses permissions au minimum : aucun accès à tous les sites en permanence. Les hôtes sont demandés **un par un**, au moment où vous cliquez sur « Connecter ce site ».

## Appairer l'extension à l'instance

1. Dans la console : **Réglages > Extension > Générer un code**. Votre mot de passe est redemandé. Le code est à **usage unique** et valable **10 minutes**.
2. Dans l'extension : saisissez l'adresse de l'instance (`https://…`) et le code.
3. L'extension reçoit un jeton lié à **votre compte et à cet appareil**, stocké dans le navigateur. L'extension affiche « connecté comme votre@adresse », la liste des domaines connectés et un bouton de déconnexion par domaine.

Le jeton expire au bout de 90 jours (renouvelé à l'usage), et vous pouvez appairer plusieurs appareils. Vous le révoquez depuis la console ; un administrateur peut aussi le **révoquer**, mais ne peut jamais le lire ni s'en servir. La connexion est sortante : aucun port à ouvrir sur votre machine. L'extension exige `wss://` ; le clair `ws://` n'est accepté que pour une instance de développement locale.

Si l'extension est plus ancienne que la version minimale que l'instance accepte (`min_extension`, voir [Compatibilité des versions](../reference/compatibilite.md)), l'appairage est refusé avec un message qui nomme la version requise.

## Connecter un site : votre session, rien d'autre

« Connecter ce site » est une action explicite, avant toute lecture de cookie. L'extension affiche d'abord un **consentement par domaine** : le domaine, l'usage choisi et le destinataire. Deux usages, réglés par domaine :

| Usage | Ce qui se passe | Quand le choisir |
|---|---|---|
| **Tunnel** (par défaut) | les cookies **restent dans votre navigateur** et ne sont jamais envoyés à l'instance ; les requêtes passent par votre navigateur, qui les signe lui-même | la plupart des cas ; l'API ne s'exécute que ordinateur allumé |
| **Côté serveur** (opt-in explicite par domaine) | l'extension envoie les cookies, que l'instance stocke chiffrés | un site dont la session n'est pas liée à l'appareil et que vous voulez rejouer sans votre navigateur |

Règles qui valent dans les deux cas :

- **Une session appartient à son propriétaire.** Une API qui utilise une session ne s'exécute que par son propriétaire. Aucun rôle, administrateur et propriétaire de l'instance compris, ne peut faire passer un run par l'extension d'un autre ni se faire passer pour lui.
- **Écriture seule** : aucune route ni aucun outil ne renvoie la valeur d'un cookie.
- Un cookie expiré, absent, ou une session liée à l'appareil donne **Action requise** (« session expirée », « connexion requise », « session liée à l'appareil »), jamais une sortie vide ni un échec silencieux.
- **Pas de clonage** : copier, exporter ou transférer une API ne copie jamais la session. L'API attend que son nouveau propriétaire connecte **son** compte.
- « Déconnecter ce site » supprime le domaine et les cookies en base. Le run suivant passe en Action requise.

Sur un site qui exige un compte, rappelez-vous que ses conditions d'utilisation interdisent souvent l'extraction automatisée, que les données de tiers relèvent du RGPD, et que cette responsabilité est la vôtre : voir [Usage responsable](../explications/usage-responsable.md#_5-sessions-et-comptes).

## Ce que le tunnel sait faire

Le worker envoie à l'extension un jeu **fermé** de commandes : une requête lancée depuis une page du site (le mode par défaut), une requête directe pour les API publiques, ou le pilotage d'un onglet en arrière-plan commande par commande (naviguer, attendre, lire, cliquer, taper, défiler). Toute commande hors de la liste est refusée. Aucun code reçu du serveur n'est exécuté dans l'extension.

L'exécution depuis le navigateur reste soumise à la cadence par domaine.

::: info Disponibilité
L'appairage, la capture de session et la révocation sont livrés (routes `/api/extension/*`). Le tunnel d'exécution (passerelle WSS et commandes du worker) est encore « en préparation » dans cette version : voir la [référence REST](../reference/rest.md) pour l'état exact.
:::
