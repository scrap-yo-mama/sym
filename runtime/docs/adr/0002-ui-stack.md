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
attributions sont dans `NOTICE`.

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
4. **Client généré.** Les types sont produits par `scripts/gen-openapi-client.ts` depuis
   `packages/client/openapi/openapi.yaml` (OpenAPI 3.1 spécifiée à partir de 05 § 4.2 et 13) et committés
   (`packages/client/src/generated/schema.ts`). `assert_openapi_client_in_sync` échoue si le fichier committé diffère de la
   génération, et un second test échoue si une route enregistrée par le serveur manque à l'OpenAPI spécifiée. La tâche 3.6
   rejoue le premier contre l'OpenAPI livrée par 3.1.
5. **Session.** La sonde d'identité est `GET /api/auth/get-session` (200 avec `null` sans session), puis `GET /api/me`
   seulement si une session existe : un visiteur anonyme ne produit aucune erreur 401 dans la console du navigateur
   (critère « 0 erreur de console » de 06 § 4.3). Le jeton de session ne vit que dans le cookie `HttpOnly` ; l'état de la
   console ne contient ni jeton ni mot de passe.

## Alternatives écartées

PrimeVue 5 et `@n8n/design-system` (licence, accessibilité) : voir l'ADR 0000. `EventSource` : voir ci-dessus.
`@intlify/unplugin-vue-i18n` (précompilation des messages) : inutile tant que le runtime compile sans `eval` ; à
reconsidérer si le poids du runtime i18n devient un sujet. `lucide` (icônes) : prévu par `components.json`, installé avec
les premiers badges de statut (3.4), pas avant.

## Conséquences

- `apps/web` se construit avec `pnpm -r build` (`vue-tsc` puis `vite build`) et se vérifie avec `pnpm typecheck`
  (`tsc` pour les paquets, `vue-tsc` pour la console).
- Les écrans suivants ajoutent leurs textes aux deux fichiers de langue ; la parité est testée
  (`assert_i18n_key_parity`).
- En production, `server` sert `apps/web/dist` (même origine, repli sur `index.html` pour les routes de la console, CSP et
  en-têtes de 08b § 2) : câblage dans la tâche 4.1 ou 3.1 selon le serveur de fichiers statiques choisi.
- En développement, `pnpm --filter @runtime/web dev` relaie `/api` vers `RUNTIME_API_URL` (défaut
  `http://127.0.0.1:3000`) ; `PUBLIC_URL` du serveur doit alors valoir l'origine de Vite (le contrôle d'`Origin` des
  mutations d'interface, 13 § 5, compare à `PUBLIC_URL`).
