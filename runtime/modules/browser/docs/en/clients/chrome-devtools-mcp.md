# Chrome DevTools MCP

The Chrome DevTools MCP server (`chrome-devtools-mcp`) lets an AI assistant inspect and drive Chrome. With `--wsEndpoint` it attaches to a SYM Browser session.

## Token in the URL

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

## Token in a header

`--wsHeaders` takes a JSON object of headers; send the token as `Authorization: Bearer`:

```json
{
  "mcpServers": {
    "sym-browser-devtools": {
      "command": "npx",
      "args": [
        "chrome-devtools-mcp@latest",
        "--wsEndpoint", "wss://browser.example.com/v1/sessions/{id}/cdp",
        "--wsHeaders", "{\"Authorization\":\"Bearer <connect token>\"}"
      ]
    }
  }
}
```

## Notes

- Performance traces and network inspection run inside the session's own Chromium; its egress still applies.
- The connection token lasts 5 minutes: read the session again (`GET /v1/sessions/{id}`) to get a fresh URL.
