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
        patch?: never;
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
        /** Crée une clé (ré-authentification par mot de passe) ; le secret n'apparaît qu'ici */
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ApiError: {
            error: {
                code: string;
                message: string;
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
        Me: {
            /** Format: uuid */
            id: string;
            email: string;
            displayName: string;
            role: components["schemas"]["Role"];
            /** @description Langue préférée (`users.locale`) ; la console n'affiche que `en` et `fr` et retombe sur `en` sinon. */
            locale: string;
            theme: components["schemas"]["Theme"];
            /** @enum {string} */
            via: "ui" | "apikey";
            /** @description Scopes de la clé d'API ; null pour une session d'interface. */
            scopes: components["schemas"]["ApiKeyScope"][] | null;
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
            currentPassword: string;
        };
        ApiKeyCreated: components["schemas"]["ApiKey"] & {
            /** @description Secret en clair, renvoyé une seule fois. */
            key: string;
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
    };
    parameters: never;
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
            403: components["responses"]["Error"];
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
            429: components["responses"]["Error"];
        };
    };
}
