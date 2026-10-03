# Playwright

Playwright connects to a `dedicated` session over CDP with `chromium.connectOverCDP`. Install the client library only (`playwright-core` or `playwright`); version 1.63 matches the server.

## Token in the URL

```ts
import { chromium } from 'playwright-core';

// session: answer of POST /v1/sessions (connectUrls.cdp ends with ?token=…)
const browser = await chromium.connectOverCDP(session.connectUrls.cdp);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.goto('https://example.com');
console.log(await page.title());
```

## Token in a header

If your logs or tools must not see the token in a URL, drop the query and send it as `Authorization: Bearer`:

```ts
const url = new URL(session.connectUrls.cdp);
const token = url.searchParams.get('token');
url.search = '';
const browser = await chromium.connectOverCDP(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
```

## Native Playwright

`connectUrls.playwright` serves the native Playwright protocol (`chromium.connect`), for `shared` and `dedicated` sessions alike. It requires Playwright 1.63.x on the client: another major.minor version answers `428 playwright_version_mismatch`.

```ts
const browser = await chromium.connect(session.connectUrls.playwright);
```

## Notes

- `browser.close()` over CDP releases the session. To keep it, just let the process end or disconnect.
- Traces and videos are produced on the server for CDP sessions (`recordings` option at creation): `connectOverCDP` cannot record them on your side.
