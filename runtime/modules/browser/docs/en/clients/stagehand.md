# Stagehand

Stagehand drives a remote browser in `LOCAL` mode through `localBrowserLaunchOptions.cdpUrl`. It sends no authentication header: the token stays in the URL (`?token=`), which is exactly what `connectUrls.cdp` contains.

```ts
import { Stagehand } from '@browserbasehq/stagehand';

// session: answer of POST /v1/sessions (connectUrls.cdp ends with ?token=…)
const stagehand = new Stagehand({
  env: 'LOCAL',
  localBrowserLaunchOptions: { cdpUrl: session.connectUrls.cdp },
});
await stagehand.init();

const page = stagehand.page;
await page.goto('https://example.com');
console.log(await page.title());

await stagehand.close();
```

## Notes

- Stagehand's AI features need your own model provider key; SYM Browser only provides the browser.
- `stagehand.close()` closes the browser, which releases the session. Create a new session for the next run.
- Restrict the session's egress to the sites your agent must visit (`egress.allowedHosts` at creation).
