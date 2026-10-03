# Déploiement

SYM 👻 : Une image, une base, une clé maîtresse. Je m'occupe du reste.

## Ce qu'il te faut

| Dépendance | Pourquoi |
|---|---|
| PostgreSQL 16, 17 ou 18 | Sessions, nœuds, clés, profils, consommation (`DATABASE_URL`) |
| Une clé maîtresse | Chiffre tous les secrets au repos (`MASTER_KEY`, 32 octets aléatoires en base64) |
| Un stockage d'objets | Profils persistants, enregistrements, téléchargements conservés : disque local (`OBJECT_STORE=disk`) ou compatible S3 (`OBJECT_STORE=s3`) |
| De la mémoire | Environ 1,5 Go par session `dedicated` ; le nœud déduit ses places de la mémoire de son conteneur |

Ce sont les seules dépendances. Les connexions sortantes de l'instance sont tout aussi fermées : l'egress de chaque session, les webhooks que tu configures, S3 si tu le choisis, le point d'écho du test de proxy.

## Un conteneur : `SYMB_MODE=all`

La passerelle et un nœud tournent dans un seul process, avec le stockage sur disque. C'est le mode du [démarrage rapide](quickstart.md), de Docker Compose et d'une machine unique.

```bash
export MASTER_KEY="$(openssl rand -base64 32)"   # sauvegarde-la hors de la machine
docker run -d --name sym-browser -p 3000:3000 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=all -e PORT=3000 \
  -e DATABASE_URL=postgres://sym_browser:CHANGE_ME@db.internal:5432/sym_browser \
  -e MASTER_KEY \
  -e OBJECT_STORE=disk -v symb-data:/data \
  ghcr.io/scrap-yo-mama/sym-browser:1
```

- Chromium tourne avec son bac à sable actif, sous l'utilisateur non root `pwuser`, sous `tini`, avec le profil seccomp `deploy/seccomp-chromium.json` (le défaut de Docker plus les espaces de noms utilisateur). Garde les trois options de sécurité ci-dessus : les tests de l'image les vérifient.
- `/data` contient les répertoires de travail des sessions (`SYMB_DATA_DIR`) et, avec `OBJECT_STORE=disk`, les objets (`OBJECT_DIR`).
- Derrière un proxy inverse TLS, l'URL publique est en `https://…` : les `connectUrls` passent alors en `wss://`.

## Configuration

Chaque variable, sa valeur par défaut et les modes qui l'exigent sont dans la [référence de configuration](reference/configuration.md). L'essentiel :

| Variable | Rôle |
|---|---|
| `SYMB_MODE` | `all`, `gateway` ou `node` |
| `PORT` | Port d'écoute, `3000` par défaut |
| `DATABASE_URL` | URL PostgreSQL |
| `MASTER_KEY` | Clé maîtresse (ou `MASTER_KEY_FILE=/run/secrets/master_key`) |
| `OBJECT_STORE` | `disk` (obligatoire en `all`) ou `s3` avec `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `SYMB_BOOTSTRAP_API_KEY` | Première clé d'API, créée quand la table des clés est vide |

Tout secret peut se lire depuis un fichier : `NOM_FILE=/chemin`. Une configuration invalide arrête le démarrage avec le code de sortie 1 et un message qui nomme la variable, jamais sa valeur. Vérifie une configuration sans démarrer :

```bash
docker run --rm --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e DATABASE_URL -e MASTER_KEY ghcr.io/scrap-yo-mama/sym-browser:1 \
  node modules/browser/apps/gateway/dist/main.js --check-config
```

## Santé

| Route | Réponse |
|---|---|
| `GET /healthz` | `200` tant que le process vit |
| `GET /readyz` | `200` quand l'instance peut servir (clé, base, nœud) ; `503` sinon |

Pointe le contrôle de santé de ta plateforme sur `/readyz`.

## Changer de clé maîtresse

Démarre avec la nouvelle clé dans `MASTER_KEY` et l'ancienne dans `MASTER_KEY_PREVIOUS`, lance le rechiffrement, puis retire `MASTER_KEY_PREVIOUS`. Ne perds jamais la clé courante : les profils chiffrés et les mots de passe de proxy deviendraient illisibles.

## Arrêt

Sur `SIGTERM`, l'instance se draine pendant `SHUTDOWN_GRACE_SECONDS` (270 s par défaut, 300 au plus) : aucune nouvelle session, celles en cours se terminent avec la raison `node_shutdown`, tout est détruit.

## Modèles d'hébergement

Docker Compose et Railway livrent SYM et SYM Browser ensemble ; Render propose les boutons « SYM + SYM Browser » et « SYM Browser seul ». Voir les [topologies](topologies.md).
