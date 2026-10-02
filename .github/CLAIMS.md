<!-- Generated from .github/claims.json by `pnpm vitrine:claims`. Do not edit by hand. -->
# Claims register

Every factual sentence of the public surfaces (README, landing, responsible-use page, repository description and image label)
comes from this register, with its proof and the date it was last reviewed. A claim marked `à relire` or `bloqué` is shown
nowhere. Source: `claims.json`.

## readme

| Id | English | Français | Proof | Reviewed | Status | Task |
|---|---|---|---|---|---|---|
| `stays-yours` | Stays yours. Self-hosted, bring your own model, and nothing is sent to us by default. | Reste chez toi. Auto-hébergé, ton propre modèle, et rien ne part chez nous par défaut. | `INV9`, `assert_no_telemetry`, `assert_otel_off_by_default` | 2026-10-02 | relu | 4.10 |
| `cheapest-route-first` | Cheapest route first. SYM tries the cheapest executor first (plain HTTP, then a real browser, then a model or an agent) and logs every attempt. | La route la moins chère d'abord. SYM essaie d'abord l'exécuteur le moins cher (HTTP simple, puis un vrai navigateur, puis un modèle ou un agent) et journalise chaque tentative. | `INV2`, `assert_cheapest_first_logged` | 2026-10-02 | relu |  |
| `six-executors` | Six executors. HTTP fetch, a real browser page, sandboxed scripts, model-shaped extraction, script plus agent steps and a full agent; a successful agent run compiles into a replayable strategy. | Six exécuteurs. Requête HTTP, page d'un vrai navigateur, scripts en bac à sable, extraction par modèle, étapes script plus agent et agent complet ; un run d'agent réussi se compile en stratégie rejouable. | `runtime/apps/worker/src/exec/strategy-executor.integration.test.ts`, `runtime/apps/worker/src/exec/agent-strategy.security.test.ts` | 2026-10-02 | relu |  |
| `guard-rails` | Guard rails. Strategy code runs in a sandbox, outgoing requests pass an SSRF guard, and requests to each domain are paced. | Des garde-fous. Le code d'une stratégie tourne dans un bac à sable, les requêtes sortantes passent par une garde SSRF, et les requêtes vers chaque domaine sont espacées. | `INV7`, `assert_sandbox`, `INV10`, `assert_ssrf_guard`, `assert_pacing_key_is_domain` | 2026-10-02 | relu |  |
| `own-session-consent` | Your session, with your consent. For sites behind a login, a browser extension runs steps through your own session, domain by domain, only after you agree. | Ta session, avec ton accord. Pour les sites derrière une connexion, une extension de navigateur exécute des étapes avec ta propre session, domaine par domaine, seulement après ton accord. | `INV5`, `assert_consent_before_capture`, `assert_tunnel_only_when_chosen` | 2026-10-02 | relu |  |
| `no-signup` | Open source and self-hosted: nothing to sign up for. | Libre et auto-hébergé : rien à quoi t'inscrire. | `assert_quickstart_no_egress` | 2026-10-02 | relu |  |
| `built-with-ai` | Much of this code and documentation was written with AI assistance, then reviewed, tested and run through CI. If something looks off, say so. | Une grande partie du code et de la documentation a été écrite avec l'aide d'une IA, puis relue, testée et passée en CI. Si quelque chose cloche, dis-le. | `.github/workflows/ci.yml` | 2026-10-02 | relu |  |
| `quickstart-replayed-by-ci` | The commands are the ones the CI replays on a blank instance. | Les commandes sont celles que la CI rejoue sur une instance vierge. | `assert_quickstart_replayed`, `assert_quickstart_compose_parity`, `runtime/tests/quickstart.integration.test.ts`, `runtime/tests/vitrine/readme.unit.test.ts` | 2026-10-02 | relu |  |

## responsible-use

| Id | English | Français | Proof | Reviewed | Status | Task |
|---|---|---|---|---|---|---|
| `robots-always-respected` | robots.txt is always respected. There is no option to ignore it. | robots.txt est toujours respecté. Il n'existe aucune option pour l'ignorer. | `INV11`, `assert_robots_respected` | 2026-10-02 | relu |  |
| `no-challenge-solving` | No captcha is ever solved, by SYM or by any third-party service. | Aucun captcha n'est résolu, ni par SYM ni par un service tiers. | `INV6`, `assert_no_circumvention` | 2026-10-02 | relu |  |
| `user-agent-engine-real` | SYM sends the standard User-Agent string of its bundled Chromium version (without the HeadlessChrome marker), the same one for its HTTP client, with no rotation and no fingerprint spoofing. Turn on instance identification to name yourself to sites. | SYM envoie la chaîne User-Agent standard de la version de Chromium embarquée (sans le marqueur HeadlessChrome), la même pour son client HTTP, sans rotation ni falsification d'empreinte. Active l'identification de l'instance pour te nommer auprès des sites. | `INV6`, `assert_user_agent_engine_real`, `assert_no_fingerprint_spoofing` | 2026-10-02 | bloqué (Publication bloquée tant que la divergence des client hints n'est pas arbitrée (17 §12, D-39).) |  |
| `stops-when-refused` | If a site refuses, SYM stops: no new IP, no other account to push through. | Si un site refuse, SYM s'arrête : pas de nouvelle IP, pas d'autre compte pour insister. | `INV6`, `assert_no_ip_change_after_refusal`, `assert_no_circumvention` | 2026-10-02 | relu |  |
| `no-telemetry-by-default` | Nothing is sent to us without your explicit consent: no telemetry by default, no update check. | Rien ne part chez nous sans ton accord explicite : aucune télémétrie par défaut, aucune vérification de version. | `INV9`, `assert_no_telemetry` | 2026-10-02 | relu | 4.10 |

## repo

| Id | English | Français | Proof | Reviewed | Status | Task |
|---|---|---|---|---|---|---|
| `repo-description` | Self-hosted, open-source web data over MCP: describe the data, approve the schema, get an API that repairs itself and stops when a site says no. | Données web libres et auto-hébergées, par MCP : décris les données, valide le schéma, obtiens une API qui se répare et s'arrête quand un site dit non. | `INV1`, `INV11`, `assert_robots_respected` | 2026-10-02 | à relire (Promet le serveur MCP (3.2) et la réparation, pas encore livrés : à relire au GO de la release (4.5), avant d'appliquer la description au dépôt et à l'étiquette OCI.) | 3.2 |
| `image-description-prerelease` | Scrapyomama (SYM): self-hosted, open-source web data runtime. Pre-release: the README says what is delivered. | Scrapyomama (SYM) : runtime de données web libre et auto-hébergé. Pré-version : le README dit ce qui est livré. | `LICENSE`, `runtime/deploy/docker-compose.prod.yml`, `.github/README.md` | 2026-10-02 | relu (Description de l'étiquette OCI tant que repo-description n'est pas relue.) |  |
