# Topologies

SYM 👻: Same image, same protocol, two ways to live: right next to SYM, or on your own. Only the configuration changes.

| Topology | Where | Network and secrets | Database |
|---|---|---|---|
| With SYM (not isolated) | Same host or project as SYM, in a separate container | Private network, no published port; its own `MASTER_KEY`; one generated exchange key shared with SYM | Its own logical database and role, on SYM's PostgreSQL server if that saves money |
| Isolated | Its own server or host | Public TLS URL and API keys | Its own PostgreSQL |
| Development | Same container, separate process | Loopback | Development database |

## With SYM

SYM Browser runs as a separate container next to SYM, like an external task runner. SYM drives it as any other client: an API key, the `/v1` API, the `connectUrls`.

1. Generate one exchange key. SYM reads it as `BROWSER_API_KEY`, SYM Browser as `SYMB_BOOTSTRAP_API_KEY` (it creates the key, client `sym`, on first start).
2. Give each service its own master key: never share `MASTER_KEY` between SYM and SYM Browser.
3. Point SYM's worker at SYM Browser with `BROWSER_URL`, on the private network.

```yaml
# docker compose (excerpt)
services:
  sym-browser:
    image: ghcr.io/scrap-yo-mama/sym-browser:1
    profiles: [browser]
    security_opt: ['seccomp=deploy/seccomp-chromium.json', 'no-new-privileges']
    cap_drop: [ALL]
    environment:
      SYMB_MODE: all
      DATABASE_URL: postgres://sym_browser:${SYMB_DB_PASSWORD}@postgres:5432/sym_browser
      MASTER_KEY: ${SYMB_MASTER_KEY}
      SYMB_BOOTSTRAP_API_KEY: ${SYMB_EXCHANGE_KEY}
  worker:
    environment:
      BROWSER_URL: http://sym-browser:3000
      BROWSER_API_KEY: ${SYMB_EXCHANGE_KEY}
```

- No port is published: only the worker reaches `sym-browser:3000`.
- At start-up, the worker calls `GET /v1/version`: `product: "sym-browser"` and the same Playwright major.minor version select the `sym-browser` provider. The worker starts even if SYM Browser is not ready yet and retries.
- The `sym_browser` database and role live on SYM's PostgreSQL server, separate from SYM's database.

On Railway, `BROWSER_URL` uses the private domain of the `sym-browser` service; on Render, the "SYM + SYM Browser" button runs SYM Browser in `all` mode in a private service.

## Isolated

SYM Browser lives on its own server and serves any project: yours, SYM on another host, or third-party tools.

- A public TLS URL (`https://browser.example.com`) in front of the gateway: `connectUrls` are then `wss://`.
- Its own PostgreSQL (`DATABASE_URL`) and its own `MASTER_KEY`.
- API keys per client, created in the console, with scopes and quotas.
- On Render, the "SYM Browser alone" button deploys a web gateway, a private node and PostgreSQL; add nodes as described in [nodes](nodes.md).

A SYM instance elsewhere connects with `BROWSER_URL=https://browser.example.com` and an API key in `BROWSER_API_KEY` (scopes `sessions:write` and `sessions:read`).

## Development

Run the gateway and the node in one process on your machine (`SYMB_MODE=all`, `PORT=3000`) against a local PostgreSQL, as in the [quickstart](quickstart.md).

## Which one?

| You want | Choose |
|---|---|
| Browser runs for SYM on the same machine, nothing exposed | With SYM |
| One browser service for several projects or teams | Isolated |
| More browsers than one machine can hold | Isolated, then add [nodes](nodes.md) |
