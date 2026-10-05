<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Guide de voix de SYM 👻

Ce guide dit comment SYM parle, dans toutes ses surfaces : MCP, console, extension, e-mails, doc. Il accompagne les catalogues
`locales/fr.json` et `locales/en.json` et les listes `locales/forbidden.fr.txt` et `locales/forbidden.en.txt`. Source :
`cdc/scrapyomama-ux/08-specs-voix.md` (tâche 3.19). Une phrase du produit décrit ce que SYM fait vraiment, avec des chiffres réels.

## La DA en une ligne

> **« Claude ne veut pas le faire. SYM 👻 : OK, je m'en occupe. »**

Un ton espiègle, un peu hacker, assumé. Chaque phrase tient sa promesse : ce que SYM annonce, SYM le fait, et le texte le chiffre
quand il peut. Le fantôme est l'unique emoji des textes produit ; les pictogrammes ✓ ▸ ■ sont permis dans le récit.

## La signature

| Forme | Où | Exemple |
|---|---|---|
| « SYM 👻 : » en fr (espace avant les deux-points), « SYM 👻: » en en | Étiquette de locuteur quand SYM parle : récit MCP, bulles de la console, panneau de l'extension | « SYM 👻 : OK, je m'en occupe. » |
| « SYM 👻 » | Badge, statut, titre de carte | « SYM 👻 travaille pour toi » |
| Icône SVG du fantôme | Interface, quand la police ne garantit pas l'emoji | Pastille de la barre de navigation |

- La signature ouvre le récit (« SYM 👻 : OK, je m'en occupe. ») et le clôt sur un succès (« SYM 👻 : C'est fait. 519 biens, 0 $ par rejeu. »).
- Sur un état d'erreur, une page « bloquée » ou une demande de consentement, le texte reste neutre et factuel, sans signature ni illustration.
- Dans un message de catalogue, `{sym}` rend la signature de la langue ; ne l'écris jamais en dur.

## Ton par situation

Tutoiement en français. Une intention par situation, un exemple par langue.

| Situation | Intention | fr | en |
|---|---|---|---|
| **Prise en charge** | Rassurer, s'engager | « SYM 👻 : OK, je m'en occupe. » | « SYM 👻: Got it, I'm on it. » |
| **Progression** | Informer, court | « 2/4 Reconnaître : 12 biens par page, 52 pages » | « 2/4 Recognize: 12 listings per page, 52 pages » |
| **Question** | Une décision, ses conséquences | « J'ai trouvé deux listes. Laquelle ? 1) 519 à vendre (~0,04 $) 2) 48 vendus » | « I found two lists. Which one? 1) 519 for sale (~$0.04) 2) 48 sold » |
| **Succès** | Fier, chiffré | « C'est fait. 519 biens, 0 $ par rejeu. » | « Done. 519 listings, $0 per replay. » |
| **Échec avec action** | Cause, puis action | « Le prix du modèle manque pour le rôle enquête. Ajoute-le dans Réglages > Modèles IA. » | « The model price is missing for the investigate role. Add it in Settings > AI models. » |
| **Site qui refuse** | Honnête, une alternative au moins | « Ce site a refusé l'accès. Tu peux passer par une API officielle ou une autre source. » | « This site refused access. You can use an official API or another source. » |
| **Attente longue** | Ce qui reste, combien de temps | « Page 31 sur 52, environ 40 s. » | « Page 31 of 52, about 40 s. » |

La signature accompagne la prise en charge et le succès. Les situations d'échec et de refus restent neutres.

## Règles de micro-texte

| Règle | Exemple fr |
|---|---|
| **Un bouton dit ce qu'il fait**, verbe d'abord | « Valider et lancer les essais · ~0,12 $ », « Télécharger le CSV » |
| **Une erreur dit la cause, puis l'action**, en deux phrases au plus | « Ta clé n'a pas le droit apis:write. Crée une clé avec ce droit dans Réglages > Clés d'API. » |
| **Un état vide donne une raison positive et une action** | « Ta première API saine apparaîtra ici. » puis « Nouvelle API » |
| **Les mots de l'utilisateur, pas ceux du code** | « essai rapide sans navigateur » plutôt que « fetch/direct » ; les codes vivent dans « Détails » |
| **Des chiffres réels, aux formats `Intl`** | « 0,04 $ » en fr, « $0.04 » en en ; aucune durée affichée avant d'être mesurée |
| **Le même verbe pour la même action** | « Connecter ma session » dans le catalogue, la fiche, le panneau et le MCP |
| **Le glossaire ne se traduit pas** | SYM, run, MCP, API, slug |
| **Des promesses exactes** | Les listes `forbidden.<langue>.txt` valent pour toutes les surfaces : catalogues, e-mails, doc, landing, README, fiche du Store, notes de version |

Autres repères : une phrase = une idée ; un code interne (`snake_case`) n'apparaît jamais dans un texte humain, ni un nom de
colonne, ni un nom d'exécuteur ; un message de refus propose au moins une alternative ; la même clé n'existe pas en deux
formulations.

## Glossaire

| Terme | Usage |
|---|---|
| **SYM** | Le produit, toujours en capitales ; avec le fantôme quand il parle |
| **run** | Une exécution d'une API ; ne pas traduire ; « rejeu » pour un run qui relit une stratégie déjà validée |
| **MCP** | Le canal par lequel l'IA de l'utilisateur parle à SYM ; ne pas traduire |
| **API** | Ce que SYM fabrique à partir d'une page ; ne pas traduire |
| **slug** | L'identifiant court d'une API ; ne pas traduire |
| **enquête** | Le travail de SYM pour comprendre une page (reconnaissance, schéma, essais) |
| **schéma** | La liste des champs que l'utilisateur recevra, validée avant les essais |
| **essai** | Une tentative de méthode d'extraction, de la moins chère à la plus chère |
| **stratégie** | La méthode retenue, rejouée ensuite sans IA quand c'est possible |
| **session** | La connexion de l'utilisateur à ses propres outils, utilisée avec son accord |

## Paires fr/en de référence

Vingt paires à reprendre telles quelles ou à imiter. Les accolades `{x}` sont des variables du catalogue.

| # | Situation | fr | en |
|---|---|---|---|
| 1 | Prise en charge | SYM 👻 : OK, je m'en occupe. | SYM 👻: Got it, I'm on it. |
| 2 | Prise en charge | Enquête sur {domain} lancée. | Investigation of {domain} started. |
| 3 | Progression | Reconnaissance : je regarde comment la page obtient ses données | Reconnaissance: looking at how the page gets its data |
| 4 | Progression | Schéma proposé : {fields} champs. | Schema proposed: {fields} fields. |
| 5 | Progression | Essais : de la méthode la moins chère à la plus chère | Trials: from the cheapest method to the most expensive |
| 6 | Question | J'ai trouvé deux listes. Laquelle ? | I found two lists. Which one? |
| 7 | Question | Valider ce schéma et lancer les essais · ~{cost} | Validate this schema and start the trials · ~{cost} |
| 8 | Succès | SYM 👻 : C'est fait. 519 biens, 0 $ par rejeu. | SYM 👻: Done. 519 listings, $0 per replay. |
| 9 | État vide | Ta première API saine apparaîtra ici. | Your first healthy API will show up here. |
| 10 | Succès | Enregistré. | Saved. |
| 11 | Échec avec action | Le prix du modèle manque pour le rôle enquête. Ajoute-le dans Réglages > Modèles IA. | The model price is missing for the investigate role. Add it in Settings > AI models. |
| 12 | Échec avec action | Le contact du robot manque. Renseigne-le dans Réglages > Identité du robot. | The robot contact is missing. Set it in Settings > Robot identity. |
| 13 | Échec avec action | Ta clé n'a pas le droit {scope}. Crée une clé avec ce droit dans Réglages > Clés d'API. | Your key does not have the {scope} right. Create a key with that right in Settings > API keys. |
| 14 | Échec avec action | Le serveur est injoignable. Vérifie ta connexion puis réessaie. | The server cannot be reached. Check your connection, then try again. |
| 15 | Échec avec action | L'essai a atteint son plafond de {cost}. Monte le plafond de l'API pour continuer. | The trial reached its {cost} cap. Raise the API cap to continue. |
| 16 | Site qui refuse | Ce site a refusé l'accès. Tu peux passer par une API officielle ou une autre source. | This site refused access. You can use an official API or another source. |
| 17 | Site qui refuse | Écrire à l'éditeur du site. | Write to the publisher of the site. |
| 18 | Attente longue | Page 31 sur 52, environ 40 s. | Page 31 of 52, about 40 s. |
| 19 | Attente longue | Il reste {n} pages. Je continue. | {n} pages left. Still going. |
| 20 | Bouton | Connecter ma session | Connect my session |
