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
   `investigation.started`, `phase.started` (plan d'essais), `schema.proposed`, `attempt.finished` (+ `why`), `status.changed`,
   `action.required`. Toute charge peut porter `budget` (`spent_usd`, `max_usd`, `elapsed_s`, `timeout_s`, `retained_est_usd`,
   `full_agent_est_usd`). Un événement dont le `run_id` (ou l'API) n'est pas celui suivi est ignoré ; l'application est
   idempotente (identifiant déjà vu, essai remplacé par son `index`), ce qui rend le doublon flux global + rejeu inoffensif.
   `RunAttempt.index` est lu comme la position de l'essai à partir de 0 (affichage : index + 1).
3. **Un seul flux par onglet** : l'enquête suit le flux global ; les événements arrivés avant la réponse de création sont mis en
   tampon (500 au plus) puis appliqués. Le flux filtré `GET /api/runs/{id}/events` ne sert qu'à **rejouer** le journal depuis le
   début à la réouverture, puis il est fermé à la fin de l'enquête.
4. **Extensions de l'OpenAPI** (marquées `x-pending: '3.1'`, client régénéré) : `POST /api/runs/{id}/pause` (06 § 2 offre Pause,
   05 ne nomme que `cancel` et `resume`) et `exclude_executions` dans `ValidateSchemaRequest` (plan d'essais restreignable avant
   exécution, même champ que `InvestigateRequest`). L'état « en pause » n'est pas un `RunState` : la console le garde localement.
5. **Avertissement A11** : confirmé avant la création si l'utilisateur déclare un site à compte, ou si le serveur répond
   `account_site_ack_required` (code proposé, à confirmer par 3.1) ; la requête porte alors `account_site_acknowledged: true`.
   Choisir le tunnel dans la politique réseau n'impose pas l'avertissement (réglage neutre).
6. **Panneau « Bloquée »** (A7) : composant présentationnel sans routeur, sans proxy et sans mot « tunnel » ; seuls contrôles :
   Ré-enquêter, Voir les essais, copier le modèle de demande d'accès, « Pourquoi cet arrêt ? » (page « Usage responsable » du site
   de documentation, tâche 4.8 : `/docs/responsible-use/` en attendant) et la voie officielle quand le rapport d'accès la
   donne (lien http(s) seulement). Le texte du CDC « Ce qui s'est passé » devient « Ce qui est arrivé » : le test de chaîne
   interdit « passé » (forme de « passer »).
7. **Textes** : `reason.*` (06 § 4.2, avec paramètres) pour les `{ code, params }` du serveur, `reasonShort.*` pour les listes
   (les raisons d'un run n'ont pas de paramètres), `failure.*` pour les classes d'échec. Un code inconnu retombe sur
   « Raison : {code} », jamais sur une page blanche.
8. **Tests sans navigateur** : rendu SSR (`renderToString`) avec un faux serveur REST ; les vues chargent leurs données dans
   `onServerPrefetch` en plus de `onMounted`. Les clics sont testés au niveau des composables (état et requêtes), pas du DOM ;
   le parcours cliquable est la suite E2E de 3.6.

## Hors de cette tâche

- **Identité du robot** (06 § 2, Réglages) : aucune route spécifiée ne porte le jeton produit ni le contact d'instance ; l'écran
  attend une route de 3.1.
- **Détail d'un run** (cascade d'essais, onglet Erreur) : ni 3.4 ni 3.5 ne le portent dans le tableau de 10-taches ; les lignes de
  « Tous les runs » renvoient vers la fiche de l'API.
- **Aperçu de page (E3+)** de la première colonne : l'`<iframe sandbox>` sans `allow-same-origin` est prévue en 3.4 ; la colonne
  montre le dernier essai (méthode, réseau, résultat, coût, durée).
- **Éditeur JSON** : un `<textarea>` valide l'objet JSON ; CodeMirror (06, « Stack d'interface ») viendra avec l'onglet Schémas de 3.4.
