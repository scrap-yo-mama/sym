# ADR 0003 : enquête en direct, « Tous les runs », réglages BYO et panneau « Bloquée » de la console

- Statut : accepté
- Date : 2026-10-01
- Source : `cdc/scrapyomama-runtime/06-specs-interface.md` (§ 2 « Nouvelle API », « Panneau Bloquée », « Tous les runs », « Réglages BYO »), tâche 3.5

## Contexte

La tâche 3.5 construit quatre écrans sur les fondations de 3.3 (ADR 0002) alors que le serveur de 3.1 n'existe pas encore :
l'OpenAPI spécifiée est la seule source de vérité, et les tests tournent contre un faux serveur injecté dans le client généré.
Le flux SSE (`GET /api/events`) n'a pas de contrat de charge : l'OpenAPI ne nomme que les événements.

## Décisions

1. **Routes** : `/apis/new` (formulaire), `/apis/new/:runId` (enquête rouverte, journal rejoué), `/runs`, `/settings/{models,proxies,extension,alerts,diagnostic}`
   (`/settings` renvoie vers `models`). `/apis/new` est statique : il ne se confond pas avec la fiche `/apis/:slug` de 3.4.
2. **Contrat des charges SSE**, lu avec des gardes de type (`src/lib/investigation.ts`, en-tête du fichier ; à confirmer par 3.1) :
   `investigation.started`, `phase.started` (plan d'essais), `schema.proposed`, `attempt.finished` (+ `why`, + `exchange`), `status.changed`,
   `action.required`. Toute charge peut porter `budget` (`spent_usd`, `max_usd`, `elapsed_s`, `timeout_s`, `retained_est_usd`,
   `full_agent_est_usd`). Un événement dont le `run_id` (ou l'API) n'est pas celui suivi est ignoré ; l'application est
   idempotente (identifiant déjà vu, essai remplacé par son `index`), ce qui rend le doublon flux global + rejeu inoffensif.
   `RunAttempt.index` est lu comme la position de l'essai à partir de 0 (affichage : index + 1).
   `exchange` porte la **carte requête/réponse** de la colonne « Ce que voit l'agent » (06 § 2) :
   `{ request: { method, url }, response?: { status?, content_type?, bytes? } }`, sans en-tête, cookie ni corps (INV8). La
   console n'en garde que la méthode (liste fermée), l'origine et le chemin de l'URL (ni requête ni fragment, http(s) seulement),
   le statut, le type de média sans paramètres et la taille ; sans `exchange`, la carte n'est pas affichée. 3.1 émet ce champ.
3. **Un seul flux par onglet** : l'enquête suit le flux global ; les événements arrivés avant la réponse de création sont mis en
   tampon (500 au plus) puis appliqués. Le flux filtré `GET /api/runs/{id}/events` ne sert qu'à **rejouer** le journal depuis le
   début à la réouverture, puis il est fermé à la fin de l'enquête.
4. **Extensions de l'OpenAPI** (marquées `x-pending: '3.1'`, client régénéré) : `POST /api/runs/{id}/pause` (06 § 2 offre Pause,
   05 ne nomme que `cancel` et `resume`) et `exclude_executions` dans `ValidateSchemaRequest` (plan d'essais restreignable avant
   exécution, même champ que `InvestigateRequest`). L'état « en pause » n'est pas un `RunState` : il est porté par
   `Run.paused_at` (date de la pause, null hors pause, remis à null par `resume` ; même marque `x-pending: '3.1'`), que la
   console relit à la réouverture d'une enquête : la pause survit au rechargement de la page. Ces trois ajouts sont à reporter
   dans 05 § 4.2 et à confier explicitement à 3.1 (mise à jour du CDC, hors du dépôt de code).
5. **Avertissement A11** : confirmé avant la création si l'utilisateur déclare un site à compte, ou si le serveur répond
   `account_site_ack_required` (code proposé, à confirmer par 3.1) ; la requête porte alors `account_site_acknowledged: true`.
   Choisir le tunnel dans la politique réseau n'impose pas l'avertissement (réglage neutre).
6. **Panneau « Bloquée »** (A7) : composant présentationnel sans routeur, sans proxy et sans mot « tunnel » ; seuls contrôles :
   Ré-enquêter, Voir les essais, copier le modèle de demande d'accès, « Pourquoi cet arrêt ? » (page « Usage responsable » du site
   de documentation, tâche 4.8 : `/docs/responsible-use/` en attendant) et la voie officielle quand le rapport d'accès la
   donne (lien http(s) seulement). Le texte du CDC « Ce qui s'est passé » devient « Ce qui est arrivé » : le test de chaîne
   interdit « passé » (forme de « passer »).
   Défi en tunnel (`challenge_in_tunnel`) : 06 § 4.2 dit « Le run est en pause » et « Reprendre », alors que 04 § 2 (« un
   défi détecté arrête le run »), 06 § 2 (« le run est arrêté », « Réessayer plus tard (nouveau run) », « Aucune reprise
   automatique ») et `packages/core` disent « arrêté ». La console retient **« Le run est arrêté ; réessaie plus tard »** et
   ne suggère aucune reprise ; 06 § 4.2 est à aligner.
7. **Textes** : `reason.*` (06 § 4.2, avec paramètres) pour les `{ code, params }` du serveur, `reasonShort.*` pour les listes
   (les raisons d'un run n'ont pas de paramètres), `failure.*` pour les classes d'échec. Un code inconnu retombe sur
   « Raison : {code} », jamais sur une page blanche.
8. **Tests sans navigateur** : rendu SSR (`renderToString`) avec un faux serveur REST ; les vues chargent leurs données dans
   `onServerPrefetch` en plus de `onMounted`. Les clics sont testés au niveau des composables (état et requêtes), pas du DOM ;
   le parcours cliquable est la suite E2E de 3.6.

## Hors de cette tâche

Suites à inscrire dans 10-taches avant 3.6 (mise à jour du CDC, hors du dépôt de code) ; les deux premiers écrans de 06 § 2 ne
sont confiés à aucune tâche :

- **Identité du robot** (06 § 2, Réglages BYO) : aucune route spécifiée ne porte le jeton produit ni le contact d'instance.
  Suite proposée : route `GET/PUT /api/settings/identity` livrée par 3.1, puis l'écran `/settings/identity` (tâche de console
  après 3.1, par exemple 3.4 ou une tâche nouvelle).
- **Détail d'un run** (deux panneaux, cascade d'essais, onglet Erreur, Pause et Arrêter ; critère `assert_run_detail_error_open`
  de 06 § 4.3, suivi en `test.todo`) : ni 3.4 ni 3.5 ne le portent dans le tableau de 10-taches. Suite proposée : 3.4 (onglet
  Enquêtes de la fiche d'API) ou une tâche nouvelle. En attendant, les lignes de « Tous les runs » renvoient vers la fiche de l'API
  (`/apis/:slug`), elle-même livrée par 3.4.
- **Aperçu de page (E3+)** de la première colonne : l'`<iframe sandbox>` sans `allow-same-origin` est prévue en 3.4. La carte
  requête/réponse, elle, est affichée dès que le flux porte `exchange` (décision 2), sous le dernier essai (méthode,
  réseau, résultat, coût, durée).
- **Essai visible en < 2 s en Chromium** : 3.5 le vérifie sans navigateur (vrai client SSE, rendu du tableau) ; la mesure
  Playwright (`attempt.finished` émis → `[data-testid=attempt]` visible < 2 s) est un `test.todo` confié à 3.6, à inscrire
  aussi dans les critères de 3.6 de 10-taches.
- **Éditeur JSON** : un `<textarea>` valide l'objet JSON ; CodeMirror (06, « Stack d'interface ») viendra avec l'onglet Schémas de 3.4.
