# ADR 0007 : dépendances du paquet de langues commun (tâche 3.20)

- Statut : accepté
- Date : 2026-10-02
- Source : `cdc/scrapyomama-runtime/21b-contrats-multilingue.md` (§ 6, garde-fous de 3.20 : « Demander d'abord »), décision D-21
  du journal d'exécution (autonomie accordée par l'utilisateur : « prends toutes les décisions »), relance du 2026-10-02
  (« accélère tout »)

## Contexte

21b § 6 range quatre dépendances hors de la stack de 03 sous « Demander d'abord » : `@intlify/core-base`,
`@intlify/unplugin-vue-i18n`, `@intlify/eslint-plugin-vue-i18n` et `@formatjs/intl-localematcher`. La tâche 3.20 en ajoute deux
au catalogue de `pnpm-workspace.yaml`. La vérification de 3.20 a relevé qu'aucune trace d'accord n'était consignée.

## Décision

Accord consigné ici, au titre de l'autonomie D-21 (toutes les décisions d'exécution déléguées à l'orchestrateur), pour les deux
dépendances effectivement ajoutées :

| Dépendance | Version | Licence | Usage | Pourquoi |
|---|---|---|---|---|
| `@intlify/core-base` | 11.4.12 | MIT | `packages/i18n/src/render.ts` : rendu serveur (REST, MCP, e-mails, CLI) | Déjà dans l'arbre (dépendance de vue-i18n, même version exacte) : aucun code nouveau téléchargé ; même syntaxe de messages que la console (u6 R3) |
| `@intlify/eslint-plugin-vue-i18n` | 4.5.1 | MIT | `eslint.config.mjs` : syntaxe des messages, pluriels, clés manquantes, `v-html` | Outil de développement seulement (rien dans l'image) ; publiée le 2026-06-02 (plus de 7 jours, `minimumReleaseAge`) |

Les deux autres ne sont PAS ajoutées : `@intlify/unplugin-vue-i18n` (la console charge les catalogues par `import.meta.glob`,
sans précompilation) et `@formatjs/intl-localematcher` (la négociation `Accept-Language` est écrite dans
`packages/i18n/src/resolve.ts`, sans dépendance).

Contrôles : `pnpm check:licenses`, `pnpm check:blacklist` et `pnpm check:deps-pinned` verts (`pnpm ci:local`).

## Conséquences

- Toute nouvelle dépendance i18n hors de cette liste repasse par « Demander d'abord ».
- L'utilisateur peut revenir sur cet accord : retirer `@intlify/eslint-plugin-vue-i18n` ne touche que le lint ; retirer
  `@intlify/core-base` imposerait un moteur de rendu maison dans `packages/i18n`.
