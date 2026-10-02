# Nodes

SYM 👻: When one machine is not enough, put a gateway in front and add nodes. I route each session to the node that has room.

## Roles

| Mode | Runs | Typical target |
|---|---|---|
| `SYMB_MODE=all` | Gateway and node in one process | One machine, Docker Compose, next to SYM |
| `SYMB_MODE=gateway` | REST API, WebSocket relays, queue, routing | A web service behind TLS |
| `SYMB_MODE=node` | Chromium pool, sessions, egress | Private services or VMs with plenty of RAM |

The gateway is stateless; nodes only hold browser state. Everything durable lives in PostgreSQL or the object storage, so a node can be stopped and replaced without losing data.

## A gateway and two nodes

All three share the database, the master key and a node token of at least 32 characters.

```bash
export NODE_TOKEN="$(openssl rand -base64 32)"

# Gateway
docker run -d --name symb-gateway -p 3000:3000 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=gateway -e DATABASE_URL -e MASTER_KEY -e NODE_TOKEN \
  ghcr.io/scrap-yo-mama/sym-browser:1

# Node 1, reachable on the private network
docker run -d --name symb-node-1 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=node -e DATABASE_URL -e MASTER_KEY -e NODE_TOKEN \
  -e NODE_ID=node-1 -e NODE_PUBLIC_URL=http://symb-node-1.internal:3000 -e NODE_REGION=eu-west \
  ghcr.io/scrap-yo-mama/sym-browser:1
```

Start node 2 the same way with its own `NODE_ID` and `NODE_PUBLIC_URL`. Nodes register themselves and send a heartbeat every 5 s (`HEARTBEAT_MS`); the gateway picks the least loaded node with enough capacity. A node can run on another host than the gateway, reached by its private URL and the node token.

## Capacity

A node reads its container memory limit (cgroup v2, then v1, else the machine) and derives its slots: about one `dedicated` session per 1.5 GB after a base of 0.5 GB (2 GB → 1 slot, 4 GB → 2, 8 GB → 5).

| Variable | Default | Role |
|---|---|---|
| `MAX_SESSIONS` | computed | Slots of the node, 1 to 64; overrides the computed value |
| `WARM_BROWSERS` | `1` | Pre-warmed Chromium instances for `shared` sessions |
| `RECYCLE_AFTER_SESSIONS`, `RECYCLE_AFTER_MS`, `RECYCLE_RSS_PERCENT` | 50, 1 h, 90 % | Recycling of warm Chromium instances |
| `QUEUE_MAX`, `QUEUE_TIMEOUT_MS` | 50, 30 s | Gateway queue when every node is full (`429 capacity_exceeded` after the wait) |

Aim for about 15 % of free slots: below that, sessions start to queue. The console's Nodes screen raises an alert.

## Draining and replacing a node

```bash
curl -fsS -X POST "$SYMB_URL/v1/admin/nodes/node-1/drain" -H "Authorization: Bearer $SYMB_ADMIN_KEY"
```

A draining node takes no new session; running ones go on until they end. `GET /v1/admin/nodes` lists the nodes with their state (`ready`, `draining`, `down`), free and total slots, memory, Playwright and Chromium versions and last heartbeat. On `SIGTERM`, a node drains for `SHUTDOWN_GRACE_SECONDS` (at most 300 s) and destroys what remains.

A node that stops sending heartbeats is declared lost: its sessions end with reason `node_lost`, and the node's startup sweeper deletes leftover session directories when it comes back.

## Security of a node

- Nodes only accept the gateway: node token and private network. Never publish a node port.
- Debugging ports of the Chromium instances listen on the node's `127.0.0.1` only; clients reach them through the authenticated gateway relay.
- Each session has its own egress; private addresses are refused unless listed in `SYMB_PRIVATE_HOSTS`.
