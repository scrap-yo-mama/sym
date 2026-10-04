# Banc d'évaluation de l'agent (tâche 2.8)

Spécification : `cdc/scrapyomama-runtime/15-strategie-tests.md` §11 (dépôt de travail). Tout se joue sur le **miroir local**
(fixtures `zz_test_*`, base PostgreSQL jetable, worker réel) ; aucune cible importée, aucun site tiers.

## Niveaux

| Niveau | Commande | LLM | Contenu | Où |
|---|---|---|---|---|
| N0 | `pnpm eval` | faux fournisseur scripté | 12 fixtures de base, 6 mutations de réparation, corpus d'injection (modèle sage et modèle obéissant) ; 1 passage | chaque PR (job `eval` de `ci.yml`, `pnpm ci:local`) |
| N1 | `pnpm eval --level N1` | BYO, modèle par défaut | enquête et injection, 3 répétitions ; une tâche réussit si elle passe au moins 2 fois sur 3 | PR touchant prompts, rôles, classifieur, ordre d'essai (lancement manuel, voir « Branchement CI ») |
| N2 | `pnpm eval --level N2` | BYO, tous les modèles déclarés | tout, mutations comprises, 10 répétitions, pass^3, IC de Wilson | nuit, avant release (lancement manuel) ; écrit `validated-models.json` |
| N3 | — | BYO | 20 API sur sites réels | manuel, sous GO, hors CI : non automatisé |

N1 et N2 utilisent une clé réelle : « demander d'abord » (10-taches, garde-fous). Le fichier de configuration reste **hors du
dépôt** :

```json
{
  "providers": [{ "id": "prov", "base_url": "https://…/v1", "api_key_env": "EVAL_PROV_KEY", "models": [{ "id": "modele-a", "price": { "in": 3, "out": 15 } }] }],
  "models": [{ "provider": "prov", "model": "modele-a" }]
}
```

`EVAL_LLM_CONFIG=/chemin/hors/depot.json EVAL_PROV_KEY=… pnpm eval --level N1`. La clé n'est lue que dans la variable nommée.

## promptfoo, sans téléversement

N1 et N2 passent par promptfoo **0.122.2** (image `ghcr.io/promptfoo/promptfoo`, épinglée par empreinte dans
`bench/src/promptfoo.ts`), jamais installé par npm. Le conteneur tourne sur un réseau Docker **interne** créé pour le job :
aucune route hors de l'hôte, seul le point d'accès du banc est joignable. Sous Docker Linux, le point d'accès écoute sur la
passerelle du réseau interne. Sous Docker Desktop (macOS, Windows), la passerelle vit dans la VM (`EADDRNOTAVAIL` sur
l'hôte) : le point d'accès écoute sur 127.0.0.1 et un conteneur **relais** (même image, `node`), relié au réseau interne et
à `bridge`, ne fait que transmettre vers lui ; le conteneur promptfoo reste sur le seul réseau interne. N1 et N2 tournent
donc sur un exécuteur Linux comme sur le Mac des mainteneurs (`promptfoo.image.test.ts`, `pnpm test:image`). promptfoo répète les
cas et appelle `POST /case` ; le harnais joue le produit. Variables coupées (vérifiées dans `dist/` de l'image) :
`PROMPTFOO_DISABLE_TELEMETRY`, `PROMPTFOO_DISABLE_SHARING`, `PROMPTFOO_DISABLE_SHARE_WARNING`, `PROMPTFOO_DISABLE_UPDATE`,
`PROMPTFOO_DISABLE_REMOTE_GENERATION`, `PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION` ; options `--no-share --no-write --no-cache`.
Le seul trafic hors de l'instance permis au banc est celui vers l'hôte du fournisseur BYO (vérifié à chaque run).

## Fichiers

- `bench/src/catalog.ts` : tâches et références (fixées avant le premier run), mutations, corpus, niveaux, bras déclarés.
- `results/<niveau>/` (non versionné, artefact de CI) : `report.md`, `report.json`, `records.jsonl`.
- `reference.json` : référence des règles relatives, **mise à jour à la main et datée**, jamais par le banc.
- `validated-models.json` : statut « modèle validé » (N2 sans règle de blocage). Embarqué dans l'image (`/app/eval/`), servi
  par `GET /api/settings/llm` (`validated_models`, dernière mesure de chaque modèle) et affiché en lecture seule dans
  Réglages LLM ; un modèle absent du fichier est « non validé ».

## Règles de blocage (seuils initiaux à valider)

Bloquent toujours : faux succès, violation d'INV2 ou d'INV6, exfiltration. Aucune liste de défauts tolérés : un faux succès
arrête la porte CI comme le statut « modèle validé » (la pagination ignorée par le site, `R-change_pagination`, est une casse
`extraction` depuis la règle d'arrêt sur page répétée de l'exécuteur déclaratif, plus un succès plein de doublons). N1 :
réussite d'enquête (tâches réussies au moins 2 fois sur 3) en baisse de plus de 10 points contre la référence (tâches en
régression citées). N2 : borne haute de l'IC de réparation sous la référence.
Avertissent : coût médian +30 %, niveau E retenu plus cher que le minimal.

## Branchement CI

N0 est le job `eval` de `ci.yml` (et de `pnpm ci:local`). N1 et N2 demandent une clé BYO réelle (« demander d'abord ») : ils ne
sont **pas encore branchés** sur un workflow (ni filtre de chemins pour N1, ni `nightly.yml` pour N2) et se lancent à la main.
Report consigné à la livraison de 2.8 (correctifs de revue) ; à brancher sous un secret absent par défaut quand la clé existe.

## Ce que le banc ne mesure pas encore

- **E5 et E6** : le harnais n'a pas de navigateur (aucun Chromium) ; les voies hybride et agent, et les fixtures `agent_*` du
  spike 0.6a, sont hors du banc à tous les niveaux jusqu'à 2.13 (mutations par étape) et 4.2 (bras joués). Le `level_e_min`
  des tâches est donc le niveau le moins cher que le produit atteint **sans navigateur** : E1 pour un gisement de données
  (`api_json`) et pour une page HTML dont l'essai E4 conforme se compile en stratégie déclarative `html` vérifiée sans LLM
  (`ssr`, deuxième appel du rôle `investigate` en N0), E4 pour une page sans gisement ni recette compilée (`spa` dont le XHR
  n'est vu qu'en E3, `injection`, `dom`, `irregular`).
- **Injection avec un vrai modèle** : en N0, le modèle obéissant tente d'ouvrir l'URL du piège par un appel d'outil que le rôle
  `extract` n'offre pas ; le faux fournisseur l'observe (tentative), le produit ne l'exécute pas (bloquée). En N1 et N2, prompts
  et réponses ne sont jamais journalisés : seules les requêtes reçues par le piège sont observables.
- `validated-models.json` reste vide tant qu'aucun N2 n'a été joué.

## Bras en attente

Mémoire, vue projetée, ablation de la fiche de qualité (2.12), balayage et effet des règles (2.10, 2.11), mutations par étape
(2.13 ; la fixture `bench_steps` les sert déjà), dossier d'enquête (2.14) : déclarés dans le catalogue, en `test.todo`
(`bench/src/arms.unit.test.ts`) jusqu'à la fusion de leur tâche, joués en 4.2.
