---
title: SYM Browser
description: Remote Chromium browsers on demand, one wss:// address per session, for Playwright, Puppeteer, Stagehand and every CDP client. Open source and self-hosted.
---

<!-- Page of the SYM website (task 5.5). Source of truth for the content: the module README. -->

# SYM Browser

English · [Français](../fr/sym-browser.md)

**Ask for a browser. Get a `wss://` address. Drive it with the client you already use.**

SYM Browser is the browser service of the SYM family. It runs Chromium on demand, isolates each session behind its own network egress, and destroys everything when the session ends. It speaks CDP, the protocol your tools already know, so there is nothing new to learn on the client side.

> SYM 👻: you ask for a browser, I hand you an address. When you're done, I clean up behind you.

**Pre-release.** SYM Browser is under active development and not production-ready yet.

## How it works

1. **Create a session.** One REST call to `/v1/sessions`, with an API key. Options: duration, network policy, upstream proxy, profile, recordings.
2. **Connect.** The answer holds a `wss://` address with a short-lived token. Point Playwright, Puppeteer, Stagehand or browser-use at it.
3. **Release.** Release it, let it time out, or let the SDK release it when your process exits. The browser, its files and its tunnels are destroyed; usage is counted to the second.

## Try it

```ts
import { chromium } from 'playwright-core';

// one REST call, then the session's wss:// address
const session = await fetch('https://browser.example.com/v1/sessions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.SYMB_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ timeoutSeconds: 600 }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.connectUrls.cdp);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
```

## Why SYM Browser

- **Your client, unchanged.** CDP for [Playwright](https://playwright.dev/), [Puppeteer](https://pptr.dev/), [Stagehand](https://github.com/browserbase/stagehand), [browser-use](https://github.com/browser-use/browser-use); native Playwright for lightweight `shared` sessions.
- **A governed network per session.** Allowed hosts, upstream proxies (HTTP, HTTPS, SOCKS5), byte budgets, private addresses refused.
- **Nothing left behind.** Processes, profile, files and tunnels destroyed at the end of every session.
- **Yours.** Open source (AGPL-3.0, SDK MIT), self-hosted, no telemetry.

## On its own or with SYM

Install SYM Browser on its own, for your scrapers, tests and agents, or next to [SYM](https://github.com/scrap-yo-mama/sym), which uses it as a browser provider. Same API either way.

## Learn more

- [README](../../../README.md): what it does, examples with the SDK and with any CDP client, license.
- [Source code](https://github.com/scrap-yo-mama/sym): SYM Browser lives in `runtime/modules/browser/` until its public mirror opens.
