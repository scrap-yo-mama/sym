<!-- Fichier généré par scripts/docs-reference.ts (`pnpm --filter @sym-browser/module docs:reference`) : ne pas éditer. -->

# Référence de l’API

Contrat `@sym/contracts/browser` 1.0.0, API REST `/v1`, Playwright 1.63.0, Chromium 153.0.8010.12. Authentification : `Authorization: Bearer <clé d’API>` (scopes ci-dessous). Document OpenAPI 3.1 complet : `GET /v1/openapi.json`.

## Opérations

### `POST /v1/sessions`

Crée une session (type par défaut `dedicated`) et attend qu’elle soit `running` ; `wait=false` rend la main en `pending`.

- Scope : `sessions:write`
- Statuts : `201`, `202`, `401`, `403`, `409`, `422`, `429`, `502`, `503`

### `GET /v1/sessions`

Liste paginée par curseur, tri par `createdAt` décroissant. Filtre par métadonnée : `metadata.{clé}={valeur}`.

- Scope : `sessions:read`
- Statuts : `200`, `401`, `403`, `422`

### `GET /v1/sessions/{id}`

Lit une session ; une session `running` reçoit des `connectUrls` à jeton neuf.

- Scope : `sessions:read`
- Statuts : `200`, `401`, `403`, `404`

### `DELETE /v1/sessions/{id}`

Libère la session (raison `released`) ; rejouable sans effet.

- Scope : `sessions:write`
- Statuts : `200`, `401`, `403`, `404`

### `POST /v1/sessions/{id}/extend`

Ajoute du temps, plafonné par la durée maximale du client.

- Scope : `sessions:write`
- Statuts : `200`, `401`, `403`, `404`, `409`, `422`

### `GET /v1/sessions/{id}/egress`

Compteurs de l’époque courante de l’egress de la session (demandes, refus, octets, budget, IP de sortie).

- Scope : `sessions:read`
- Statuts : `200`, `401`, `403`, `404`, `422`

### `PUT /v1/sessions/{id}/egress`

Remplace la politique d’egress à chaud : ouvre une nouvelle époque aux compteurs remis à zéro. Les identifiants d’un proxy amont ne sont ni stockés ni journalisés.

- Scope : `sessions:write`
- Statuts : `200`, `401`, `403`, `404`, `422`, `502`

### `GET /v1/version`

Served versions: product, API, contract, Playwright, Chromium, platform, minimum SDK.

- Scope : aucun
- Statuts : `200`

### `GET /v1/openapi.json`

This OpenAPI 3.1 document.

- Scope : aucun
- Statuts : `200`

## Champs de `POST /v1/sessions`

Tous facultatifs ; les défauts sont ceux de l’instance.

| Champ | Type |
|---|---|
| `type` | `shared`, `dedicated` |
| `id` | `string` |
| `region` | `string` |
| `timeoutSeconds` | `integer` |
| `idleTimeoutSeconds` | `integer` |
| `viewport` | `object` |
| `locale` | `string` |
| `timezoneId` | `string` |
| `userAgent` | `string` |
| `extraHTTPHeaders` | `object` |
| `geolocation` | `object` |
| `colorScheme` | `light`, `dark`, `no-preference` |
| `acceptDownloads` | `boolean` |
| `launchArgs` | `mute-audio`, `hide-scrollbars`, `disable-gpu`, `force-color-profile-srgb`, `disable-smooth-scrolling` [] |
| `egress` | `EgressPolicy` |
| `profile` | `object` |
| `storageState` | `object` |
| `recordings` | `object` |
| `liveView` | `object` |
| `metadata` | `object` |

## Connexions WebSocket

Chaque session `running` porte ses `connectUrls` : URL `ws(s)://` à jeton court (`?token=…`, 5 minutes) que tout client ouvre telle quelle. Le jeton peut aussi passer en `Authorization: Bearer` pour les clients qui envoient des en-têtes. Relire la session (`GET /v1/sessions/{id}`) rend des jetons neufs.

| Point | Rôle |
|---|---|
| `/v1/sessions/{id}/cdp` | CDP, protocole commun (sessions `dedicated`, type par défaut) ; `409 protocol_not_served` sur une session `shared` |
| `/v1/sessions/{id}/playwright` | Playwright natif (`chromium.connect`), client 1.63.x exigé (`428 playwright_version_mismatch` sinon) |

## Codes d’erreur

Forme de toute erreur : `{ "error": { "code", "message", "retryable", "what_to_do", "requestId" } }`. Le `code` est stable ; `what_to_do` suit `Accept-Language`.

| Code | Statut HTTP |
|---|---|
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `session_not_found` | 404 |
| `profile_locked` | 409 |
| `session_id_taken` | 409 |
| `idempotency_conflict` | 409 |
| `protocol_not_served` | 409 |
| `invalid_option` | 422 |
| `playwright_version_mismatch` | 428 |
| `quota_exceeded` | 429 |
| `capacity_exceeded` | 429 |
| `proxy_unreachable` | 502 |
| `no_node` | 503 |
