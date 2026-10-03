<div align="center">

<img src="docs/assets/banner.svg" alt="SYM Browser (SYM 👻): remote browsers, one wss:// address per session" width="860">

# SYM Browser (SYM 👻)

**Ask for a browser. Get a `wss://` address. Drive it with the client you already use.**

<img src="docs/assets/badges/license.svg" alt="license: AGPL-3.0"> <img src="docs/assets/badges/sdk.svg" alt="sdk: MIT"> <img src="docs/assets/badges/status.svg" alt="status: pre-release"> <img src="docs/assets/badges/protocol.svg" alt="protocol: CDP"> <img src="docs/assets/badges/deploy.svg" alt="deploy: self-hosted">

English · [Français](README.fr.md)

</div>

SYM Browser is a service that runs Chromium browsers on demand and lets you drive them remotely. You create a session with one REST call and get back a `wss://` address that speaks the common protocol, CDP. Playwright, Puppeteer, Stagehand, browser-use and the other CDP clients connect to it as if the browser were local. When the session ends, everything it touched is destroyed: processes, profile, files, network tunnels.

It is open source and self-hosted. You can install it on its own, or alongside [SYM](https://github.com/scrap-yo-mama/sym), which uses it as one of its browser providers. Your servers, your keys, your traffic.

> SYM 👻: you ask for a browser, I hand you an address. When you're done, I clean up behind you.

> [!WARNING]
> **Status: pre-release, work in progress. Not ready for production.**
> There is no stable release yet. The REST API, the node pool and the WebSocket relay are being built and tested in CI; the TypeScript SDK client shown below is the planned interface and is not published yet. Interfaces and database schema will change. Please do not build anything critical on it today.

## How it feels

```text
you> I need a browser for my scraper. Ten minutes, example.com only.
SYM 👻: Here you go: wss://browser.example.com/v1/sessions/6f1c…/cdp?token=…
you> Done.
SYM 👻: Released. 7 min 12 s of browser, 3.4 MB out, nothing left behind.
```

## What it does

What SYM Browser is built for. The warning above says what is ready today.

- **One address per session.** Every session gets its own `wss://` URL with a short-lived token. By default a session is `dedicated` (a whole Chromium), driven over CDP; `shared` sessions (a context in a warm Chromium) are driven with native Playwright.
- **Works with your client.** Playwright `connectOverCDP`, Puppeteer `connect`, Stagehand `cdpUrl`, browser-use `cdp_url`: no plugin, no fork.
- **A governed network per session.** Each session goes out through its own egress: allowed hosts, upstream proxy (HTTP, HTTPS, SOCKS5), DNS resolved once and checked, byte budget, every connection counted.
- **Nothing left behind.** Release, timeout, crash or node shutdown: the browser, its profile, its files and its tunnels are destroyed in a fixed order.
- **Secrets stay secret.** API keys are hashed, proxy passwords and persistent profiles are encrypted at rest, and logs are redacted.
- **Accounted to the second.** Every second of browser time and every byte of egress is measured by the node and reconciled.

## Quick look

With the SDK (planned interface of `@sym-browser/sdk`):

```ts
import { SymBrowser } from '@sym-browser/sdk';

// url and apiKey default to SYMB_URL and SYMB_API_KEY
const symb = new SymBrowser({ url: 'https://browser.example.com', apiKey: process.env.SYMB_API_KEY });

// released at the end of the block (await using), or when the process exits
await using session = await symb.sessions.create({
  timeoutSeconds: 120,
  egress: { allowedHosts: ['example.com'], budgetBytes: 50_000_000 },
  metadata: { job: 'demo' },
});

// dedicated by default: a whole Chromium, driven over CDP
const browser = await symb.connectCDP(session);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
console.log(await page.title());

for await (const event of symb.events(session.id)) {
  if (event.type === 'egress.blocked') console.warn('blocked:', event.data.host);
  if (event.type === 'state' && event.data.state !== 'running') break;
}
```

With any CDP client, no SDK needed:

```ts
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer-core';

// one REST call, then the session's wss:// address
const session = await fetch('https://browser.example.com/v1/sessions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.SYMB_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ timeoutSeconds: 600 }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.connectUrls.cdp); // Playwright
const pptr = await puppeteer.connect({ browserWSEndpoint: session.connectUrls.cdp }); // Puppeteer
// Stagehand: localBrowserLaunchOptions: { cdpUrl: session.connectUrls.cdp }
```

## Works with

| Client | How it connects |
|---|---|
| [Playwright](https://playwright.dev/) | `chromium.connectOverCDP(url)`, or native `chromium.connect(url)` for `shared` sessions |
| [Puppeteer](https://pptr.dev/) | `puppeteer.connect({ browserWSEndpoint: url })` |
| [Stagehand](https://github.com/browserbase/stagehand) | `localBrowserLaunchOptions.cdpUrl` |
| [browser-use](https://github.com/browser-use/browser-use) | `Browser(cdp_url=url)` |
| Any [CDP](https://chromedevtools.github.io/devtools-protocol/) client | the `wss://` address, token in the query or in `Authorization: Bearer` |

## On its own or with SYM

SYM Browser is a product of its own. It deploys, runs, counts usage and is administered without SYM: its own image, its own PostgreSQL database, its own console, clients and API keys. Its only dependencies are its database, its master key and its object storage (local disk or S3).

[SYM](https://github.com/scrap-yo-mama/sym) is one client among others: it holds an API key and calls the same `/v1` API. The same contract works on the same host as SYM or on another server; only the configuration changes.

## Self-hosted

- **One image, three roles.** `all` (gateway and node in one process), or `gateway` and `node` on separate machines. See the [Dockerfile](Dockerfile) and the [seccomp profile](deploy/seccomp-chromium.json).
- **Hardened by default.** Chromium runs as a non-root user with its sandbox on, `tini` as PID 1, a seccomp profile, and a closed list of launch arguments.
- **Pinned versions.** Playwright 1.63.0 and Chromium 153, checked at connection time.

## What is in this folder

| Folder | Package | License | Role |
|---|---|---|---|
| [`apps/gateway`](apps/gateway) | `@sym-browser/gateway` | AGPL-3.0 | REST `/v1`, WebSocket relay, quotas, routing |
| [`apps/node`](apps/node) | `@sym-browser/node` | AGPL-3.0 | Chromium pool, sessions, per-session egress |
| [`apps/console`](apps/console) | `@sym-browser/console` | AGPL-3.0 | Web console (English and French) |
| [`packages/sdk`](packages/sdk) | `@sym-browser/sdk` | MIT | TypeScript SDK |
| [`packages/core`](packages/core) | `@sym-browser/core` | AGPL-3.0 | Encryption, configuration, logs |
| [`packages/db`](packages/db) | `@sym-browser/db` | AGPL-3.0 | PostgreSQL schema and migrations |

## License

- **Service (gateway, node, console, core, db): [AGPL-3.0](LICENSE)** ([text](https://www.gnu.org/licenses/agpl-3.0)).
- **TypeScript SDK (`packages/sdk`): [MIT](packages/sdk/LICENSE)** ([text](https://opensource.org/license/mit)). The API contract `@sym/contracts` is MIT too.

Licenses grant rights on the code, not on the name or logo.

## Built with AI assistance

Much of this code and documentation was written with AI assistance, then reviewed, tested and run through CI by a human. If you spot something off, say so.
