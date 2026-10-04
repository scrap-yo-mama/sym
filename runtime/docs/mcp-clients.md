# Matrice des clients MCP (tâche 3.10)

Ce que le serveur MCP de SYM garantit à un client, selon les fonctions optionnelles que ce client gère, et la grille de recette
sur quatre clients réels. Spécification : `cdc/scrapyomama-runtime/05-specs-mcp-rest.md` § 1.2, § 1.3 et § 4.4. Le support réel des
fonctions optionnelles varie d'un client à l'autre et d'une version à l'autre : **rien n'est requis du client** (repli texte
partout), et les cases « constat » ci-dessous se remplissent à la recette, avec captures.

## Ce que le serveur garantit, fonction par fonction

| Fonction | Si le client la gère | Sinon (repli, toujours livré) |
|---|---|---|
| `instructions` | Le modèle lit la consigne (1 000 caractères au plus, l'essentiel dans les 512 premiers) | Le contenu vital est aussi dans les descriptions d'outils et dans `what_to_do` de chaque erreur |
| Prompts (`prompts/list`, `prompts/get`) | `new_api`, `fix_api`, `first_steps`, `review_catalog` : noms stables, titres `sym:…` dans la langue du compte (`?lang=` la remplace), corps en anglais | La marche à suivre est dans `instructions` (list_apis d'abord, create_api, montrer le schéma, validate_schema) |
| Élicitation | `create_api` pose une question plate (« Valider ce schéma de sortie ? », décision `validate` ou `modify`, remarque libre) et joue `validate_schema` sur « oui » | La phase reste `awaiting_schema_validation` ; la réponse dit de montrer le schéma, puis d'appeler `validate_schema` |
| `progress` | `notifications/progress` strictement croissant pendant l'attente d'une enquête (création, validation, ré-enquête), avec le dernier pas du récit en message | Aucune notification ; le récit complet arrive dans le résultat, `get_run` rend le même récit à tout moment |
| `list_changed` | `notifications/tools/list_changed` par `subscriptions/listen` quand la liste d'outils par API de l'utilisateur change | Reconnecter le serveur relit la liste (« si l'outil n'apparaît pas, reconnecte le serveur ») |
| `structuredContent` | `timeline[]`, `attempts[]`, `cost`, `console_url`, schéma proposé : les mêmes faits que le texte | Le texte (`content`) suffit : phases, étapes, essais, coût, stratégie, prochaine action, lien de la console, schéma à montrer |

Deux ères de protocole, un seul code (le SDK serveur fait la correspondance) :

- **2026-07-28** : le client déclare ses capacités à chaque requête. L'élicitation passe par un résultat `input_required`
  (multi-aller-retour) : le serveur rend la question, le client répond et rejoue l'appel avec l'état reçu. L'état ne nomme que
  l'API et son enquête ; chaque lecture est refaite sous RLS (propriétaire, phase), il ne confère aucun droit.
- **2025-xx** : le serveur est sans état, il ne connaît pas les capacités du client d'une requête à l'autre. Il ne pose donc
  pas de question et reste sur le repli `validate_schema`. Le texte, `progress` (si le client envoie un jeton) et `list_changed`
  fonctionnent sans changement.

## Statut à la livraison de 3.10

Le critère de 05 § 4.4 sur les clients réels (« le jeu de 12 prompts tourne sur les 4 clients de la matrice, l'outil attendu
est choisi ») n'est **pas joué** par la tâche 3.10 : il est reporté à la recette (étape MCP), comme le prévoit 15 § 6 (jeu
rejoué à la recette, clients réels manuels, captures consignées). Ce report est à consigner au journal d'exécution du CDC par l'orchestrateur (la tâche n'écrit pas dans `cdc/`). Ce
que la tâche livre : le jeu de prompts (`eval/mcp-prompts.json`), la grille ci-dessous, et la seconde moitié du critère
(descriptions servies identiques aux textes figés) vérifiée automatiquement. Toutes les cases restent « à constater »
jusqu'à la recette.

## Grille de recette : 4 clients réels

Clients de la matrice (05 § 1) : Claude (Desktop, web ou Code), ChatGPT, Cursor, opencode. Pour chacun : ajouter
`https://<instance>/mcp` avec une clé d'API de test, puis relever. **Constat à consigner à la recette** (captures dans le dossier
de recette) ; aucune case n'est remplie ici sans capture.

| Fonction | Claude | ChatGPT | Cursor | opencode |
|---|---|---|---|---|
| `instructions` affichées ou lues | à constater | à constater | à constater | à constater |
| Prompts listés et jouables | à constater | à constater | à constater | à constater |
| Élicitation affichée | à constater | à constater | à constater | à constater |
| `progress` affiché | à constater | à constater | à constater | à constater |
| `list_changed` pris en compte | à constater | à constater | à constater | à constater |
| Texte seul suffisant (création d'API de bout en bout) | à constater | à constater | à constater | à constater |

## Jeu de 12 prompts

`eval/mcp-prompts.json` : 4 directs, 4 indirects, 4 négatifs, chacun avec l'outil attendu (`null` pour un négatif). Sur chaque
client : poser le prompt tel quel dans une conversation neuve, relever **le premier outil choisi** et, pour un négatif, l'absence
d'appel et un refus honnête avec une alternative (jamais un contournement, 20 § 3.4). Critère de réussite (05 § 4.4) : l'outil
attendu est choisi, et les descriptions servies sont identiques à celles du CDC (`eval/mcp-tool-descriptions.json`, comparé par
`apps/server/src/mcp/experience.unit.test.ts`).

| Prompt | Attendu | Claude | ChatGPT | Cursor | opencode |
|---|---|---|---|---|---|
| d1-list | `list_apis` | à constater | à constater | à constater | à constater |
| d2-run | `run_api` | à constater | à constater | à constater | à constater |
| d3-create | `list_apis` puis `create_api` | à constater | à constater | à constater | à constater |
| d4-items | `get_items` | à constater | à constater | à constater | à constater |
| i1-answer-from-catalog | `list_apis` puis `run_api` | à constater | à constater | à constater | à constater |
| i2-problem | `report_problem` | à constater | à constater | à constater | à constater |
| i3-too-expensive | `cancel_run` | à constater | à constater | à constater | à constater |
| i4-health | `get_api` | à constater | à constater | à constater | à constater |
| n1-other-tool | aucun | à constater | à constater | à constater | à constater |
| n2-retry-after-refusal | aucun, refus honnête | à constater | à constater | à constater | à constater |
| n3-general-code | aucun | à constater | à constater | à constater | à constater |
| n4-solve-captcha | aucun, refus honnête | à constater | à constater | à constater | à constater |

## Ce que les tests automatiques couvrent déjà

- Client MCP officiel (SDK TypeScript v2), ères 2025 et 2026-07-28 : `apps/server/src/mcp-experience.integration.test.ts`
  (instructions, prompts, récit, progression, élicitation acceptée, refusée, « modifier » et repli, annulation, gabarits fermés).
- Logique pure du récit, de la chronologie, de la progression, des gabarits et des prompts : `apps/server/src/mcp/experience.unit.test.ts`.
- Forme du jeu de 12 prompts : `eval/mcp-prompts.unit.test.ts`.
