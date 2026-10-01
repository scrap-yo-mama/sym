Dockerfile, entrypoint et modèles de déploiement (tâches 0.1, 4.x). Guide pas à pas : [docs/deploiement.md](../docs/deploiement.md).

| Fichier | Rôle |
|---|---|
| `Dockerfile`, `entrypoint.sh` | Image unique (`RUNTIME_MODE=server\|worker\|all\|migrate`) ; une commande passée en argument est exécutée telle quelle (pré-déploiement `runtime migrate` des hébergeurs) ; la commande `runtime` est dans le PATH |
| `render.yaml` | Blueprint Render (cible de référence) : web, worker, base privée, `MASTER_KEY` générée et partagée |
| `docker-compose.prod.yml`, `install.sh` | Machine Docker (VPS, Coolify, Dokploy) : `install.sh` écrit le `.env` (clé, jeton, mot de passe), le fichier compose démarre postgres, migrate, server, worker |
| `verify.sh` | Contrôle d'une instance déployée, quelle que soit la cible : `/api/health`, `/api/ready`, `/api/version`, `/mcp` |
| `check-image-public.sh` | Piège GHCR : l'image est-elle tirable sans identifiant ? |
| `railway/template.yaml` | Description du modèle Railway (best-effort) |
| `heroku/` | `heroku.yml`, deux Dockerfile minces, `app.json` (best-effort) |

L'image est épinglée `X.Y.Z` dans chaque modèle (jamais `latest`) : release-please met ces fichiers à jour à chaque release (marqueurs `x-release-please-*`, `extra-files` génériques).

`TRUST_PROXY` (serveur) : défaut `false`, l'IP d'un client est celle de la connexion TCP. Derrière le proxy d'un hébergeur (Render, Railway, Heroku), poser `TRUST_PROXY=1` (un saut) ou la liste des IP/CIDR du proxy : sinon toutes les requêtes semblent venir du proxy et partagent les limites par IP. Ne jamais poser `true` sans proxy devant : un client choisirait son IP par `X-Forwarded-For`.

Observabilité (tâche 1.10, 14 § 3 et § 10) :

- `GET /api/health` : vivacité, sans accès base, `{status, version}` (`RUNTIME_VERSION`, défaut `0.0.0` : seule version publiée). `GET /api/ready` : 200, ou 503 avec les contrôles en échec (`database`, `schema`, `key_check`) ; chemin de contrôle des plateformes. `?detail=1` (administrateur connecté) ajoute workers vivants et profondeur de file.
- Schéma en retard (base vierge, image déployée avant `runtime migrate`) : le `server` démarre en **mode dégradé**, seules les deux sondes répondent (`/api/ready` = 503, `schema: false`), toute autre route répond 503 ; après `runtime migrate`, `/api/ready` passe à 200 sans redémarrage. Schéma plus récent que le code : refus de démarrer. Base vierge sans `ADMIN_BOOTSTRAP_TOKEN` : refus immédiat.
- `GET /api/version` (tâche 4.9, 16 §3) : `{server, schema, min_extension, mcp_spec}`, public, servi localement (aucune requête vers un serveur distant). `server` = `RUNTIME_VERSION` (posée à la construction de l'image par la chaîne de release : `docker build --build-arg RUNTIME_VERSION=X.Y.Z`). L'extension envoie sa version à l'appairage ; sous `min_extension`, l'instance répond 426 `extension_outdated` avec un message qui nomme la version requise, sans consommer le code d'appairage. Versions, canaux et vérification des signatures : `docs/release.md`.
- `/metrics` : **fermé par défaut** (404). `METRICS_TOKEN` (32 caractères minimum, `_FILE` accepté) l'ouvre ; `Authorization: Bearer` exigé (401 sinon). Métriques préfixées `scrapyomama_`, calculées depuis la base ; aucune version (ni Node, ni dépendance) n'y figure. Reportées : `llm_requests_total` et l'étiquette `role` de `llm_tokens_total` (2.1), `browser_crashes_total` (1.6), `sandbox_violations_total` (1.5), `tunnel_connected` (2.7).
- OpenTelemetry : **coupé par défaut**, ni l'API ni le SDK ne sont chargés (seule `@opentelemetry/semantic-conventions`, constantes importées par Better Auth, l'est). `OTEL_ENABLED=true` **et** `OTEL_EXPORTER_OTLP_ENDPOINT` (obligatoire, aucune destination implicite) ; `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` par défaut, ou `http/json`), `OTEL_EXPORTER_OTLP_HEADERS` (traité comme un secret), `OTEL_TRACES_SAMPLER` (`parentbased_traceidratio`), `OTEL_TRACES_SAMPLER_ARG` (0.1), `OTEL_SERVICE_NAME`. Aucun en-tête `traceparent`, `tracestate` ni `baggage` ne part vers les cibles, proxys ou LLM.
- Journal : `LOG_LEVEL` (`info`), JSON sur stdout, masqué. Artefacts de run : `ARTIFACTS_LEVEL` (`none` par défaut = aucun), `ARTIFACT_MAX_BYTES` (5 Mo), `ARTIFACT_QUOTA_MB` (500), `ARTIFACT_RETENTION_DAYS` (7, purge en 1.8) ; `RUN_LOG_RETENTION_DAYS` (30, purge en 1.8). `LOG_FORMAT=pretty` : non fourni (JSON seulement).
