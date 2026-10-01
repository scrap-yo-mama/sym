---
title: "Brancher son modèle IA"
description: "Un fournisseur compatible OpenAI choisi par vous, ses clés chiffrées, ses capacités sondées."
---

# Brancher son modèle IA

L'enquête, la réparation et les extractions assistées appellent un modèle de langage. Ce modèle est **le vôtre** : vous choisissez le fournisseur, vous payez ses appels, et l'éditeur du produit n'y a aucun accès. Rien n'est livré avec une clé.

::: info Où se règle le modèle
Le modèle se règle dans la console, sous **Réglages > Modèles**, par un administrateur de l'instance. Les routes REST qui enregistrent ces réglages (`/api/settings/llm`) sont encore « en préparation » : voir la [référence REST](../reference/rest.md). Cette page décrit le comportement visé, qui est celui du CDC et des couches déjà livrées (transport, sonde de capacités, classes d'erreur, prix).
:::

## Ce qu'est un fournisseur

Un fournisseur est un point d'accès **compatible Chat Completions** : `POST {base_url}/chat/completions`, avec appel d'outils. Conviennent notamment z.ai (GLM), OpenAI, OpenRouter, DeepInfra, vLLM, Ollama, DeepSeek et Qwen, ou un proxy de type LiteLLM que vous placez devant, saisi comme `base_url`. L'API Responses n'est pas utilisée, et le format natif d'Anthropic viendra plus tard : un `base_url` pointé vers l'API d'Anthropic par la couche OpenAI ignore les sorties structurées strictes.

Vous pouvez enregistrer plusieurs fournisseurs. Chacun porte sa clé, d'éventuels en-têtes personnalisés (chiffrés comme la clé), son délai et ses modèles.

## Les quatre rôles

Chaque rôle désigne un couple fournisseur et modèle, pour payer le bon prix au bon endroit.

| Rôle | Sert à | Remarque |
|---|---|---|
| `investigate` | l'enquête et la génération de stratégie | le rôle qui compte le plus pour la qualité |
| `repair` | la réparation d'une API cassée | |
| `extract` | la mise en forme des données à chaque run en E4 | peut viser un petit modèle local (Ollama) |
| `agent` | le pilotage du navigateur (E5 et E6) | exige l'appel d'outils ; multimodal si vous utilisez des captures |

Affecter à un rôle un modèle dont les capacités ne couvrent pas ce que le rôle exige (un rôle `agent` sans appel d'outils, par exemple) est refusé.

## La sonde de capacités

Les services « compatibles OpenAI » ne se comportent pas tous pareil : certains acceptent un schéma strict puis répondent en prose avec un code 200, d'autres n'ont pas la sortie structurée sur tous leurs points d'accès. À l'enregistrement d'un couple fournisseur et modèle, l'administrateur lance une **sonde de trois appels minuscules** (moins de 300 jetons chacun). Elle remplit un profil visible dans l'interface : appel d'outils, `tool_choice`, mode de sortie structurée (`json_schema`, outil forcé, `json_object` ou aucun), flux, usage, cache.

La sonde ne contacte que le fournisseur que vous avez configuré, uniquement sur votre action. Elle se rejoue à chaque changement de modèle.

## Sortie structurée : toujours validée

Le profil choisit le niveau de contrainte (S1 à S4, du `json_schema` strict à l'extraction du JSON dans le texte). Quel que soit le niveau, la validation finale porte sur **votre schéma d'origine**, avec au plus deux réparations, sans jamais résoudre de `$ref` distant. Une sortie hors schéma n'est **jamais** comptée comme un succès, même avec un HTTP 200.

## Erreurs et repli

La décision de réessayer se prend par **classe d'erreur**, pas par code HTTP : trois essais au plus, attente exponentielle avec gigue, `Retry-After` respecté. Deux règles à connaître :

- **Aucun repli sur un autre modèle** pour `llm_refused` (le modèle a refusé la demande), `llm_auth` (clé refusée) ni `llm_quota_exhausted` (crédit épuisé). Changer de modèle pour contourner un refus est précisément ce que le produit ne fait pas ; il s'arrête et le dit.
- Un repli n'existe que si vous l'avez configuré pour le rôle, et seulement sur surcharge, délai dépassé ou réponse vide.

Un crédit épuisé met le run en erreur et suspend les planifications. Les classes sont listées dans [Statuts et classes d'échec](../reference/statuts-et-raisons.md).

## Coût

Le coût d'un run se calcule d'après l'**usage renvoyé** par le fournisseur (cache et raisonnement compris), et d'après le prix que vous avez saisi pour le modèle. Un prix absent donne un coût « inconnu » avec avertissement, **jamais zéro**. Le coût estimé s'affiche avant de lancer, et un run qui dépasserait son plafond s'arrête.

## Confidentialité

- `base_url` et en-têtes ne sont modifiables que par un administrateur. `localhost` et les réseaux privés sont permis, pour Ollama ou vLLM : c'est de la configuration d'opérateur.
- Les **prompts et les réponses ne sont pas journalisés** par défaut, parce que les pages lues peuvent contenir des données personnelles.
- Un fournisseur distant est **votre sous-traitant** au sens du RGPD : voyez sa région, son accord de traitement, sa rétention et sa politique d'entraînement. L'option `llm.redact` masque e-mails et téléphones avant l'envoi. Pour des données sensibles, préférez un modèle local. Détails : [Usage responsable](../explications/usage-responsable.md#_8-donnees-envoyees-au-llm).
- Une clé enregistrée est chiffrée en base avec `MASTER_KEY` et n'est jamais relue par l'interface (écriture seule).
