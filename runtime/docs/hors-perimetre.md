# Hors périmètre : ce que Scrapyomama Runtime ne fera jamais

> Cette page énonce ce que le produit exclut par conception, et pourquoi. Elle ne décrit **aucune méthode** : ni comment ces fonctions marcheraient, ni comment reconnaître les protections visées. Ce n'est pas un avis juridique. Brouillon, à valider par un avocat avant toute publication.

## La règle

Le produit ne propose aucune fonction dont le rôle est de **tromper ou franchir une protection technique** mise en place par un site : détection de robots, défi de vérification, limite de comptes. Le reste de l'outil est normal : appeler les API qu'un site utilise pour son propre site, piloter un navigateur, utiliser les proxys que **vous** configurez, utiliser **votre** session avec votre consentement, planifier des exécutions.

C'est une ligne plus stricte que celle d'une partie du marché. Elle est assumée : certains sites protégés resteront donc en statut « bloquée », même pour un usage légitime.

Quand le produit rencontre un refus ou un défi, il **s'arrête et rend la main**. Il explique ce qui s'est passé, dit que l'arrêt est voulu (ce n'est pas une panne), et propose les voies légitimes : l'API officielle du site, une autre source pour la même donnée, un contact avec l'éditeur, ou une nouvelle enquête plus tard.

## Les six exclusions

| # | Ce que le produit ne fait pas | Pourquoi |
|---|---|---|
| X1 | Résoudre un captcha, par un solveur intégré ou par un service tiers | Un captcha est la décision d'un site de réserver une étape à un humain. La franchir est un contournement. Pour la CNIL (fiche du 19/06/2025 sur le moissonnage), il exprime aussi une opposition au moissonnage : le franchir fragilise la base légale du traitement. |
| X2 | Masquer l'identité du navigateur ou imiter un comportement humain pour échapper à la détection | Ces fonctions n'ont qu'un usage : tromper un dispositif de détection. Le navigateur du worker s'annonce tel qu'il est. |
| X3 | Franchir les défis anti-robot posés par un site ou par un éditeur de protection | Même motif que X1 et X2. Le produit détecte le défi, arrête toute escalade, passe l'API en statut « bloquée » et explique pourquoi. En mode navigateur de l'utilisateur, un défi arrête le run : c'est à la personne de naviguer normalement. |
| X4 | Changer d'adresse IP après un refus pour déjouer une détection | Un 401 ou un 403 n'entraîne jamais de changement d'IP. Un 429 entraîne un ralentissement. Les proxys ne servent qu'à des motifs réseau (contenu propre à un pays, erreurs de connexion), sont réglés par l'administrateur de l'instance et tracés dans chaque run. |
| X5 | Faire tourner plusieurs comptes ou identités pour échapper à une limite | Cela contourne les règles des plateformes et revient à usurper des identités. Une API qui utilise une session n'utilise que celle de son propriétaire ; une limite de compte atteinte arrête le run (« action requise »), sans relance ni changement de compte. Plusieurs membres qui ont chacun leur propre session ne sont pas du multi-comptes. |
| X6 | Reprendre ou publier du code historique de franchissement de protections | Le publier reviendrait à distribuer X1 à X3. Aucun fichier Python ni notebook n'entre dans le dépôt : la CI et un hook de pré-commit les refusent. |

## Ce qui n'est pas exclu

- Appeler les API internes d'un site, y compris depuis le contexte de la page.
- Piloter un navigateur et, en dernier recours, un agent.
- Utiliser des proxys fournis et configurés par vous.
- Utiliser votre propre session et votre propre adresse IP, avec votre consentement explicite par domaine, quand vous avez choisi ce mode.
- Planifier des exécutions.
- Consulter `robots.txt` comme source d'information, par exemple pour trouver le sitemap ; il ne conditionne pas la collecte.

## Ce qui reste votre responsabilité

S'arrêter sur un défi ne rend pas une extraction sûre pour autant : les conditions d'utilisation d'un site, le droit des bases de données et le RGPD s'appliquent indépendamment de toute protection technique. Ces points de conformité sont à votre charge.

## Contribuer, proposer, demander

Les contributions dont le but relève de X1 à X6 (code, dépendance, documentation, extrait dans une issue) sont refusées. Une pull request de ce type est fermée sans revue technique, et le débat ne se rouvre pas : voir [CONTRIBUTING.md](../CONTRIBUTING.md). Merci de ne pas publier de code de ce type dans les issues.

Réponse type, portée par le label `out-of-scope` :

> Cette demande relève d'une fonction que le projet ne fournit pas (résolution de défis, furtivité, franchissement de protections, changement d'IP après un refus, multi-comptes, code de contournement). Le produit s'arrête et rend la main. Voir [Hors périmètre](hors-perimetre.md) et l'API officielle du site s'il en a une.

Ce qui reste bienvenu : respect des conditions d'usage, limitation de cadence, API officielles, meilleur diagnostic des blocages, documentation des cas où le produit s'arrête. Pour la recherche en sécurité, le canal est [SECURITY.md](../SECURITY.md), pas une pull request publique.
