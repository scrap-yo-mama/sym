# ADR 0002 : pile d'interface de la console

- Statut : accepté
- Date : 2026-10-01
- Source : `cdc/scrapyomama-runtime/06-specs-interface.md` (« Stack d'interface »), `03-architecture.md` (tâche 3.3)

## Contexte

La console (`apps/web`) est servie par le même service que l'API (08b § 2) : une XSS donnerait accès aux clés et aux
données. Elle doit tenir la CSP `script-src 'self'; style-src 'self'`, respecter WCAG 2.2 AA (06 § 1), parler `en` et `fr`
et ne contenir aucune logique métier (06 § 4.1). Cette tâche pose les fondations ; les écrans viennent en 3.4, 3.5, 3.8
et 3.9.

## Décision

Versions exactes, épinglées dans le catalogue de `pnpm-workspace.yaml` (dernières versions publiées depuis plus de 7 jours
au 2026-10-01, `minimumReleaseAge`).

| Besoin | Choix | Version |
|---|---|---|
| Base | Vue, Vite, `@vitejs/plugin-vue`, vue-router, `vue-tsc` | 3.5.43, 8.3.0, 6.0.9, 5.3.1, 3.3.11 |
| Composants | Reka UI + composants shadcn-vue **copiés** (`apps/web/src/components/ui`) | reka-ui 2.10.5 |
| Style | Tailwind CSS v4 via `@tailwindcss/vite`, variables CSS, `tw-animate-css` | 4.3.3, 4.3.3, 1.4.0 |
| Utilitaires des composants | `class-variance-authority`, `clsx`, `tailwind-merge`, `@vueuse/core` | 0.7.1, 2.1.1, 3.7.0, 14.4.0 |
| i18n | vue-i18n 11, API Composition (`legacy: false`), `en` et `fr`, chargement paresseux | 11.4.12 |
| Client API | `openapi-typescript` (types) + `openapi-fetch` (appels), depuis l'OpenAPI spécifiée | 7.13.0, 0.17.0 |
| SSE | Client maison sur `fetch` (aucune dépendance) | |

Les composants shadcn-vue (MIT) sont ajoutés par `npx shadcn-vue@latest add <composant>` depuis `apps/web` (fichier
`components.json`), puis relus. Une mise à jour du composant est un diff de revue, pas une montée de version. Les
attributions sont dans `NOTICE`. Le code copié garde sa licence : `apps/web/src/components/ui/**` et
`src/lib/utils.ts` portent `SPDX-License-Identifier: MIT` et, en ligne 2, le copyright de shadcn-vue (en commentaire
`<!-- -->` pour un `.vue`). `scripts/spdx-headers.ts` couvre les `.vue` et attend MIT sous ces chemins ; un composant
ajouté reçoit ces deux lignes à la main avant `pnpm spdx:add` (`tests/governance.unit.test.ts`).

### Ce que le spike a vérifié

1. **CSP stricte.** Le HTML produit n'a ni script ni style en ligne : le thème est posé par `public/theme-init.js`
   (fichier externe, synchrone, avant le premier rendu), Vue est compilé à l'avance (build « runtime-only », pas
   d'`eval`), Tailwind produit un fichier CSS, `assetsInlineLimit: 0` interdit les `data:` générés par le build.
   vue-i18n compile ses messages sans `eval` : la console tourne sous la CSP complète de 08b § 2 sans aucune violation
   (vérifié dans Chromium, serveur réel). Règles de garde : aucun `v-html`, `innerHTML` ni bloc `<style>`
   (`console-security.unit.test.ts`, règle ESLint `vue/no-v-html`) ; vérifier, avant d'adopter un composant Reka
   (ScrollArea par exemple), qu'il n'injecte pas de `<style>` en ligne.
2. **Pluriels (question ouverte de 06).** La syntaxe native `un | plusieurs` suffit pour `en` et `fr`, avec une règle
   `fr` maison (0 et 1 au singulier, `frenchPlural`). Weblate et Crowdin ne lisent pas ce format nativement : ils
   travaillent en JSON i18next v4 (suffixes CLDR). Au moment d'ouvrir les langues communautaires (hors V1), un script
   convertira `en.json` vers i18next v4 et inversement ; rien à changer avant.
3. **SSE.** `EventSource` ne permet ni de renvoyer `Last-Event-ID` après une fermeture définitive (401, 503) ni de
   distinguer « reconnexion » d'« arrêt ». Le client maison (`src/lib/sse.ts`) envoie `Last-Event-ID`, dédoublonne par
   identifiant, ne fait avancer la reprise que sur une trame complète, réarme un délai de silence (le serveur envoie un
   ping toutes les 15 à 20 s) et réinitialise tout à l'arrêt (un autre compte ne reçoit pas la position du précédent). Une
   réponse 404 (serveur sans flux) l'arrête sans bandeau ni boucle.
   **Dette, à solder par 3.1** : ce cas 404 ne vaut que tant que le serveur n'enregistre pas `GET /api/events`. Après,
   une 404 trahit un déploiement cassé (routage, reverse proxy) et la console perdrait en silence toute mise à jour en
   direct. `STOP_ON_NOT_FOUND_DEFAULT` (`src/lib/sse.ts`) doit alors passer à `false` : la 404 devient une coupure
   (bandeau, reconnexion). Un test de contrat l'impose dès que la route apparaît dans le registre du serveur.
4. **Client généré.** Les types sont produits par `scripts/gen-openapi-client.ts` depuis
   `packages/client/openapi/openapi.yaml` et committés (`packages/client/src/generated/schema.ts`).
   `assert_openapi_client_in_sync` échoue si le fichier committé diffère de la génération. L'OpenAPI spécifiée décrit
   **toutes** les routes de 05 § 4.2 et 13 § 13.1 (`assert_openapi_specified_covers_cdc`), pour que 3.4, 3.5 et 3.8 aient
   leurs types sans attendre 3.1. Le lien avec le serveur est une **inclusion** et non une égalité
   (`assert_openapi_specified_vs_delivered_drift`) : toute route enregistrée par le serveur (registre INV12) doit être
   spécifiée ; une route spécifiée et pas encore livrée porte `x-pending: '<tâche>'` (3.1, 3.7, 3.12, 2.6 ou 1.10), et
   la tâche qui la livre retire la marque. La tâche 3.6 rejoue ce contrôle contre l'OpenAPI générée par le serveur
   (15 § 6) et exige une liste d'attente vide.
   Écarts assumés, à confirmer par 3.1 : (a) quelques opérations servent un écran de 06 que 05 § 4.2 ne détaille pas
   (« extension de 05 § 4.2 » : liste des runs, journal d'un run, versions de stratégie, diff, retour à une version,
   transitions de statut, boutons **Tester** des réglages) ; (b) les champs des nouvelles routes sont en snake_case comme
   les contrats de 04b et 05, alors que les routes livrées par 0.3b (`/api/me`, `/api/api-keys`, `/api/setup`) sont en
   camelCase : 3.1 tranche pour l'ensemble (renommage des routes 0.3b ou adaptation des nouvelles).
5. **Session.** La sonde d'identité est `GET /api/auth/get-session` (200 avec `null` sans session), puis `GET /api/me`
   seulement si une session existe : un visiteur anonyme ne produit aucune erreur 401 dans la console du navigateur
   (critère « 0 erreur de console » de 06 § 4.3). Le jeton de session ne vit que dans le cookie `HttpOnly` ; l'état de la
   console ne contient ni jeton ni mot de passe.

6. **Connexion puis page vide authentifiée.** Le critère de la ligne 3.3 est rejouable :
   `src/console-session.integration.test.ts` (`assert_console_login_then_empty_authenticated_page`) démarre le vrai
   serveur sur une base migrée et fait passer le client généré, `useSession` et la garde du routeur par `app.inject`
   (cookie tenu comme par un navigateur) : refus du mauvais mot de passe, connexion, `GET /api/me`, page vide, reprise
   de session par le seul cookie, déconnexion. Le même parcours en Chromium revient à la suite E2E (3.6).
7. **Accessibilité (06 § 1).** La gate WCAG 2.2 AA est portée par 3.9 (`assert_a11y_axe_clean`, chaque écran) et
   rejouée par 3.6. Passage ponctuel du 2026-10-01 sur les deux pages livrées : axe-core 4.13.0 (hors dépendances du
   dépôt), tags `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`, Chromium, vrai serveur, build de production ; connexion et
   page vide, thèmes clair et sombre, `en` et `fr` : **0 violation** sur les 8 combinaisons. Seule erreur de console :
   la 404 de `/api/events`, attendue tant que 3.1 n'a pas livré la route (voir le point 3). Les tags axe ne signalent pas
   un titre imbriqué dans un titre : un `<h1>` posé dans le `<h3>` de `CardTitle` (shadcn-vue) a été retiré de la page de
   connexion, et `assert_no_nested_headings` le garde.
8. **Mots interdits (06 § 4.1).** La garde des fichiers de langue reconnaît toutes les formes de « passer » (exceptions
   explicites : « mot de passe », « dépasser »). Le test complet, messages REST et MCP compris, est
   `assert_ui_strings_no_forbidden_words` (3.5).

## Alternatives écartées

PrimeVue 5 et `@n8n/design-system` (licence, accessibilité) : voir l'ADR 0000. `EventSource` : voir ci-dessus.
`@intlify/unplugin-vue-i18n` (précompilation des messages) : inutile tant que le runtime compile sans `eval` ; à
reconsidérer si le poids du runtime i18n devient un sujet. `lucide` (icônes) : prévu par `components.json`, installé avec
les premiers badges de statut (3.4), pas avant.

## Conséquences

- `apps/web` se construit avec `pnpm -r build` (`vue-tsc -p tsconfig.app.json` puis `vite build`) sans dépendre du serveur
  ni de la base : les tests de la console, dont l'intégration qui démarre le serveur, ont leur propre `tsconfig.test.json`,
  vérifié par `pnpm typecheck` (`tsc` pour les paquets, `vue-tsc` pour la console, build des paquets requis).
- Les écrans suivants ajoutent leurs textes aux deux fichiers de langue ; la parité est testée
  (`assert_i18n_key_parity`).
- En production, `server` sert `apps/web/dist` (même origine, repli sur `index.html` pour les routes de la console, CSP et
  en-têtes de 08b § 2) : câblage dans la tâche 4.1 ou 3.1 selon le serveur de fichiers statiques choisi.
- En développement, `pnpm --filter @runtime/web dev` relaie `/api` vers `RUNTIME_API_URL` (défaut
  `http://127.0.0.1:3000`) ; `PUBLIC_URL` du serveur doit alors valoir l'origine de Vite (le contrôle d'`Origin` des
  mutations d'interface, 13 § 5, compare à `PUBLIC_URL`).
