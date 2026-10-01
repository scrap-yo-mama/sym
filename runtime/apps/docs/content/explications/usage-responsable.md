---
title: "Usage responsable"
description: "Votre responsabilité, le RGPD, les conditions des sites, la conservation et les usages déconseillés."
---

# Usage responsable

Scrapyomama Runtime est un logiciel libre, **sans restriction d'usage dans sa licence**. Ce qui suit n'est donc pas une clause du contrat : c'est une information, écrite sur un ton direct, pour que vous sachiez à quoi vous vous engagez en l'installant. Le projet ne vous surveille pas et ne peut ni consulter ni effacer ce que vous collectez. Cette page n'a **aucune valeur de décharge**, ni pour vous ni pour le projet.

Dans la console, cette page est prévue pour s'afficher au premier lancement, puis à la création d'une API dont le schéma de sortie contient un champ `x-personal`, avec une case « j'ai lu » enregistrée (date, utilisateur, version du texte), sans valeur de décharge.

::: info Disponibilité
Cette version de développement ne livre pas encore tout ce que décrit cette page.

- **En préparation** : l'affichage de cette page au premier lancement, la case « j'ai lu » et le refus de créer une API à champ `x-personal` sans elle, ainsi que les avertissements de la création d'API (catégorie sensible, fournisseur de modèle distant), qui arrivent avec la création d'API (tâche 3.1) ; l'affichage du rapport d'accès dans l'enquête et la console (tâches 2.1 et 3.1) ; l'arrêt devant un refus ou un défi (tâche 1.7) ; la fiche de traitement par API, spécifiée mais sans tâche planifiée à ce jour.
- **Livrés** : la lecture de `robots.txt` sans option pour l'ignorer, le rapport d'accès et le User-Agent avec contact (module d'accès, tâche 1.11), l'effacement et l'export d'une personne avec la liste d'exclusion, la purge à échéance (tâche 1.8), la cadence par domaine (tâche 1.9), l'option `llm.redact`, l'absence de télémétrie (tâche 1.10) et la confirmation des sites à compte dans la console (tâche 3.5).
:::

::: info Ce que l'instance fait pour vous
Elle respecte `robots.txt` sans option pour l'ignorer, s'annonce honnêtement, limite sa cadence par domaine, efface sur demande une personne de vos jeux de données, purge les données à échéance et n'envoie rien à l'éditeur. Elle ne décide à votre place ni de la finalité, ni de la base légale, ni de la licéité de ce que vous collectez.
:::

## 1. Qui est responsable

**Vous.** C'est vous qui choisissez les sites visés, les données que vous gardez, pourquoi et pour combien de temps. Si ces données concernent des personnes, vous êtes le responsable de traitement au sens du RGPD.

L'éditeur du logiciel ne reçoit aucune donnée : pas de télémétrie, pas de contrôle de version, pas de rapport d'usage (voir [Télémétrie](./telemetrie.md)). Il n'a aucun accès à votre instance, et il ne peut donc pas non plus vous aider à effacer quoi que ce soit : c'est à vous de le faire. Si un jour une offre hébergée existait, ce serait un autre rôle, avec un autre contrat.

## 2. Avant de collecter des données personnelles

Avant la première collecte, écrivez noir sur blanc :

- **la finalité** : à quoi serviront ces données, précisément ;
- **la base légale** : si c'est l'intérêt légitime, il faut un **test de mise en balance écrit** (votre intérêt contre les droits des personnes concernées) ;
- **la minimisation** : les seuls champs strictement nécessaires. Le schéma de sortie le plus étroit possible est aussi le moins cher et le plus facile à défendre ;
- **le registre** de vos traitements, et une **analyse d'impact** (AIPD) si deux critères de risque se cumulent. L'instance exporte une fiche de traitement pré-remplie par API (finalité, base légale, catégories, durée, destinataires, transferts) que vous pouvez recopier dans l'outil de la CNIL ; elle ne décide pas à votre place si une analyse est requise.

Marquez dans le schéma de sortie les champs qui sont des données personnelles (`x-personal`), leur finalité (`x-purpose`) et, s'il y a lieu, un traitement de pseudonymisation (`x-pseudonymize`). Un champ qui relève d'une catégorie sensible (opinions, santé…) déclenche un avertissement à confirmer à la création. Attention : les « j'aime » et les commentaires d'un réseau social peuvent révéler des opinions.

## 3. Ce que la CNIL dit du moissonnage

Dans sa fiche du 19 juin 2025 sur la collecte par moissonnage (contexte du développement de systèmes d'IA), la CNIL pose des conditions : des critères de collecte précis, des filtres, le **respect de `robots.txt` et des captchas** (qui expriment une opposition), la suppression immédiate des données sensibles collectées par erreur. Elle place hors de l'intérêt légitime les **profils privés** et les **sites qui exigent un compte**.

Le produit en tient compte : `robots.txt` est respecté sans exception, un défi de vérification arrête tout, et une API qui exige une session vous demande de confirmer que vous connaissez les risques. Ce n'est pas une garantie que votre usage soit licite. La lecture de ces conditions est **à valider par un avocat**.

[Fiche de la CNIL sur le moissonnage](https://www.cnil.fr/fr/focus-interet-legitime-collecte-par-moissonnage)

## 4. Sites et conditions d'utilisation

Beaucoup de sites interdisent l'extraction automatisée dans leurs conditions d'utilisation, et le droit des bases de données (directive 96/9/CE) protège le producteur d'une base indépendamment de toute protection technique. Les décisions *Leboncoin c/ Jinka* (Cour de cassation, 5 octobre 2022, puis cour d'appel de Versailles, 14 avril 2026, à vérifier par un avocat) le rappellent : **s'arrêter devant un refus technique ne rend pas l'extraction sûre**, et passer outre aggrave le dossier.

Le produit **ne vérifie pas vos droits** sur un site. Il vous montre le lien vers ses conditions d'utilisation dans le rapport d'accès (« lire avant d'agir »), sans les interpréter. Quand une API existe officiellement, préférez-la : elle est plus claire, plus stable et moins chère.

## 5. Sessions et comptes

- **Votre session, seulement la vôtre.** Une API qui utilise une session ne s'exécute que par son propriétaire. Aucun administrateur ne peut s'en servir à votre place, aucune API n'utilise la session d'un autre utilisateur, et copier ou exporter une API ne copie jamais la session.
- **Les comptes de tiers sont hors de propos** : pas de pool de comptes, pas de rotation entre comptes pour échapper à une limite.
- **Une limite de compte rend la main** : l'API passe en « Action requise », sans relance automatique ni changement de compte.
- **Sur LinkedIn**, les conditions d'utilisation interdisent l'extraction automatisée et les données sont personnelles. Le cas existe dans les cas de référence du produit, avec cet avertissement ; vous en portez la responsabilité, y compris le risque de restriction de votre compte.
- **« Bloquée » est une réponse du site**, pas un obstacle à franchir. Voir [Hors périmètre](./hors-perimetre.md).

## 6. Conservation

- Par défaut : **90 jours** pour les jeux de données, **14 jours** pour les échantillons d'enquête et les détails d'erreur, **30 jours** pour les journaux de run. Réduisez ces durées dès que votre finalité le permet.
- La durée court depuis la première collecte (ou la dernière modification) : retrouver un item **inchangé ne la prolonge pas**.
- Une exemption exige une durée **et** une raison, jamais un « pour toujours ».
- N'attendez pas de renouvellement silencieux : en décembre 2024, la CNIL a sanctionné l'entreprise Kaspr (240 000 euros), notamment pour une conservation de cinq ans renouvelée automatiquement.

Les durées par défaut sont des valeurs proposées, **à valider** pour votre situation. Variables : [Variables d'environnement](../reference/variables-environnement.md#retention-et-stockage).

## 7. Droits des personnes

Une personne dont vous avez collecté les données peut demander l'accès, la rectification, l'effacement ou l'opposition. Vous avez **un mois** pour répondre (prolongeable de deux dans certains cas).

- `export_subject` rassemble ce que l'instance détient sur une personne, pour le propriétaire des données.
- `erase_subject` supprime la personne dans les jeux de données, les échantillons, les erreurs et les journaux, puis l'ajoute à une **liste d'exclusion hachée** consultée avant collecte et avant écriture : un run suivant ne la réécrit pas. Un essai à blanc (`dry_run`) montre ce qui serait supprimé.
- Un administrateur n'a **jamais** accès au contenu des runs ou des jeux de données d'un autre utilisateur ; ces actions sont tracées dans le journal d'audit.
- N'oubliez pas **l'information des personnes** (article 14) : un mois après la collecte, ou une information générale publique si l'informer individuellement demande un effort disproportionné.

## 8. Données envoyées au LLM

Un fournisseur de modèle distant est **votre sous-traitant** : contrat de traitement, région, durée de conservation, entraînement. Le transfert hors de l'Union européenne est à évaluer ; l'état du cadre entre l'Union et les États-Unis est contesté, à vérifier.

- L'option `llm.redact` masque les e-mails et les téléphones **avant l'envoi** au fournisseur.
- Un avertissement s'affiche quand un schéma qui contient des données personnelles vise un fournisseur distant.
- Pour des données sensibles, utilisez un **modèle local** (par exemple Ollama ou vLLM sur une machine à vous).
- Les prompts et les réponses ne sont pas journalisés par défaut.

Voir [Brancher son modèle IA](../guides/modele-llm.md).

## 9. Usages déconseillés

Le projet **déconseille vivement**, et n'offre aucun support pour :

- **constituer une base de contacts pour la revendre** : c'est le modèle de Kaspr, sanctionné par la CNIL (240 000 euros, décembre 2024), notamment pour avoir collecté des contacts dont la visibilité était restreinte ;
- **prospecter sans base légale valide** : c'est le reproche fait à Nestor, sanctionné par la CNIL d'une amende de 20 000 euros (d'après des sources secondaires, date exacte à vérifier) ;
- **alimenter une base de reconnaissance faciale** par collecte d'images de visages : interdit par l'article 5, paragraphe 1, point e du règlement (UE) 2024/1689 sur l'IA. Le produit n'a aucune fonction d'images de visages ;
- **prendre des décisions automatisées sur des personnes** (recrutement, crédit) : ce sont des usages à haut risque dont vous répondez.

Ces mentions n'ajoutent aucune restriction à la licence : elles disent ce que le projet ne soutient pas.

## 10. Cadence et bon voisinage

- `robots.txt` est lu avant tout et **respecté sans option pour l'ignorer**, y compris pour une adresse saisie à la main et en tunnel.
- La cadence est réglée **par domaine** (1,5 seconde entre deux requêtes par défaut, plancher fixé par `Crawl-delay` quand il existe), jamais par adresse, compte ou proxy : changer de proxy ou d'utilisateur ne donne aucun débit supplémentaire. Elle ne fait que ralentir quand le site demande de ralentir.
- Le robot **s'annonce** avec un User-Agent honnête qui contient le **contact de votre instance** : renseignez un contact joignable. Voir [Le robot Scrapyomama](./robot.md).
- Monter en charge, c'est traiter plus de domaines en parallèle, jamais multiplier les sources vers un même site.

## 11. Limites de ce document

**Ceci n'est pas un avis juridique.** Consultez un juriste ou votre délégué à la protection des données. Ce texte est écrit de bonne foi à partir des sources publiques citées, le droit évolue, plusieurs lectures sont **à valider par un avocat** (la qualification des rôles, la position de la CNIL sur `robots.txt` et les sites à compte, le calendrier du règlement sur l'IA), et rien ici ne promet que votre usage soit autorisé.

Pour aller plus loin : la [CNIL](https://www.cnil.fr/fr/les-fiches-pratiques-ia) et le [Comité européen de la protection des données](https://www.edpb.europa.eu/our-work-tools/our-documents/opinion-board-art-64/opinion-282024-certain-data-protection-aspects_en).
