# Audit de sécurité de SYM Browser (tâche 5.3)

Audit de la branche d'intégration `integ-browser-v1` (tâches 0.1 à 3.8, 5.1 et 5.5 fusionnées ; 2.6 pas encore livrée),
le 2026-10-02. Ligne 5.3 de `cdc/sym-browser/06-taches.md` : BINV1, BINV2, BINV6 et BINV7 (plus BINV3 et BINV8), relais
WSS, OWASP API Top 10 (2023), secrets, en-têtes, image (uid, seccomp, capacités). Critère : aucun constat bloquant ni
majeur ouvert, chaque invariant rejoué.

## 1. Résumé

| Gravité | Constats | Corrigés | Ouverts |
|---|---|---|---|
| Bloquant | 1 | 1 (S01) | 0 |
| Majeur | 10 | 10 (S02, S03, S04, S08, S09, S10, S11, S13, S14, S15) | 0 |
| Mineur | 15 | 6 (S05, S06, S07, S12, S16, S17) | 9, acceptés et documentés (§ 4) |
| Hors sécurité, bloquant pour la recette | 1 | 0 | 1 (R1 : rôles de production non câblés, § 5) |

Chaque correctif a commencé par un test rouge, nommé `audit 5.3 Snn` dans le code de test. Aucun test existant n'a été
désactivé ; trois tests ont été alignés sur un comportement volontairement durci (S04, S10, `authorizeConnection`).

## 2. Méthode

- Relecture adversariale du diff complet du module, en deux volets (passerelle et noyau ; nœud et image), puis
  vérification de chaque constat dans le code et par un test rouge avant correctif.
- Scénarios cherchés : contournement de l'egress par CDP ou par le protocole Playwright, fuite entre clients et entre
  sessions, jeton rejoué ou auto-renouvelé, SSRF par webhook, proxy amont ou egress, secrets dans les journaux, la base et
  les enregistrements, profils lisibles sans `MASTER_KEY` ou d'un autre client, déni de service (messages CDP géants,
  argon2id, files d'attente), image (uid, seccomp, capacités, setuid).
- Preuve de bout en bout : `tests/audit-securite.chromium.test.ts` rejoue S01, S02 et S03 sur vrai Chromium 153 au travers
  des deux relais (passerelle puis nœud), instance en mode `all` (PostgreSQL, vraies clés argon2id).

## 3. Constats corrigés

| ID | Gravité | Invariant, OWASP | Constat | Correctif | Test |
|---|---|---|---|---|---|
| S01 | Bloquant | BINV1 ; API5 | Le protocole Playwright natif ouvrait un CDP brut (`newCDPSession`, `newBrowserCDPSession`) : refus 409 du `/cdp` des sessions shared contourné (cibles des autres sessions du même Chromium chaud) et toutes les réécritures CDP de 04f § 4 évitées. `launch*` et `connect*` du serveur Playwright transmis aussi. | `rewritePlaywrightMessage` refuse ces méthodes (réponse d'erreur, rien transmis). Le CDP reste servi par `connectUrls.cdp` des sessions dedicated, réécritures comprises. | `apps/node/src/relay/rewrite.security.unit.test.ts`, `tests/audit-securite.chromium.test.ts` (`assert_session_isolation`) |
| S02 | Majeur | BINV1, BINV3 | `DOM.setFileInputFiles` (CDP) et `localDirectory` (Playwright) posaient n'importe quel fichier du nœud dans un champ fichier, puis la page pouvait l'envoyer (fichiers des autres sessions, même uid). Playwright 1.63 refuse déjà `localPaths` d'un client distant. | Chemins admis : `sessions/{id}/uploads/` seulement (normalisés, absolus) ; `localPaths` et `localDirectory` refusés. | idem, `tests/audit-securite.chromium.test.ts` |
| S03 | Majeur | BINV2 ; API7 | Navigation pilotée (`Page.navigate`, `Target.createTarget`, `goto`) vers `file://`, `chrome://`, `devtools://` : lecture du système de fichiers du nœud hors egress. | Schémas admis : http, https, about, data, blob. | idem (`assert_session_egress_enforced`) |
| S04 | Majeur | BINV3 ; API4 | `setDownloadBehavior` gardait `behavior` et `eventsEnabled` du client : `eventsEnabled:false` coupait les plafonds de téléchargement du nœud, `default` écrivait dans le dossier commun de `pwuser`. | Hors `deny` : `allowAndName` (Browser) ou `allow` (Page), dossier de la session, événements actifs. | `rewrite.security.unit.test.ts`, `node-relay.unit.test.ts` |
| S05 | Mineur | API8 | `Tethering.bind`, `Target.exposeDevToolsProtocol`, `Browser.crash*` transmis. | Refusés. | `rewrite.security.unit.test.ts` |
| S06 | Mineur | API4 | Un identifiant mal encodé (`%E0%A4%A`) levait une `URIError` dans l'upgrade du nœud : arrêt du processus (derrière `NODE_TOKEN`). | Décodage protégé, 404. | `apps/node/src/relay/node-relay.security.unit.test.ts` |
| S07 | Mineur | API4 | Relais du nœud : messages en attente avant l'ouverture de Chromium sans borne, ni délai d'ouverture. | Borne d'un plafond de message (1008), `handshakeTimeout` 10 s. | idem |
| S08 | Majeur | BINV1, BINV6 | La restauration d'un profil lisait la clé d'objet du registre sans la recalculer : un registre altéré faisait restaurer (et déchiffrer, l'AAD dérivant de la clé) le profil d'un autre client. | Clé d'objet exigée égale à `profileObjectKey(client, profil, version)`. | `packages/core/src/profiles/profile-store.unit.test.ts` |
| S09 | Majeur | BINV7 ; API5 | Une clé `sessions:read` recevait des `connectUrls` (jetons `symt_` de pilotage) : élévation lecture → pilotage. | `connectUrls` réservés à `sessions:write` ; la vue en direct en lecture seule reste servie. Écart assumé à 04 § 4 (« GET renouvelle les connectUrls »). | `apps/gateway/src/api/security.integration.test.ts` (`assert_access_authenticated`) |
| S10 | Majeur | BINV6 | `idempotency_keys.response_body` gardait 24 h les jetons `symt_` et `t=` en clair ; le rejeu rendait des jetons expirés. | Réponse gardée sans jetons ; rejeu relu en base, jetons neufs. | idem (`assert_secrets_protected`), `sessions.integration.test.ts` |
| S11 | Majeur | BINV6 | `extraHTTPHeaders` (dont `Authorization`, `Cookie`) et `storageState` (cookies de session) en clair dans `sessions.options`. | Valeurs masquées en base ; le nœud reçoit la demande intacte. | idem |
| S12 | Mineur | API8 | Ni `nosniff`, ni `Referrer-Policy`, ni protection de cadre (jetons dans les URL). | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`. | idem |
| S13 | Majeur | API4 | Relais WSS de la passerelle : file illimitée tant que le nœud n'a pas accepté, sans délai d'ouverture (plusieurs × 100 Mio). | Borne d'un plafond de message (1008), `handshakeTimeout` 10 s. | idem |
| S14 | Majeur | BINV7 ; API2 | `GET /v1/sessions/{id}/cdp/json/version` ouvert par un jeton en émettait un neuf de 300 s : jeton auto-renouvelable jusqu'à la fin de la session, même après révocation de la clé. | Jeton découvert borné à l'échéance du jeton présenté (`ConnectTokens.issue({notAfter})`). | `apps/gateway/src/relay/relay.integration.test.ts` |
| S15 | Majeur | API4 | argon2id (19 Mio, t=2) calculé sans borne pour toute clé bien formée, même inventée : ~3,8 Go pour 200 requêtes. | Concurrence bornée (cœurs, 2 au moins) et file de 64 ; au-delà 429 `capacity_exceeded` + `Retry-After`. Une clé déjà vérifiée ne coûte rien. | `packages/core/src/auth/api-key.unit.test.ts` |
| S16 | Mineur | BINV6 | `NODE_TOKEN`, `SYMB_METRICS_TOKEN`, `MASTER_KEY`, mot de passe de `DATABASE_URL` hors registre du masquage ; ni `whsec_`, ni jeton de vue `v1.…` reconnus. | Inscrits au chargement de la configuration ; motifs ajoutés. | `packages/core/src/service/log-secrets.unit.test.ts` |
| S17 | Mineur | BINV6 | HAR : seuls 4 en-têtes masqués (`X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token` en clair). | Motif étendu (auth, token, secret, api-key, csrf, session, signature, credential). | `packages/core/src/crypto/redact.unit.test.ts` |

## 4. Constats ouverts acceptés (mineurs)

| ID | Constat | Raison, mesure |
|---|---|---|
| A1 | Un nom déclaré dans `SYMB_PRIVATE_HOSTS` qui résout vers 127.0.0.1 ouvre la boucle locale du nœud à l'egress. | Choix d'exploitant (les bancs l'utilisent). À documenter dans le guide de déploiement : ne jamais déclarer de nom résolu en boucle locale en production. |
| A2 | Archives de profil : nombre d'entrées non plafonné (taille bornée). | Objet issu du propre stockage chiffré de l'instance (AAD liée au client et au profil). |
| A3 | Profil seccomp de Chromium (espaces de noms utilisateur autorisés) appliqué aussi à la passerelle en Compose multi-nœuds. | Nécessaire au bac à sable sans setuid ; passerelle : profil par défaut de Docker conseillé (`compose.nodes.yaml`). |
| A4 | Files sans borne : messages précoces d'un visionneur de vue en direct, nombre d'envois par session ; flux SSE sans limite par client. | Derrière authentification ; à borner avec la charge (5.2). |
| A5 | Traces Playwright : corps postés et captures DOM non nettoyés. | Données du client, dans son enregistrement chiffré au repos ; aucun secret de l'instance (le mot de passe du proxy amont n'atteint jamais Chromium). |
| A6 | Jeton de vue en direct (15 min) non lié à la clé émettrice ; jeton `symt_` non lié non plus (échéance ≤ 300 s, 1 h au plus, sans auto-renouvellement après S14). | Durée courte ; lier le jeton à la clé changerait le format (contrat). |
| A7 | Identifiant de session fourni par le client : 409 `session_id_taken` révèle l'existence d'un UUID d'un autre client. | UUID imprévisibles ; clé `(tenant_id, id)` envisageable au prochain changement de schéma. |
| A8 | Webhooks : tout port accepté (la garde SSRF s'applique : adresses privées, métadonnées, rebinding). | Restreindre à 80/443/8443 si un abus apparaît. |
| A9 | `idempotency_keys` purgée seulement au réemploi d'une clé ; file globale partagée entre clients. | Croissance bornée par les quotas ; à revoir avec 5.2. |

## 5. Constat hors sécurité bloquant pour la recette

**R1 — rôles de production non câblés.** `apps/gateway/src/runtime/runtime.ts` (tâche 5.1) assemble base, migrations,
première clé, pool Chromium, battement et `/readyz`, mais ne monte ni l'API REST `/v1` (2.2), ni le relais WSS (2.3), ni le
superviseur des sessions (1.2) : l'image ne sert que `/healthz`, `/readyz` et `/metrics`. Aucun chemin de production ne
lance donc de session (rien d'exploitable, mais BINV2 n'est tenu que par les appelants des bancs : `tests/helpers/all-mode.ts`,
`quickstart-instance.ts`). Tâche à ouvrir : brancher `createGatewayApi`, `registerRelay`, `SessionSupervisor` et
`createNodeRelay` dans `prepareRuntime` (mode `all` d'abord, puis `POST /internal/sessions` pour les modes séparés), en
imposant l'egress de session au lanceur dedicated.

## 6. Invariants rejoués

| Invariant | Tests (nommés) | Résultat |
|---|---|---|
| BINV1 Isolation | `assert_session_isolation` (1.3, 1.4, 1.7) ; S01, S02, S08 | vert |
| BINV2 Egress | `assert_session_egress_enforced` (1.5, 1.6, Compose) ; S03 | vert (C6 SOCKS5 : intermittence corrigée, sonde `/health` du conteneur) |
| BINV3 Destruction | `assert_session_teardown`, `drain_*` ; S04 | vert |
| BINV6 Secrets | `assert_secrets_protected` (0.3, 3.0, 3.1, 3.3) ; S10, S11, S16, S17 | vert |
| BINV7 Accès | `assert_access_authenticated` (2.1, 2.3, 3.2) ; S09, S14 | vert |
| BINV8 CDP | `assert_cdp_client_compat` (2.3, 2.8, 3.4) | vert |

## 7. Relais WSS, en-têtes, image

- Relais : authentification en `preValidation` avant tout octet vers le nœud ; `NODE_TOKEN` comparé à temps constant,
  jamais renvoyé ; plafond 1008 appliqué aux messages fragmentés ; ping 20 s ; messages re-sérialisés (clé JSON en double
  ramenée à la valeur contrôlée).
- En-têtes de l'API : `cache-control: no-store`, `x-request-id`, `nosniff`, `no-referrer`, `DENY` ; aucun CORS.
- Image (sondes de `scripts/image-checks.ts`, rejouées le 2026-10-02 sur l'image construite) : uid 1001 (`pwuser`),
  `Seccomp: 2`, `NoNewPrivs: 1`, `CapEff: 0000000000000000`, `tini` en PID 1, 0 binaire setuid ou setgid ; configuration
  invalide refusée (code 1, variable nommée) ; Compose : `cap_drop ALL` + `SYS_CHROOT` (nœud), `no-new-privileges`,
  port publié sur 127.0.0.1 par défaut.

## 8. Limites de l'audit

- Tests réseau IPv6 (`::1`) : non exécutables dans l'environnement d'audit (cloud sans IPv6), ni modifiés.
- Recette 24 (Render réel) et 25 (hôte distinct) hors périmètre ; charge (5.2) non mesurée.
