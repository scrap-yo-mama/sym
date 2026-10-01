# ADR 0004 : catalogue et fiche d'une API

- Statut : accepté
- Date : 2026-10-01
- Source : `cdc/scrapyomama-runtime/06-specs-interface.md` (§ 2 « Statut et raison », « Catalogue », « Fiche API », « Panneau
  Bloquée », « Action requise » ; § 3 ; § 4.3), tâche 3.4

## Contexte

La tâche 3.3 a posé les fondations de la console (ADR 0002). La tâche 3.4 livre le catalogue et la fiche d'une API avec
ses huit onglets. Les routes REST que ces écrans lisent sont dans l'OpenAPI spécifiée, encore marquées `x-pending: '3.1'`
côté serveur : la console s'appuie sur le contrat (client généré) et ses tests passent par un serveur factice.

## Décision

### Routes et organisation

| Chemin | Écran |
|---|---|
| `/apis` | Catalogue (`ApiCatalogView`) |
| `/apis/:slug` et `/apis/:slug/:onglet` | Fiche (`ApiDetailView`, contenu dans `ApiDetailPage`) ; onglets `overview`, `schemas`, `strategy`, `runs`, `status`, `schedules`, `access`, `investigations` |
| `/apis/:slug/investigations?run=<id>` | Onglet Enquêtes ouvert sur l'enquête ou la réparation qui a produit une version |

Les routes statiques sous `/apis/` (par exemple `/apis/new`, tâche 3.5) l'emportent sur le paramètre `:slug`. Les liens
vers des écrans d'autres tâches sont des chemins : `/runs/:id` (détail d'un run), `/settings/models`, `/settings/proxies`,
`/settings/extension` (réglages), `/responsible-use` (page « Usage responsable », 17 § 9, tâche 4.8, ouverte dans un autre
onglet). Tant que le routeur de la console ne connaît pas `/responsible-use`, le lien « Pourquoi cet arrêt ? » du panneau
Bloquée n'est pas affiché (il ouvrirait la page 404) ; il apparaît dès que la route existe. **À reprendre à la fusion de
4.8** : si la page reste dans le site de doc (VitePress) sans route dans la console, le lien pointera vers l'URL du site.

Composables (modèle `use{Entity}` : `data`, `loading`, `error`, `refetch`) : `useAsyncResource` (un seul appel utile à la
fois, `silent` pour une relecture sans clignotement), `usePagedList` (curseur serveur, « Charger la suite »),
`useLiveRefresh` (relecture périodique et sur événement SSE), `useApiCatalog`, `useApiDetail`, `useStrategyVersions`,
`useApiRuns`, `useStatusEvents`, `useSchedules`, `useApiActions`, `useInvestigationReplay`, `useReplayPlayer`.

### Statut, raison, drapeau `stale`

- Le statut est une icône de forme distincte + un libellé ; la raison est un paragraphe de texte sur sa propre ligne,
  sans info-bulle ni région repliée (`assert_reason_visible_without_hover`, `assert_status_not_color_only`).
- `stale` est un drapeau : la pastille s'ajoute à `sain` et `warning` seulement (`assert_stale_is_flag`).
- « Action requise » : la colonne Statut du catalogue affiche le titre de la tâche (`actionRequired.<cause>.title`, par
  exemple « Connecte monsite.com »), le même verbe et les mêmes paramètres que le bandeau de la fiche
  (`actionTitleParams`, `assert_action_verb_same_in_banner_and_catalog`). L'en-tête de la fiche garde la phrase de la
  raison (« La session de … a expiré. »), le bandeau portant déjà le titre.
- La raison est un code stable + paramètres (`ReasonMessage`), traduit par `reasons.<code>`. Un code inconnu ou absent
  retombe sur `statusDefault.<statut>`, jamais sur le code brut. Codes ajoutés à la table de 06 § 4.2 pour couvrir les
  exemples de raison de § 2 et les causes d'action requise sans code nommé : `investigating`, `healthy`, `repairing`,
  `repair_exhausted`, `proxy_not_configured`, `tunnel_offline`, `not_found` (`EXTRA_REASON_CODES`). La parité avec la table
  du CDC est testée (`assert_reason_codes_stable`) contre une liste figée et versionnée
  (`apps/web/src/testing/spec-reason-codes.json`, ordre de la table) : le CDC n'est pas dans le dépôt (absent en CI et
  dans un worktree). Quand le CDC est disponible (arbre principal, ou `SCRAPYOMAMA_CDC_DIR`), un second test vérifie que la
  liste figée suit la table ; sinon ce test est marqué sauté, jamais vert sans rien vérifier.

### Contrat attendu du serveur (à confirmer par 3.1)

Ces points ne sont pas dans l'OpenAPI : la console les lit de façon tolérante (champ absent = texte générique).

1. Paramètres de `status_reason` pour `bloquee` : `domain`, `at` (date-heure), `attempt` (entier), `execution`, `network`,
   `kind` (`challenge` ou `refusal`), `cost_usd`, `run_id`. Pour `action_requise` : `domain`, `country`, `offer`,
   `platform`. Les codes d'exécution et de réseau sont traduits par la console.
2. Phrases de diff (`StrategyDiff.summary.code`) : `selector_changed` (`field`), `pagination_changed`,
   `execution_changed` (`from`, `to`), `network_changed` (`from`, `to`), `fields_changed` (`n`), `script_changed`,
   `no_change` ; tout autre code donne « des champs ont changé (n) ».
3. Événements de `GET /api/events` : la console relit la fiche ou le catalogue à chaque `status.changed`, `action.required`
   (et, pour la fiche, les événements d'enquête), sans interpréter la charge ; une charge qui porte `api_slug` ou `slug`
   (au premier niveau ou dans `payload`) n'est relue que par la fiche de cette API.
4. Événements du replay (`GET /api/runs/{id}/events`) : trame `event:` = nom ; `data:` = `{ seq, at, payload }`, charge
   à valeurs scalaires (`phase`, `n`, `execution`, `network`, `result`, `robots`, `to`). Phrases : `replay.kinds.<nom>` où
   les points deviennent des tirets bas (`phase_started`) ; nom inconnu : « Événement <nom> ».

### Écarts avec la pile de 06 (« Stack d'interface »)

- **Pas de CodeMirror** (éditeur JSON, diff de script). CodeMirror 6 injecte des éléments `<style>` à l'exécution
  (style-mod) : la CSP `style-src 'self'` de 08b § 2 les refuse, sauf nonce que le serveur ne pose pas. Le schéma de sortie
  et l'entrée JSON de Lancer sont édités dans un `<textarea>` (validation JSON locale, confirmation avant ré-enquête),
  l'arbre en lecture est un composant maison (`JsonTree`, `<details>` natifs).
- **Pas de `jsondiffpatch`** : le serveur calcule la phrase et le tableau des champs (`StrategyDiff`). Le diff brut côte à
  côte est une plus longue sous-suite commune sur les lignes du JSON (`lib/line-diff.ts`, 100 lignes, sans dépendance).
- **Pas de TanStack Table** : le catalogue est un `<table>` sémantique à pagination serveur sans virtualisation (06 :
  « sans virtualisation ») ; le journal virtualisé reste à faire avec le journal de run (3.5).
- **`cronstrue` 3.27.0** (MIT, sans dépendance, publiée le 2026-09-15) pour l'aide cron des planifications, chargé à la
  demande (`import('cronstrue/i18n')`, un fragment séparé). ctx7 n'indexe pas ce paquet : API vérifiée dans le README et
  les types du paquet (`toString(expression, { locale, throwExceptionOnParseError })`).
- **Client SSE** (`src/lib/sse.ts`) : option `stopOnEnd` (défaut `false`, comportement de 3.3 inchangé). Le replay d'une enquête
  terminée est une réponse finie : sans l'option, le client reconnecterait en boucle ; avec elle, une réponse qui se termine
  proprement arrête la lecture (une coupure réseau reconnecte toujours).
- **Un second flux SSE pendant le replay** (écart avec « un seul flux SSE par onglet », 06 § 3). Le replay de l'onglet
  Enquêtes lit `GET /api/runs/{id}/events` (la « vue filtrée du même flux » de 06 § 3) dans son propre client, en plus du
  flux `GET /api/events` de l'onglet : l'OpenAPI ne définit aucun abonnement à une enquête sur `/api/events`, et seule la
  vue filtrée rejoue depuis le début. Ce second flux n'existe que pendant une lecture (fermé en quittant l'onglet ou en
  changeant d'enquête) et compte dans le plafond de flux par utilisateur que 3.1 posera. Une enquête terminée est lue
  avec `stopOnEnd` (réponse finie, pas de reconnexion) ; une enquête en cours est suivie sans `stopOnEnd` (une fin propre,
  au redémarrage du serveur, reconnecte avec `Last-Event-ID`) jusqu'à ce que la fiche la montre terminée, puis la fin de
  réponse suivante arrête la lecture (`stopAtEnd`). **À reprendre avec 3.1** : si `/api/events` accepte un abonnement à
  une enquête avec rejeu, le replay passera par le flux de l'onglet.
- **Revenir à cette version** : le panneau de confirmation montre l'aperçu (diff à trois niveaux de la version courante
  vers la version visée, `useRevertPreview`, distinct du comparateur) puis la conséquence ; si l'aperçu ne se charge pas,
  la conséquence reste lisible et la confirmation possible.
- Graphique des statuts sur 30 jours (« priorité basse », onglet Vue d'ensemble) : non livré.

### Textes

« Ce qui s'est passé », titre d'une des trois parties du panneau Bloquée dans 06 § 2, devient « Ce qui s'est produit » : la
garde `fichiers de langue` (06 § 4.1, toutes les formes de « passer ») refuse « passé ». Même raison pour « l'API passe en… »
des aperçus de conséquence, remplacé par « devient » et « repart en ».

## Conséquences

- Les espaces de noms de textes de cette tâche (`catalog`, `detail`, `blockedPanel`, `runsTab`, `apiErrors`, `ui`,
  `reasons`, `reasonLabel`…) sont distincts de ceux de la tâche 3.5 (`runs`, `errors`, `common`, `reason`, `investigation`…) ;
  `execution` et `network` (libellés E1 à E6 et modes réseau) sont communs, à unifier à la fusion.
- Le panneau « Bloquée » de la fiche est `components/api/BlockedPanel.vue` ; la tâche 3.5 a le sien pour le détail d'un run.
  Ils partagent la règle (aucun bouton ni lien vers le tunnel, A7) ; une extraction commune est possible après la fusion.
- `assert_no_robots_override_ui` balaye tout le code de la console : les réglages de 3.5 sont couverts dès leur fusion.
- Vérifié dans Chromium (serveur factice, build de production, CSP exacte de 08b § 2) : 0 violation de CSP, 0 erreur ni
  avertissement de console sur le catalogue, la fiche, les huit onglets, le bandeau « Reprise de l'enquête… » reçu par SSE
  sans rechargement et le replay. Le parcours E2E contre le vrai serveur revient à 3.6, la gate axe à 3.9.
