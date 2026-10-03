# Quickstart

SYM 👻: Ten minutes, three commands and one script. At the end you will have opened a page in your own remote Chromium, then given it back to me.

You need Docker, OpenSSL and Node.js 24 (or 22). The session below is of type `dedicated` (the default): a Chromium of its own, driven over CDP.

<!-- CI replays this page end to end on the built image: step 1 (the commands below, with the local image, unique names and ports) then steps 3 to 5 extracted from this page and run as is (tests/deploy.e2e.test.ts, quickstart_replayed_on_image). tests/docs-quickstart.chromium.test.ts also runs steps 3 to 5 against an in-process assembly. -->

## 1. Start SYM Browser

SYM Browser needs PostgreSQL, a master key and a first API key. The master key encrypts every secret at rest: **save it** outside the machine, without it nothing encrypted can be read again.

```bash
export MASTER_KEY="$(openssl rand -base64 32)"   # save it in your password manager
export SYMB_API_KEY="symb_$(openssl rand -hex 6)_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
curl -fsSLO https://raw.githubusercontent.com/scrap-yo-mama/sym-browser/main/deploy/seccomp-chromium.json

docker network create symb
docker run -d --name symb-db --network symb \
  -e POSTGRES_PASSWORD=symb -e POSTGRES_DB=sym_browser \
  postgres:16
docker run -d --name sym-browser --network symb -p 127.0.0.1:3000:3000 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  --cap-add SYS_CHROOT --shm-size 1g \
  -e SYMB_MODE=all \
  -e DATABASE_URL=postgres://postgres:symb@symb-db:5432/sym_browser \
  -e MASTER_KEY -e SYMB_BOOTSTRAP_API_KEY="$SYMB_API_KEY" \
  ghcr.io/scrap-yo-mama/sym-browser:1

export SYMB_URL=http://localhost:3000
until curl -fsS "$SYMB_URL/readyz"; do sleep 2; done   # answers 200 once the instance is ready
```

`/readyz` answers `200` once the instance is ready. `SYMB_BOOTSTRAP_API_KEY` creates the first API key (scopes `sessions:write` and `sessions:read`) when the key table is empty.

## 2. Install the Playwright client

```bash
mkdir symb-quickstart && cd symb-quickstart
npm init -y && npm pkg set type=module
npm install playwright-core@1.63.0
```

Only the client library is needed: the browser runs in SYM Browser.

## 3. Create a session

Copy the three blocks below, in order, into `quickstart.mjs`.

```js quickstart
// quickstart.mjs: SYMB_URL and SYMB_API_KEY come from step 1.
import { chromium } from 'playwright-core';

const SYMB_URL = process.env.SYMB_URL ?? 'http://localhost:3000';
const SYMB_API_KEY = process.env.SYMB_API_KEY;
const target = new URL(process.env.TARGET_URL ?? 'https://example.com/');

// A dedicated session (the default type): a Chromium of its own, reachable over CDP.
// Its egress only lets through the target host and port.
const created = await fetch(`${SYMB_URL}/v1/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${SYMB_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    timeoutSeconds: 120,
    egress: { allowedHosts: [target.hostname], ports: [Number(target.port || (target.protocol === 'https:' ? 443 : 80))] },
    metadata: { guide: 'quickstart' },
  }),
});
if (!created.ok) throw new Error(`POST /v1/sessions: ${created.status} ${await created.text()}`);
const session = await created.json();
console.log(`session ${session.id}: ${session.state} (${session.type})`);
```

The answer carries `connectUrls`: `cdp` and `playwright` are `wss://` URLs with a short-lived token in `?token=`. No other header is needed to open them.

## 4. Drive it over CDP

```js quickstart
// The CDP URL is enough: the token is in its query.
const browser = await chromium.connectOverCDP(session.connectUrls.cdp);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.goto(target.href);
console.log(`title: ${await page.title()}`);
```

## 5. Release the session

```js quickstart
// Release: the browser, its profile and its files are destroyed; the final usage comes back in the answer.
const released = await fetch(`${SYMB_URL}/v1/sessions/${session.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${SYMB_API_KEY}` },
});
const ended = await released.json();
console.log(`session ${ended.id}: ${ended.state} (${ended.endReason})`);
await browser.close();
```

Run it:

```bash
node quickstart.mjs
```

```text
session 6f1c0a52-…: running (dedicated)
title: Example Domain
session 6f1c0a52-…: ended (released)
```

SYM 👻: Done! The session is gone, and so is everything it touched. Forget to release one and I end it myself when `timeoutSeconds` runs out.

## Next

- [Connect another client](clients/README.md): Puppeteer, Stagehand, browser-use, Skyvern, MCP servers.
- [Use the SDK](sdk.md) instead of `fetch`.
- [Deploy for real](deployment.md), then [add nodes](nodes.md).
