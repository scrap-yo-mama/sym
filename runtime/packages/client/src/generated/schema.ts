// SPDX-License-Identifier: MIT
// Fichier généré par `pnpm gen:openapi` (scripts/gen-openapi-client.ts) : ne pas modifier à la main.
export interface paths {
    "/api/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Santé du processus (joignable avant l'initialisation) */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Disponibilité (version de schéma, base) et état d'initialisation */
        get: operations["getReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/setup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Assistant de premier démarrage (13 § 4), répond 404 pour toujours une fois l'owner créé */
        post: operations["postSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/sign-in/email": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Connexion par e-mail et mot de passe (cookie de session HttpOnly) */
        post: operations["postSignIn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/sign-out": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Déconnexion */
        post: operations["postSignOut"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/get-session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Session d'interface courante (null sans session) */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/two-factor/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Second facteur d'une session en attente (code TOTP ou code de secours) ; remplace la session (nouveau jeton, 13 § 7) */
        post: operations["verifyTwoFactor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/password-reset/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mot de passe oublié (avec SMTP) ; réponse identique que le compte existe ou non (13 § 4) */
        post: operations["requestPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/password-reset/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Nouveau mot de passe par lien à usage unique ; second facteur exigé si le compte en a un ; révoque sessions, clés, jetons et cookies */
        post: operations["resetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/oidc/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Redirige vers le fournisseur OIDC de l'instance (PKCE S256, state et nonce liés au navigateur) ; connexion ou acceptation d'invitation, jamais liaison */
        get: operations["startOidc"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/oidc/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Retour du fournisseur OIDC ; identité = (issuer, sub), jamais l'e-mail */
        get: operations["oidcCallback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Identité de l'appelant, relue en base */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Langue, fuseau et thème du compte (session d'interface seulement) */
        patch: operations["updateMe"];
        trace?: never;
    };
    "/api/api-keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Clés d'API de l'appelant (session d'interface seulement) */
        get: operations["listApiKeys"];
        put?: never;
        /** Crée une clé (ré-authentification, voir `CurrentPassword`) ; le secret n'apparaît qu'ici */
        post: operations["createApiKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/api-keys/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Révoque une clé de l'appelant (404 pour la clé d'autrui) */
        delete: operations["revokeApiKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Flux SSE multiplexé, un seul par onglet (06 § 3)
         * @description Trames `id:`, `event:`, `data:` (JSON), commentaire `: ping` toutes les 15 à 20 s. Reprise par l'en-tête `Last-Event-ID` sur des événements persistés : la console le renvoie à chaque reconnexion et ignore tout événement dont l'identifiant a déjà été vu. Les noms d'événements sont définis avec le serveur (tâche 3.1).
         */
        get: operations["streamEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Version de l'instance et du schéma (14 § 3), sans version de dépendance ni nom d'hôte */
        get: operations["getVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Métriques Prometheus (14 § 3), fermées sans METRICS_TOKEN */
        get: operations["getMetrics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/oauth-protected-resource": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Métadonnées de ressource protégée (RFC 9728, 13 § 11) */
        get: operations["getProtectedResourceMetadata"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** OpenAPI 3.1 livrée par le serveur (05 § 2) ; comparée à ce fichier par le test de dérive (15 § 6, tâche 3.6) */
        get: operations["getOpenApi"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sso": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Connexion SSO proposée sur la page de connexion (public, sans secret) */
        get: operations["getSsoInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Catalogue (= list_apis), pagination serveur, filtres par statut, exécution et réseau, recherche (06 § 2) */
        get: operations["listApis"];
        put?: never;
        /** Crée une API (= create_api) ; lance l'enquête, rapport d'accès en étape 0 (17 § 2) */
        post: operations["createApi"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Importe une API exportée (16 § 6) ; aperçu sans écriture, puis confirm=true ; repasse toujours par l'enquête
         * @description Sans `confirm=true` : aperçu (200), rien n'est écrit. Avec `confirm=true` : nouvelle API privée en `enquete`, enquête en file au stade `access_check` (rapport d'accès) puis `testing` de la stratégie importée (`created_by: import`) ; planifications recréées désactivées, cibles d'alerte à configurer. Les champs inconnus sont ignorés (`ignored_fields`) ; un `$ref` distant (400 `remote_ref`), une empreinte fausse (400 `integrity_mismatch`) ou une version de format d'une autre majeure (400 `unsupported_format`) sont refusés. Un `max_cost_usd` ou un `budget_daily_usd` du fichier au-dessus des plafonds de l'instance (`MAX_COST_USD_PER_RUN`, `USER_BUDGET_DAILY_USD`) est refusé de même (400 `cost_cap_exceeded`), aperçu compris.
         */
        post: operations["importApi"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{id}/validate-schema": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Valide (ou corrige) le schéma de sortie proposé (= validate_schema) */
        post: operations["validateSchema"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fiche d'une API (= get_api) ; métadonnées seules pour l'admin sur une API avec session d'autrui */
        get: operations["getApi"];
        put?: never;
        post?: never;
        /**
         * Supprime une API
         * @description Supprime l'API, ses versions et les runs, datasets et planifications de son propriétaire. `409 runs_active` tant qu'un run est actif ; `409 api_in_use_by_others` si un autre membre a un run, un dataset ou une planification sur cette API `instance` (ses données ne partent jamais avec l'API d'autrui, INV12).
         */
        delete: operations["deleteApi"];
        options?: never;
        head?: never;
        /**
         * Modifie description, politiques, schémas (→ ré-enquête), exposition MCP
         * @description Mode « SYM ne lâche pas » (`persistence_mode`, `persistence_budget_usd`, D-49) : décidé avant tout autre champ ; refusé, rien n'est écrit. Activer (ou changer le plafond d'un mode actif) par une clé d'API : `403 human_confirmation_required` ; API sans version courante, mémoire des refus absente ou plafond effectif ≤ 0 : `409 persistence_not_eligible` (`reason`) ; les deux avec `what_to_do`. Désactiver est permis à toute clé. Un `max_cost_usd` ou un `budget_daily_usd` au-dessus des plafonds de l'instance (`MAX_COST_USD_PER_RUN`, `USER_BUDGET_DAILY_USD`) : `400 cost_cap_exceeded`.
         */
        patch: operations["updateApi"];
        trace?: never;
    };
    "/api/apis/{slug}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lance un run (= run_api) ; synchrone jusqu'à `wait` secondes, sinon run à suivre (05 § 4.3) */
        post: operations["runApi"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/investigate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ré-enquête manuelle (transitions 17 et 18) ; seule reprise offerte à une API `bloquee`
         * @description La transition et l'enquête partent au même COMMIT : une enquête refusée (demande illisible, file pleine) laisse l'API dans son statut. Une API `bloquee` ne repart que par un geste humain dans la console (transition 18, 04 § 6) : par une clé d'API, `403 human_confirmation_required`, sans transition ni run.
         */
        post: operations["reinvestigateApi"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Export JSON d'une API, sans secret ni session (16 § 6, assert_export_no_secret) ; propriétaire seulement */
        get: operations["exportApi"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** OpenAPI propre à une API (05 § 2, 16 § 6) - schémas d'entrée et de sortie, section webhooks */
        get: operations["getApiOpenApi"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Versions de stratégie (onglet « Stratégie & versions », 06 § 2) ; extension de 05 § 4.2 */
        get: operations["listStrategyVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Une version de stratégie, spécification déclarative ou référence de script (lecture seule) */
        get: operations["getStrategyVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/versions/{version}/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Diff à trois niveaux (phrase en code stable, champs modifiés, brut) entre deux versions (06 § 2) */
        get: operations["diffStrategyVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/versions/{version}/revert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revient à cette version (l'API bascule en `warning`, raison `reverted`, transitions 7 ou 8)
         * @description Seule une version qui a été courante se rétablit (400 `version_not_revertable`) ; version courante et transition sont écrites dans la même transaction (INV3).
         */
        post: operations["revertStrategyVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/instructed-steps/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirme les étapes instruites affichées (acte humain, session console seulement)
         * @description Confirme les étapes instruites de la version `version` dont l'empreinte est `sha256` (celles que la console a affichées). Hors session de console (clé d'API, outil MCP) : `403 human_confirmation_required`. Étapes changées depuis l'affichage : `409 sha_mismatch`. Version sans étapes instruites : `409 no_instructed_steps`.
         */
        post: operations["confirmInstructedSteps"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/instructed-mode": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Active ou désactive le mode « agent instruit » (opt-in explicite, jamais par défaut)
         * @description L'activation exige une API non compilable dont les étapes instruites EXACTES sont confirmées ; sinon `409` et `instructed_mode` reste faux : `instructed_steps_unconfirmed`, `compilable` (une stratégie rejouable sans agent existe) ou `no_instructed_steps`. La désactivation est toujours acceptée.
         */
        put: operations["setInstructedMode"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/resolved-rules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Aperçu de l'ensemble de règles résolu pour l'API (19 § 2, 19b § 2, tâche 2.10) ; propriétaire seul, 404 sinon */
        get: operations["getResolvedRules"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/brief": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Indices du dossier d'enquête de l'API (état, raison, coût, version ; 19c § 7) ; propriétaire seulement, aucun texte du dossier */
        get: operations["getApiBrief"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/status-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Chronologie des transitions de statut (onglet « Bugs & statut », 06 § 2) ; extension de 05 § 4.2 */
        get: operations["listStatusEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/schedules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Planifications d'une API (08 § 5) */
        get: operations["listSchedules"];
        put?: never;
        /** Crée une planification (fréquence minimale 1 minute) */
        post: operations["createSchedule"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apis/{slug}/schedules/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Une planification, avec ses prochaines exécutions calculées côté serveur */
        get: operations["getSchedule"];
        put?: never;
        post?: never;
        /** Supprime une planification */
        delete: operations["deleteSchedule"];
        options?: never;
        head?: never;
        /** Modifie une planification (dont la suspension) */
        patch: operations["updateSchedule"];
        trace?: never;
    };
    "/api/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** « Tous les runs » et historique d'une API, filtrables, pagination serveur (06 § 2) ; extension de 05 § 4.2 */
        get: operations["listRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Un run (= get_run) ; l'admin n'obtient que les métadonnées d'un run avec session d'autrui */
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Arrête un run ou une enquête (= cancel_run), essais et coûts engagés conservés */
        post: operations["cancelRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Met en pause une enquête ou un run en cours (action de l'utilisateur) ; essais et coûts engagés conservés, reprise par `resume` */
        post: operations["pauseRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reprend un run en pause (action de l'utilisateur ; jamais en réponse à une vérification) */
        post: operations["resumeRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Vue filtrée du flux SSE pour un run ou une enquête, rejouée depuis `investigation_events`
         * @description Récit du run depuis le début (ou depuis `Last-Event-ID`), puis une trame `run.finished` d'identifiant `end` quand le run est terminé ; le serveur clôt alors le flux. Une reconnexion avec `Last-Event-ID: end` (run entièrement servi) reçoit `204 No Content`, qui arrête un client SSE standard (EventSource) au lieu de le faire reconnecter.
         */
        get: operations["streamRunEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Journal d'un run (`run_logs`, vue Technique de 06 § 2) ; extension de 05 § 4.2 */
        get: operations["listRunLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/datasets/{id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Items d'un dataset, exportés en flux (JSON, NDJSON, CSV à cellules neutralisées), curseur `after` */
        get: operations["getDatasetItems"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhook-subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Abonnements webhook (Standard Webhooks, 08 § 5) */
        get: operations["listWebhookSubscriptions"];
        put?: never;
        /** Crée un abonnement ; l'URL est contrôlée par la garde SSRF, le secret `whsec_` n'apparaît qu'ici */
        post: operations["createWebhookSubscription"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhook-subscriptions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Un abonnement, avec le journal de ses dernières livraisons */
        get: operations["getWebhookSubscription"];
        put?: never;
        post?: never;
        /** Supprime un abonnement */
        delete: operations["deleteWebhookSubscription"];
        options?: never;
        head?: never;
        /** Modifie un abonnement (URL, événements, réactivation, rotation du secret) */
        patch: operations["updateWebhookSubscription"];
        trace?: never;
    };
    "/api/webhook-subscriptions/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bouton **Tester** (06 § 2, Alertes) ; extension de 05 § 4.2 */
        post: operations["testWebhookSubscription"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/llm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Réglages des modèles IA (08 § 7) ; les clés ne sont jamais relues (INV8) */
        get: operations["getLlmSettings"];
        /**
         * Remplace les réglages (admin) ; un secret absent est conservé, un secret fourni est remplacé
         * @description Un secret est lié à sa destination (INV8) ; si la `base_url` d'un fournisseur change, sa clé est exigée dans la même requête (400 `api_key_required`) et ses en-têtes secrets d'avant sont abandonnés.
         */
        put: operations["putLlmSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/llm/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sonde de 5 appels minuscules d'un couple fournisseur × modèle (08 § 1) ; extension de 05 § 4.2 */
        post: operations["testLlmProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/proxies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Proxys définis par l'admin (08 § 2) ; une API ne référence qu'un identifiant */
        get: operations["listProxies"];
        put?: never;
        /** Ajoute un proxy (admin) */
        post: operations["createProxy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/proxies/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Un proxy, identifiants masqués */
        get: operations["getProxy"];
        put?: never;
        post?: never;
        /** Supprime un proxy (admin) */
        delete: operations["deleteProxy"];
        options?: never;
        head?: never;
        /**
         * Modifie un proxy (admin) ; un identifiant absent est conservé
         * @description Identifiants liés au proxy (INV8) ; une `url` d'un autre schéma, hôte ou port sans `username` et `password` ressaisis est refusée (400 `credentials_required`).
         */
        patch: operations["updateProxy"];
        trace?: never;
    };
    "/api/settings/proxies/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bouton **Tester** d'un proxy (IP et pays de sortie, 06 § 2) ; extension de 05 § 4.2 */
        post: operations["testProxy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/smtp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Réglages SMTP (alertes, invitations) ; mot de passe jamais relu */
        get: operations["getSmtpSettings"];
        /**
         * Remplace les réglages SMTP (admin) ; un secret absent est conservé
         * @description Le mot de passe n'est conservé que pour le même relais (hôte et port) et le même identifiant (INV8) ; sinon 400 `password_required`.
         */
        put: operations["putSmtpSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/smtp/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bouton **Tester** du SMTP (06 § 2, Alertes) ; extension de 05 § 4.2 */
        post: operations["testSmtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/security": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Réglages de sécurité (owner) : durées de session, domaines, plafond de clés */
        get: operations["getSecuritySettings"];
        /** Remplace les réglages de sécurité (owner) */
        put: operations["putSecuritySettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/identity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Identité du robot (admin ou owner) : interrupteur identify_instance, contact d'instance, User-Agent réel du moteur en lecture seule */
        get: operations["getIdentitySettings"];
        /** Écrit l'interrupteur identify_instance et/ou le contact d'instance (admin ou owner, audité) */
        put: operations["putIdentitySettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/settings/sso": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Réglages OIDC (owner) ; `client_secret` jamais relu */
        get: operations["getSsoSettings"];
        /** Remplace les réglages OIDC (owner) ; `client_secret` en écriture seule */
        put: operations["putSsoSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Utilisateurs de l'instance (admin) */
        get: operations["listUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Supprime un compte désactivé (jamais l'owner) */
        delete: operations["deleteUser"];
        options?: never;
        head?: never;
        /** Change le rôle (owner seulement) ou le statut d'un compte ; personne ne change son propre rôle */
        patch: operations["updateUser"];
        trace?: never;
    };
    "/api/users/{id}/reset-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lien de réinitialisation copiable (jamais de mot de passe choisi par l'admin), sans SMTP et pour un compte avec 2FA seulement (second facteur exigé à la consommation), audité */
        post: operations["createResetLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/revoke-access": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ferme les sessions et révoque clés d'API et jetons de tunnel d'un compte (révocation seule, jamais d'accès au contenu) */
        post: operations["revokeUserAccess"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/2fa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Réinitialise la 2FA d'un membre (owner pour un admin) ; ré-enrôlement exigé, sessions fermées, audité */
        delete: operations["resetUserTwoFactor"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/owner/transfer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Transfert de propriété (owner, mot de passe + 2FA) */
        post: operations["transferOwnership"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Invitations en cours (admin) */
        get: operations["listInvitations"];
        put?: never;
        /** Invite une adresse exacte avec un rôle (48 h, usage unique) ; lien copiable seulement sans SMTP */
        post: operations["createInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Accepte une invitation (public) ; réponse identique pour un jeton inconnu, expiré ou consommé */
        post: operations["acceptInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/invitations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Révoque une invitation */
        delete: operations["revokeInvitation"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/invitations/{id}/resend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Renvoie une invitation (nouveau jeton, nouvelle échéance) */
        post: operations["resendInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change le mot de passe de l'appelant (mot de passe actuel exigé, voir `CurrentPassword`) ; la fermeture des autres sessions est proposée
         * @description Nouveau mot de passe soumis à la politique (13 § 5 : 12 caractères au moins, liste locale des mots de passe compromis ; 400 `weak_password`). Les sessions restent ouvertes : la réponse donne le nombre des autres sessions, que la console propose de fermer (`DELETE /api/me/sessions`, ASVS 7.4.3). Un lien de réinitialisation en cours est annulé. Audit `auth.password_changed`, sans aucune valeur. Compte sans mot de passe local (OIDC seul) : 409 `no_local_password`.
         */
        post: operations["changeMyPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Sessions d'interface ouvertes de l'appelant */
        get: operations["listMySessions"];
        put?: never;
        post?: never;
        /** Ferme toutes les autres sessions de l'appelant */
        delete: operations["revokeMyOtherSessions"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Ferme une session de l'appelant (404 pour celle d'autrui) */
        delete: operations["revokeMySession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/2fa/enroll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Commence l'enrôlement TOTP (ré-authentification, voir `CurrentPassword`) */
        post: operations["enrollTwoFactor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/2fa/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirme la 2FA par un premier code ; renvoie les 10 codes de secours (affichés une fois) */
        post: operations["confirmTwoFactor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/2fa/backup-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Régénère les codes de secours (mot de passe ET second facteur ; les anciens sont révoqués) */
        post: operations["regenerateBackupCodes"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/2fa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Retire la 2FA de l'appelant (mot de passe et code, limité par compte), refusé si MFA_ENFORCED le concerne */
        delete: operations["disableTwoFactor"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/identities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Identités OIDC liées au compte de l'appelant (émetteur, jamais le sub) */
        get: operations["listMyIdentities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/identities/oidc": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lie une identité OIDC au compte après ré-authentification (mot de passe, second facteur si 2FA) ; renvoie l'URL d'autorisation et pose le cookie d'état */
        post: operations["startOidcLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/identities/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Retire une identité OIDC liée (refusé si c'est le dernier moyen de connexion du compte) */
        delete: operations["unlinkMyIdentity"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Événements d'audit de l'appelant (tous les rôles) */
        get: operations["listMyAuditEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me/responsible-use": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Case « j'ai lu » de la page « Usage responsable » (17 § 11) ; extension de 05 § 4.2 */
        get: operations["getResponsibleUseAck"];
        put?: never;
        /** Coche « j'ai lu » ; sans elle, une API à champ `x-personal` est refusée (403 `responsible_use_ack_required`) */
        post: operations["acknowledgeResponsibleUse"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Journal d'audit de l'instance (admin), métadonnées seulement */
        get: operations["listAuditEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/audit/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Export NDJSON du journal d'audit (owner) */
        get: operations["exportAuditEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/subjects/erase": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Effacement d'une personne (RGPD, 17 § 6), aperçu `dry_run` d'abord ; admin, audité */
        post: operations["eraseSubject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/subjects/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Export des données d'une personne (droit d'accès, 17 § 6) ; admin, audité */
        post: operations["exportSubject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tunnel/pairing-code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Code d'appairage de l'extension, usage unique, 10 minutes (07 § 1) ; session récente exigée */
        post: operations["createPairingCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/pairing-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Code d'appairage de l'extension, usage unique, 10 minutes (07 § 1) ; ré-authentification (voir `CurrentPassword`) */
        post: operations["createExtensionPairingCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/pair": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Échange d'un code d'appairage contre un jeton d'appareil (07 § 1) ; limité par IP */
        post: operations["pairExtension"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Appareil et domaines connectés du jeton (07 § 2) */
        get: operations["getExtensionSession"];
        put?: never;
        post?: never;
        /** Déconnexion de l'appareil, le jeton est révoqué (07 § 2) */
        delete: operations["deleteExtensionSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/tunnel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * WebSocket du tunnel (07 § 6) : jeton d'appareil dans le premier message, jamais dans l'URL
         * @description Ouverture refusée avec un paramètre d'URL (400) ou une Origin autre qu'une extension (403). Puis messages JSON (schéma strict, 1 Mio au plus par message, compression désactivée) : extension → instance hello, ping, result (découpé en morceaux seq/last) ; instance → extension welcome, pong, cmd (http_fetch, page_fetch, page_script, agent_step). Fermetures 4401 (jeton refusé ou révoqué), 4409 (connexion plus récente du même utilisateur), 4400 (protocole), 4429 (débit), 4408 (pas de hello).
         */
        get: operations["openExtensionTunnel"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/sites/{domain}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Consentement par domaine et choix du mode (usage serveur ou tunnel) (07 § 2) */
        put: operations["connectExtensionSite"];
        post?: never;
        /** Déconnexion d'un domaine (les cookies serveur sont supprimés) (07 § 2) */
        delete: operations["disconnectExtensionSite"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/sites/{domain}/cookies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Cookies d'un domaine en usage serveur, écriture seule, scellés (07 § 2) ; remplacé par la WSS en 2.7 */
        put: operations["putExtensionSiteCookies"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Appareils appairés de l'utilisateur (06 § 2, Paramètres) */
        get: operations["listExtensionDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/extension/devices/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Révocation d'un appareil de l'utilisateur (07 § 1) */
        delete: operations["revokeExtensionDevice"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Domaines connectés de l'utilisateur (06 § 2, Paramètres) */
        get: operations["listConnectedSites"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sites/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Déconnexion d'un domaine depuis la console */
        delete: operations["disconnectConnectedSite"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/tunnels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Appareils de l'instance, métadonnées seules (jamais un jeton) ; admin (13 § 4) */
        get: operations["listAdminTunnels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/admin/tunnels/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Révocation d'un appareil par un admin (révocation seule, INV5) */
        delete: operations["revokeAdminTunnel"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface webhooks {
    "run.succeeded": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run réussi (ou dégradé) */
        post: operations["webhookRunSucceeded"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "run.failed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run en échec */
        post: operations["webhookRunFailed"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "api.status_changed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Changement de statut d'une API */
        post: operations["webhookApiStatusChanged"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "items.new": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Nouveaux items (planification avec diff) */
        post: operations["webhookItemsNew"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export interface components {
    schemas: {
        ApiError: {
            error: {
                code: string;
                message: string;
                /** @description Raison stable d'un refus quand le code en a plusieurs (ex. `persistence_not_eligible`). */
                reason?: string;
                /** @description Marche à suivre, en anglais (05 § 1). */
                what_to_do?: string;
                /** @description L'appel peut être refait tel quel une fois la marche à suivre faite (ex. `instance_contact_missing` : le contact du robot posé, UX-04). */
                retryable?: boolean;
            };
        };
        /** @description Erreur de la bibliothèque d'authentification (format à plat, sans enveloppe `error`). */
        AuthError: {
            code: string;
            message: string;
        } & {
            [key: string]: unknown;
        };
        /** @description 429 du serveur (`ApiError`) ou de la limite par IP de la bibliothèque (`AuthError`). */
        RateLimited: components["schemas"]["ApiError"] | components["schemas"]["AuthError"];
        Health: {
            /** @constant */
            status: "ok";
        };
        Ready: {
            /** @constant */
            status: "ready";
            initialized: boolean;
        };
        NotReady: {
            /** @constant */
            status: "not_ready";
            /** @enum {string} */
            reason: "schema_version" | "database";
        };
        /** @enum {string} */
        Role: "owner" | "admin" | "member";
        /** @enum {string} */
        Theme: "light" | "dark" | "system";
        /** @enum {string} */
        Locale: "en" | "fr";
        /** @enum {string} */
        ApiKeyScope: "apis:read" | "apis:run" | "apis:write" | "runs:read" | "datasets:read" | "schedules:write" | "sites:read";
        SetupRequest: {
            token: string;
            email: string;
            password: string;
            displayName?: string;
            /** @description Contact de l'opérateur de l'instance (URL http(s), mailto: ou adresse électronique) ; annoncé par le robot quand identify_instance est activé (17 §5). */
            instanceContact?: string;
        };
        SetupResult: {
            /** Format: uuid */
            userId: string;
            keyFingerprint: string;
            reminder: string;
        };
        SignInRequest: {
            email: string;
            password: string;
            rememberMe?: boolean;
        };
        AuthUser: {
            id: string;
            email: string;
            name?: string;
        } & {
            [key: string]: unknown;
        };
        SignInResult: {
            redirect?: boolean;
            user: components["schemas"]["AuthUser"];
            /** @description Compte à 2FA (13 § 7) ; la session reste en attente du second facteur (`POST /api/auth/two-factor/verify`). */
            twoFactorRequired?: boolean;
            notices?: components["schemas"]["AccountNotices"];
        } & {
            [key: string]: unknown;
        };
        SessionInfo: {
            session?: {
                [key: string]: unknown;
            };
            user: components["schemas"]["AuthUser"];
        } & {
            [key: string]: unknown;
        };
        /**
         * @description Permission de la matrice des rôles (13 § 2), nom de `packages/core/src/auth/roles.ts`.
         * @enum {string}
         */
        Permission: "account:update" | "account:mfa" | "account:sessions" | "apikeys:manage" | "users:invite" | "users:list" | "users:deactivate" | "users:delete" | "users:set_role" | "owner:transfer" | "users:revoke_sessions" | "apis:create" | "apis:update" | "apis:delete" | "schedules:manage" | "apis:read" | "apis:set_visibility" | "apis:run" | "runs:read" | "datasets:read" | "runs:stats" | "sites:connect" | "sites:server_use" | "tunnel:pair" | "sites:read_cookies" | "tunnel:route_other" | "apikeys:read_other" | "tunnel:revoke_other" | "apikeys:revoke_other" | "settings:llm:write" | "settings:proxies:write" | "settings:smtp:write" | "settings:identity:write" | "settings:security:write" | "settings:sso:write" | "audit:read" | "audit:export" | "audit:purge";
        Me: {
            /** @description Fuseau IANA du compte (`users.timezone`), null tant qu'il n'est pas posé ; sert aux e-mails, aux messages MCP et au fuseau par défaut d'une planification. Donnée personnelle, jamais déduite de la langue (21b § 1). */
            timezone: string | null;
            /** @description Le fuseau a déjà été écrit une fois (première connexion ou Mon compte, même effacé) : la console ne pose le fuseau du navigateur qu'à la première connexion (21b § 1), jamais sur un fuseau effacé volontairement. */
            timezoneInitialized?: boolean;
            /** Format: uuid */
            id: string;
            email: string;
            displayName: string;
            role: components["schemas"]["Role"];
            /** @description Langue préférée (`users.locale`), code d'une langue du registre de l'instance ; la console retombe sur `en` pour une langue qu'elle ne connaît pas. */
            locale: string;
            theme: components["schemas"]["Theme"];
            /** @enum {string} */
            via: "ui" | "apikey";
            /** @description Scopes de la clé d'API ; null pour une session d'interface. */
            scopes: components["schemas"]["ApiKeyScope"][] | null;
            /** @description Permissions que `can(role, …)` (13 § 2) accorde au rôle de l'appelant. La console pilote ses écrans et ses routes par cette liste, sans recopier la matrice ; le serveur reste seul juge à chaque requête. */
            permissions: components["schemas"]["Permission"][];
            /** @description 2FA TOTP confirmée et lisible sur le compte. */
            mfaEnabled: boolean;
            /** @description MFA_ENFORCED concerne le rôle de l'appelant (13 § 7) : la 2FA ne peut pas être retirée (`DELETE /api/me/2fa` répond 403 `mfa_enforced`), la console ne le propose pas. */
            mfaRequired: boolean;
            /** @description MFA_ENFORCED concerne le rôle et la 2FA n'est pas en place (ni `amr` de l'IdP) : toute route sauf l'enrôlement répond 403 `mfa_enrollment_required` (13 § 7). */
            mfaEnrollmentRequired: boolean;
        };
        MePatch: {
            /** @description Code d'une langue livrée (`400 invalid_locale` sinon). Le choix du compte l'emporte sur `Accept-Language`. */
            locale?: string;
            /** @description Fuseau IANA contrôlé contre `Intl.supportedValuesOf('timeZone')` (`400 invalid_timezone` sinon) ; null l'efface. */
            timezone?: string | null;
            theme?: components["schemas"]["Theme"];
        };
        ApiKey: {
            /** Format: uuid */
            id: string;
            label: string;
            prefix: string;
            scopes: components["schemas"]["ApiKeyScope"][];
            /** Format: date-time */
            expiresAt: string;
            lastUsedAt: string | null;
            /** Format: date-time */
            createdAt: string;
            revokedAt: string | null;
        };
        ApiKeyCreate: {
            label: string;
            scopes: components["schemas"]["ApiKeyScope"][];
            expiresInDays?: number;
            currentPassword?: components["schemas"]["CurrentPassword"];
        };
        ApiKeyCreated: components["schemas"]["ApiKey"] & {
            /** @description Secret en clair, renvoyé une seule fois. */
            key: string;
        };
        /** @enum {string} */
        ApiStatus: "enquete" | "sain" | "warning" | "reparation" | "erreur" | "action_requise" | "bloquee";
        /** @enum {string} */
        InvestigationPhase: "access_check" | "reconnaissance" | "awaiting_schema_validation" | "testing" | "done";
        /** @enum {string} */
        Visibility: "private" | "instance";
        /**
         * @description Niveaux E1 à E6, du moins cher au plus cher (04 § 3.1).
         * @enum {string}
         */
        Execution: "fetch" | "fetch_in_page" | "playwright" | "agent_fetch" | "hybrid" | "agent";
        /** @enum {string} */
        Network: "direct" | "dc_proxy" | "res_proxy" | "tunnel";
        /** @enum {string} */
        StrategyCreator: "investigation" | "repair" | "user" | "revert" | "import";
        /** @enum {string} */
        RunTrigger: "mcp" | "rest" | "schedule" | "ui" | "canary";
        /** @enum {string} */
        RunState: "queued" | "running" | "waiting_tunnel" | "succeeded" | "failed" | "cancelled" | "skipped_tunnel_offline" | "skipped_window" | "skipped_quota" | "skipped_status" | "skipped_overlap";
        /** @enum {string} */
        RunOutcome: "clean" | "degraded" | "failed";
        /** @description Classe d'échec fermée (04b § 1), ou famille `llm_*` (08 § 1). Code stable, jamais localisé. `robots_disallowed` et `robots_unreachable` sont des valeurs historiques (D-91) : plus produites, encore lisibles sur les runs anciens. */
        FailureClass: string;
        /** @description Code de raison stable (06 § 4.2 : `retried`, `escalated`, `repaired`, `stale`, `reverted`, `cookie_expired`… ; reprise par étape, 19b § 3 : `repair_not_validated`, `write_step_broken`, `step_cascade`, `not_compilable`, `session_step_broken`), traduit par la console ; jamais une phrase. */
        ReasonCode: string;
        /** @description Phrase générée côté serveur, transmise en code et paramètres (traduite par la console, 06 § 4.1). */
        ReasonMessage: {
            code: components["schemas"]["ReasonCode"];
            params: {
                [key: string]: string | number;
            };
        };
        /**
         * @description Noms d'événements du flux SSE (06 § 3). Toute trame porte `id:` (reprise par `Last-Event-ID`), `event:` et `data:` (JSON). Le récit d'une enquête reprend les noms de `investigation_events` (3.1) ; `status.changed` vient aussi de `status_events` et `run.finished` de la fin d'un run. La charge porte `run_id`, `api_id` et `api_slug`.
         * @enum {string}
         */
        EventName: "investigation.started" | "access_report" | "phase.started" | "reconnaissance.finished" | "schema.proposed" | "schema.validated" | "attempt.finished" | "attempt.pruned" | "status.changed" | "action.required" | "investigation.finished" | "run.finished";
        /** @description Coût en dollars ; `null` quand le prix est inconnu (jamais 0 par défaut, 08 § 1). */
        Cost: {
            llm_usd: number | null;
            proxy_usd: number | null;
            compute_usd?: number | null;
            total_usd: number | null;
            estimated?: boolean;
        };
        Tokens: {
            in: number;
            cached: number;
            out: number;
            reasoning: number;
            estimated: boolean;
        };
        Requires: {
            session_domain: string | null;
            tunnel: boolean;
        };
        /** @description Modes réseau autorisés pour l'API ; `res_proxy` est un opt-in explicite par API. Une API ne référence un proxy que par son identifiant (08 § 2). Jamais de montée réseau après un refus (X4). */
        NetworkPolicy: {
            allow: components["schemas"]["Network"][];
            /** @description Proxy choisi par niveau, par son identifiant (à défaut, le premier proxy du type). */
            proxy_ids?: {
                dc_proxy?: string;
                res_proxy?: string;
            };
            res_proxy_params?: {
                country?: string;
            };
            dc_proxy_params?: {
                country?: string;
            };
        };
        AccessPolicy: {
            /**
             * @deprecated
             * @description Champ retiré (D-91), toléré et ignoré ; présent seulement sur les politiques écrites avant.
             */
            robots?: unknown;
            /** Format: uuid */
            report_id?: string | null;
            user_agent_contact?: string;
        };
        DomainPacing: {
            min_delay_ms?: number;
            max_requests_per_run?: number;
            max_wait_ms?: number;
        };
        /** @description Rapport d'accès, étape 0 de l'enquête (17 § 2) ; onglet « Accès » en lecture seule. */
        AccessReport: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            checked_at: string;
            /**
             * @description Pastille Accès du catalogue (vert, orange). `disallowed` est une valeur historique (D-91), sur les rapports anciens.
             * @enum {string}
             */
            signal: "allowed" | "review" | "disallowed";
            /**
             * @deprecated
             * @description Section historique (D-91), présente seulement sur les rapports produits avant ; plus produite.
             */
            robots?: {
                /** @enum {string} */
                status: "allowed" | "disallowed" | "absent" | "unreachable";
                /** Format: date-time */
                fetched_at?: string | null;
                rule?: string | null;
            };
            usage_signals?: {
                kind: string;
                value: string;
            }[];
            /**
             * @description Qui envoie les requêtes vers le site, donc leur `Accept-Language` (21 § 6) : `engine` = le moteur serveur, la valeur est dans `accept_language` ; `user_browser` = run en tunnel, le Chrome de l'utilisateur envoie sa langue réelle (21 § 6.4), non mesurée : `accept_language` est alors absent. Absent (rapport antérieur) : `engine`.
             * @enum {string}
             */
            accept_language_source?: "engine" | "user_browser";
            /** @description `Accept-Language` effectif envoyé aux sites cibles par le moteur : celui d'un Chromium vierge de l'image, le même pour le client HTTP et pour le navigateur (21 § 6). Jamais la langue de l'interface, du compte ou du run. `null` : aucun en-tête (un Chromium vierge de l'image n'en envoie pas). Absent quand `accept_language_source` vaut `user_browser` (tunnel). */
            accept_language?: string | null;
            llms_txt?: boolean;
            payment_offer?: string | null;
            official_api_url?: string | null;
        };
        NextAction: {
            tool: string;
            args: {
                [key: string]: unknown;
            };
        };
        /** @description Ligne du catalogue (= élément de list_apis, plus les colonnes de 06 § 2). */
        ApiSummary: {
            /** Format: uuid */
            id: string;
            slug: string;
            description: string;
            /** @description Domaine de la page enquêtée (hôte de l'URL de départ, en minuscules), affiché sous le nom dans le catalogue (20 § 5.2) ; null s'il n'est pas connu. */
            domain?: string | null;
            status: components["schemas"]["ApiStatus"];
            status_reason: components["schemas"]["ReasonMessage"] | null;
            stale: boolean;
            execution: components["schemas"]["Execution"] | null;
            network: components["schemas"]["Network"] | null;
            requires: components["schemas"]["Requires"];
            avg_cost_usd: number | null;
            avg_cost_estimated?: boolean;
            /** Format: date-time */
            last_run_at?: string | null;
            success_rate_30d?: number | null;
            /** @enum {string|null} */
            access_signal?: "allowed" | "review" | "disallowed" | null;
            visibility: components["schemas"]["Visibility"];
            /** Format: uuid */
            owner_id?: string;
            pinned?: boolean;
            mcp_exposed?: boolean;
        };
        ApiList: {
            apis: components["schemas"]["ApiSummary"][];
            next_cursor: string | null;
        };
        /** @description Fiche (= get_api, entité Api de 04b § 1). Pour l'admin face à une API avec session d'autrui, `metadata_only` vaut true et les schémas, l'échantillon et la stratégie sont absents (13 § 2, INV12). Un membre qui lit l'API `instance` d'autrui reçoit de quoi la lancer (schémas, statut, exécution, réseau autorisé, coût estimé), jamais la politique du propriétaire : `project_id`, `purpose`, `legal_basis`, `max_cost_usd`, `budget_daily_usd`, `domain_pacing`, ni les proxys et paramètres de `network_policy` (seulement `allow`). */
        ApiDetail: components["schemas"]["ApiSummary"] & {
            metadata_only: boolean;
            /** Format: uuid */
            project_id?: string;
            investigation_phase: components["schemas"]["InvestigationPhase"] | null;
            input_schema?: {
                [key: string]: unknown;
            };
            output_schema?: {
                [key: string]: unknown;
            };
            views?: {
                columns?: string[];
            };
            clean_streak?: number;
            /** Format: date-time */
            last_signal_at?: string | null;
            current_strategy_version: number | null;
            current_strategy?: components["schemas"]["StrategyVersionSummary"] | null;
            network_policy?: components["schemas"]["NetworkPolicy"];
            access_policy?: components["schemas"]["AccessPolicy"];
            access_report?: components["schemas"]["AccessReport"] | null;
            purpose?: string | null;
            legal_basis?: string | null;
            contains_personal_data?: boolean;
            allow_write_actions?: boolean;
            max_cost_usd?: number | null;
            budget_daily_usd?: number | null;
            domain_pacing?: components["schemas"]["DomainPacing"];
            /** @description Mode « SYM ne lâche pas » (D-49) ; propriétaire seulement. */
            persistence?: components["schemas"]["ApiPersistence"] | null;
            /** @description Coût estimé avant lancement (« ~0,002 $, médiane de 10 runs » ou « non estimé »). */
            cost_estimate?: {
                median_usd: number | null;
                sample_size: number;
            };
            /** @description Propriétaire de la session utilisée, quand ce n'est pas l'appelant (message de 06 § 2). */
            session_owner?: {
                /** Format: uuid */
                id: string;
                display_name: string;
            } | null;
            recent_runs?: components["schemas"]["RunSummary"][];
            /** @description Mode « agent instruit » (19 § 4, tâche 2.13) : opt-in explicite par API, jamais par défaut, jamais vrai sans étapes instruites confirmées par un humain. Un agent travaille à chaque run (coût affiché avant chaque lancement). Absent : faux. */
            instructed_mode?: boolean;
            /** @description Étapes instruites de la version courante ; null quand la version n'en a pas. */
            instructed?: components["schemas"]["InstructedSteps"] | null;
            retention_days?: number | null;
            /** Format: date-time */
            created_at?: string;
        };
        /** @description Étapes instruites de la version courante (19 § 4, 19b § 1) : intentions et `post`, sans cible. Les `intent` sont du contenu NON FIABLE (écrit par un LLM qui a lu des pages) : affichés comme texte brut, jamais interprétés. La confirmation humaine porte `version` et `sha256` (empreinte des étapes affichées). */
        InstructedSteps: {
            version: number;
            /** @enum {string} */
            compilable: "yes" | "unknown" | "no";
            steps: components["schemas"]["InstructedStep"][];
            sha256: string;
            /** Format: uuid */
            confirmed_by: string | null;
            /** Format: date-time */
            confirmed_at: string | null;
            /** @description Coût estimé d'un run instruit (somme des budgets d'étape, plafond) ; null si inconnu. */
            estimated_run_usd: number | null;
        };
        InstructedStep: {
            id: string;
            /** @description Intention nettoyée (200 caractères au plus), non fiable. */
            intent: string;
            post: components["schemas"]["StepPost"][];
        };
        /** @description Condition de sortie d'une étape (liste fermée, 19 § 4) ; immuable en réparation. */
        StepPost: {
            /** @enum {string} */
            kind: "url_changed" | "url_contains" | "element_present" | "element_absent" | "text_present";
            value?: string;
            role?: string;
            name?: string;
        };
        /** @description Confirmation humaine des étapes instruites affichées (version et empreinte reçues de la fiche). */
        InstructedStepsConfirm: {
            version: number;
            sha256: string;
        };
        InstructedModeWrite: {
            enabled: boolean;
        };
        /** @description Entrée de create_api (05 § 4.1). */
        ApiCreate: {
            description: string;
            /** Format: uri */
            url: string;
            /** @description Exemple de sortie facultatif (objet ou tableau JSON). */
            example_output?: unknown;
            auto_validate?: boolean;
            network_policy?: components["schemas"]["NetworkPolicy"];
            wait_seconds?: number;
            visibility?: components["schemas"]["Visibility"];
            /** @description Avertissement A11 confirmé (site à compte, 06 § 2). */
            account_site_acknowledged?: boolean;
            brief?: components["schemas"]["InvestigationBrief"];
        };
        /** @description Dossier d'enquête facultatif (19c § 9.1, objet fermé) : indices typés avec provenance, essais, notes, questions. SYM vérifie chaque indice et peut l'ignorer ; il n'élargit jamais l'accès ni les budgets. 16 000 octets au plus, jamais tronqué (400 brief_too_large) ; clé inconnue : 400 invalid_brief ; cookie, jeton ou URL signée : 400 secret_in_brief. */
        InvestigationBrief: {
            /** @constant */
            v?: 1;
            notes?: string;
            hints?: {
                id: string;
                /** @enum {string} */
                kind: "endpoint" | "embedded_data" | "selector" | "pagination" | "example_url" | "pitfall";
                value: string;
                /** @enum {string} */
                seen?: "http_response" | "network_log" | "dom" | "user_said" | "guess";
                /** Format: uri */
                seen_on?: string;
                /** Format: date-time */
                seen_at?: string;
                /** @enum {string} */
                confidence?: "high" | "medium" | "low";
                sample?: string;
            }[];
            tried?: {
                /** @enum {string} */
                approach: "fetch_json" | "fetch_html" | "embedded_data" | "dom_selector" | "browser" | "other";
                target?: string;
                /** @enum {string} */
                outcome: "ok" | "empty" | "wrong_data" | "error" | "refused" | "unknown";
                note?: string;
            }[];
            open_questions?: string[];
        };
        /** @description Fait du code sur un indice (19c § 7) ; jamais le texte du dossier (gabarit reconstruit par le code). */
        BriefReportEntry: {
            id: string;
            /** @enum {string} */
            kind: "endpoint" | "embedded_data" | "selector" | "pagination" | "example_url" | "pitfall";
            /** @enum {string} */
            state: "used" | "verified_unused" | "probe_failed" | "ignored" | "unverified";
            reason: string | null;
            /** @enum {string|null} */
            provenance: "probe" | "traffic" | "dom" | null;
            template: string | null;
            stale: boolean;
            cost_usd: number | null;
        };
        ApiBriefView: {
            latest: {
                version: number;
                /** Format: date-time */
                created_at: string;
                hints: number;
                tried: number;
                open_questions: number;
                erased: boolean;
            } | null;
            hints: {
                identity_key: string;
                hint_id: string;
                kind: string;
                /** @enum {string} */
                state: "used" | "verified_unused" | "probe_failed" | "ignored";
                reason: string | null;
                cost_usd: number | null;
                brief_version: number;
                stale: boolean;
                /** Format: date-time */
                probed_at: string | null;
                /** Format: date-time */
                last_ok_at: string | null;
            }[];
            versions: {
                strategy_version: number;
                brief_version: number | null;
                used: number;
                ignored: number;
            }[];
            report: components["schemas"]["BriefReportEntry"][];
        };
        ApiCreated: {
            /** Format: uuid */
            api_id: string;
            slug: string;
            investigation_phase: components["schemas"]["InvestigationPhase"] | null;
            proposed_output_schema: {
                [key: string]: unknown;
            } | null;
            sample: {
                [key: string]: unknown;
            }[];
            access_report: components["schemas"]["AccessReport"] | null;
            /** Format: uuid */
            run_id?: string | null;
            /** @description Version du dossier d'enquête enregistrée avec l'API (19c § 4). */
            brief_version?: number;
            brief_report?: components["schemas"]["BriefReportEntry"][];
            /** @description Récit du dossier en gabarits fermés (narrative.brief.*), sans texte du dossier. */
            brief_narrative?: string[];
            /** @description État réel du run d'enquête à la réponse (UX-07) : en cours, ou terminé (`failed` avec `error`). */
            run_state?: components["schemas"]["RunState"];
            status?: components["schemas"]["ApiStatus"];
            error?: components["schemas"]["RunError"];
            /** @description Enquête encore en cours à la réponse (validation automatique plus longue que l'attente) : relire `get_run` (ou GET /api/runs/{id}) après ce délai ; `null` en pause. Absent si l'enquête est terminée. */
            poll_after_seconds?: number | null;
            /** @description Enquête encore en cours à la réponse : même indice que `RunResult.progress` (phase, essais, phrase). */
            progress?: {
                phase: string;
                strategies_tried: number;
                last_attempt: {
                    execution: string;
                    network: string;
                    result: string;
                } | null;
                message: string;
            };
            /** @description Enquête encore en cours à la réponse : l'appel suivant (`get_run` avec `run_id`). */
            next_action?: components["schemas"]["NextAction"];
        };
        /** @description Champs modifiables. Un schéma (`output_schema`, `input_schema`) ne change que par un brouillon puis une promotion (19 § 6, itération) : en place, 409 `draft_required`. `access_policy` n'est pas modifiable (INV11) ; une API avec session reste `private` (400 `session_api_private`). */
        ApiPatch: {
            description?: string;
            input_schema?: {
                [key: string]: unknown;
            };
            output_schema?: {
                [key: string]: unknown;
            };
            views?: {
                columns?: string[];
            };
            network_policy?: components["schemas"]["NetworkPolicy"];
            mcp_exposed?: boolean;
            pinned?: boolean;
            visibility?: components["schemas"]["Visibility"];
            purpose?: string | null;
            legal_basis?: string | null;
            contains_personal_data?: boolean;
            /** @description Plafond de coût d'un run ; `null` revient au défaut de l'instance (0,5 $). */
            max_cost_usd?: number | null;
            /** @description Budget quotidien de l'API ; `null` revient au défaut de l'instance (5 $). */
            budget_daily_usd?: number | null;
            /** @description Mode « SYM ne lâche pas » (D-49, 04 § 6), désactivé par défaut. L'activer est un acte humain : session de la console seulement (`403 human_confirmation_required` par une clé d'API) ; le désactiver est permis à toute clé du scope `apis:write`. Chaque bascule est auditée avec son acteur. */
            persistence_mode?: boolean;
            /** @description Plafond propre du mode, cumulé depuis l'entrée en `erreur` ; `null` revient à `PERSISTENCE_BUDGET_USD_DEFAULT` (jamais illimité). Le changer sur un mode actif exige la console ; un plafond effectif ≤ 0 répond `409 persistence_not_eligible`. */
            persistence_budget_usd?: number | null;
        };
        /** @description État du mode « SYM ne lâche pas » (D-49), propriétaire seulement : interrupteur, plafond effectif (jamais illimité), tentatives du cycle en cours, prochain essai, dépense, tentative en cours, fin du mode et sa raison. */
        ApiPersistence: {
            enabled: boolean;
            budget_usd: number;
            attempt: number;
            /** Format: date-time */
            next_at: string | null;
            spent_usd: number;
            in_progress: boolean;
            /** Format: date-time */
            entered_error_at: string | null;
            ended: ("refused" | "ineligible" | "exhausted") | null;
            ended_reason: string | null;
        };
        /** @description Export portable d'une API (16 § 6, tâche 3.12), format `scrapyomama.api` 1.0, clés triées. AUCUN champ pour une session, un cookie, une clé LLM, un identifiant de proxy, un secret ou une URL de webhook, ni pour une donnée de run (cibles d'alerte en référence `$ALERT_WEBHOOK_1`). Stratégie déclarative seulement (E1-E3, hors tunnel). `integrity.sha256` : empreinte du JSON canonique (clés triées) de l'enveloppe sans `integrity`. À l'import, les champs inconnus sont ignorés (contrôle complet : `parseApiExport` du cœur). */
        ApiExport: {
            /** @constant */
            format: "scrapyomama.api";
            format_version: string;
            min_runtime_version: string;
            /** Format: date-time */
            exported_at: string;
            api: components["schemas"]["ApiExportApi"];
            strategy: components["schemas"]["ApiExportStrategy"] | null;
            history?: {
                version: number;
                execution: string;
                network: string;
                created_by: string;
                created_at: string;
            }[];
            schedules: components["schemas"]["ApiExportSchedule"][];
            /** @description Enregistrements synthétiques conformes au schéma de sortie (modèles de `templates/` seulement). */
            fixtures?: {
                items: {
                    [key: string]: unknown;
                }[];
            };
            integrity: {
                sha256: string;
            };
        };
        ApiExportApi: {
            slug?: string;
            description: string;
            /** @description Page de la demande d'enquête, rejouée à l'import (rapport d'accès). */
            source_url: string;
            input_schema: {
                [key: string]: unknown;
            };
            output_schema: {
                [key: string]: unknown;
            };
            output_columns?: string[];
            views?: {
                columns?: string[];
            };
            purpose?: string | null;
            legal_basis?: string | null;
            contains_personal_data?: boolean;
            max_cost_usd?: number;
            budget_daily_usd?: number;
            /** @description Niveaux réseau exportables seulement (jamais le tunnel ni un identifiant de proxy). */
            network_policy?: {
                allow: components["schemas"]["Network"][];
            };
            alert_targets?: {
                ref: string;
                events: components["schemas"]["WebhookEventName"][];
            }[];
        };
        ApiExportStrategy: {
            /** @enum {string} */
            execution: "fetch" | "fetch_in_page" | "playwright";
            /** @enum {string} */
            network: "direct" | "dc_proxy" | "res_proxy";
            /** @description Stratégie déclarative (04b § 2), sans session ni secret. */
            spec: {
                [key: string]: unknown;
            };
            est_cost_usd?: number | null;
        };
        ApiExportSchedule: {
            cron: string;
            timezone: string;
            input: {
                [key: string]: unknown;
            };
            rules: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            overlap: "skip" | "queue" | "allow";
            /** @enum {string} */
            missed: "once" | "skip";
            enabled: boolean;
        };
        /** @description Aperçu d'un import (aucune écriture) ; confirmer par `POST /api/apis/import?confirm=true`. */
        ApiImportPreview: {
            /** @constant */
            preview: true;
            description: string;
            source_url: string;
            output_fields: string[];
            /** @description Le schéma de sortie porte un champ `x-personal` (ou l'API se déclare à données personnelles). */
            personal_fields: boolean;
            /** @description Niveaux réseau que l'API importée pourra utiliser (politique du fichier, contrôlée, jamais le tunnel ; un proxy résidentiel se voit avant la confirmation). */
            network_allow: components["schemas"]["Network"][];
            strategy: {
                execution: components["schemas"]["Execution"];
                network: components["schemas"]["Network"];
            } | null;
            /** @description Planifications recréées DÉSACTIVÉES. */
            schedules: number;
            /** @description Références de cibles d'alerte à configurer (aucune n'est créée). */
            alert_targets: string[];
            /** @description Chemins des champs inconnus ignorés (`$.api.x`) et des niveaux réseau écartés (`$.api.network_policy.allow[1]`, un `tunnel` n'étant jamais importé). */
            ignored_fields: string[];
            /** @description La case « j'ai lu » (17 § 11) doit être cochée avant la confirmation. */
            requires_ack: boolean;
        };
        /** @enum {string} */
        WebhookEventName: "run.succeeded" | "run.failed" | "api.status_changed" | "items.new";
        /** @description Charge de `run.succeeded` (08 § 5) ; jamais d'item, seulement des identifiants et des compteurs. */
        WebhookRunSucceeded: {
            /** @constant */
            type: "run.succeeded";
            /** Format: date-time */
            timestamp: string;
            data: {
                api: string;
                /** Format: uuid */
                api_id: string;
                /** Format: uuid */
                run_id: string;
                status: components["schemas"]["ApiStatus"];
                outcome: string;
                items: number;
                new_items?: number;
                dataset_url?: string;
            };
        };
        /** @description Charge de `run.failed` ; une classe bloquante n'est jamais `retryable`. */
        WebhookRunFailed: {
            /** @constant */
            type: "run.failed";
            /** Format: date-time */
            timestamp: string;
            data: {
                api: string;
                /** Format: uuid */
                api_id: string;
                /** Format: uuid */
                run_id: string;
                status: components["schemas"]["ApiStatus"];
                failure_class: components["schemas"]["FailureClass"] | null;
                retryable: boolean | null;
            };
        };
        /** @description Charge de `api.status_changed` ; vers `bloquee`, `retryable` vaut false. */
        WebhookApiStatusChanged: {
            /** @constant */
            type: "api.status_changed";
            /** Format: date-time */
            timestamp: string;
            data: {
                api: string;
                /** Format: uuid */
                api_id: string;
                from: components["schemas"]["ApiStatus"] | null;
                to: components["schemas"]["ApiStatus"];
                reason: string | null;
                /** Format: uuid */
                run_id?: string;
                retryable: boolean;
            };
        };
        /** @description Charge de `items.new`. */
        WebhookItemsNew: {
            /** @constant */
            type: "items.new";
            /** Format: date-time */
            timestamp: string;
            data: {
                api: string;
                /** Format: uuid */
                api_id: string;
                /** Format: uuid */
                run_id: string;
                new_items: number;
                items: number;
                dataset_url?: string;
            };
        };
        /** @description Validation (ou correction) du schéma proposé. Le schéma validé est celui de l'appelant : propriétés renommées, retirées ou ajoutées et descriptions modifiées sont appliquées, et l'affectation des champs est refaite par le rôle `investigate` (les descriptions guident l'affectation). Ce qui a changé par rapport à la proposition et ce qui n'est pas appliqué (marques `x-personal` de l'appelant ignorées, celles détectées gardées) entrent dans la chronologie du run des essais (entrée `schema_validated`) et dans `schema_validation` de la réponse MCP. */
        ValidateSchemaRequest: {
            output_schema?: {
                [key: string]: unknown;
            };
            /** @description Consignes de l'utilisateur (jamais du site), traitées comme la description de l'API : transmises au rôle `investigate` pour refaire l'affectation des champs (quelle liste lire, préfixe à retirer…) et ajoutées à la consigne des voies agentiques. */
            instructions?: string;
            /** @description Source candidate de la reconnaissance (`candidates[].id` de l'événement `reconnaissance.finished`, ex. `c2`) : les essais déclaratifs se limitent aux stratégies construites sur elle ; les voies agentiques sur la page restent essayées en dernier (les retirer par `exclude_executions`). Identifiant inconnu ou inutilisable : 400 `unknown_source`, la liste des identifiants valides dans `message` et `what_to_do`. */
            source_id?: string;
            /** @description Plan d'essais restreint avant exécution (06 § 2, tâche 3.5), dans les bornes de la politique réseau ; jamais d'ajout. */
            exclude_executions?: components["schemas"]["Execution"][];
            wait_seconds?: number;
        };
        InvestigateRequest: {
            /** @description Plan d'essais restreint avant exécution (06 § 2), dans les bornes de la politique réseau. */
            exclude_executions?: components["schemas"]["Execution"][];
        };
        /** @description Entrée de run_api (05 § 4.1), validée contre `input_schema` (400 `invalid_input`, aucun run créé). */
        RunRequest: {
            input: {
                [key: string]: unknown;
            };
            force_investigate?: boolean;
            /** @description Relance avec une version précise (06 § 2) : une version qui a été courante (la courante, l'origine), sinon `400 invalid_strategy_version` ; réservé au propriétaire de l'API (`403 forbidden` pour un membre). */
            strategy_version?: number;
        };
        RunAccepted: {
            /** Format: uuid */
            run_id: string;
            state: components["schemas"]["RunState"];
            poll_after_seconds?: number | null;
        };
        /** @description Cause nommée d'un run arrêté ou en échec (UX-04) : code stable (`instance_contact_missing`…), message lisible, marche à suivre pour l'agent (en anglais) et `retryable`. Absente quand la cause n'est pas nommée. */
        RunError: {
            code: components["schemas"]["ReasonCode"];
            message: string;
            what_to_do: string;
            retryable: boolean;
        };
        /** @description Enveloppe commune des sorties d'exécution (05 § 4.1), identique en MCP et en REST. */
        RunResult: {
            /** @description Dossier d'enquête enregistré à la création de l'API (réponse de create_api avec auto_validate seulement). */
            brief_version?: number;
            brief_report?: components["schemas"]["BriefReportEntry"][];
            /** @description Récit du dossier en gabarits fermés (narrative.brief.*), sans texte du dossier. */
            brief_narrative?: string[];
            /**
             * Format: uuid
             * @description Réponse de création d'API (`auto_validate`, enquête terminée pendant l'attente) : l'API créée, toujours présente.
             */
            api_id?: string;
            /** @description Réponse de création d'API (`auto_validate`, enquête terminée pendant l'attente) : le slug de l'API créée, toujours présent. */
            slug?: string;
            /** Format: uuid */
            run_id: string;
            state: components["schemas"]["RunState"];
            status: components["schemas"]["ApiStatus"];
            items: {
                [key: string]: unknown;
            }[];
            total: number | null;
            /** Format: uuid */
            dataset_id: string | null;
            truncated: boolean;
            next_cursor: string | null;
            degraded_reasons: components["schemas"]["ReasonCode"][];
            message: string;
            error?: components["schemas"]["RunError"];
            next_action: components["schemas"]["NextAction"] | null;
            poll_after_seconds: number | null;
            /** @description Enquête en cours : phase, stratégies déjà essayées, dernier essai et une phrase (anglais) pour le client, qui rappelle que SYM fait l'extraction ; `null` sinon. */
            progress?: {
                phase: string;
                strategies_tried: number;
                last_attempt: {
                    execution: string;
                    network: string;
                    result: string;
                } | null;
                message: string;
            } | null;
            timeline: {
                [key: string]: unknown;
            }[];
            cost: components["schemas"]["Cost"];
            console_url: string;
        };
        RunCancelled: {
            /** Format: uuid */
            run_id: string;
            /** @constant */
            state: "cancelled";
            cost: components["schemas"]["Cost"];
        };
        /** @description Métadonnées d'un run (état, coût, durée, nombre d'items) : seule vue de l'admin sur les runs d'autrui. */
        RunSummary: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            api_id: string;
            api_slug: string;
            /** Format: uuid */
            owner_id: string;
            strategy_version?: number | null;
            trigger: components["schemas"]["RunTrigger"];
            state: components["schemas"]["RunState"];
            outcome: components["schemas"]["RunOutcome"] | null;
            degraded_reasons: components["schemas"]["ReasonCode"][];
            failure_class: components["schemas"]["FailureClass"] | null;
            retryable?: boolean;
            error?: components["schemas"]["RunError"];
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            started_at: string | null;
            /** Format: date-time */
            finished_at: string | null;
            duration_ms: number | null;
            cost: components["schemas"]["Cost"];
            items: number | null;
            /** Format: uuid */
            dataset_id?: string | null;
            /** Format: date-time */
            retention_until?: string | null;
        };
        RunList: {
            runs: components["schemas"]["RunSummary"][];
            next_cursor: string | null;
        };
        /** @description Un essai de la cascade (exécution × réseau × résultat × coût) ; un essai élagué n'a pas été lancé (INV2). */
        RunAttempt: {
            index: number;
            execution: components["schemas"]["Execution"];
            network: components["schemas"]["Network"];
            /** @enum {string} */
            state: "running" | "done" | "pruned";
            pruned_reason?: string | null;
            est_cost_usd: number | null;
            /** @description `ok`, ou la classe d'échec de l'essai. */
            result: string | null;
            cost_usd: number | null;
            ms: number | null;
            model_id?: string | null;
            prompt_version?: string | null;
            engine?: string | null;
            tokens?: components["schemas"]["Tokens"];
            /** @description Onglet Erreur (Où, Quoi, Pourquoi, Que faire) en codes stables ; absent pour l'admin sur un run d'autrui. */
            error?: components["schemas"]["ReasonMessage"] | null;
            /** @description Étape reprise (`s3`…) ; null pour un essai de la cascade hors reprise par étape. */
            step_id?: string | null;
            /** @description Niveau de la reprise (1 localisateurs enregistrés sans LLM, 2 agent borné sur l'étape, 3 segment d'étapes). */
            step_level?: (1 | 2 | 3) | null;
            step_outcome?: components["schemas"]["StepOutcome"] | null;
            /** @description Diff de l'étape (patch RFC 6902 borné à `/steps/i/target`, `/steps/i/target/alternates` ou l'insertion d'une étape) ; null sans changement. */
            step_patch?: components["schemas"]["StepPatchOperation"][] | null;
        };
        /**
         * @description Issue d'une reprise d'étape (19 § 4, `run_attempts.step_outcome`).
         * @enum {string}
         */
        StepOutcome: "replayed" | "alternate" | "agent_repaired" | "failed";
        /** @description Opération RFC 6902 d'un patch d'étape ; `value` absent pour `remove`. */
        StepPatchOperation: {
            /** @enum {string} */
            op: "add" | "replace" | "remove";
            path: string;
            value?: unknown;
        };
        /** @description Détail d'un run (entité Run de 04b § 1) ; `metadata_only` pour l'admin face au run avec session d'autrui. */
        Run: components["schemas"]["RunSummary"] & {
            metadata_only: boolean;
            attempts: components["schemas"]["RunAttempt"][];
            tokens: components["schemas"]["Tokens"];
            /** @description Le run a été réparé seul par la reprise par étape (badge « réparée automatiquement », 19 § 4). */
            repaired_automatically?: boolean;
            trace_id?: string | null;
            /**
             * Format: date-time
             * @description Date de la pause demandée par l'utilisateur (`POST /api/runs/{id}/pause`) ; null hors pause, remis à null par `resume`.
             */
            paused_at?: string | null;
            /** @description Entrée du run ; absente pour l'admin sur un run d'autrui. */
            input?: {
                [key: string]: unknown;
            };
            /** @description Fiche de qualité du run (tâche 2.12, 19 § 3) : profil calculé par le code après la garde de classification et Ajv ; un champ `x-personal` n'a que des formes. Absente pour l'admin sur un run d'autrui. */
            quality?: components["schemas"]["RunQuality"] | null;
            /** @description Avis CONSULTATIF du juge (19 § 3) ; il ne change jamais le statut ni la version. */
            judge?: components["schemas"]["RunJudge"] | null;
        };
        RunQuality: {
            items: number;
            duplicates: number;
            duplicate_rate: number;
            fields: {
                [key: string]: components["schemas"]["FieldQuality"];
            };
        };
        FieldQuality: {
            type: string;
            personal: boolean;
            suspected_personal: boolean;
            fill_rate: number;
            sentinel_rate: number;
            top_pattern: string | null;
            patterns?: {
                [key: string]: number;
            };
            unique_rate: number;
            distinct?: number;
            constant: boolean;
            length: {
                min: number;
                max: number;
                mean: number;
            };
            /** @description Champs non personnels seulement. */
            min?: number;
            /** @description Champs non personnels seulement. */
            max?: number;
        };
        RunJudge: {
            flag: boolean;
            /** @enum {string} */
            trigger: "investigation" | "repair" | "anomaly";
            /** Format: date-time */
            at?: string;
            verdicts: {
                field: string;
                /** @enum {string} */
                verdict: "ok" | "wrong" | "unsure";
                indices: number[];
                reason: string;
            }[];
        };
        RunLogLine: {
            seq: number;
            /** Format: date-time */
            at: string;
            /** @enum {string} */
            level: "debug" | "info" | "warn" | "error";
            code: string;
            attempt?: number | null;
            data?: {
                [key: string]: unknown;
            };
        };
        RunLogList: {
            lines: components["schemas"]["RunLogLine"][];
            next_after: number | null;
        };
        DatasetItems: {
            items: {
                [key: string]: unknown;
            }[];
            next_cursor: string | null;
        };
        StrategyVersionSummary: {
            version: number;
            execution: components["schemas"]["Execution"];
            network: components["schemas"]["Network"];
            est_cost_usd: number | null;
            created_by: components["schemas"]["StrategyCreator"];
            parent_version: number | null;
            /** Format: date-time */
            created_at: string;
            validated_samples?: number | null;
            /**
             * Format: uuid
             * @description Enquête ou réparation qui a produit la version.
             */
            run_id?: string | null;
        };
        StrategyVersion: components["schemas"]["StrategyVersionSummary"] & {
            /** @description Stratégie déclarative (04b § 2), ou null si la version est un script. */
            spec: {
                [key: string]: unknown;
            } | null;
            script_ref: string | null;
            /** @description Patch RFC 6902 (version produite par une réparation). */
            patch?: {
                [key: string]: unknown;
            }[] | null;
        };
        /** @description Ensemble résolu des règles et skills d'une API (19 § 2) ; noms, versions, empreintes et jetons, jamais le contenu. */
        ResolvedRules: {
            /** @enum {string} */
            role: "investigate" | "repair" | "embedded";
            budget_tokens: number;
            tokens: number;
            rules: {
                name: string;
                version: number;
                /** @enum {string} */
                level: "instance" | "domain" | "api";
                tokens: number;
                sha256: string;
            }[];
            skills: {
                name: string;
                version: number;
                description: string | null;
                sha256: string;
            }[];
            truncated: {
                name: string;
                version: number;
                /** @enum {string} */
                level: "instance" | "domain" | "api";
                tokens: number;
            }[];
            skills_listing_truncated: boolean;
            skills_tokens: number;
        };
        StrategyVersionList: {
            versions: components["schemas"]["StrategyVersionSummary"][];
            next_cursor: string | null;
        };
        /** @description Diff à trois niveaux (06 § 2) ; la phrase est un code de raison avec ses paramètres. */
        StrategyDiff: {
            from: number;
            to: number;
            summary: components["schemas"]["ReasonMessage"];
            fields: {
                path: string;
                /** @enum {string} */
                change: "added" | "removed" | "changed";
                before?: unknown;
                after?: unknown;
            }[];
            raw: {
                before: {
                    [key: string]: unknown;
                } | null;
                after: {
                    [key: string]: unknown;
                } | null;
            };
        };
        StatusEvent: {
            id: string;
            /** Format: date-time */
            at: string;
            from_status: components["schemas"]["ApiStatus"] | null;
            to_status: components["schemas"]["ApiStatus"];
            transition?: number | null;
            reason: components["schemas"]["ReasonMessage"] | null;
            failure_class?: components["schemas"]["FailureClass"] | null;
            /** Format: uuid */
            run_id: string | null;
        };
        StatusEventList: {
            events: components["schemas"]["StatusEvent"][];
            next_cursor: string | null;
        };
        ScheduleRules: {
            only_if_tunnel_online?: boolean;
            window?: {
                start: string;
                end: string;
                days?: number[];
            } | null;
            max_runs_per_day?: number | null;
            /** @description Défaut `[erreur, action_requise, bloquee]` (on ne sollicite pas un site qui a refusé). */
            skip_if_status_in?: components["schemas"]["ApiStatus"][];
            dedup_key?: string | null;
            /** @enum {string|null} */
            diff?: "new" | "changed" | "removed" | "all" | null;
            alert_on?: ("new_items" | "status_change" | "error")[];
        };
        ScheduleWrite: {
            cron: string;
            timezone: string;
            /** @description Entrée du run ; variables datées `{{today}}`, `{{yesterday}}`. */
            input: {
                [key: string]: unknown;
            };
            /**
             * @default skip
             * @enum {string}
             */
            overlap: "skip" | "queue" | "allow";
            /**
             * @default once
             * @enum {string}
             */
            missed: "once" | "skip";
            rules?: components["schemas"]["ScheduleRules"];
            enabled?: boolean;
        };
        SchedulePatch: {
            cron?: string;
            timezone?: string;
            input?: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            overlap?: "skip" | "queue" | "allow";
            /** @enum {string} */
            missed?: "once" | "skip";
            rules?: components["schemas"]["ScheduleRules"];
            enabled?: boolean;
        };
        Schedule: {
            /** Format: uuid */
            id: string;
            api_slug: string;
            cron: string;
            timezone: string;
            input: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            overlap: "skip" | "queue" | "allow";
            /** @enum {string} */
            missed: "once" | "skip";
            rules: components["schemas"]["ScheduleRules"];
            enabled: boolean;
            paused_reason?: string | null;
            /** @description Prochaines exécutions calculées côté serveur (06 § 1, aucun composant cron dans la console). */
            next_runs: string[];
            /** Format: date-time */
            created_at: string;
        };
        ScheduleList: {
            schedules: components["schemas"]["Schedule"][];
        };
        /** @enum {string} */
        WebhookEvent: "run.succeeded" | "run.failed" | "api.status_changed" | "items.new" | "api.persistence_attempt";
        WebhookDelivery: {
            id: string;
            /** Format: date-time */
            at: string;
            /** @description Événement livré (`WebhookEvent`), ou `webhook.test` pour le bouton Tester. */
            event: string;
            attempt: number;
            status_code: number | null;
            duration_ms: number | null;
            excerpt?: string | null;
        };
        WebhookSubscription: {
            /** Format: uuid */
            id: string;
            url: string;
            events: components["schemas"]["WebhookEvent"][];
            /** @description API concernée, ou null pour l'alerte d'instance par défaut. */
            api_slug: string | null;
            /** @enum {string} */
            status: "active" | "disabled";
            /** Format: date-time */
            tested_at: string | null;
            /** Format: date-time */
            created_at: string;
            deliveries?: components["schemas"]["WebhookDelivery"][];
        };
        WebhookSubscriptionWrite: {
            /** Format: uri */
            url: string;
            events: components["schemas"]["WebhookEvent"][];
            /** @description API dont les événements sont livrés ; absent ou null, toutes les API du propriétaire. */
            api_slug?: string | null;
        };
        WebhookSubscriptionPatch: {
            /** Format: uri */
            url?: string;
            events?: components["schemas"]["WebhookEvent"][];
            /** @enum {string} */
            status?: "active" | "disabled";
            /** @description Nouveau secret ; l'ancien reste accepté pendant la rotation (sauf si l'URL change dans la même requête). */
            rotate_secret?: boolean;
        };
        WebhookSubscriptionCreated: components["schemas"]["WebhookSubscription"] & {
            /** @description Secret `whsec_…`, renvoyé une seule fois (création ou rotation). */
            secret?: string;
        };
        WebhookSubscriptionList: {
            subscriptions: components["schemas"]["WebhookSubscription"][];
        };
        TestResult: {
            ok: boolean;
            /** Format: date-time */
            tested_at: string;
            /** @description Échec lisible, en code stable. */
            error?: components["schemas"]["ReasonMessage"] | null;
        };
        /** @enum {string} */
        LlmPreset: "zai" | "openrouter" | "vllm" | "ollama" | "deepseek" | "qwen" | "openai" | "anthropic" | "gemini" | "mistral" | "groq" | "custom";
        LlmProfile: {
            tools?: boolean;
            tool_choice?: string[];
            /** @enum {string} */
            structured?: "json_schema" | "tool_forced" | "json_object" | "none";
            stream_tools?: boolean;
            stream_usage?: boolean;
            cache?: boolean;
            reasoning_field?: string | null;
            /** @description Paramètres d'échantillonnage acceptés par le modèle (mesurés par la sonde) ; un paramètre refusé n'est jamais envoyé. */
            sampling?: {
                temperature?: boolean;
                top_p?: boolean;
            };
        };
        /** @description USD par million de jetons ; nombres positifs ou nuls, `in` et `out` obligatoires (un prix négatif est refusé). */
        LlmPrice: {
            in: number;
            in_cached?: number;
            in_cache_write?: number;
            out: number;
            windows?: {
                [key: string]: unknown;
            }[];
            as_of?: string;
        };
        LlmModel: {
            profile?: components["schemas"]["LlmProfile"] | null;
            price?: components["schemas"]["LlmPrice"] | null;
            extra_body?: {
                [key: string]: unknown;
            };
        };
        LlmRole: {
            provider: string;
            model: string;
            fallback?: {
                provider: string;
                model: string;
            } | null;
            provider_routing?: {
                [key: string]: unknown;
            };
        };
        LlmRoles: {
            investigate?: components["schemas"]["LlmRole"];
            repair?: components["schemas"]["LlmRole"];
            extract?: components["schemas"]["LlmRole"];
            agent?: components["schemas"]["LlmRole"];
            /** @description Juge de qualité consultatif (tâche 2.12, 19 § 3), actif seulement avec `judge.enabled`. */
            judge?: components["schemas"]["LlmRole"];
            /** @description Propositions de règles, toujours validées par un humain (19 § 5). */
            reflect?: components["schemas"]["LlmRole"];
            /** @description Embeddings de l'étage 4 de la mémoire du catalogue (option désactivée, `catalog_memory.embeddings`). */
            embed?: components["schemas"]["LlmRole"];
        };
        LlmProviderBase: {
            id: string;
            preset: components["schemas"]["LlmPreset"];
            base_url: string;
            timeout_ms?: number;
            max_retries?: number;
            /** @description Modèles du fournisseur (au plus 50), indexés par identifiant. En écriture (`PUT /api/settings/llm`), la requête est FUSIONNÉE avec la table enregistrée, modèle par modèle puis clé par clé : un modèle ou une clé absents de la requête sont gardés (le prix survit à toute écriture qui ne le mentionne pas) ; `models[m].price: null` (ou `profile`, `extra_body`) retire cette clé ; `models[m]: null` retire le modèle entier. La table fusionnée est bornée à 50 modèles (sinon `too_many_models`, 400). */
            models?: {
                [key: string]: components["schemas"]["LlmModel"] | null;
            };
        };
        LlmProvider: components["schemas"]["LlmProviderBase"] & {
            api_key_set: boolean;
            headers_set: boolean;
            /** @description Secret illisible (`secret_unreadable`, 06 § 4.2) ; à ressaisir. */
            api_key_unreadable?: boolean;
        };
        LlmProviderWrite: components["schemas"]["LlmProviderBase"] & {
            /** @description Écriture seule ; absent = clé conservée. */
            api_key?: string;
            /** @description En-têtes personnalisés, chiffrés comme la clé ; écriture seule. */
            headers?: {
                [key: string]: string;
            };
        };
        LlmSettingsCommon: {
            roles?: components["schemas"]["LlmRoles"];
            redact?: {
                enabled?: boolean;
                patterns?: string[];
            };
            log_prompts?: {
                enabled?: boolean;
                retention_days?: number;
            };
            /** @description Juge consultatif (tâche 2.12, 19 § 3) : désactivé par défaut, activé par l'admin avec l'avertissement « juge non étalonné, avis consultatif » ; son fournisseur s'ajoute à la mention fournisseur. */
            judge?: {
                enabled?: boolean;
            };
            /** @description Mémoire du catalogue (19 § 2) ; l'étage 4 par embeddings est une option désactivée (pgvector requis). */
            catalog_memory?: {
                embeddings?: boolean;
            };
        };
        LlmSettings: components["schemas"]["LlmSettingsCommon"] & {
            providers: components["schemas"]["LlmProvider"][];
            /** @description Statut « modèle validé » du banc d'évaluation (15 § 11), en lecture seule : copie de eval/validated-models.json (produit par `pnpm eval --level N2`). Un modèle configuré absent de la liste n'a jamais été mesuré : « non validé ». */
            readonly validated_models?: components["schemas"]["ValidatedModel"][];
            /** @description Prix connus (UX-11), en lecture seule : table versionnée de la couche LLM (USD par million de jetons) qui pré-remplit le prix d'un modèle reconnu par son nom. Le prix saisi dans `providers[].models[m].price` fait foi. */
            readonly known_prices?: components["schemas"]["KnownModelPrice"][];
        };
        KnownModelPrice: {
            model: string;
            provider: string;
            /**
             * @description `verified` : prix relevé dans le dépôt ; `to_validate` : aucun prix relevé, à saisir.
             * @enum {string}
             */
            status: "verified" | "to_validate";
            price: {
                in: number;
                out: number;
                in_cached?: number;
            } | null;
            source: string;
            as_of?: string;
        };
        ValidatedModel: {
            model_id: string;
            /** Format: date */
            date: string;
            /** @enum {string} */
            status: "validated" | "not_validated";
            /** @enum {string} */
            level: "N2";
            blocking_rules?: string[];
        };
        LlmSettingsWrite: components["schemas"]["LlmSettingsCommon"] & {
            providers: components["schemas"]["LlmProviderWrite"][];
        };
        LlmProbeRequest: {
            provider: string;
            model: string;
        };
        LlmProbeResult: components["schemas"]["TestResult"] & {
            profile?: components["schemas"]["LlmProfile"] | null;
        };
        /**
         * @description `dc` : serveur ; `res` : résidentiel, opt-in par API (08 § 2).
         * @enum {string}
         */
        ProxyType: "dc" | "res";
        ProxyPrice: {
            per_gb_usd?: number | null;
            per_request_usd?: number | null;
        };
        Proxy: {
            /** Format: uuid */
            id: string;
            label: string;
            type: components["schemas"]["ProxyType"];
            /** @description Schéma, hôte et port, sans identifiants. */
            url: string;
            username_set: boolean;
            password_set: boolean;
            params: {
                [key: string]: string;
            };
            username_template?: string | null;
            price: components["schemas"]["ProxyPrice"];
            /** Format: date-time */
            tested_at: string | null;
        };
        ProxyWrite: {
            label: string;
            type: components["schemas"]["ProxyType"];
            url: string;
            username?: string;
            password?: string;
            params?: {
                [key: string]: string;
            };
            username_template?: string | null;
            price?: components["schemas"]["ProxyPrice"];
        };
        ProxyPatch: {
            label?: string;
            url?: string;
            username?: string;
            password?: string;
            params?: {
                [key: string]: string;
            };
            username_template?: string | null;
            price?: components["schemas"]["ProxyPrice"];
        };
        ProxyList: {
            proxies: components["schemas"]["Proxy"][];
        };
        ProxyTestResult: components["schemas"]["TestResult"] & {
            exit_ip?: string | null;
            exit_country?: string | null;
        };
        SmtpSettings: {
            host: string;
            port: number;
            /** @enum {string} */
            security: "tls" | "starttls" | "none";
            from: string;
            username_set: boolean;
            password_set: boolean;
            /** Format: date-time */
            tested_at: string | null;
        };
        SmtpSettingsWrite: {
            host: string;
            port: number;
            /** @enum {string} */
            security: "tls" | "starttls" | "none";
            from: string;
            username?: string;
            password?: string;
        };
        SecuritySettings: {
            session_idle_minutes: number;
            session_absolute_hours: number;
            allowed_email_domains: string[];
            api_key_max_lifetime_days: number;
            audit_retention_months?: number;
        };
        IdentitySettings: {
            /** @description Réglage admin ; null tant qu'il n'est pas posé (le worker retombe sur IDENTIFY_INSTANCE, puis sur désactivé). */
            identify_instance: boolean | null;
            /** @description Valeur que le worker applique : le réglage, sinon IDENTIFY_INSTANCE publiée par le worker, sinon désactivé ; null sans réglage tant qu'aucun worker n'a publié son environnement. */
            identify_effective: boolean | null;
            /**
             * @description Origine de identify_effective : réglage admin, environnement du worker, ou défaut (désactivé).
             * @enum {string|null}
             */
            identify_source: "setting" | "env" | "default" | null;
            /** @description Contact d'instance normalisé (URL http(s) ou mailto:) ; null tant qu'il n'est pas posé (repli : INSTANCE_CONTACT). */
            instance_contact: string | null;
            /** @description Contact que le worker annonce : le réglage, sinon INSTANCE_CONTACT publiée par le worker ; null si aucun. */
            instance_contact_effective: string | null;
            /**
             * @description Origine de instance_contact_effective : réglage ou environnement du worker.
             * @enum {string|null}
             */
            instance_contact_source: "setting" | "env" | null;
            /** @description Moteur embarqué tel que le worker le publie ; null tant qu'aucun worker n'a démarré. */
            engine: {
                version: string;
                platform: string;
            } | null;
            /** @description Version que le worker annonce dans le jeton (sa RUNTIME_VERSION), publiée avec son moteur ; null pour un worker qui ne la publie pas. */
            worker_version: string | null;
            /** @description User-Agent réel du moteur (lecture seule, sans HeadlessChrome). */
            user_agent: string | null;
            /** @description Le même User-Agent suivi du jeton compatible; Scrapyomama/<version du worker>; +<contact appliqué>, tel qu'il part quand l'identification est activée. */
            user_agent_identified: string | null;
            product_version: string;
        };
        IdentitySettingsWrite: {
            identify_instance?: boolean;
            /** @description URL http(s), mailto: ou adresse électronique, sans espace ni saut de ligne ; null efface le réglage. */
            instance_contact?: string | null;
        };
        SsoCommon: {
            enabled?: boolean;
            slug?: string;
            label?: string;
            issuer_url?: string;
            client_id?: string;
            sso_required?: boolean;
            /** @description Création à la volée (13 § 7), désactivée par défaut ; activée, `domains` doit compter au moins un domaine (sinon 400 `invalid_settings`). */
            jit_provisioning?: {
                enabled?: boolean;
                domains?: string[];
            };
            /** @description Correspondance groupe d'IdP → rôle ; `owner` n'est jamais attribuable. */
            group_roles?: {
                group: string;
                /** @enum {string} */
                role: "member" | "admin";
            }[];
        };
        SsoSettings: components["schemas"]["SsoCommon"] & {
            client_secret_set: boolean;
        };
        SsoSettingsWrite: components["schemas"]["SsoCommon"] & {
            /** @description Écriture seule ; absent = secret conservé. */
            client_secret?: string;
        };
        SsoPublic: {
            enabled: boolean;
            sso_required: boolean;
            providers: {
                slug: string;
                label: string;
            }[];
        };
        /** @enum {string} */
        UserStatus: "invited" | "active" | "disabled";
        User: {
            /** Format: uuid */
            id: string;
            email: string;
            display_name: string;
            role: components["schemas"]["Role"];
            status: components["schemas"]["UserStatus"];
            mfa_enabled: boolean;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            last_login_at: string | null;
            /** Format: date-time */
            disabled_at?: string | null;
        };
        UserList: {
            users: components["schemas"]["User"][];
            next_cursor: string | null;
        };
        UserPatch: {
            /** @enum {string} */
            role?: "member" | "admin";
            /** @enum {string} */
            status?: "active" | "disabled";
        };
        OneTimeLink: {
            link: string;
            /** Format: date-time */
            expires_at: string;
        };
        OwnerTransferRequest: {
            /** Format: uuid */
            to_user_id: string;
            current_password?: components["schemas"]["CurrentPassword"];
            totp_code: string;
        };
        Invitation: {
            /** @description Langue de l'e-mail d'invitation (`invitations.locale`), choisie par l'invitant ; copiée dans `users.locale` à l'acceptation. Donnée personnelle de l'invité (17 § 6). */
            locale: string;
            /** Format: uuid */
            id: string;
            email: string;
            /** @enum {string} */
            role: "member" | "admin";
            /** Format: uuid */
            invited_by: string;
            /** Format: date-time */
            expires_at: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            accepted_at: string | null;
            /** Format: date-time */
            revoked_at: string | null;
        };
        InvitationList: {
            invitations: components["schemas"]["Invitation"][];
        };
        InvitationCreate: {
            email: string;
            /**
             * @description `admin` seulement si l'invitant est l'owner.
             * @enum {string}
             */
            role: "member" | "admin";
            /** @description Langue de l'e-mail (code d'une langue livrée) ; par défaut la langue de l'invitant. */
            locale?: string;
        };
        InvitationCreated: components["schemas"]["Invitation"] & {
            emailed: boolean;
            /** @description Lien copiable, affiché une fois, seulement sans SMTP ; null si envoyé par e-mail. */
            link: string | null;
        };
        InvitationAccept: {
            token: string;
            password: string;
            display_name?: string;
        };
        AuthSession: {
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            last_seen_at: string | null;
            /** Format: date-time */
            expires_at: string;
            ip?: string | null;
            user_agent?: string | null;
            current: boolean;
        };
        AuthSessionList: {
            sessions: components["schemas"]["AuthSession"][];
        };
        /** @description Mot de passe actuel (ré-authentification, 13 § 5, ASVS 7.5.1). Compte à mot de passe local : exigé (absent → 400 `current_password_required` ; faux → 403 `reauth_failed` ; 5 échecs sur 15 min, toutes opérations sensibles confondues → 429 `too_many_attempts` et session fermée). Compte sans mot de passe local (OIDC seul) : facultatif et ignoré, une connexion de moins de 10 minutes fait foi (sinon 403 `reauth_required` : se reconnecter chez le fournisseur d’identité, sans échec compté). */
        CurrentPassword: string;
        /** @description Ré-authentification (session récente exigée). */
        PasswordConfirmation: {
            current_password?: components["schemas"]["CurrentPassword"];
        };
        SecondFactorCode: {
            /** @description Code TOTP (6 chiffres) ou code de secours. */
            code: string;
        };
        SecondFactorResult: {
            ok: boolean;
            /** @enum {string} */
            method: "totp" | "backup_code";
            backup_codes_remaining?: number;
            notices?: components["schemas"]["AccountNotices"];
        };
        /** @description Signalements au titulaire, montrés une fois après une authentification complète (ex. `password_reset_by_operator` - lien émis par la commande serveur, 13 § 4 ; `password_reset_withheld` - lien par e-mail retenu, relais SMTP réglé par un admin depuis moins de 24 h et compte sans 2FA). */
        AccountNotices: {
            code: string;
            /** Format: date-time */
            at: string;
        }[];
        /** @description Changement du mot de passe depuis Mon compte (ré-authentification par le mot de passe actuel). */
        PasswordChange: {
            current_password?: components["schemas"]["CurrentPassword"];
            new_password: string;
        };
        PasswordChanged: {
            /** @description Autres sessions d'interface ouvertes du compte, restées ouvertes ; la console propose de les fermer. */
            other_sessions: number;
        };
        /** @description Ré-authentification et second facteur (code TOTP ou code de secours), limité par compte. */
        PasswordAndCode: {
            current_password?: components["schemas"]["CurrentPassword"];
            code: string;
        };
        /** @description Ré-authentification avant liaison ; `code` exigé si le compte a une 2FA. */
        OidcLinkRequest: {
            current_password?: components["schemas"]["CurrentPassword"];
            code?: string;
        };
        OidcLinkStart: {
            /** Format: uri */
            authorization_url: string;
        };
        LinkedIdentity: {
            /** Format: uuid */
            id: string;
            /** @description Fournisseur, sous la forme `oidc:<slug>`. */
            provider: string;
            issuer: string;
            /** Format: date-time */
            created_at: string | null;
        };
        LinkedIdentityList: {
            identities: components["schemas"]["LinkedIdentity"][];
        };
        PasswordResetRequest: {
            email: string;
        };
        PasswordReset: {
            token: string;
            password: string;
            /** @description Code TOTP ou code de secours, exigé si le compte a une 2FA. */
            code?: string;
        };
        TotpCode: {
            code: string;
        };
        TwoFactorEnrollment: {
            otpauth_uri: string;
            /** @description Graine base32, affichée une seule fois pendant l'enrôlement. */
            secret: string;
        };
        BackupCodes: {
            backup_codes: string[];
        };
        TwoFactorDisable: {
            current_password?: components["schemas"]["CurrentPassword"];
            /** @description Code TOTP ou code de secours. */
            code: string;
        };
        ResponsibleUseAck: {
            version: string;
            /** Format: date-time */
            acknowledged_at: string | null;
            /** @description Vrai tant que la version courante n'est pas cochée (la console affiche alors la page). */
            required: boolean;
        };
        /** @enum {string} */
        AuditOutcome: "success" | "denied" | "error";
        /** @description Événement d'audit ; `meta` ne contient ni secret, ni cookie, ni contenu, ni argument d'outil. */
        AuditEvent: {
            id: string;
            /** Format: date-time */
            at: string;
            /** Format: uuid */
            actor_user_id: string | null;
            /** @enum {string} */
            actor_via: "ui" | "apikey" | "mcp" | "sso" | "system";
            actor_ref?: string | null;
            action: string;
            target_type: string | null;
            target_id: string | null;
            outcome: components["schemas"]["AuditOutcome"];
            ip?: string | null;
            user_agent?: string | null;
            meta: {
                [key: string]: unknown;
            };
        };
        AuditEventList: {
            events: components["schemas"]["AuditEvent"][];
            next_cursor: string | null;
        };
        SubjectRequest: {
            /** @description Identifiant de la personne (e-mail, téléphone, identifiant de plateforme). */
            identifier: string;
            /** @enum {string} */
            kind?: "email" | "phone" | "other";
            /**
             * @description `own` : les données de l'appelant (contenu compris) ; `instance` : toute l'instance, réservé à l'admin et à l'owner, qui n'obtiennent que des métadonnées et les valeurs identifiantes (INV5). Défaut : `instance` pour l'admin, `own` pour un membre.
             * @enum {string}
             */
            scope?: "own" | "instance";
        };
        SubjectEraseRequest: components["schemas"]["SubjectRequest"] & {
            dry_run: boolean;
            /** @description Empreinte rendue par l'aperçu (`dry_run` à true), exigée pour effacer (sinon 409 `confirmation_required`). */
            confirmation?: string;
        };
        SubjectEraseResult: {
            dry_run: boolean;
            /** @description Occurrences par table (aperçu) ou supprimées. */
            counts: {
                [key: string]: number;
            };
            /** @description Ajoutée à la liste d'exclusion hachée (faux en aperçu). */
            excluded: boolean;
            /** @description Aperçu seulement - empreinte du plan, à renvoyer pour effacer. */
            confirmation?: string;
        };
        /** @description Ce que l'instance détient sur la personne dans la portée (1.8, D-26) : items, runs, journaux, événements d'enquête, artefacts. Contenu rendu au seul propriétaire des données (`content: true`), métadonnées sinon. */
        SubjectExport: {
            identifier: string;
            /** Format: date-time */
            generated_at: string;
            /** @enum {string} */
            scope: "owner" | "instance";
            content: boolean;
            subject_hashes: string[];
            excluded: boolean;
            dataset_items: {
                [key: string]: unknown;
            }[];
            runs: {
                [key: string]: unknown;
            }[];
            run_logs: {
                [key: string]: unknown;
            }[];
            investigation_events: {
                [key: string]: unknown;
            }[];
            run_artifacts: {
                [key: string]: unknown;
            }[];
        } & {
            [key: string]: unknown;
        };
        PairingCode: {
            /** @description Code à usage unique, valable 10 minutes. */
            code: string;
            /** Format: date-time */
            expires_at: string;
        };
        ExtensionPairingCodeRequest: {
            currentPassword?: components["schemas"]["CurrentPassword"];
        };
        ExtensionPairingCode: {
            /** @description Code à usage unique, valable 10 minutes. */
            code: string;
            /** Format: date-time */
            expiresAt: string;
        };
        ExtensionPairRequest: {
            code: string;
            deviceId: string;
            deviceLabel?: string;
        };
        ExtensionPaired: {
            /** @description Jeton d'appareil, jamais ré-affiché. */
            token: string;
            /** Format: date-time */
            expiresAt: string;
            email: string;
            deviceLabel: string | null;
        };
        ConnectedSite: {
            /** Format: uuid */
            id: string;
            domain: string;
            /** @description Faux = mode tunnel (les cookies restent dans le navigateur). */
            serverUseAllowed: boolean;
            hasServerCookies: boolean;
            /** Format: date-time */
            consentedAt: string;
            /** Format: date-time */
            capturedAt: string | null;
            /** Format: date-time */
            expiresAt: string | null;
        };
        ConnectedSiteList: {
            items: components["schemas"]["ConnectedSite"][];
        };
        ExtensionSession: {
            email: string;
            deviceLabel: string | null;
            /** Format: date-time */
            expiresAt: string | null;
            sites: components["schemas"]["ConnectedSite"][];
        };
        ExtensionSiteConnect: {
            serverUseAllowed: boolean;
        };
        ExtensionSiteCookies: {
            cookies: {
                name: string;
                value: string;
                domain: string;
                path: string;
                secure: boolean;
                httpOnly: boolean;
                /** @enum {string} */
                sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
                expirationDate?: number;
            }[];
        };
        ExtensionDevice: {
            /** Format: uuid */
            id: string;
            deviceLabel: string | null;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastSeenAt: string | null;
            /** Format: date-time */
            expiresAt: string;
            /** Format: date-time */
            revokedAt: string | null;
        };
        ExtensionDeviceList: {
            items: components["schemas"]["ExtensionDevice"][];
        };
        AdminExtensionDevice: components["schemas"]["ExtensionDevice"] & {
            /** Format: uuid */
            ownerId: string;
            ownerEmail: string;
        };
        AdminExtensionDeviceList: {
            items: components["schemas"]["AdminExtensionDevice"][];
        };
        Version: {
            /** @description Version de l'instance (SemVer, `RUNTIME_VERSION`). */
            server: string;
            /** @description Version attendue du schéma de base. */
            schema: number;
            /** @description Version minimale de l'extension acceptée à l'appairage. */
            min_extension: string;
            /** @description Version de la spécification MCP servie. */
            mcp_spec: string;
        };
        /** @description RFC 9728. */
        ProtectedResourceMetadata: {
            resource: string;
            authorization_servers?: string[];
            bearer_methods_supported?: string[];
            scopes_supported?: components["schemas"]["ApiKeyScope"][];
        } & {
            [key: string]: unknown;
        };
    };
    responses: {
        /** @description Erreur au format commun `{ error: { code, message } }` (le code est stable, jamais localisé). */
        Error: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ApiError"];
            };
        };
        /** @description Ré-authentification refusée (13 § 5) : `reauth_failed` (mot de passe actuel incorrect) ; `reauth_required` (compte OIDC seul dont la connexion date de plus de 10 minutes : se reconnecter chez le fournisseur d’identité) ; ou autre refus de l’opération (`forbidden`, `mfa_required`, `mfa_enforced`...). */
        ReauthError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ApiError"];
            };
        };
        /** @description Accepté ; run (ou enquête) à suivre par `GET /api/runs/{id}` ou le flux SSE (05 § 4.3). */
        Accepted: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["RunAccepted"];
            };
        };
        /** @description File pleine (08b § 3) ; `queue_full` au-delà de `MAX_CONCURRENT_RUNS` runs actifs sur l'instance, `user_queue_full` au-delà de `MAX_ACTIVE_RUNS_PER_USER` pour l'appelant, `key_rate_limited` au-delà de `MAX_RUNS_PER_KEY_PER_MINUTE` créations par clé d'API ; réessayer après `Retry-After`. Exception : `budget_exceeded` (budget USD du jour de l'appelant, `USER_BUDGET_DAILY_USD` : dépense du jour, enveloppes maximales des runs actifs et enveloppe du nouveau run, 08b § 3) n'a PAS de `Retry-After` et n'est pas réessayable avant minuit UTC. */
        QueueFull: {
            headers: {
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ApiError"];
            };
        };
    };
    parameters: {
        /** @description Identifiant de l'envoi (Standard Webhooks), stable d'une tentative à l'autre. */
        WebhookId: string;
        /** @description Horodatage Unix (secondes) de l'envoi. */
        WebhookTimestamp: string;
        /** @description Signature HMAC-SHA256 `v1,<base64>` de `id.timestamp.corps` (secret de la cible). */
        WebhookSignature: string;
        Id: string;
        Slug: string;
        Version: number;
        /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
        Cursor: string;
        Limit: number;
        /** @description Attente synchrone maximale en secondes (05 § 2) ; au-delà, 202 et run à suivre. */
        Wait: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Le processus répond. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
        };
    };
    getReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Prêt ; `initialized` vaut false tant que l'assistant n'a pas créé l'owner. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ready"];
                };
            };
            /** @description Pas prêt. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotReady"];
                };
            };
        };
    };
    postSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetupRequest"];
            };
        };
        responses: {
            /** @description Owner créé. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetupResult"];
                };
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    postSignIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SignInRequest"];
            };
        };
        responses: {
            /** @description Connecté ; le jeton de session ne sort que dans le cookie. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignInResult"];
                };
            };
            /** @description Identifiants invalides (réponse identique pour tout échec, 13 § 5). */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthError"];
                };
            };
            /** @description Trop de tentatives (par IP ou par compte). */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RateLimited"];
                };
            };
            503: components["responses"]["Error"];
        };
    };
    postSignOut: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description Session fermée. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        success?: boolean;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Error"];
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session ou null. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionInfo"] | null;
                };
            };
            503: components["responses"]["Error"];
        };
    };
    verifyTwoFactor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecondFactorCode"];
            };
        };
        responses: {
            /** @description Session complète (cookie), appareil reconnu. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecondFactorResult"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    requestPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetRequest"];
            };
        };
        responses: {
            /** @description Demande prise en compte (un e-mail part si le compte existe et si SMTP est configuré). */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "accepted";
                    };
                };
            };
            400: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    resetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordReset"];
            };
        };
        responses: {
            /** @description Mot de passe changé ; tous les accès du compte révoqués. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    startOidc: {
        parameters: {
            query?: {
                /** @description `login` (seule valeur). La liaison à un compte ouvert passe par `POST /api/me/identities/oidc` (ré-authentification). */
                intent?: "login";
                /** @description Jeton d'invitation à accepter par l'IdP (adresse vérifiée égale à celle de l'invitation). */
                invitation?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirection vers l'IdP, ou vers `/login?sso_error=<code>`. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    oidcCallback: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Vers la console (session ouverte), `/login?mfa=1` (second facteur attendu) ou `/login?sso_error=<code>`. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Identité. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            401: components["responses"]["Error"];
            503: components["responses"]["Error"];
        };
    };
    updateMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MePatch"];
            };
        };
        responses: {
            /** @description Identité mise à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    listApiKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Liste, sans aucun secret. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["ApiKey"][];
                    };
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    createApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiKeyCreate"];
            };
        };
        responses: {
            /** @description Clé créée. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiKeyCreated"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            429: components["responses"]["Error"];
        };
    };
    revokeApiKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Révoquée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    streamEvents: {
        parameters: {
            query?: never;
            header?: {
                "Last-Event-ID"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Flux d'événements. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    getVersion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Version"];
                };
            };
        };
    };
    getMetrics: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Texte d'exposition Prometheus (préfixe `scrapyomama_`, étiquettes bornées). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/plain": string;
                };
            };
            /** @description Jeton faux. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description METRICS_TOKEN absent (route fermée). */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getProtectedResourceMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Métadonnées. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProtectedResourceMetadata"];
                };
            };
        };
    };
    getOpenApi: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document OpenAPI 3.1. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getSsoInfo: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description État public du SSO. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SsoPublic"];
                };
            };
        };
    };
    listApis: {
        parameters: {
            query?: {
                status?: components["schemas"]["ApiStatus"];
                execution?: components["schemas"]["Execution"];
                network?: components["schemas"]["Network"];
                q?: string;
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page du catalogue. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiList"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    createApi: {
        parameters: {
            query?: {
                /** @description Attente synchrone maximale en secondes (05 § 2) ; au-delà, 202 et run à suivre. */
                wait?: components["parameters"]["Wait"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiCreate"];
            };
        };
        responses: {
            /** @description API créée ; schéma proposé à valider, ou résultat de run si `auto_validate`. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiCreated"] | components["schemas"]["RunResult"];
                };
            };
            202: components["responses"]["Accepted"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["QueueFull"];
            507: components["responses"]["Error"];
        };
    };
    importApi: {
        parameters: {
            query?: {
                confirm?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiExport"];
            };
        };
        responses: {
            /** @description Aperçu de l'import (aucune écriture). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiImportPreview"];
                };
            };
            /** @description API importée, enquête lancée. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiCreated"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["QueueFull"];
            507: components["responses"]["Error"];
        };
    };
    validateSchema: {
        parameters: {
            query?: {
                /** @description Attente synchrone maximale en secondes (05 § 2) ; au-delà, 202 et run à suivre. */
                wait?: components["parameters"]["Wait"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ValidateSchemaRequest"];
            };
        };
        responses: {
            /** @description Enquête terminée. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunResult"];
                };
            };
            202: components["responses"]["Accepted"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["QueueFull"];
        };
    };
    getApi: {
        parameters: {
            query?: {
                response_format?: "concise" | "detailed";
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fiche. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDetail"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    deleteApi: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprimée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    updateApi: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApiPatch"];
            };
        };
        responses: {
            /** @description Fiche à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDetail"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            /** @description `human_confirmation_required` : activation du mode « SYM ne lâche pas » (ou changement de son plafond) hors de la console, par une clé d'API, avec `what_to_do` ; `insufficient_scope` : clé sans `apis:write`. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    runApi: {
        parameters: {
            query?: {
                /** @description Attente synchrone maximale en secondes (05 § 2) ; au-delà, 202 et run à suivre. */
                wait?: components["parameters"]["Wait"];
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunRequest"];
            };
        };
        responses: {
            /** @description Run terminé (y compris dégradé, ou en échec de budget). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunResult"];
                };
            };
            202: components["responses"]["Accepted"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["QueueFull"];
            507: components["responses"]["Error"];
        };
    };
    reinvestigateApi: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["InvestigateRequest"];
            };
        };
        responses: {
            202: components["responses"]["Accepted"];
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            /** @description `human_confirmation_required` : API `bloquee` relancée hors de la console (clé d'API) ; `insufficient_scope` : clé sans `apis:write`. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["QueueFull"];
        };
    };
    exportApi: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Export, servi en fichier `<slug>.api.json` (clés triées). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiExport"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    getApiOpenApi: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document OpenAPI 3.1 réduit à cette API, pour générer des types (openapi-typescript). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listStrategyVersions: {
        parameters: {
            query?: {
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Versions, de la plus récente à la plus ancienne. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyVersionList"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    getStrategyVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
                version: components["parameters"]["Version"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyVersion"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    diffStrategyVersions: {
        parameters: {
            query: {
                against: number;
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
                version: components["parameters"]["Version"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Diff. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StrategyDiff"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    revertStrategyVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
                version: components["parameters"]["Version"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fiche à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDetail"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    confirmInstructedSteps: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstructedStepsConfirm"];
            };
        };
        responses: {
            /** @description Fiche à jour (`instructed.confirmed_by` et `confirmed_at` remplis). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDetail"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            /** @description `human_confirmation_required` : la confirmation est un acte humain, depuis la console. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            404: components["responses"]["Error"];
            /** @description `sha_mismatch` (étapes changées depuis l'affichage) ou `no_instructed_steps`. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    setInstructedMode: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InstructedModeWrite"];
            };
        };
        responses: {
            /** @description Fiche à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiDetail"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            /** @description `instructed_steps_unconfirmed`, `compilable` ou `no_instructed_steps` : le mode ne s'active pas. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getResolvedRules: {
        parameters: {
            query?: {
                /** @description Usage du plafond RULES_MAX_TOKENS (investigate et repair 3 000, embedded 1 000) ; défaut investigate. */
                role?: "investigate" | "repair" | "embedded";
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Règles injectées, skills listés, jetons et ce que les plafonds ont retiré (aucun contenu de règle). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResolvedRules"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    getApiBrief: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dernière version du dossier (comptes), faits du code par indice, version du dossier lue par chaque version de stratégie. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApiBriefView"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listStatusEvents: {
        parameters: {
            query?: {
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Transitions, de la plus récente à la plus ancienne. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StatusEventList"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listSchedules: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Planifications. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScheduleList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    createSchedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ScheduleWrite"];
            };
        };
        responses: {
            /** @description Planification créée. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Schedule"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    getSchedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Planification. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Schedule"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    deleteSchedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprimée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    updateSchedule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slug: components["parameters"]["Slug"];
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SchedulePatch"];
            };
        };
        responses: {
            /** @description Planification à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Schedule"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listRuns: {
        parameters: {
            query?: {
                /** @description Slug de l'API. */
                api?: string;
                state?: components["schemas"]["RunState"];
                trigger?: components["schemas"]["RunTrigger"];
                since?: string;
                until?: string;
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Runs (métadonnées seulement, jamais d'items). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunList"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run, avec sa cascade d'essais. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Run"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    cancelRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run annulé. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCancelled"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    pauseRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    resumeRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            202: components["responses"]["Accepted"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
            429: components["responses"]["QueueFull"];
        };
    };
    streamRunEvents: {
        parameters: {
            query?: never;
            header?: {
                "Last-Event-ID"?: string;
            };
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Flux d'événements (mêmes trames que `/api/events`). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            /** @description Run terminé et entièrement servi (`Last-Event-ID: end`) ; rien à rejouer, ne pas se reconnecter. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    listRunLogs: {
        parameters: {
            query?: {
                after?: number;
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Lignes du journal, en ordre croissant. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunLogList"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    getDatasetItems: {
        parameters: {
            query?: {
                /** @description CSV à cellules neutralisées (08b § 2) ; colonnes = propriétés du schéma de sortie dans leur ordre déclaré (ou `fields`). Un champ d'item hors des propriétés du schéma n'a pas de colonne CSV ; il reste dans JSON et NDJSON, ou se nomme par `fields`. */
                format?: "json" | "ndjson" | "csv";
                /** @description Curseur opaque du dernier item servi (`next_cursor`, ou en-tête `X-Next-Cursor`), ou `seq` en clair du dernier item reçu (rang dans le dataset, 0 pour le premier). */
                after?: string;
                /** @description Reprise d'un export coupé en cours de route : nombre d'items déjà reçus EN ENTIER (lignes NDJSON complètes, lignes CSV hors en-tête), avec les mêmes filtres ; l'export reprend à l'item suivant, sans doublon ni perte. */
                offset?: number;
                /** @description Nombre maximal d'items ; absent, l'export va jusqu'au bout du dataset, en flux. */
                limit?: number;
                /** @description Champs à garder, séparés par des virgules. */
                fields?: string;
                /** @description Champs à retirer, séparés par des virgules. */
                omit?: string;
                since?: string;
            };
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Items, écrits en flux (mémoire bornée) ; pièce jointe avec `nosniff` pour un export. CSV : cellules qui commencent par =, +, -, @, tabulation ou retour chariot préfixées d'une apostrophe (08b § 2). */
            200: {
                headers: {
                    /** @description Curseur de la suite quand `limit` arrête la page avant la fin du dataset. */
                    "X-Next-Cursor"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetItems"];
                    "application/x-ndjson": string;
                    "text/csv": string;
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listWebhookSubscriptions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Abonnements. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookSubscriptionList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    createWebhookSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookSubscriptionWrite"];
            };
        };
        responses: {
            /** @description Abonnement créé. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookSubscriptionCreated"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getWebhookSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Abonnement. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookSubscription"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    deleteWebhookSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprimé. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    updateWebhookSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookSubscriptionPatch"];
            };
        };
        responses: {
            /** @description Abonnement à jour ; `secret` présent seulement après une rotation. Changer l'URL fait tourner le secret (lié à sa destination), sans période de grâce : le nouveau secret est rendu une fois. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WebhookSubscriptionCreated"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    testWebhookSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Résultat du test. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TestResult"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    getLlmSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Réglages, secrets masqués. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmSettings"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    putLlmSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LlmSettingsWrite"];
            };
        };
        responses: {
            /** @description Réglages à jour, secrets masqués. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmSettings"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    testLlmProvider: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LlmProbeRequest"];
            };
        };
        responses: {
            /** @description Profil de capacités relevé, ou échec lisible. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LlmProbeResult"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listProxies: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Proxys, identifiants masqués. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProxyList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    createProxy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProxyWrite"];
            };
        };
        responses: {
            /** @description Proxy créé. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Proxy"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getProxy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Proxy. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Proxy"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    deleteProxy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprimé. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    updateProxy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProxyPatch"];
            };
        };
        responses: {
            /** @description Proxy à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Proxy"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    testProxy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Résultat du test. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProxyTestResult"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    getSmtpSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Réglages, ou null si non configuré. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SmtpSettings"] | null;
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    putSmtpSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SmtpSettingsWrite"];
            };
        };
        responses: {
            /** @description Réglages à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SmtpSettings"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    testSmtp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    to: string;
                };
            };
        };
        responses: {
            /** @description Résultat du test. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TestResult"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getSecuritySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Réglages. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecuritySettings"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    putSecuritySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SecuritySettings"];
            };
        };
        responses: {
            /** @description Réglages à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecuritySettings"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getIdentitySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Réglages et User-Agent du moteur. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdentitySettings"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    putIdentitySettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IdentitySettingsWrite"];
            };
        };
        responses: {
            /** @description Réglages à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdentitySettings"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getSsoSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Réglages, ou null si non configuré. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SsoSettings"] | null;
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    putSsoSettings: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SsoSettingsWrite"];
            };
        };
        responses: {
            /** @description Réglages à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SsoSettings"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    listUsers: {
        parameters: {
            query?: {
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Utilisateurs. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    deleteUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprimé. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    updateUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserPatch"];
            };
        };
        responses: {
            /** @description Compte à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    createResetLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Lien affiché une fois. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OneTimeLink"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    revokeUserAccess: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accès révoqués. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    resetUserTwoFactor: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description 2FA retirée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    transferOwnership: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OwnerTransferRequest"];
            };
        };
        responses: {
            /** @description Propriété transférée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            404: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    listInvitations: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Invitations. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    createInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationCreate"];
            };
        };
        responses: {
            /** @description Invitation créée. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationCreated"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    acceptInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationAccept"];
            };
        };
        responses: {
            /** @description Compte activé ; session d'interface ouverte (cookie). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            400: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    revokeInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Révoquée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    resendInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Invitation renvoyée. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationCreated"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    changeMyPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordChange"];
            };
        };
        responses: {
            /** @description Mot de passe changé. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasswordChanged"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    listMySessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sessions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthSessionList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    revokeMyOtherSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sessions fermées. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    revokeMySession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session fermée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    enrollTwoFactor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordConfirmation"];
            };
        };
        responses: {
            /** @description Graine à saisir dans l'application d'authentification (affichée une fois). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TwoFactorEnrollment"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    confirmTwoFactor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TotpCode"];
            };
        };
        responses: {
            /** @description 2FA active. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackupCodes"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    regenerateBackupCodes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordAndCode"];
            };
        };
        responses: {
            /** @description Nouveaux codes (affichés une fois). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BackupCodes"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    disableTwoFactor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TwoFactorDisable"];
            };
        };
        responses: {
            /** @description 2FA retirée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            429: components["responses"]["Error"];
        };
    };
    listMyIdentities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Identités liées. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LinkedIdentityList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    startOidcLink: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OidcLinkRequest"];
            };
        };
        responses: {
            /** @description Ouvrir `authorization_url` dans le navigateur ; le retour (`/api/auth/oidc/callback`) lie l'identité. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OidcLinkStart"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            409: components["responses"]["Error"];
            429: components["responses"]["Error"];
            502: components["responses"]["Error"];
        };
    };
    unlinkMyIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Identité retirée. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    listMyAuditEvents: {
        parameters: {
            query?: {
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Événements. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEventList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    getResponsibleUseAck: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Version courante de la page et date de lecture. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResponsibleUseAck"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    acknowledgeResponsibleUse: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: string;
                };
            };
        };
        responses: {
            /** @description Lecture enregistrée. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResponsibleUseAck"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    listAuditEvents: {
        parameters: {
            query?: {
                action?: string;
                actor?: string;
                outcome?: components["schemas"]["AuditOutcome"];
                since?: string;
                until?: string;
                /** @description Curseur opaque renvoyé par la page précédente (`next_cursor`). */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Événements. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEventList"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    exportAuditEvents: {
        parameters: {
            query?: {
                since?: string;
                until?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Une ligne JSON par événement (`AuditEvent`). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/x-ndjson": string;
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    eraseSubject: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubjectEraseRequest"];
            };
        };
        responses: {
            /** @description Comptes par table (aperçu ou effacement réalisé). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubjectEraseResult"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    exportSubject: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubjectRequest"];
            };
        };
        responses: {
            /** @description Données de la personne. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubjectExport"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    createPairingCode: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordConfirmation"];
            };
        };
        responses: {
            /** @description Code créé. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PairingCode"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    createExtensionPairingCode: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtensionPairingCodeRequest"];
            };
        };
        responses: {
            /** @description Code créé (seule apparition). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionPairingCode"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["ReauthError"];
            429: components["responses"]["Error"];
        };
    };
    pairExtension: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtensionPairRequest"];
            };
        };
        responses: {
            /** @description Jeton d'appareil (seule apparition). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionPaired"];
                };
            };
            400: components["responses"]["Error"];
            429: components["responses"]["Error"];
        };
    };
    getExtensionSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session de l'extension. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionSession"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    deleteExtensionSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fait. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    openExtensionTunnel: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Protocole changé (WebSocket). */
            101: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            403: components["responses"]["Error"];
            426: components["responses"]["Error"];
        };
    };
    connectExtensionSite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtensionSiteConnect"];
            };
        };
        responses: {
            /** @description Domaine déjà connecté, mode mis à jour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectedSite"];
                };
            };
            /** @description Domaine connecté. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectedSite"];
                };
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    disconnectExtensionSite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fait. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    putExtensionSiteCookies: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtensionSiteCookies"];
            };
        };
        responses: {
            /** @description Fait. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["Error"];
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
            409: components["responses"]["Error"];
        };
    };
    listExtensionDevices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Appareils. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExtensionDeviceList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    revokeExtensionDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fait. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listConnectedSites: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Domaines. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConnectedSiteList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    disconnectConnectedSite: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fait. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    listAdminTunnels: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Appareils. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminExtensionDeviceList"];
                };
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
        };
    };
    revokeAdminTunnel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fait. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Error"];
            403: components["responses"]["Error"];
            404: components["responses"]["Error"];
        };
    };
    webhookRunSucceeded: {
        parameters: {
            query?: never;
            header: {
                /** @description Identifiant de l'envoi (Standard Webhooks), stable d'une tentative à l'autre. */
                "webhook-id": components["parameters"]["WebhookId"];
                /** @description Horodatage Unix (secondes) de l'envoi. */
                "webhook-timestamp": components["parameters"]["WebhookTimestamp"];
                /** @description Signature HMAC-SHA256 `v1,<base64>` de `id.timestamp.corps` (secret de la cible). */
                "webhook-signature": components["parameters"]["WebhookSignature"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "type": "run.succeeded",
                 *       "timestamp": "2026-10-02T10:00:00.000Z",
                 *       "data": {
                 *         "api": "books-demo-a1b2c3",
                 *         "api_id": "00000000-0000-0000-0000-000000000001",
                 *         "run_id": "00000000-0000-0000-0000-000000000002",
                 *         "status": "sain",
                 *         "outcome": "clean",
                 *         "items": 20
                 *       }
                 *     }
                 */
                "application/json": components["schemas"]["WebhookRunSucceeded"];
            };
        };
        responses: {
            /** @description Reçu (2xx en 15 s, sinon nouvelle tentative au barème). */
            "2XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    webhookRunFailed: {
        parameters: {
            query?: never;
            header: {
                /** @description Identifiant de l'envoi (Standard Webhooks), stable d'une tentative à l'autre. */
                "webhook-id": components["parameters"]["WebhookId"];
                /** @description Horodatage Unix (secondes) de l'envoi. */
                "webhook-timestamp": components["parameters"]["WebhookTimestamp"];
                /** @description Signature HMAC-SHA256 `v1,<base64>` de `id.timestamp.corps` (secret de la cible). */
                "webhook-signature": components["parameters"]["WebhookSignature"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookRunFailed"];
            };
        };
        responses: {
            /** @description Reçu. */
            "2XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    webhookApiStatusChanged: {
        parameters: {
            query?: never;
            header: {
                /** @description Identifiant de l'envoi (Standard Webhooks), stable d'une tentative à l'autre. */
                "webhook-id": components["parameters"]["WebhookId"];
                /** @description Horodatage Unix (secondes) de l'envoi. */
                "webhook-timestamp": components["parameters"]["WebhookTimestamp"];
                /** @description Signature HMAC-SHA256 `v1,<base64>` de `id.timestamp.corps` (secret de la cible). */
                "webhook-signature": components["parameters"]["WebhookSignature"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookApiStatusChanged"];
            };
        };
        responses: {
            /** @description Reçu. */
            "2XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    webhookItemsNew: {
        parameters: {
            query?: never;
            header: {
                /** @description Identifiant de l'envoi (Standard Webhooks), stable d'une tentative à l'autre. */
                "webhook-id": components["parameters"]["WebhookId"];
                /** @description Horodatage Unix (secondes) de l'envoi. */
                "webhook-timestamp": components["parameters"]["WebhookTimestamp"];
                /** @description Signature HMAC-SHA256 `v1,<base64>` de `id.timestamp.corps` (secret de la cible). */
                "webhook-signature": components["parameters"]["WebhookSignature"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebhookItemsNew"];
            };
        };
        responses: {
            /** @description Reçu. */
            "2XX": {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
