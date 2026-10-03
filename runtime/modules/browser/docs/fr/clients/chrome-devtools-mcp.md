# Chrome DevTools MCP

Le serveur Chrome DevTools MCP (`chrome-devtools-mcp`) permet à un assistant IA d'inspecter et de piloter Chrome. Avec `--wsEndpoint`, il s'attache à une session SYM Browser.

## Jeton dans l'URL

```json
{
  "mcpServers": {
    "sym-browser-devtools": {
      "command": "npx",
      "args": ["chrome-devtools-mcp@latest", "--wsEndpoint", "wss://browser.example.com/v1/sessions/{id}/cdp?token=…"]
    }
  }
}
```

## Jeton dans un en-tête

`--wsHeaders` prend un objet JSON d'en-têtes ; envoie le jeton en `Authorization: Bearer` :

```json
{
  "mcpServers": {
    "sym-browser-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--wsEndpoint", "wss://browser.example.com/v1/sessions/{id}/cdp",
        "--wsHeaders", "{\"Authorization\":\"Bearer <jeton de connexion>\"}"
      ]
    }
  }
}
```

## Remarques

- Les traces de performance et l'inspection réseau tournent dans le Chromium de la session ; son egress s'applique toujours.
- Le jeton de connexion dure 5 minutes : relis la session (`GET /v1/sessions/{id}`) pour obtenir une URL neuve.
