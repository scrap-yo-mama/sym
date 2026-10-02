# Nœuds

SYM 👻 : Quand une machine ne suffit plus, mets une passerelle devant et ajoute des nœuds. J'envoie chaque session au nœud qui a de la place.

## Rôles

| Mode | Fait tourner | Cible type |
|---|---|---|
| `SYMB_MODE=all` | Passerelle et nœud dans un seul process | Une machine, Docker Compose, à côté de SYM |
| `SYMB_MODE=gateway` | API REST, relais WebSocket, file d'attente, routage | Un service web derrière TLS |
| `SYMB_MODE=node` | Pool de Chromium, sessions, egress | Des services privés ou des VM avec beaucoup de RAM |

La passerelle est sans état ; les nœuds ne portent que l'état des navigateurs. Tout ce qui dure vit dans PostgreSQL ou le stockage d'objets : un nœud peut être arrêté et remplacé sans perte de données.

## Une passerelle et deux nœuds

Les trois partagent la base, la clé maîtresse et un jeton de nœud d'au moins 32 caractères.

```bash
export NODE_TOKEN="$(openssl rand -base64 32)"

# Passerelle
docker run -d --name symb-gateway -p 3000:3000 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=gateway -e DATABASE_URL -e MASTER_KEY -e NODE_TOKEN \
  ghcr.io/scrap-yo-mama/sym-browser:1

# Nœud 1, joignable sur le réseau privé
docker run -d --name symb-node-1 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=node -e DATABASE_URL -e MASTER_KEY -e NODE_TOKEN \
  -e NODE_ID=node-1 -e NODE_PUBLIC_URL=http://symb-node-1.internal:3000 -e NODE_REGION=eu-west \
  ghcr.io/scrap-yo-mama/sym-browser:1
```

Démarre le nœud 2 de la même façon, avec son propre `NODE_ID` et sa propre `NODE_PUBLIC_URL`. Les nœuds s'enregistrent seuls et envoient un battement toutes les 5 s (`HEARTBEAT_MS`) ; la passerelle choisit le nœud le moins chargé qui a assez de capacité. Un nœud peut tourner sur un autre hôte que la passerelle, joint par son URL privée et le jeton de nœud.

## Capacité

Un nœud lit la limite mémoire de son conteneur (cgroup v2, puis v1, sinon la machine) et en déduit ses places : environ une session `dedicated` par 1,5 Go au-delà d'une base de 0,5 Go (2 Go → 1 place, 4 Go → 2, 8 Go → 5).

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_SESSIONS` | calculé | Places du nœud, de 1 à 64 ; remplace la valeur calculée |
| `WARM_BROWSERS` | `1` | Chromium préchauffés pour les sessions `shared` |
| `RECYCLE_AFTER_SESSIONS`, `RECYCLE_AFTER_MS`, `RECYCLE_RSS_PERCENT` | 50, 1 h, 90 % | Recyclage des Chromium chauds |
| `QUEUE_MAX`, `QUEUE_TIMEOUT_MS` | 50, 30 s | File d'attente de la passerelle quand tous les nœuds sont pleins (`429 capacity_exceeded` après l'attente) |

Vise environ 15 % de places libres : en dessous, les sessions commencent à attendre. L'écran Nœuds de la console lève une alerte.

## Drainer et remplacer un nœud

```bash
curl -fsS -X POST "$SYMB_URL/v1/admin/nodes/node-1/drain" -H "Authorization: Bearer $SYMB_ADMIN_KEY"
```

Un nœud en drainage ne prend plus de nouvelle session ; celles en cours continuent jusqu'à leur fin. `GET /v1/admin/nodes` liste les nœuds avec leur état (`ready`, `draining`, `down`), leurs places libres et totales, leur mémoire, leurs versions de Playwright et de Chromium et leur dernier battement. Sur `SIGTERM`, un nœud se draine pendant `SHUTDOWN_GRACE_SECONDS` (300 s au plus) et détruit ce qui reste.

Un nœud qui n'envoie plus de battement est déclaré perdu : ses sessions se terminent avec la raison `node_lost`, et le balayage de démarrage du nœud efface les répertoires de session restants quand il revient.

## Sécurité d'un nœud

- Les nœuds n'acceptent que la passerelle : jeton de nœud et réseau privé. Ne publie jamais le port d'un nœud.
- Les ports de débogage des Chromium n'écoutent que sur le `127.0.0.1` du nœud ; les clients les atteignent par le relais authentifié de la passerelle.
- Chaque session a son propre egress ; les adresses privées sont refusées sauf si elles figurent dans `SYMB_PRIVATE_HOSTS`.
