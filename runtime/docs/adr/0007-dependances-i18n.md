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

## Écarts assumés par rapport à 21 (décisions explicites, vérification de 3.20)

La vérification de 3.20 a relevé deux écarts justifiés par une seule ligne. Ils sont tranchés ici, au titre de D-21, au plus près
du CDC ; le journal d'exécution (`cdc/…/.executed/journal.md`, hors de ce dépôt de code) doit en reprendre une entrée D-*.

### É1 — Console sans précompilation des messages (21 § 2 : « messages précompilés par `@intlify/unplugin-vue-i18n` »)

- **Décision** : la console garde la compilation à la volée (JIT) de vue-i18n 11 ; `@intlify/unplugin-vue-i18n` n'est pas ajouté
  en V1.
- **Pourquoi** : (1) le compilateur JIT de vue-i18n 11 n'emploie ni `eval` ni `new Function` : la console tourne sous sa CSP
  stricte sans `unsafe-eval`, ce que garde `assert_no_csp_violation` (E2E, chaque écran) ; (2) la pseudo-locale `qps-ploc`
  (21 § 9) est générée EN MÉMOIRE depuis `en.json` et doit être compilée à l'exécution : une construction « runtime only » la
  casserait ; (3) une 3e langue s'ajoute par fichiers seuls (M14) : `import.meta.glob` les découvre sans réglage de plugin.
- **Ce qui reste garanti** : syntaxe des messages contrôlée au lint (`valid-message-syntax`, bloquant), clés manquantes (lint
  `no-missing-keys` et gestionnaire `missing` qui lève en DEV et en E2E), aucun HTML dans un message.
- **Extension (3.18)** : sous la CSP MV3, l'extension décide pour son propre build ; si sa CSP refuse la compilation à la volée,
  3.18 ajoute `@intlify/unplugin-vue-i18n` à SON build (dépendance déjà acceptée par 21 § 2), sans toucher la console.
- **Rouvrable** : si une mesure montre un coût de démarrage notable, ajouter le plugin à la console (même dépendance).

### É2 — Choix de langue d'avant connexion en `localStorage` (21b § 2 : source `cookie` `sym_locale`)

- **Décision** : la console mémorise le choix fait avant connexion dans `localStorage` (clé `runtime.locale`), pas dans un cookie
  `sym_locale`. La source `cookie` reste dans `resolveLocale` (surface `prelogin`) pour un rendu serveur futur.
- **Pourquoi** : la console est une application monopage sans rendu serveur des pages d'avant connexion : le choix ne sert qu'au
  navigateur. Un cookie partirait avec chaque requête (y compris `/api/*`) sans usage côté serveur, et ajouterait un cookie non
  essentiel à l'inventaire (bandeau, RGPD) ; `localStorage` ne quitte pas le navigateur (INV9). Après connexion, la langue du
  COMPTE gagne (`users.locale`, 21 § 3) et le choix suit la personne d'un navigateur à l'autre.
- **Ce qui reste garanti** : messages REST d'avant connexion dans la langue d'`Accept-Language` (`Content-Language`, `Vary`),
  `assert_locale_resolution_order` couvre la ligne `cookie` de la table.

## Conséquences

- Toute nouvelle dépendance i18n hors de cette liste repasse par « Demander d'abord ».
- L'utilisateur peut revenir sur cet accord : retirer `@intlify/eslint-plugin-vue-i18n` ne touche que le lint ; retirer
  `@intlify/core-base` imposerait un moteur de rendu maison dans `packages/i18n`.
