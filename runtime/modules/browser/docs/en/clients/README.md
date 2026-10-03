# Connect a client

SYM 👻: Any CDP client works with a `dedicated` session. Give it `connectUrls.cdp`, that is all.

Create a session first (see the [quickstart](../quickstart.md)): its `connectUrls.cdp` looks like `wss://browser.example.com/v1/sessions/{id}/cdp?token=…`. The URL is self-sufficient: the short-lived token travels in `?token=`, no header is needed. Clients that can send headers may also pass the token as `Authorization: Bearer`. Read the session again (`GET /v1/sessions/{id}`) to get fresh tokens before reconnecting later than 5 minutes.

| Client | Parameter | Token | Guide |
|---|---|---|---|
| Playwright | `chromium.connectOverCDP(url, { headers })` | query or header | [Playwright](playwright.md) |
| Puppeteer | `puppeteer.connect({ browserWSEndpoint, headers })` | query or header | [Puppeteer](puppeteer.md) |
| Stagehand | `localBrowserLaunchOptions.cdpUrl` | query | [Stagehand](stagehand.md) |
| browser-use | `Browser(cdp_url=…)` | query | [browser-use](browser-use.md) |
| Skyvern | `BROWSER_TYPE=cdp-connect`, `BROWSER_REMOTE_DEBUGGING_URL` | query | [Skyvern](skyvern.md) |
| Playwright MCP | `--cdp-endpoint`, `--cdp-header` | query or header | [Playwright MCP](playwright-mcp.md) |
| Chrome DevTools MCP | `--wsEndpoint`, `--wsHeaders` | query or header | [Chrome DevTools MCP](chrome-devtools-mcp.md) |

Good to know for every client:

- CDP is served by `dedicated` sessions (the default type). Asking for CDP on a `shared` session answers `409 protocol_not_served`.
- Disconnecting your client keeps the session alive until you release it or it times out. Closing the browser (`Browser.close`) releases the session.
- New contexts and downloads stay inside the session: its egress and its download directory apply, whatever the client asks.
