# Playwright MCP

The Playwright MCP server (`@playwright/mcp`) gives an AI assistant a browser. With `--cdp-endpoint` it drives a SYM Browser session instead of starting its own Chromium.

## Token in the URL

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

## Token in a header

`--cdp-header` sends the token as `Authorization: Bearer`, so it does not appear in the URL:

```json
{
  "mcpServers": {
    "sym-browser": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--cdp-endpoint", "wss://browser.example.com/v1/sessions/{id}/cdp",
        "--cdp-header", "Authorization: Bearer <connect token>"
      ]
    }
  }
}
```

## Notes

- The connection token lasts 5 minutes and the session lives `timeoutSeconds`: create the session right before starting the MCP server, with a timeout that covers the conversation.
- Restrict the session's egress (`egress.allowedHosts`) to what the assistant may visit.
