# TypeScript SDK

> **To review with task 3.4.** The `SymBrowser` client is not published yet: `@sym-browser/sdk` currently exports the contract types only. This page describes the API fixed by the specification (04 § 10) and the contract `@sym/contracts/browser` 1.0.0; the examples will be run in CI with the SDK. Until then, use the REST API as in the [quickstart](quickstart.md).

The `@sym-browser/sdk` package (MIT) wraps the REST API, the connections and the events. Its types are generated from the OpenAPI document of the contract.

```bash
npm install @sym-browser/sdk playwright-core@1.63.0
```

## Client

```ts
import { SymBrowser } from '@sym-browser/sdk';

// url and apiKey default to the SYMB_URL and SYMB_API_KEY environment variables.
const symb = new SymBrowser({ url: process.env.SYMB_URL, apiKey: process.env.SYMB_API_KEY });
```

| API | Role |
|---|---|
| `sessions.create(options)` · `get(id)` · `list(filter)` · `release(id)` · `extend(id, seconds)` | Session lifecycle, same fields as `POST /v1/sessions` ([reference](reference/api.md)) |
| `connectCDP(session)` | A Playwright `Browser` over `connectOverCDP` (`dedicated` sessions, the default) |
| `connect(session)` | A Playwright `Browser` over native Playwright (`chromium.connect`); checks the version through `GET /v1/version` |
| `events(sessionId)` | Async iterator over the server-sent events: `state`, `egress.blocked`, `download`, `recording.ready` |
| `sessions.egress.get(id)` · `put(id, policy)` | Egress counters and policy |
| `version()` | `GET /v1/version` |
| `profiles` · `files` | Persistent profiles and session files |

## Automatic release

The SDK releases the sessions it created when the process exits (`SIGINT`, `SIGTERM`, `beforeExit`) and at the end of an `await using` block (`Symbol.asyncDispose`).

```ts
import { SymBrowser } from '@sym-browser/sdk';

const symb = new SymBrowser();

await using session = await symb.sessions.create({
  timeoutSeconds: 120,
  egress: { allowedHosts: ['example.com'], budgetBytes: 50_000_000 },
  metadata: { job: 'demo' },
});

// dedicated session (default type): CDP connection.
const browser = await symb.connectCDP(session);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
console.log(await page.title());

for await (const event of symb.events(session.id)) {
  if (event.type === 'state' && event.data.state !== 'running') break;
}
// End of the block: release() is called; the final usage is in symb.sessions.get(session.id).
```

## Native Playwright

A `shared` session (a fresh context in a warm Chromium, cheaper) is driven with native Playwright only:

```ts
await using session = await symb.sessions.create({ type: 'shared', timeoutSeconds: 60 });
const browser = await symb.connect(session);
```

`connect(session)` requires Playwright 1.63.x on your side: the server refuses another major.minor version with `428 playwright_version_mismatch`.

## Errors

Every failed call throws an error carrying the stable `code` of the API (`unauthorized`, `quota_exceeded`, `capacity_exceeded`, `no_node`…), `retryable` and `what_to_do`. The full list is in the [API reference](reference/api.md#error-codes).
