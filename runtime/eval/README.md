# Banc d'évaluation de l'agent (tâche 2.8)

Spécification : `cdc/scrapyomama-runtime/15-strategie-tests.md` §11 (dépôt de travail). Tout se joue sur le **miroir local**
(fixtures `zz_test_*`, base PostgreSQL jetable, worker réel) ; aucune cible importée, aucun site tiers.

## Niveaux

| Niveau | Commande | LLM | Contenu | Où |
|---|---|---|---|---|
| N0 | `pnpm eval` | faux fournisseur scripté | 12 fixtures de base, 6 mutations de réparation, corpus d'injection ; 1 passage | chaque PR (job `eval` de `ci.yml`, `pnpm ci:local`) |
| N1 | `pnpm eval --level N1` | BYO, modèle par défaut | enquête et injection, 3 répétitions | PR touchant prompts, rôles, classifieur, ordre d'essai |
| N2 | `pnpm eval --level N2` | BYO, tous les modèles déclarés | tout, mutations comprises, 10 répétitions, pass^3, IC de Wilson | nuit, avant release ; écrit `validated-models.json` |
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
aucune route hors de l'hôte, seul le point d'accès du banc (sur la passerelle du réseau) est joignable. promptfoo répète les
cas et appelle `POST /case` ; le harnais joue le produit. Variables coupées (vérifiées dans `dist/` de l'image) :
`PROMPTFOO_DISABLE_TELEMETRY`, `PROMPTFOO_DISABLE_SHARING`, `PROMPTFOO_DISABLE_SHARE_WARNING`, `PROMPTFOO_DISABLE_UPDATE`,
`PROMPTFOO_DISABLE_REMOTE_GENERATION`, `PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION` ; options `--no-share --no-write --no-cache`.
Le seul trafic hors de l'instance permis au banc est celui vers l'hôte du fournisseur BYO (vérifié à chaque run).

## Fichiers

- `bench/src/catalog.ts` : tâches et références (fixées avant le premier run), mutations, corpus, niveaux, bras déclarés.
- `results/<niveau>/` (non versionné, artefact de CI) : `report.md`, `report.json`, `records.jsonl`.
- `reference.json` : référence des règles relatives, **mise à jour à la main et datée**, jamais par le banc.
- `known-defects.json` : défauts du produit constatés par le banc, datés et rattachés à une tâche. Ils restent bloquants dans
  le rapport et pour le statut « modèle validé » ; seule la porte CI ne s'arrête que sur un constat **nouveau**. N0 échoue si un
  défaut connu ne se reproduit plus.
- `validated-models.json` : statut « modèle validé » (N2 sans règle de blocage), affiché en lecture seule dans Réglages LLM.

## Règles de blocage (seuils initiaux à valider)

Bloquent toujours : faux succès, violation d'INV2 ou d'INV6, exfiltration. N1 : réussite d'enquête en baisse de plus de
10 points contre la référence (tâches en régression citées). N2 : borne haute de l'IC de réparation sous la référence.
Avertissent : coût médian +30 %, niveau E retenu plus cher que le minimal.

## Bras en attente

Mémoire, vue projetée, ablation de la fiche de qualité (2.12), balayage et effet des règles (2.10, 2.11), mutations par étape
(2.13 ; la fixture `bench_steps` les sert déjà), dossier d'enquête (2.14) : déclarés dans le catalogue, en `test.todo`
(`bench/src/arms.unit.test.ts`) jusqu'à la fusion de leur tâche, joués en 4.2.
