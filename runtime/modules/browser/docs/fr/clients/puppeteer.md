# Puppeteer

Puppeteer se connecte avec `puppeteer.connect({ browserWSEndpoint })`. Utilise `puppeteer-core` : le navigateur tourne dans SYM Browser, rien à télécharger.

## Jeton dans l'URL

```ts
import puppeteer from 'puppeteer-core';

// session : réponse de POST /v1/sessions (connectUrls.cdp se termine par ?token=…)
const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrls.cdp });
const page = await browser.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.disconnect();
```

## Jeton dans un en-tête

```ts
const url = new URL(session.connectUrls.cdp);
const token = url.searchParams.get('token');
url.search = '';
const browser = await puppeteer.connect({
  browserWSEndpoint: url.toString(),
  headers: { Authorization: `Bearer ${token}` },
});
```

## Remarques

- `browser.disconnect()` laisse la session tourner ; `browser.close()` la libère.
- Découverte : `GET /v1/sessions/{id}/cdp/json/version` (jeton dans `?token=` ou en `Bearer`) renvoie un `webSocketDebuggerUrl` qui pointe vers la passerelle avec un jeton neuf.
- Avec `recordings: { video: true, har: true, console: true }` à la création, le nœud enregistre lui-même la session : une vidéo `webm`, un HAR et le journal de la console reviennent en enregistrements.
