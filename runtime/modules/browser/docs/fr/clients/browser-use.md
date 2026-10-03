# browser-use

browser-use (Python) s'attache à un navigateur existant avec `cdp_url`. Il n'envoie aucun en-tête d'authentification : garde le jeton dans l'URL (`?token=`), tel que `connectUrls.cdp` le fournit.

## Crée la session

N'importe quel client HTTP fait l'affaire ; avec `httpx` :

```python
import os

import httpx

symb_url = os.environ["SYMB_URL"]
headers = {"Authorization": "Bearer " + os.environ["SYMB_API_KEY"]}
session = httpx.post(f"{symb_url}/v1/sessions", headers=headers, json={"timeoutSeconds": 600}).json()
cdp_url = session["connectUrls"]["cdp"]  # wss://…/v1/sessions/{id}/cdp?token=…
```

## Attache browser-use

```python
import asyncio

from browser_use import Agent, Browser, ChatOpenAI


async def main() -> None:
    browser = Browser(cdp_url=cdp_url)
    agent = Agent(task="Ouvre example.com et donne-moi le titre de la page", llm=ChatOpenAI(model="gpt-4.1-mini"), browser=browser)
    await agent.run()


asyncio.run(main())
```

## Libère la session

```python
httpx.delete(f"{symb_url}/v1/sessions/{session['id']}", headers=headers)
```

## Remarques

- L'exemple ci-dessus vit dans ton propre projet ; SYM Browser ne fournit que le navigateur.
- Si l'agent tourne plus de 5 minutes avant de se connecter, relis la session (`GET /v1/sessions/{id}`) pour obtenir une `cdp_url` neuve.
