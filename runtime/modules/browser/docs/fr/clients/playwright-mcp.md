# Playwright MCP

Le serveur Playwright MCP (`@playwright/mcp`) donne un navigateur à un assistant IA. Avec `--cdp-endpoint`, il pilote une session SYM Browser au lieu de démarrer son propre Chromium.

## Jeton dans l'URL

```json
{
  "mcpServers": {
    "sym-browser": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--cdp-endpoint", "wss://browser.example.com/v1/sessions/{id}/cdp?token=…"]
    }
  }
}
```

## Jeton dans un en-tête

`--cdp-header` envoie le jeton en `Authorization: Bearer`, il n'apparaît donc pas dans l'URL :

```json
{
  "mcpServers": {
    "sym-browser": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint", "wss://browser.example.com/v1/sessions/{id}/cdp",
        "--cdp-header", "Authorization: Bearer <jeton de connexion>"
      ]
    }
  }
}
```

## Remarques

- Le jeton de connexion dure 5 minutes et la session vit `timeoutSeconds` : crée la session juste avant de démarrer le serveur MCP, avec un délai qui couvre la conversation.
- Restreins l'egress de la session (`egress.allowedHosts`) à ce que l'assistant a le droit de visiter.
