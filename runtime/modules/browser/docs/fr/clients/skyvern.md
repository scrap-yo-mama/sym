# Skyvern

Skyvern se connecte à un navigateur existant en CDP quand `BROWSER_TYPE=cdp-connect`, avec l'URL du navigateur dans `BROWSER_REMOTE_DEBUGGING_URL`. Il n'envoie aucun en-tête d'authentification : utilise la `connectUrls.cdp` complète, jeton compris (`?token=`).

## Configure Skyvern

Crée d'abord une session (voir le [démarrage rapide](../quickstart.md)), puis démarre Skyvern avec :

```bash
export BROWSER_TYPE=cdp-connect
export BROWSER_REMOTE_DEBUGGING_URL='wss://browser.example.com/v1/sessions/{id}/cdp?token=…'
```

## Depuis Python

La même session, créée et transmise depuis Python :

```python
import os

import httpx

symb_url = os.environ["SYMB_URL"]
headers = {"Authorization": "Bearer " + os.environ["SYMB_API_KEY"]}
session = httpx.post(f"{symb_url}/v1/sessions", headers=headers, json={"timeoutSeconds": 1800}).json()

os.environ["BROWSER_TYPE"] = "cdp-connect"
os.environ["BROWSER_REMOTE_DEBUGGING_URL"] = session["connectUrls"]["cdp"]
# Démarre Skyvern depuis cet environnement, puis libère la session à la fin de la tâche :
# httpx.delete(f"{symb_url}/v1/sessions/{session['id']}", headers=headers)
```

## Remarques

- Le jeton de connexion dure 5 minutes : crée la session juste avant le démarrage de Skyvern, ou relis-la pour rafraîchir `connectUrls`.
- Donne à la session un `timeoutSeconds` qui couvre toute la tâche, et restreins son egress aux sites dont la tâche a besoin.
