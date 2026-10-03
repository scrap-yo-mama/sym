# SYM Browser

SYM 👻: Hi! I hand out browsers on demand. You ask for a session, I start a Chromium for you, you drive it with any CDP client, and when you are done I destroy everything.

SYM Browser is a self-hosted browser service. One image, three roles (`all`, `gateway`, `node`), one PostgreSQL database and one master key. Each session gets its own Chromium (type `dedicated`, the default) or a fresh context in a warm Chromium (type `shared`), its own network egress with an allow-list and a byte budget, and is fully destroyed at the end.

## Start here

1. [Quickstart](quickstart.md): start an instance, open a session, drive it with Playwright, release it. About ten minutes.
2. [Connect your client](clients/README.md): Playwright, Puppeteer, Stagehand, browser-use, Skyvern, Playwright MCP, Chrome DevTools MCP.
3. [TypeScript SDK](sdk.md): sessions, connections and events in a few lines.

## Run it

- [Deployment](deployment.md): the image, `SYMB_MODE=all`, PostgreSQL, the master key, health checks.
- [Nodes](nodes.md): a gateway in front of several nodes, capacity, draining.
- [Topologies](topologies.md): next to SYM, or isolated on its own server.

## Reference

- [API](reference/api.md): operations, scopes, statuses, error codes, WebSocket connections. Generated from the OpenAPI document of the contract.
- [Configuration](reference/configuration.md): every environment variable. Generated from the configuration catalogue.

## Promises you can rely on

| Promise | What it means for you |
|---|---|
| Isolation | Two sessions never share cookies, storage, cache, tabs, downloads or proxy credentials. |
| Governed network | Every connection of a session goes through its egress: allowed hosts, ports, byte budget. |
| Full destruction | At the end of a session, its processes, profile directory and files are gone; only what you asked to keep stays. |
| Protected secrets | Tokens, proxy passwords and persistent profiles are encrypted at rest and never written to logs. |
| Authenticated access | Every REST call and every WebSocket is checked before it reaches a browser. |
| CDP compatibility | A `dedicated` session is driven with nothing but its `connectUrls.cdp`. |
