# Puppeteer

Puppeteer connects with `puppeteer.connect({ browserWSEndpoint })`. Use `puppeteer-core`: the browser runs in SYM Browser, nothing to download.

## Token in the URL

```ts
import puppeteer from 'puppeteer-core';

// session: answer of POST /v1/sessions (connectUrls.cdp ends with ?token=…)
const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrls.cdp });
const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.disconnect();
```

## Token in a header

```ts
const url = new URL(session.connectUrls.cdp);
const token = url.searchParams.get('token');
url.search = '';
const browser = await puppeteer.connect({
  browserWSEndpoint: url.toString(),
  headers: { Authorization: `Bearer ${token}` },
});
```

## Notes

- `browser.disconnect()` leaves the session running; `browser.close()` releases it.
- Discovery: `GET /v1/sessions/{id}/cdp/json/version` (token in `?token=` or as `Bearer`) returns a `webSocketDebuggerUrl` that points at the gateway with a fresh token.
- With `recordings: { video: true, har: true, console: true }` at creation, the node records the session itself: a `webm` video, a HAR and the console log come back as recordings.
