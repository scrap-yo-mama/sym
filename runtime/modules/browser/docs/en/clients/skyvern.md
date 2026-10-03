# Skyvern

Skyvern connects to an existing browser over CDP when `BROWSER_TYPE=cdp-connect`, with the browser URL in `BROWSER_REMOTE_DEBUGGING_URL`. It sends no authentication header: use the full `connectUrls.cdp`, token included (`?token=`).

## Configure Skyvern

Create a session first (see the [quickstart](../quickstart.md)), then start Skyvern with:

```bash
export BROWSER_TYPE=cdp-connect
export BROWSER_REMOTE_DEBUGGING_URL='wss://browser.example.com/v1/sessions/{id}/cdp?token=…'
```

## From Python

The same session, created and passed from Python:

```python
import os

import httpx

symb_url = os.environ["SYMB_URL"]
headers = {"Authorization": "Bearer " + os.environ["SYMB_API_KEY"]}
session = httpx.post(f"{symb_url}/v1/sessions", headers=headers, json={"timeoutSeconds": 1800}).json()

os.environ["BROWSER_TYPE"] = "cdp-connect"
os.environ["BROWSER_REMOTE_DEBUGGING_URL"] = session["connectUrls"]["cdp"]
# Start Skyvern from this environment, then release the session when the task ends:
# httpx.delete(f"{symb_url}/v1/sessions/{session['id']}", headers=headers)
```

## Notes

- The connection token lasts 5 minutes: create the session right before Skyvern starts, or read it again to refresh `connectUrls`.
- Give the session a `timeoutSeconds` that covers the whole task, and restrict its egress to the sites the task needs.
