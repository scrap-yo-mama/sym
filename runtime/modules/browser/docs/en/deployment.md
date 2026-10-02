# Deployment

SYM 👻: One image, one database, one master key. I take care of the rest.

## What you need

| Dependency | Why |
|---|---|
| PostgreSQL 16, 17 or 18 | Sessions, nodes, keys, profiles, usage (`DATABASE_URL`) |
| A master key | Encrypts every secret at rest (`MASTER_KEY`, 32 random bytes in base64) |
| Object storage | Persistent profiles, recordings, kept downloads: local disk (`OBJECT_STORE=disk`) or S3-compatible (`OBJECT_STORE=s3`) |
| Memory | About 1.5 GB per `dedicated` session; the node derives its slots from its container memory |

These are the only dependencies. The instance's outgoing connections are just as closed: the egress of each session, the webhooks you configure, S3 when you choose it, the proxy test echo endpoint.

## One container: `SYMB_MODE=all`

The gateway and a node run in one process, with disk storage. This is the mode of the [quickstart](quickstart.md), of Docker Compose and of a single machine.

```bash
export MASTER_KEY="$(openssl rand -base64 32)"   # back it up outside the machine
docker run -d --name sym-browser -p 3000:3000 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=all -e PORT=3000 \
  -e DATABASE_URL=postgres://sym_browser:CHANGE_ME@db.internal:5432/sym_browser \
  -e MASTER_KEY \
  -e OBJECT_STORE=disk -v symb-data:/data \
  ghcr.io/scrap-yo-mama/sym-browser:1
```

- Chromium runs with its sandbox on, as the non-root user `pwuser`, under `tini`, with the seccomp profile `deploy/seccomp-chromium.json` (Docker default plus user namespaces). Keep the three security options above: they are checked by the image tests.
- `/data` holds the session working directories (`SYMB_DATA_DIR`) and, with `OBJECT_STORE=disk`, the objects (`OBJECT_DIR`).
- Behind a TLS reverse proxy, the public URL is `https://…`: `connectUrls` then use `wss://`.

## Configuration

Every variable, its default and the modes that require it are in the [configuration reference](reference/configuration.md). Essentials:

| Variable | Role |
|---|---|
| `SYMB_MODE` | `all`, `gateway` or `node` |
| `PORT` | Listening port, `3000` by default |
| `DATABASE_URL` | PostgreSQL URL |
| `MASTER_KEY` | Master key (also `MASTER_KEY_FILE=/run/secrets/master_key`) |
| `OBJECT_STORE` | `disk` (required in `all`) or `s3` with `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `SYMB_BOOTSTRAP_API_KEY` | First API key, created when the key table is empty |

Any secret can be read from a file: `NAME_FILE=/path`. An invalid configuration stops the start with exit code 1 and a message that names the variable, never its value. Check a configuration without starting:

```bash
docker run --rm --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e DATABASE_URL -e MASTER_KEY ghcr.io/scrap-yo-mama/sym-browser:1 \
  node modules/browser/apps/gateway/dist/main.js --check-config
```

## Health

| Route | Answer |
|---|---|
| `GET /healthz` | `200` as long as the process lives |
| `GET /readyz` | `200` when the instance can serve (key, database, node); `503` otherwise |

Point your platform's health check at `/readyz`.

## Changing the master key

Start with the new key in `MASTER_KEY` and the old one in `MASTER_KEY_PREVIOUS`, run the rekey, then remove `MASTER_KEY_PREVIOUS`. Never lose the current key: encrypted profiles and proxy passwords would be unreadable.

## Stopping

On `SIGTERM` the instance drains for `SHUTDOWN_GRACE_SECONDS` (270 s by default, 300 at most): no new session, running ones end with reason `node_shutdown`, everything is destroyed.

## Hosting templates

Docker Compose and Railway ship SYM and SYM Browser together; Render offers "SYM + SYM Browser" and "SYM Browser alone" buttons. See [topologies](topologies.md).
