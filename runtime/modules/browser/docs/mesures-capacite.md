# Mesures de capacité de SYM Browser (tâche 0.6)

Daté du 2026-10-02. Rapport de référence des constantes de capacité d'un nœud (`cdc/sym-browser/04b-specs-pool-noeuds.md` § 3, KPI K2 et K4 de `07-kpis.md`). Les résultats bruts (JSON, une entrée par répétition) sont dans `bench/results/` ; les tableaux ci-dessous sont générés par `node bench/report.ts`, sans retranscription.

## 1. Résumé

- **Constantes retenues** (code : `packages/core/src/capacity.ts`) : `BASE_BYTES` 512 Mio, `SLOT_BYTES` 768 Mio, poids `dedicated` 4 unités sur 4 (un slot), poids `shared` 3 unités sur 4, `CONTEXTS_PER_BROWSER` 6. Capacité : 2 Go → 2 slots, 4 Go → 4, 8 Go → 10 (formule de départ : 1, 2, 5).
- **Ce qui limite la capacité est la mémoire anonyme du cgroup, pas la somme des RSS.** Un Chromium `dedicated` (Chromium headless shell, mode de production du worker de SYM) pèse 442 Mio en RSS sommé, 218 Mio en PSS et **100 Mio dans le cgroup** sur une page typique ; 677 / 454 / **336 Mio** sur une page applicative lourde. La somme des RSS compte plusieurs fois les bibliothèques partagées de Chromium (pages de fichier, récupérables) : elle surestime d'un facteur 2 à 4,5 la mémoire que le noyau doit réellement fournir.
- **Les chiffres publiés** (690 à 1 094 Mo par Chromium, [08 hébergeurs](../../../../docs/sym-browser-protocole-deploiement/08-hebergeurs-un-clic.md)) sont des sommes de RSS : on les retrouve en RSS sommé (442 Mio pour le headless shell, 987 Mio pour le nouveau mode headless du Chromium complet, 677 Mio pour une page lourde). Ils ne peuvent pas servir tels quels à dimensionner un cgroup.
- **Démarrage** : un Chromium `dedicated` est prêt (lancement, connexion Playwright, contexte, page chargée) en 88 ms (médiane) et 215 ms (p95) pour le headless shell sur 1 CPU ; 432 ms et 596 ms pour le Chromium complet : très en dessous des cibles K2 (p50 < 2 s, p95 < 4 s).
- **Écart au périmètre** : pas de mesure sur Render (Standard 2 Go, Pro 4 Go), faute de compte d'hébergement (« demander d'abord », `06-taches.md` §1) ; et l'environnement n'est pas la VM cloud décrite (voir §2). Les constantes gardent donc une marge de 2 sur le p95 mesuré et doivent être confirmées sur Render avant de promettre une capacité (K4).

## 2. Environnement

| Élément | Valeur |
|---|---|
| Machine | MacBook Pro Apple silicon (arm64), 10 cœurs, 16 Go, macOS 15.6 : **pas** la VM cloud 4 vCPU / 16 Go du brief ni un hébergeur cible |
| Conteneurs | Docker Desktop 28.1.1, VM Linux aarch64 (noyau 6.10.14-linuxkit, cgroup v2) à 4 vCPU et 3,8 Gio : le profil « 4 Go » de Render n'y tient pas |
| Image | `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30…a4a27` (celle du `Dockerfile` du module), Node 24.20.0, `playwright-core` 1.63.0, Chromium 153.0.8010.12 |
| Lancement du conteneur | `--init` (tini en PID 1), `--user pwuser` (non root), profil `deploy/seccomp-chromium.json`, `--memory` = `--memory-swap` (pas de swap), `--cpus`, `--shm-size=512m` |
| Profils | `std` : 2 Go, 1 CPU (équivalent Render Standard) ; `large` : 3 Go, 2 CPU (le plus grand profil que la VM Docker permette, au lieu de 4 Go / 2 CPU de Render Pro) |
| Options Chromium | celles du worker de SYM : `headless: true`, `chromiumSandbox: true` (bac à sable actif), `CHROMIUM_SILENT_ARGS` ; variante `chromium` = `channel: 'chromium'` (nouveau mode headless du Chromium complet), mesurée à titre de comparaison |
| Pages de test | servies par un serveur HTTP local (aucun réseau) : `typical` = 1 500 lignes DOM, 30 SVG, ~150 000 objets JS ; `heavy` = 10 fois plus (15 000 lignes, ~1,5 million d'objets) : +235 Mio de mémoire anonyme par Chromium mesurés par rapport à `typical` |
| Répétitions | 30 par cas et par profil (`meta.reps`), médiane et p95 au rang le plus proche (`bench/stats.ts`) |

Limites propres à cet environnement : le disque de la VM Docker était plein (ENOSPC) pendant les runs `large-heavy`, `*-sat*`, `*-base` et `*-leak` : leur `/tmp` est monté depuis le disque hôte (`BENCH_TMP_HOST`, `bench/run.sh`), sans effet attendu sur la mémoire mesurée mais possible sur les durées de lancement. La VM Docker est partagée avec d'autres tâches pendant les mesures : les p95 de durée (par exemple 3 787 ms pour `dedicated` Chromium complet sur `large`) contiennent du bruit de contention et ne se lisent pas comme une garantie. Processeur arm64 : les tailles de pages et de binaires diffèrent un peu de x86_64.

## 3. Protocole (`bench/measure.ts`, lancé par `bench/run.sh`)

Le script tourne dans le conteneur, lit `/proc` (RSS et PSS de l'arbre de processus d'un Chromium) et le cgroup v2 (`memory.current`, `memory.stat` : `anon`). Chaque Chromium est lancé par `chromium.launchServer` puis utilisé par `chromium.connect`, comme le fera le nœud (04b §1 et §2). Le script ne signale que des pids qu'il a créés (`killOwnChild`, test `bench : garde-fou de sécurité`).

| Cas | Ce qui est fait, par répétition | Mesures |
|---|---|---|
| `warm_shared` | Un Chromium chaud neuf, 1 à 8 contextes `shared` ouverts un par un (page chargée dans chacun), paliers 1, 2, 4, 6, 8 ; fermeture | Lancement, prêt, durée du contexte, RSS et PSS à vide, coût par contexte, reliquat |
| `dedicated` | Un Chromium lancé pour une session, une page chargée, 1,5 s de stabilisation, arrêt | Durée de démarrage décomposée, RSS, PSS, cgroup, pic d'allocation (échantillon toutes les 50 ms), arrêt, processus orphelins |
| `concurrent` | k sessions `dedicated` lancées ensemble (k = 2 sur `std`, 3 sur `large`) | Démarrage sous contention, mémoire par session |
| `saturate` | Des sessions `dedicated` ajoutées une à une tant que `memory.current` reste sous 90 % de la limite (seuil de recyclage 04b §4) | Sessions qui tiennent |
| `leak` | Un Chromium chaud, 100 cycles ouvrir-charger-fermer un contexte | Dérive de mémoire pour 50 sessions |
| `node_base` | Un processus Node avec `playwright-core` chargé et un serveur HTTP | RSS de la base du nœud hors Chromium |

Trois mesures de mémoire, à ne pas confondre :

- **RSS sommé** : somme des `VmRSS` de l'arbre de processus ; borne haute, comparable aux chiffres publiés ;
- **PSS** : pages partagées réparties entre les processus qui les mappent ;
- **cgroup** (`memory.current` et `anon`) : ce que le noyau impute à la limite du conteneur ; c'est ce que l'OOM killer et le seuil de recyclage (04b §4) regardent. `memory.current` contient aussi du cache de fichiers (binaire de Chromium, ~500 Mio résidents, partagés entre tous les Chromium et récupérables) ; la mémoire propre à une session est la mémoire anonyme.

## 4. Résultats

Cellules : médiane / p95. Durées en ms, mémoires en Mio (1 Mio = 2^20 octets).

### Démarrage (ms)

| Run | Répét. | Chromium chaud : lancement | Chromium chaud : prêt (lancement + connexion) | Contexte shared : newContext + newPage (1er) | Contexte shared : + chargement page (1er) | dedicated : prêt (lancement + connexion + page chargée) | dedicated simultanées : prêt |
|---|---|---|---|---|---|---|---|
| std shell | 30 | 29 / 141 | 32 / 155 | 26 / 41 | 39 / 69 | 88 / 215 | 246 / 360 (k=2) |
| std chromium | 30 | 121 / 346 | 124 / 356 | 102 / 188 | 152 / 307 | 432 / 596 | 1153 / 1905 (k=2) |
| large shell | 30 | 38 / 187 | 43 / 202 | 32 / 80 | 46 / 95 | 83 / 591 | 214 / 1073 (k=3) |
| large chromium | 30 | 145 / 440 | 153 / 452 | 93 / 251 | 86 / 191 | 270 / 3787 | 1167 / 1988 (k=3) |
| std-heavy shell | 30 | 47 / 207 | 56 / 219 | 29 / 92 | 265 / 656 | 451 / 642 | 781 / 1289 (k=2) |
| large-heavy shell | 30 | 81 / 383 | 83 / 399 | 35 / 79 | 297 / 550 | 339 / 555 | 900 / 2517 (k=3) |

### Chromium chaud sans contexte (Mio)

| Run | Processus | RSS (somme des processus) | PSS (partages répartis) |
|---|---|---|---|
| std shell | 6 / 6 | 271.4 / 273.2 | 116.8 / 118.9 |
| std chromium | 7 / 7 | 535.7 / 541.6 | 223.2 / 226.0 |
| large shell | 6 / 6 | 269.3 / 271.9 | 115.3 / 117.0 |
| large chromium | 7 / 7 | 535.5 / 540.4 | 222.1 / 225.5 |
| std-heavy shell | 6 / 6 | 270.1 / 270.7 | 116.6 / 116.8 |
| large-heavy shell | 6 / 6 | 271.3 / 273.6 | 117.5 / 119.4 |

### Contexte shared : coût par contexte (Mio)

| Run | Page | Paliers | RSS marginal / contexte | RSS / contexte au dernier palier | PSS / contexte au dernier palier | Mémoire anonyme du cgroup / contexte au dernier palier | Reliquat après fermeture des contextes |
|---|---|---|---|---|---|---|---|
| std shell | typical | 8 | 146.2 / 146.4 | 149.2 / 149.4 | 62.5 / 62.7 | 50.5 / 51.5 | 37.6 / 38.1 |
| std chromium | typical | 8 | 333.0 / 337.1 | 347.9 / 352.1 | 109.8 / 110.2 | 91.2 / 91.7 | 87.3 / 104.4 |
| large shell | typical | 8 | 146.3 / 146.4 | 149.1 / 149.4 | 62.3 / 62.6 | 50.5 / 51.6 | 34.8 / 37.9 |
| large chromium | typical | 8 | 333.1 / 338.1 | 348.0 / 353.3 | 109.3 / 110.9 | 90.8 / 91.4 | 86.6 / 109.4 |
| std-heavy shell | heavy | 4 | 382.8 / 383.4 | 389.0 / 389.5 | 303.5 / 303.9 | 285.7 / 286.3 | 33.2 / 33.7 |
| large-heavy shell | heavy | 6 | 381.6 / 385.1 | 385.6 / 388.8 | 298.3 / 301.5 | 284.3 / 287.9 | 35.3 / 35.9 |

### Session dedicated, un Chromium (Mio)

| Run | Page | RSS au repos | RSS pic | PSS au repos | cgroup `memory.current` au repos | cgroup anonyme, pic | Arrêt (ms) | Orphelins après arrêt (max) |
|---|---|---|---|---|---|---|---|---|
| std shell | typical | 442.1 / 444.1 | 442.1 / 444.1 | 217.9 / 220.0 | 99.5 / 103.1 | 89.3 / 93.0 | 22 / 30 | 0 |
| std chromium | typical | 986.7 / 998.7 | 986.7 / 998.7 | 399.3 / 402.1 | 201.9 / 205.9 | 180.3 / 184.0 | 50 / 69 | 0 |
| large shell | typical | 437.1 / 437.6 | 437.1 / 437.6 | 213.8 / 214.2 | 99.7 / 102.3 | 89.0 / 90.8 | 22 / 79 | 0 |
| large chromium | typical | 986.8 / 999.1 | 986.8 / 999.1 | 398.8 / 402.0 | 203.1 / 207.0 | 179.0 / 182.6 | 66 / 364 | 0 |
| std-heavy shell | heavy | 677.0 / 680.1 | 677.0 / 680.1 | 454.5 / 458.1 | 334.4 / 337.8 | 324.3 / 327.9 | 21 / 41 | 0 |
| large-heavy shell | heavy | 677.0 / 678.9 | 677.0 / 678.9 | 453.1 / 455.1 | 335.8 / 338.6 | 322.9 / 326.8 | 36 / 55 | 0 |

### Sessions dedicated simultanées (par session, Mio)

| Run | k | RSS | PSS | cgroup `memory.current` | cgroup anonyme, pic | Lancements échoués (max) |
|---|---|---|---|---|---|---|
| std shell | 2 | 442.3 / 443.4 | 157.2 / 158.2 | 100.7 / 104.0 | 89.3 / 91.8 | 0 |
| std chromium | 2 | 987.4 / 997.3 | 294.5 / 296.3 | 203.0 / 205.0 | 179.7 / 181.9 | 0 |
| large shell | 3 | 436.1 / 437.3 | 134.4 / 135.6 | 100.3 / 102.0 | 88.2 / 89.2 | 0 |
| large chromium | 3 | 988.2 / 994.2 | 259.9 / 262.0 | 203.4 / 205.9 | 179.4 / 181.4 | 0 |
| std-heavy shell | 2 | 677.3 / 687.3 | 393.3 / 403.3 | 336.4 / 346.5 | 324.8 / 334.7 | 0 |
| large-heavy shell | 3 | 680.4 / 699.7 | 373.7 / 393.3 | 338.6 / 358.5 | 325.9 / 345.1 | 0 |

### Saturation : sessions dedicated sous 90 % de la limite du cgroup

| Run | Limite (Mio) | Page | Sessions sous 90 % | cgroup `memory.current` / session | Lancements échoués (max) |
|---|---|---|---|---|---|
| std-sat shell | 2048 | typical | 14.0 / 14.0 | 100.3 / 101.8 | 0 |
| std-sat-heavy shell | 2048 | heavy | 4.0 / 4.0 | 336.6 / 340.1 | 0 |
| large-sat shell | 3072 | typical | 16.0 / 16.0 | 100.9 / 102.4 | 0 |
| large-sat-heavy shell | 3072 | heavy | 7.0 / 7.0 | 338.1 / 341.0 | 0 |

### Dérive d’un Chromium chaud qui enchaîne des sessions shared (Mio pour 50 sessions)

| Run | Cycles | RSS | PSS | cgroup anonyme |
|---|---|---|---|---|
| std-leak shell | 100 | 1.4 / 2.1 | 1.2 / 2.2 | 1.2 / 5.1 |

### Base du nœud hors Chromium (processus Node + playwright-core + serveur HTTP, Mio)

| Run | RSS Node |
|---|---|
| std-base shell | 123.3 / 123.7 |

## 5. Lecture

1. **Coût d'un Chromium `dedicated`** (headless shell) : 100 Mio dans le cgroup sur page typique (p95 103), 336 Mio sur page lourde (p95 338 ; mémoire anonyme au pic : p95 328). Constant d'un profil à l'autre (`std`, `large`), et avec k = 2 ou 3 sessions simultanées (100 à 101 Mio par session) : pas de surcoût de contention. Le Chromium complet en nouveau mode headless coûte 2 fois plus (203 Mio, 987 Mio en RSS sommé) et démarre 5 fois plus lentement ; le worker de SYM utilise le headless shell, le nœud fait de même (parité, BINV4).
2. **Contexte `shared`** : 50 Mio de mémoire anonyme par contexte sur page typique (p95 52), 286 Mio sur page lourde (p95 288), soit 0,57 à 0,88 d'un Chromium dédié ; un Chromium chaud à vide pèse 271 Mio en RSS sommé, 117 en PSS. Le coût par contexte est linéaire (pente de 146 Mio de RSS par contexte entre 1 et 8, quasi identique d'une répétition à l'autre : p95 146,4) et la latence de création reste stable : médiane 16 à 27 ms et p95 de 41 à 80 ms, sans seuil entre 1 et 8 contextes. Fermer tous les contextes laisse 35 à 38 Mio (headless shell) : la mémoire revient presque entièrement.
3. **Dérive** : un Chromium chaud qui enchaîne 100 sessions `shared` gagne 1,4 Mio de RSS (p95 2,1) et 1,2 Mio de PSS (p95 2,2) pour 50 sessions : `RECYCLE_AFTER_SESSIONS` = 50 est confirmé, sans urgence (la dérive est négligeable) ; le recyclage par âge et par mémoire reste le filet.
4. **Arrêt** : 21 à 66 ms (médiane) ; 0 processus orphelin après arrêt sur toutes les répétitions de tous les profils.
5. **Saturation** : sous 90 % de la limite, 2 Go portent 14 sessions `dedicated` typiques ou 4 lourdes, 3 Go en portent au moins 16 typiques (plafond du banc) ou 7 lourdes, sans lancement échoué. Les 2 et 3 slots calculés (2 Go, 3 Go) restent à moins de la moitié de ces mesures lourdes.
6. **Démarrage (K2)** : `dedicated` headless shell prêt en 88 ms (p95 215) sur `std`, 83 ms (p95 591) sur `large`, 339 à 451 ms avec la page lourde ; sous contention de 2 à 3 lancements simultanés, 214 à 900 ms (p95 jusqu'à 2 517 ms). Toutes les médianes sont très en dessous de 2 s ; le p95 le plus haut (3 787 ms, Chromium complet, `large`) approche les 4 s de K2 mais vient d'un pic isolé de la VM partagée. Sur un hébergeur plus lent, ces valeurs seront à refaire (le cadre `dedicated` < 2 s de 04b §2 n'est pas menacé ici).

## 6. Constantes proposées et justification

| Constante | Avant (04b, point de départ) | Retenue | Justification |
|---|---|---|---|
| `BASE_BYTES` | 0,5 Go | **512 Mio** (inchangée) | Node + `playwright-core` + serveur HTTP : 123 Mio de RSS (p95 124). La base couvre 4 fois cette mesure : tini, client PostgreSQL, tampons, noyau |
| `SLOT_BYTES` | 1,5 Go | **768 Mio** | p95 de la mémoire anonyme d'un Chromium dédié sur page lourde : 328 Mio ; le slot en vaut 2,3 fois (test : au moins 2 fois). La somme des RSS (677 Mio) tiendrait aussi dans le slot, mais ce n'est pas la grandeur qui remplit un cgroup |
| `SLOT_UNITS` | (poids fractionnaires) | **4** | Réservation SQL en entiers (`slots_free - poids`) |
| Poids `dedicated` | 1 | **4 / 4** | Un Chromium = un slot entier |
| Poids `shared` | ≤ 1 | **3 / 4** | Un contexte coûte 0,57 (page typique) à 0,88 (page lourde) d'un Chromium dédié ; 3/4 de 768 Mio = 576 Mio, 2,0 fois le p95 d'un contexte lourd (288 Mio). L'économie de densité de `shared` est donc modeste (1,3 fois), pas le facteur 3 qu'on aurait pu espérer : son avantage est le démarrage (65 ms contre 88 ms page comprise avec le headless shell ; 254 contre 432 ms avec le Chromium complet) |
| `CONTEXTS_PER_BROWSER` | à fixer | **6** | Coût linéaire et latence stable mesurés jusqu'à 6 sur page lourde (3 Go) et 8 sur page typique ; 6 laisse de la marge et limite la perte en cas de plantage du Chromium (tous les contextes d'un client tombent avec lui) |
| `RECYCLE_AFTER_SESSIONS` | 50 | 50 (confirmé) | Dérive 1,4 Mio / 50 sessions |

Capacités résultantes, `max(1, floor((limite − 512 Mio) / 768 Mio))` : 2 Go → 2 slots, 3 Go → 3, 4 Go → 4, 8 Go → 10 (avant : 1, 1, 2, 5). Valeur pour **K4** : 1,3 session `dedicated` par Go de nœud dans le régime établi (1 / 0,75 Go), à confirmer sur Render ; mesures brutes de saturation : 2,0 (page lourde) à 7,0 (page typique) sessions par Go sous 90 %.

Si la confirmation sur Render montre un écart (mémoire par page réelle plus forte, x86_64), changer `SLOT_BYTES` dans `capacity.ts` et relancer `bench/run.sh` : le test `constantes de capacité reliées aux mesures versionnées` échoue tant que les résultats ne soutiennent pas la nouvelle valeur. `MAX_SESSIONS` (04b §3) reste le réglage manuel d'un nœud.

## 7. Reproduire

Depuis `runtime/`, avec Docker :

```sh
modules/browser/bench/run.sh std 2g 1 shell --reps 30 --concurrency 2                       # warm_shared + dedicated + concurrent
modules/browser/bench/run.sh large 3g 2 shell --reps 30 --concurrency 3
modules/browser/bench/run.sh std-heavy 2g 1 shell --reps 30 --concurrency 2 --page heavy --max-contexts 4
modules/browser/bench/run.sh std-sat 2g 1 shell --reps 30 --cases saturate [--page heavy]
modules/browser/bench/run.sh std-leak 2g 1 shell --reps 30 --cases leak
modules/browser/bench/run.sh std-base 2g 1 shell --reps 30 --cases node_base
node modules/browser/bench/report.ts            # tableaux de ce rapport
```

À refaire sur chaque hébergeur cible : lancer `bench/measure.ts` dans un conteneur à la limite mémoire de l'offre (`node bench/measure.ts --label render-standard --out …`, avec `BENCH_PLAYWRIGHT_CORE` pointant sur `playwright-core` si le dossier du module n'est pas installé) et comparer à ce rapport.

## 8. Sources

- Specs : `cdc/sym-browser/04b-specs-pool-noeuds.md` §1 à §4, `07-kpis.md` (K2, K4), `06-taches.md` (ligne 0.6) ; `docs/sym-browser-protocole-deploiement/08-hebergeurs-un-clic.md` (690 à 1 094 Mo, mesure publiée du 2025-06-06).
- Options de lancement : `runtime/apps/worker/src/browser/launch.ts` (`CHROMIUM_SILENT_ARGS`, `headless: true`, `chromiumSandbox: true`).
- Noyau Linux, cgroup v2 : `memory.current`, `memory.stat` (`anon`, `file`, `shmem`), `memory.max` ; `/proc/<pid>/status` (`VmRSS`) et `/proc/<pid>/smaps_rollup` (`Pss`).
