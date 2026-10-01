Dockerfile, entrypoint et modèles de déploiement (tâches 0.1, 4.x).

`TRUST_PROXY` (serveur) : défaut `false`, l'IP d'un client est celle de la connexion TCP. Derrière le proxy d'un hébergeur (Render, Railway, Heroku), poser `TRUST_PROXY=1` (un saut) ou la liste des IP/CIDR du proxy : sinon toutes les requêtes semblent venir du proxy et partagent les limites par IP. Ne jamais poser `true` sans proxy devant : un client choisirait son IP par `X-Forwarded-For`.

Observabilité (tâche 1.10, 14 § 3 et § 10) :

- `GET /api/health` : vivacité, sans accès base. `GET /api/ready` : 200, ou 503 avec les contrôles en échec (`database`, `schema`, `key_check`) ; chemin de contrôle des plateformes. `?detail=1` (administrateur connecté) ajoute workers vivants et profondeur de file.
- `/metrics` : **fermé par défaut** (404). `METRICS_TOKEN` (32 caractères minimum, `_FILE` accepté) l'ouvre ; `Authorization: Bearer` exigé (401 sinon). Métriques préfixées `scrapyomama_`, calculées depuis la base.
- OpenTelemetry : **coupé par défaut**, aucun module chargé. `OTEL_ENABLED=true` **et** `OTEL_EXPORTER_OTLP_ENDPOINT` (obligatoire, aucune destination implicite) ; `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` par défaut, ou `http/json`), `OTEL_EXPORTER_OTLP_HEADERS` (traité comme un secret), `OTEL_TRACES_SAMPLER` (`parentbased_traceidratio`), `OTEL_TRACES_SAMPLER_ARG` (0.1), `OTEL_SERVICE_NAME`. Aucun en-tête `traceparent`, `tracestate` ni `baggage` ne part vers les cibles, proxys ou LLM.
- Journal : `LOG_LEVEL` (`info`), JSON sur stdout, masqué. Artefacts de run : `ARTIFACTS_LEVEL` (`none` par défaut = aucun), `ARTIFACT_MAX_BYTES` (5 Mo), `ARTIFACT_QUOTA_MB` (500), `ARTIFACT_RETENTION_DAYS` (7, purge en 1.8) ; `RUN_LOG_RETENTION_DAYS` (30, purge en 1.8). `LOG_FORMAT=pretty` : non fourni (JSON seulement).
