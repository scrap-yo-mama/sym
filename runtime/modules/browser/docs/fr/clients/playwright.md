# Playwright

Playwright se connecte à une session `dedicated` en CDP avec `chromium.connectOverCDP`. Installe seulement la bibliothèque cliente (`playwright-core` ou `playwright`) ; la version 1.63 correspond au serveur.

## Jeton dans l'URL

```ts
import { chromium } from 'playwright-core';

// session : réponse de POST /v1/sessions (connectUrls.cdp se termine par ?token=…)
const browser = await chromium.connectOverCDP(session.connectUrls.cdp);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.goto('https://example.com');
console.log(await page.title());
```

## Jeton dans un en-tête

Si tes journaux ou tes outils ne doivent pas voir le jeton dans une URL, retire la query et envoie-le en `Authorization: Bearer` :

```ts
const url = new URL(session.connectUrls.cdp);
const token = url.searchParams.get('token');
url.search = '';
const browser = await chromium.connectOverCDP(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
```

## Playwright natif

`connectUrls.playwright` sert le protocole Playwright natif (`chromium.connect`), pour les sessions `shared` comme `dedicated`. Il exige Playwright 1.63.x côté client : une autre version majeure.mineure répond `428 playwright_version_mismatch`.

```ts
const browser = await chromium.connect(session.connectUrls.playwright);
```

## Remarques

- `browser.close()` en CDP libère la session. Pour la garder, laisse simplement le process se terminer ou déconnecte-toi.
- Les traces et vidéos sont produites sur le serveur pour les sessions CDP (option `recordings` à la création) : `connectOverCDP` ne peut pas les enregistrer de ton côté.
