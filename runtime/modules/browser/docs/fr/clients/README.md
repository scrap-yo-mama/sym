# Brancher un client

SYM 👻 : N'importe quel client CDP marche avec une session `dedicated`. Donne-lui `connectUrls.cdp`, c'est tout.

Crée d'abord une session (voir le [démarrage rapide](../quickstart.md)) : sa `connectUrls.cdp` ressemble à `wss://browser.example.com/v1/sessions/{id}/cdp?token=…`. L'URL se suffit à elle-même : le jeton court voyage dans `?token=`, aucun en-tête n'est nécessaire. Les clients qui savent envoyer des en-têtes peuvent aussi passer le jeton en `Authorization: Bearer`. Relis la session (`GET /v1/sessions/{id}`) pour obtenir des jetons neufs avant de te reconnecter plus de 5 minutes après.

| Client | Paramètre | Jeton | Guide |
|---|---|---|---|
| Playwright | `chromium.connectOverCDP(url, { headers })` | query ou en-tête | [Playwright](playwright.md) |
| Puppeteer | `puppeteer.connect({ browserWSEndpoint, headers })` | query ou en-tête | [Puppeteer](puppeteer.md) |
| Stagehand | `localBrowserLaunchOptions.cdpUrl` | query | [Stagehand](stagehand.md) |
| browser-use | `Browser(cdp_url=…)` | query | [browser-use](browser-use.md) |
| Skyvern | `BROWSER_TYPE=cdp-connect`, `BROWSER_REMOTE_DEBUGGING_URL` | query | [Skyvern](skyvern.md) |
| Playwright MCP | `--cdp-endpoint`, `--cdp-header` | query ou en-tête | [Playwright MCP](playwright-mcp.md) |
| Chrome DevTools MCP | `--wsEndpoint`, `--wsHeaders` | query ou en-tête | [Chrome DevTools MCP](chrome-devtools-mcp.md) |

Bon à savoir, quel que soit le client :

- Le CDP est servi par les sessions `dedicated` (le type par défaut). Demander le CDP sur une session `shared` répond `409 protocol_not_served`.
- Déconnecter ton client garde la session en vie jusqu'à ce que tu la libères ou qu'elle expire. Fermer le navigateur (`Browser.close`) libère la session.
- Les nouveaux contextes et les téléchargements restent dans la session : son egress et son répertoire de téléchargement s'appliquent, quoi que demande le client.
