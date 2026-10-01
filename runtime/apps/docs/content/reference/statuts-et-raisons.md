---
title: "Statuts et classes d'échec"
description: "Les sept statuts d'une API, les 21 transitions, le drapeau stale et les classes d'échec."
---

# Statuts et classes d'échec

Chaque API du catalogue a **un statut**. Il ne change que selon une table fermée de **21 transitions**, chacune journalisée avec sa raison : aucun comportement implicite. Cette page est la référence de cette table et du classifieur d'échec qui la déclenche. Les codes de raison eux-mêmes sont dans [Codes de raison](./codes-de-raison.md).

## Les sept statuts

| Statut (code) | Libellé dans la console | Sens |
|---|---|---|
| `enquete` | En enquête | l'agent cherche la méthode la moins chère qui produit la sortie demandée |
| `sain` | Sain | les derniers runs sont propres |
| `warning` | À surveiller | sortie conforme, avec un point à surveiller (run dégradé, site indisponible, retour à une ancienne version) |
| `reparation` | En réparation | l'extraction est cassée, une réparation est en cours |
| `erreur` | En erreur | budget épuisé ou correctif répété sans résultat ; l'API répond `api_error` avec la dernière raison |
| `action_requise` | Action requise | une action de votre part est nécessaire : connexion, proxy, paiement, tunnel hors ligne |
| `bloquee` | Bloquée | le site refuse l'accès automatisé, ou le demande par `robots.txt` ; le produit s'arrête |

`stale` n'est **pas** un statut : c'est un **drapeau d'affichage** (aucune exécution depuis un délai, ou canari en échec sans casse confirmée). Il s'ajoute à `sain` ou `warning` dans le catalogue et ne déclenche aucune transition.

## Les 21 transitions

| # | De vers | Déclencheur |
|---|---|---|
| 1 | enquete vers sain | une stratégie v1 conforme au schéma |
| 2 | enquete vers erreur | budget d'enquête épuisé sans rien de conforme ; `robots.txt` injoignable de façon persistante |
| 3 | enquete vers action_requise | connexion, paiement, limite de compte, proxy requis non configuré ou tunnel hors ligne |
| 4 | enquete vers bloquee | refus, défi de vérification ou `robots.txt` |
| 5 | sain vers warning | run réussi **dégradé** |
| 6 | sain vers warning | run **indisponible** (erreurs passagères persistantes) |
| 7 | sain vers warning | retour manuel à une version antérieure |
| 8 | warning vers warning | nouveau signal : le compteur de runs propres repart à zéro |
| 9 | warning vers sain | trois runs propres consécutifs, **ou** au moins un run propre et aucun signal depuis le plus long de 7 jours et de trois périodes de planification |
| 10 | sain vers reparation | échec non passager d'un rejeu |
| 11 | warning vers reparation | idem |
| 12 | reparation vers warning | réparation conforme (version suivante) |
| 13 | reparation vers erreur | budget de réparation épuisé ou correctif répété |
| 14 | reparation vers action_requise | connexion, paiement ou limite de compte, ou défi pendant un run en tunnel |
| 15 | reparation vers bloquee | refus, défi ou `robots.txt` |
| 16 | erreur vers enquete | nouvel essai automatique espacé (1 h, 6 h, 24 h, puis arrêt), réservé à l'extraction, l'erreur de script, le réseau et `robots.txt` injoignable ; ou bouton **Ré-enquêter** |
| 17 | action_requise vers enquete | l'utilisateur a agi |
| 18 | bloquee vers enquete | **uniquement** une ré-enquête manuelle. Jamais automatique, jamais suggérée comme une manière de passer le refus |
| 19 | sain vers enquete | ré-enquête, schéma de sortie modifié ou ré-enquête forcée |
| 20 | warning vers enquete | idem |
| 21 | enquete vers statut précédent | ré-enquête d'une API existante sans stratégie conforme : l'ancienne version est gardée (raison `reinvestigation_failed`) |

**Refus pendant un rejeu.** Si une API `sain` ou `warning` se heurte à un refus, à un défi ou à un `robots.txt` devenu restrictif, le run passe par `reparation` (transition 10 ou 11), puis la garde de classification l'envoie **dans le même run** vers `bloquee` ou `action_requise`, **sans jamais invoquer l'agent de réparation**. Un refus n'est pas une casse qu'on répare.

**Run dégradé.** Un run dont la sortie est conforme mais qui porte au moins un signal : plusieurs réessais, méthode plus chère, réparation, champ facultatif qui se vide, volume anormal, pagination courte, lenteur, coût anormal. Chaque signal s'affiche comme une raison.

## Le classifieur d'échec

Chaque essai et chaque run porte une `failure_class`. Le classifieur **élague** la suite de l'enquête selon la classe.

| Classe | Signaux | Suite |
|---|---|---|
| `transient` | délai dépassé, 5xx, connexion coupée | nouveaux essais, puis « site indisponible » |
| `network` | connexion refusée, DNS, restriction géographique | autre mode réseau si l'API l'autorise. **Jamais** pour un 401, un 403 ou un 429 |
| `rate_limited` | 429, `Retry-After` | **ralentir** la cadence ; le domaine est suspendu après des refus répétés. Jamais de changement de proxy |
| `forbidden` | 403 sans signature de protection | **arrêt**, sans changement de réseau ; statut `bloquee` |
| `blocked_by_protection` | page de défi (même servie avec un 200), en-tête de protection connu | **arrêt de toute escalade** ; statut `bloquee` |
| `robots_disallowed` | `robots.txt` interdit le chemin | **arrêt**, aucune requête sur le chemin ; statut `bloquee` |
| `robots_unreachable` | `robots.txt` en 5xx persistant | par précaution, rien n'est collecté ; `erreur` si persistant |
| `payment_required` | réponse 402 | `action_requise` : l'accès est payant, rien n'est payé |
| `auth_required` | 401, redirection vers la connexion, cookie expiré | `action_requise` : connecter le site dans l'extension |
| `account_limit` | la plateforme signale une limite sur **votre** compte | `action_requise` ; **aucune relance** automatique, aucun changement de compte |
| `not_found` | 404, 410 | réparation limitée à retrouver l'adresse |
| `extraction` | sélecteur introuvable, format changé, sortie hors schéma, zéro item anormal | réparation, puis autre méthode |
| `code_error` | exception du script généré | réparation |
| `llm_*` | les 13 classes d'erreur du modèle IA, préfixées `llm_` (`llm_quota_exhausted`, `llm_context_length`…) | réessai ou repli selon la classe ; **jamais de repli** sur `llm_refused`, `llm_auth` ni `llm_quota_exhausted` |

Un 401 ou un 403 n'est **jamais** classé `network` et n'entraîne jamais de changement d'adresse. C'est l'une des lignes du produit : voir [Hors périmètre](../explications/hors-perimetre.md).

## Disjoncteur par domaine

Après plusieurs refus ou 429 consécutifs sur un domaine, un disjoncteur s'ouvre et suspend les runs de ce domaine. Il se referme (semi-ouvert) après le `Retry-After` ou un délai croissant, et peut être réarmé à la main. Il ne change jamais de réseau.

## Textes affichés

Le statut et sa raison s'affichent toujours avec un **texte lisible sans survol** : une icône de forme distincte, un libellé et la raison en toutes lettres. La couleur n'est jamais le seul signal. Pour un statut `bloquee`, le panneau explique ce qui s'est passé, dit que l'arrêt est voulu (ce n'est pas une panne), et propose des voies légitimes : l'API officielle du site, une autre source, un contact avec l'éditeur, une ré-enquête plus tard. Aucun bouton n'invite à passer outre.
