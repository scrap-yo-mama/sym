---
title: "Diagnostiquer une instance"
description: "doctor, diagnostics masqué, sondes de santé et métriques fermées par défaut."
---

# Diagnostiquer une instance

Quatre outils, tous **locaux** : aucun n'envoie quoi que ce soit hors de votre instance.

## Les sondes de santé

| Sonde | Ce qu'elle vérifie | Réponse |
|---|---|---|
| `GET /api/health` | le processus répond ; **aucun accès à la base** ; répond même pendant une migration | 200, avec la version |
| `GET /api/ready` | base joignable, schéma à la version attendue, empreinte de clé valide ; `initialized` indique si le propriétaire existe | 200, ou 503 avec la liste des contrôles en échec |
| `GET /api/ready?detail=1` | ajoute les workers vivants et la profondeur de la file | 200 ; **administrateur connecté** seulement |

`/api/ready` est le chemin de contrôle à donner à votre plateforme ; `/api/health` sert de vivacité. Les workers vivants sont **informatifs** : ils n'entrent pas dans le code de retour, pour ne pas bloquer un déploiement où le serveur démarre avant le worker. Un worker n'a pas de port : il inscrit un battement toutes les 15 secondes et est considéré mort après 45 secondes sans battement.

Aucune de ces réponses ne contient de version de dépendance ni de nom d'hôte.

## `runtime doctor`

```bash
runtime doctor          # lisible
runtime doctor --json   # pour un script
```

Contrôles **locaux** (rien n'est écrit, rien n'est envoyé) : base joignable, connexion de session derrière un pooler, version de PostgreSQL, version du schéma, rôle `runtime_app`, empreinte de clé, secrets « À ressaisir », budget de connexions, workers vivants, taille de la base contre `STORAGE_PLAN_GB`, dernière sauvegarde déclarée, `PUBLIC_URL` en HTTPS, jeton d'amorçage resté posé.

Code de sortie : **0** tout va bien, **1** avertissement, **2** erreur. Vous pouvez donc l'appeler depuis une supervision.

## `runtime diagnostics`

```bash
runtime diagnostics --out diagnostic.json
```

Produit un fichier JSON **masqué**, pour joindre à un ticket : versions, **noms** des réglages (jamais leurs valeurs), compteurs, dernières classes d'échec et résultat de `doctor` réduit à (contrôle, statut, code). Il ne contient aucun secret, cookie, URL, nom d'hôte, adresse e-mail ni texte libre. Il n'est **jamais envoyé** : c'est à vous de le joindre, après l'avoir relu. La console propose le même export dans **Réglages > Diagnostic** : il se télécharge sur votre ordinateur.

## `/metrics`

Les métriques au format Prometheus sont **fermées par défaut** : sans `METRICS_TOKEN`, la route répond 404. Avec un jeton (32 caractères au moins), le jeton porteur est exigé (401 sinon). Elles sont calculées depuis la base et préfixées `scrapyomama_` ; elles ne contiennent jamais d'identifiant de run, d'API, de domaine cible ni de message d'erreur.

## OpenTelemetry

Coupé par défaut : ni l'API ni le SDK ne sont même chargés. Pour l'activer : `OTEL_ENABLED=true` **et** `OTEL_EXPORTER_OTLP_ENDPOINT` (obligatoire, aucune destination implicite), vers un collecteur que vous contrôlez. Aucun en-tête de trace ne part vers les sites cibles, les proxys ou le fournisseur du modèle. Variables : [Variables d'environnement](../reference/variables-environnement.md).

## Journaux

JSON sur la sortie standard, masqué : `LOG_LEVEL` règle le niveau. Les secrets, cookies, en-têtes d'autorisation et données personnelles n'y figurent pas. Les artefacts de run (captures, traces) sont **désactivés par défaut** (`ARTIFACTS_LEVEL=none`).

## Un démarrage qui échoue

Un refus de démarrer affiche toujours **ce qui manque** et jamais de valeur secrète. Les causes courantes :

| Message | Cause | Remède |
|---|---|---|
| `DATABASE_URL manquante` | variable absente | la poser |
| `MASTER_KEY invalide` | pas 32 octets en base64, ou phrase secrète | `runtime keygen` |
| clé différente de celle de la base | une autre `MASTER_KEY` que celle qui a chiffré la base | restaurer la bonne clé (voir [Sauvegarder et restaurer](./sauvegarde.md)) |
| `connexion de session requise` | pooler en mode transaction sans connexion directe | poser `DATABASE_URL_DIRECT` |
| `premier démarrage sans ADMIN_BOOTSTRAP_TOKEN` | base vierge sans jeton d'amorçage | poser le jeton |
| schéma plus récent que le code | image plus ancienne que la base | redéployer la version courante, ou restaurer |
