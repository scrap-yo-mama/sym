---
title: "Sécurité"
description: "Secrets chiffrés, bac à sable, garde SSRF, isolement des utilisateurs et ce que le produit ne protège pas."
---

# Sécurité

Cette page explique ce que le produit protège, comment, et où s'arrête sa protection. Une instance manipule des clés de modèle, des identifiants de proxy et, parfois, des cookies de session : le modèle de sécurité est donc une partie du produit, pas une option. Les principes ci-dessous sont des **invariants**, chacun verrouillé par un test nommé qui s'exécute à chaque modification du code.

Pour signaler une vulnérabilité, **n'ouvrez jamais une issue publique** : le canal est le signalement privé de vulnérabilité du dépôt, décrit dans `SECURITY.md` (accusé de réception visé sous 72 heures, correctif visé sous 90 jours, **à valider**).

## Les secrets sont chiffrés au repos

Clés du modèle IA, identifiants de proxy, cookies, secrets de webhook : tout secret écrit en base est chiffré en **AES-256-GCM** avec des données associées (identifiant, nature, propriétaire, domaine). Un chiffré recopié sur une autre ligne ou chez un autre propriétaire ne se déchiffre pas. Chaque valeur a sa clé de chiffrement propre, elle-même enveloppée par une clé dérivée de `MASTER_KEY`.

- `MASTER_KEY` fait **exactement 32 octets** en base64 ; une phrase secrète est refusée, parce qu'une phrase faible donnerait une clé faible. Les valeurs triviales (octets répétés, texte ASCII encodé) sont refusées aussi.
- Une empreinte témoin est vérifiée au démarrage du serveur **et** du worker : une mauvaise clé empêche tout traitement de secret, au lieu de produire des échecs obscurs.
- La clé se fait tourner avec `runtime rekey`, et se perd avec dignité : les secrets passent à l'état « À ressaisir », jamais regénérés ni devinés. Voir [Sauvegarder et restaurer](../guides/sauvegarde.md).
- **Écriture seule** : aucune route, aucun outil, aucun écran ne renvoie la valeur d'un secret ou d'un cookie.
- **Masquage** : aucun secret n'apparaît en clair dans les journaux, les journaux de run, les messages d'erreur, les traces, les métriques ni les artefacts. Trois couches se complètent (un type qui se sérialise masqué, une liste de chemins masqués dans le journal, un balayage par valeur des textes libres), et des valeurs « canaris » dans les tests prouvent qu'aucune ne passe.

## Le code généré tourne dans un bac à sable

Quand l'agent écrit un script pour une API, ce script ne tourne **jamais** dans le processus principal. Il s'exécute dans un isolat (`isolated-vm`) lancé dans un **processus enfant dédié** :

- à **environnement vide** : ni `MASTER_KEY`, ni `DATABASE_URL`, ni clé du modèle ;
- sous un **utilisateur système distinct** de celui du worker, sans droit de lire la mémoire ni les fichiers de ce dernier (l'image le configure ; en production, le worker refuse de démarrer s'il ne peut pas le faire) ;
- sans réseau ni disque : le script n'a que des **ponts**, qui sont des fonctions (jamais des objets de l'hôte), valident taille et domaine côté hôte, et refusent tout domaine hors de ceux de l'API ;
- avec des plafonds de temps, de mémoire et de CPU, et un arrêt forcé en moins de deux secondes.

Les stratégies **déclaratives** n'exécutent aucun code : un interpréteur sans `eval`, avec des plafonds de taille, de profondeur et de temps.

::: warning Défense en profondeur, pas frontière absolue
Le bac à sable réduit l'impact d'un défaut, il ne l'exclut pas. D'autres couches agissent en complément : garde SSRF, secrets chiffrés, sorties validées. Le projet ne prétend pas qu'un bac à sable soit infaillible.
:::

## Garde SSRF sur toute connexion sortante

L'instance appelle des adresses que des utilisateurs, ou le contenu d'une page, lui donnent : c'est le terrain classique du SSRF (faire appeler à votre serveur ce que l'attaquant ne peut pas atteindre). La garde est **active par défaut** et non désactivable par un membre :

- elle contrôle l'adresse **réellement résolue**, à chaque connexion, pour les requêtes du worker, le Chromium du worker (par un proxy d'egress local), les webhooks et les alertes ;
- elle refuse les adresses privées et réservées, les métadonnées d'un cloud, les rebonds de DNS et les redirections vers une adresse privée ;
- seules les exceptions explicites de l'administrateur (`ALLOWED_PRIVATE_HOSTS`) passent, et les métadonnées d'un cloud restent refusées même alors.

## Les utilisateurs sont isolés

Chaque requête REST et chaque outil MCP est filtré par propriétaire, dans le code **et** dans PostgreSQL (sécurité au niveau des lignes). Un test paramétré échoue si une route n'a pas son cas « l'utilisateur B contre les objets de A ». Aucun rôle ne lit les cookies, les sorties de run ni les jeux de données d'un autre : il n'y a pas d'impersonation. Voir [Comptes, rôles et clés d'API](../guides/comptes.md).

## La console et l'authentification

- Cookie de session `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS, avec contrôle de l'en-tête `Origin` sur toute action.
- Mots de passe hachés en argon2id ; liste **locale** de mots de passe courants refusés, aucun service externe interrogé.
- Clés d'API à portées et à expiration, jamais de portée d'administration.
- Les textes affichés par la console ne viennent jamais d'une page lue : seulement de codes stables traduits localement. Aucun contenu collecté n'est interprété comme du HTML dans la console.

## Aucune donnée ne part vers l'éditeur

Voir [Télémétrie](./telemetrie.md) : pas de télémétrie, pas de contrôle de version distant, pas de ressource externe dans la console. Le trafic sortant ne va qu'aux sites que vous visez, au modèle, aux proxys, au courrier, aux webhooks et au collecteur OpenTelemetry que vous configurez.

## Chaîne d'approvisionnement

- Dépendances en **versions exactes**, fichier de verrouillage gelé, refus d'une version publiée depuis moins de sept jours, aucun script d'installation non autorisé.
- Actions de CI épinglées par empreinte ; images de base épinglées par empreinte ; scan des licences ; liste noire de paquets dont la fonction est de franchir des protections.
- Chaque release signe l'image (cosign sans clé), publie ses SBOM (CycloneDX) et une attestation de provenance. Voir [Compatibilité des versions](../reference/compatibilite.md#verifier-une-release).
- Aucun fichier Python ni notebook dans le dépôt : la CI et un hook de pré-commit les refusent, sur tout l'historique.

## Ce que le produit ne protège pas

- **L'opérateur de l'instance** (qui a la base et `MASTER_KEY`) n'est pas couvert : il peut tout lire. Choisissez votre hébergeur en conséquence.
- **Votre IA.** Le contenu d'une page lue peut contenir des instructions destinées à la tromper. Le produit limite les dégâts (sorties typées, descriptions d'outils figées, signaux d'usage traités comme des données) mais ne peut pas garantir que votre assistant ignore ce qu'il lit.
- **Une instance mal configurée** : secrets exposés, port ouvert, sauvegarde sans chiffrement. `runtime doctor` repère une partie de ces cas (voir [Diagnostiquer une instance](../guides/diagnostic.md)).
- **La licéité de vos collectes.** C'est l'objet de [Usage responsable](./usage-responsable.md).
