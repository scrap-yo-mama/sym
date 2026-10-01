# Bac à sable du code généré (INV7, tâche 1.5)

Spécification : CDC `08-specs-byo-securite.md` §3 (bac à sable) et §7, `15-strategie-tests.md` §7, `_index.md` INV7. Types : `@runtime/core` (`packages/core/src/sandbox/types.ts`). Tests : `sandbox.unit.test.ts` (borne de version, validation et fuzz des ponts, protocole), `sandbox.security.test.ts` (`assert_sandbox`, `pnpm test:security`).

## Architecture

- **`ProcessSandboxEngine`** (`engine.ts`) implémente `SandboxEngine { run(code, bridges, limits) }`. Un **processus enfant dédié par run** : `spawn(process.execPath, ['--no-node-snapshot', '--max-old-space-size=64', '--permission', '--allow-addons', '--allow-fs-read=<script de l'enfant et paquets du moteur>', child.js], { env: {} })`. L'enfant déclare ses variables à `ready` ; toute variable hors celles que la plateforme injecte d'elle-même (macOS : `__CF_USER_TEXT_ENCODING`) fait refuser le run (`env_not_empty`). L'enfant est tué par `SIGKILL` à la fin de **chaque** run.
- **Enfant** (`child.ts`) : héberge l'isolat, ne fait ni réseau ni fichier, relaie les appels par IPC. Il est traité comme compromis : le parent valide chaque message (`protocol.ts`) et tue l'enfant sur message invalide.
- **Isolat** : une seule fonction de l'hôte y entre (`ivm.Callback` en mode `ignored`), aucune `Reference` ni objet de l'hôte (surface de GHSA-864f-rcv7-6rh4). Valeurs échangées en chaînes JSON. Globals retirés et piégés (`require`, `process`, `fetch`, `WebSocket`, `EventSource`, `navigator`, `WebAssembly`, `SharedArrayBuffer`, `Atomics`…) : un accès lève et journalise `sandbox_violation` (`forbidden_global`).
- **Ponts** (`bridges.ts`, côté parent) : `ctx.fetch(url, init)` (schéma, tailles, méthodes `GET`/`HEAD`/`POST` par défaut, en-têtes d'identité et de secret interdits, **domaines de l'API seulement**, redirections suivies par le pont avec contrôle du domaine **avant** chaque saut, garde SSRF à chaque connexion, `set-cookie` retiré), `ctx.log(...)`, `ctx.emit(item)`, `input`. Quotas par run (requêtes, octets de réponse, éléments, journal).
- **Plafonds** : temps mur (`timeoutMs`, SIGKILL à l'échéance, y compris boucle après un `await` que le `timeout` d'isolated-vm ne couvre pas, issue #572) ; mémoire d'isolat (`memoryMb`, 128 par défaut, à valider) ; RSS du processus (`processMemoryMb`, défaut `3 × memoryMb + 192`, lue dans `/proc` sous Linux, déclarée par l'enfant ailleurs). `killLatencyMs` est mesuré sur la fin effective du processus.
- **Verdict** : une violation fait échouer le run (`outcome: 'violation'`), même si le script rattrape l'erreur ; un appel de pont lâché (promesse non attendue) est attendu avant le verdict.

## Version d'isolated-vm retenue : 7.0.1

Avis GHSA-864f-rcv7-6rh4 (critique, 2026-08-07) : versions `<= 7.0.0` affectées, **corrigées en 7.0.1 et 6.2.0**. Le CDC fixe 6.2.0 sur Node 24 et ≥ 7.0.1 sur Node 26. Constat terrain (2026-10-01) : 7.0.1 (`engines: >=24`) publie des binaires précompilés ABI 137 (Node 24) **et** ABI 147 (Node 26), glibc et musl, x64 et arm64 ; 6.2.0 s'arrête à ABI 137. 7.0.1 charge et passe `assert_sandbox` sur Node 24.21.0 et 26.10.0. Une seule version couvre donc la matrice sans second lockfile (pnpm n'installe qu'une version par importeur). `version.ts` refuse au démarrage du worker : 7.x < 7.0.1, 6.x < 6.2.0, 6.x sur Node ≥ 25, toute autre branche.

## Spike QuickJS (plan B, pas de production)

`quickjs-runner.ts` : `quickjs-emscripten-core` 0.32.0 + `@jitl/quickjs-wasmfile-release-sync` 0.32.0 (MIT), en **devDependencies**. Il tourne dans le même processus enfant, avec la même amorce et les mêmes ponts : la suite `assert_sandbox` passe sur les deux moteurs sans changer un pont (08 §7). Plafonds natifs : `setMemoryLimit`, `setMaxStackSize`, gestionnaire d'interruption à l'échéance.

Mesure locale (Apple M-series, Node 24.21, 3 essais, durée totale du run, démarrage de l'enfant ~50 ms compris) :

| Script | isolated-vm | QuickJS |
|---|---|---|
| trivial | ~49 ms | ~60 ms |
| boucle 2·10⁷ itérations | ~110 ms | ~1 000 ms |
| 20 000 objets, JSON aller-retour, filtre | ~57 ms | ~128 ms |

Soit ~15 fois plus lent en calcul pur, ~10 fois sur JSON (hors démarrage), dans la fourchette « 10 à 50 fois » du CDC. **Non retenu par défaut** : QuickJS pré-1.0 non audité, et la recette n'a pas encore ses scripts réels pour vérifier le plafond de temps. À réévaluer si isolated-vm casse sur une version de Node.

## Limites et risques résiduels

- Le mode permission de Node 24 n'a **pas de filtrage réseau** (pas de `--allow-net`) et `--allow-addons` l'affaiblit (avertissement `PERM0001`) : c'est une ceinture, pas une frontière. L'enfant n'ouvre aucun socket de lui-même ; la frontière réseau est l'absence de primitive dans l'isolat et le filtrage par le parent.
- Utilisateur sans droits : options `uid`/`gid` si le worker tourne en root ; l'image tourne déjà en `pwuser` (1001), l'enfant hérite de cet utilisateur.
- Coût : un processus par run (~50 ms de démarrage). Pool recyclé après N runs : à valider (08 §3).
- `ctx.page.*` (Playwright relayé) et `evaluate` côté page : tâche 1.6, sur ce même mécanisme de ponts.
- Matrice CI : `security` (ci.yml) sur Node 24 à chaque PR ; `sandbox-node-matrix` (nightly.yml, Node 24 et 26).
