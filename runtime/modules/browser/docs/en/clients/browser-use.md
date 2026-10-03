# browser-use

browser-use (Python) attaches to an existing browser with `cdp_url`. It sends no authentication header: keep the token in the URL (`?token=`), as `connectUrls.cdp` provides it.

## Create the session

Any HTTP client works; with `httpx`:

```python
import os

import httpx

symb_url = os.environ["SYMB_URL"]
headers = {"Authorization": "Bearer " + os.environ["SYMB_API_KEY"]}
session = httpx.post(f"{symb_url}/v1/sessions", headers=headers, json={"timeoutSeconds": 600}).json()
cdp_url = session["connectUrls"]["cdp"]  # wss://…/v1/sessions/{id}/cdp?token=…
```

## Attach browser-use

```python
import asyncio

from browser_use import Agent, Browser, ChatOpenAI


async def main() -> None:
    browser = Browser(cdp_url=cdp_url)
    agent = Agent(task="Open example.com and give me the page title", llm=ChatOpenAI(model="gpt-4.1-mini"), browser=browser)
    await agent.run()


asyncio.run(main())
```

## Release

```python
httpx.delete(f"{symb_url}/v1/sessions/{session['id']}", headers=headers)
```

## Notes

- The example above lives in your own project; SYM Browser only provides the browser.
- If the agent runs longer than 5 minutes before it connects, read the session again (`GET /v1/sessions/{id}`) to get a fresh `cdp_url`.
