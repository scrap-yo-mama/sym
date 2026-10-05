// SPDX-License-Identifier: MIT
// Fichier généré par `pnpm --filter @sym-browser/sdk gen` (scripts/generate-client.ts) depuis `browserOpenApi`
// (@sym/contracts/browser) : ne pas modifier à la main.
export interface paths {
    "/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Liste paginée par curseur, tri par `createdAt` décroissant. Filtre par métadonnée : `metadata.{clé}={valeur}`. */
        get: operations["listSessions"];
        put?: never;
        /** @description Crée une session (type par défaut `dedicated`) et attend qu’elle soit `running` ; `wait=false` rend la main en `pending`. */
        post: operations["createSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Lit une session ; une session `running` reçoit des `connectUrls` à jeton neuf. */
        get: operations["getSession"];
        put?: never;
        post?: never;
        /** @description Libère la session (raison `released`) ; rejouable sans effet. */
        delete: operations["releaseSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}/extend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Ajoute du temps, plafonné par la durée maximale du client. */
        post: operations["extendSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}/egress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** @description Compteurs de l’époque courante de l’egress de la session (demandes, refus, octets, budget, IP de sortie). */
        get: operations["getSessionEgress"];
        /** @description Remplace la politique d’egress à chaud : ouvre une nouvelle époque aux compteurs remis à zéro. Les identifiants d’un proxy amont ne sont ni stockés ni journalisés. */
        put: operations["replaceSessionEgress"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getOpenApi"];
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
        UpstreamProxy: {
            /** @enum {unknown} */
            type: "http" | "https" | "socks5";
            host: string | unknown | unknown;
            port: number;
            username?: string;
            password?: string;
            /** @enum {unknown} */
            kind?: "isp" | "datacenter" | "enterprise";
        };
        EgressPolicy: {
            allowedHosts?: string[];
            ports?: number[];
            upstream?: components["schemas"]["UpstreamProxy"] | {
                profileId: string;
            };
            dnsViaProxy?: boolean;
            budgetBytes?: number;
            /** @enum {unknown} */
            onBudgetExceeded?: "cut" | "end";
        };
        EgressState: {
            epoch: number;
            requests: number;
            blocked: number;
            bytesIn: number;
            bytesOut: number;
            budgetBytes?: number;
            budgetExceeded: boolean;
            exitIp?: string;
            latencyMs?: number;
        };
        /** @enum {unknown} */
        EgressBlockReason: "domain_not_allowed" | "port_not_allowed" | "address_not_public" | "unresolvable" | "egress_closed" | "budget_exceeded";
        CreateSessionRequest: {
            /**
             * @default dedicated
             * @enum {unknown}
             */
            type: "shared" | "dedicated";
            /** Format: uuid */
            id?: string;
            region?: string;
            timeoutSeconds?: number;
            idleTimeoutSeconds?: number;
            viewport?: {
                width: number;
                height: number;
            };
            locale?: string;
            timezoneId?: string;
            userAgent?: string;
            extraHTTPHeaders?: {
                [key: string]: string;
            };
            geolocation?: {
                latitude: number;
                longitude: number;
                accuracy?: number;
            };
            /** @enum {unknown} */
            colorScheme?: "light" | "dark" | "no-preference";
            acceptDownloads?: boolean;
            launchArgs?: ("mute-audio" | "hide-scrollbars" | "disable-gpu" | "force-color-profile-srgb" | "disable-smooth-scrolling")[];
            egress?: components["schemas"]["EgressPolicy"];
            profile?: {
                id: string;
                /** @enum {unknown} */
                mode: "read" | "write";
            };
            storageState?: {
                cookies: Record<string, never>[];
                origins: Record<string, never>[];
            };
            recordings?: {
                trace?: boolean;
                har?: boolean;
                video?: boolean;
                console?: boolean;
                network?: boolean;
            };
            liveView?: {
                interactive?: boolean;
            };
            metadata?: {
                [key: string]: string;
            };
        };
        ExtendSessionRequest: {
            timeoutSeconds: number;
        };
        ConnectUrls: {
            cdp: string | null;
            playwright: string;
            bidi: null;
        };
        Session: {
            /** Format: uuid */
            id: string;
            /** @enum {unknown} */
            state: "pending" | "running" | "ended" | "timed_out" | "failed";
            /** @enum {unknown} */
            type: "shared" | "dedicated";
            nodeRegion?: string;
            connectUrls?: components["schemas"]["ConnectUrls"];
            liveViewUrl?: string;
            egress?: {
                exitIp?: string;
                latencyMs?: number;
            };
            /** Format: date-time */
            expiresAt: string;
            /** Format: date-time */
            createdAt: string;
            /** @enum {unknown} */
            endReason?: "released" | "timeout" | "idle" | "budget_exceeded" | "node_shutdown" | "crash" | "node_lost" | "quota";
            usage?: {
                seconds: number;
                bytesIn: number;
                bytesOut: number;
            };
            metadata?: {
                [key: string]: string;
            };
        };
        SessionPage: {
            data: components["schemas"]["Session"][];
            nextCursor: string | null;
        };
        VersionInfo: {
            /** @constant */
            product: "sym-browser";
            api: string;
            contract: string;
            playwright: string;
            chromium: string;
            platform: string;
            minSdk: string;
        };
        Error: {
            error: {
                /** @enum {unknown} */
                code: "unauthorized" | "forbidden" | "session_not_found" | "profile_locked" | "session_id_taken" | "idempotency_conflict" | "protocol_not_served" | "invalid_option" | "playwright_version_mismatch" | "quota_exceeded" | "capacity_exceeded" | "proxy_unreachable" | "no_node";
                message: string;
                retryable: boolean;
                what_to_do: string;
                requestId: string;
                details?: unknown;
            };
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listSessions: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                state?: "pending" | "running" | "ended" | "timed_out" | "failed";
                type?: "shared" | "dedicated";
                createdAfter?: string;
                createdBefore?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page de sessions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionPage"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `invalid_option` (limite, curseur, filtre) */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createSession: {
        parameters: {
            query?: {
                wait?: boolean;
            };
            header?: {
                "Idempotency-Key"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CreateSessionRequest"];
            };
        };
        responses: {
            /** @description Session `running` */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description Session `pending` (`wait=false`) */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `session_id_taken` ou `idempotency_conflict` */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `invalid_option`, avec `details[]` (`field`, `reason`) */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `quota_exceeded` ou `capacity_exceeded`, avec `Retry-After` */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `proxy_unreachable` */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `no_node`, avec `Retry-After` */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSession: {
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
            /** @description Session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `session_not_found` */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    releaseSession: {
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
            /** @description Session libérée */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `session_not_found` */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    extendSession: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExtendSessionRequest"];
            };
        };
        responses: {
            /** @description Session prolongée */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `session_not_found` */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `idempotency_conflict` */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `invalid_option` (durée, session terminée) */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSessionEgress: {
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
            /** @description Etat de l’egress */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EgressState"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `session_not_found` */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `invalid_option` (session terminée ou pas encore démarrée) */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    replaceSessionEgress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EgressPolicy"];
            };
        };
        responses: {
            /** @description Etat de la nouvelle époque */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EgressState"];
                };
            };
            /** @description `unauthorized` : clé absente, inconnue ou expirée */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `forbidden` : scope manquant */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `session_not_found` */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `invalid_option` (politique refusée, session terminée ou pas encore démarrée) */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description `proxy_unreachable` (nouvel amont injoignable ; politique courante inchangée) */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
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
            /** @description Versions servies */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VersionInfo"];
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
            /** @description Ce document (OpenAPI 3.1) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, never>;
                };
            };
        };
    };
}

/** Opérations de l’OpenAPI : méthode, chemin complet (serveur compris), paramètres par emplacement, corps JSON, clé requise. */
export const OPERATIONS = {
  listSessions: { method: 'GET', path: '/v1/sessions', pathParams: [], query: ["limit","cursor","state","type","createdAfter","createdBefore"], headers: [], body: false, auth: true },
  createSession: { method: 'POST', path: '/v1/sessions', pathParams: [], query: ["wait"], headers: ["Idempotency-Key"], body: true, auth: true },
  getSession: { method: 'GET', path: '/v1/sessions/{id}', pathParams: ["id"], query: [], headers: [], body: false, auth: true },
  releaseSession: { method: 'DELETE', path: '/v1/sessions/{id}', pathParams: ["id"], query: [], headers: [], body: false, auth: true },
  extendSession: { method: 'POST', path: '/v1/sessions/{id}/extend', pathParams: ["id"], query: [], headers: ["Idempotency-Key"], body: true, auth: true },
  getSessionEgress: { method: 'GET', path: '/v1/sessions/{id}/egress', pathParams: ["id"], query: [], headers: [], body: false, auth: true },
  replaceSessionEgress: { method: 'PUT', path: '/v1/sessions/{id}/egress', pathParams: ["id"], query: [], headers: [], body: true, auth: true },
  getVersion: { method: 'GET', path: '/v1/version', pathParams: [], query: [], headers: [], body: false, auth: false },
  getOpenApi: { method: 'GET', path: '/v1/openapi.json', pathParams: [], query: [], headers: [], body: false, auth: false },
} as const;

export type OperationId = keyof typeof OPERATIONS;
