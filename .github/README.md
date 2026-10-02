<a href="README.md">English</a> · <a href="README.fr.md">Français</a>

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/banner-light.png">
  <img alt="Scrapyomama and SYM next to the SYM ghost logo" src="assets/brand/banner-light.png" width="800"></picture></p>

<p align="center"><b>Describe the data. SYM 👻 handles the rest.</b><br>Open source and self-hosted: nothing to sign up for.</p>

<p align="center"><a href="https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/index.md">Docs</a> · <a href="https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/tutoriels/quickstart.md">Quickstart</a> · <a href="https://github.com/scrap-yo-mama/sym/discussions">Discussions</a><br>
<a href="https://github.com/scrap-yo-mama/sym/blob/main/LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/github/license/scrap-yo-mama/sym"></a> <a href="https://github.com/scrap-yo-mama/sym/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/scrap-yo-mama/sym?include_prereleases"></a> <a href="https://github.com/scrap-yo-mama/sym/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/scrap-yo-mama/sym/ci.yml?branch=main"></a></p>

> [!WARNING]
> **Pre-release, not ready for production.** There is no stable release yet and interfaces will change.
> **Not delivered yet:** repair, the REST API for APIs and runs, and the MCP server. Until they land, you cannot ask your AI for data through SYM.

<!-- demo: the terminal GIF (assets/demo/quickstart-en.gif) is added by task 3.11 -->

## What it does

- **Stays yours.** Self-hosted, bring your own model, and nothing is sent to us by default.
- **Cheapest route first.** SYM tries the cheapest executor first (plain HTTP, then a real browser, then a model or an agent) and logs every attempt.
- **Six executors.** HTTP fetch, a real browser page, sandboxed scripts, model-shaped extraction, script plus agent steps and a full agent; a successful agent run compiles into a replayable strategy.
- **Guard rails.** Strategy code runs in a sandbox, outgoing requests pass an SSRF guard, and requests to each domain are paced.
- **Your session, with your consent.** For sites behind a login, a browser extension runs steps through your own session, domain by domain, only after you agree.

## Try it (no key)

SYM 👻: On it. You need Docker with Compose and about 4 GB of memory. The commands are the ones the CI replays on a blank instance.

```bash
git clone https://github.com/scrap-yo-mama/sym && cd sym/runtime
(
  umask 077
  set -C
  {
    echo "MASTER_KEY=$(openssl rand -base64 32)"
    echo "ADMIN_BOOTSTRAP_TOKEN=$(openssl rand -base64 32)"
  } > .env
)
docker compose up --build
```

The first start builds the image, so count several minutes. The [quickstart](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/tutoriels/quickstart.md) goes on from there (owner account, API key). The demo mode with no key arrives with the first release. The docs are in French for now.

Deploy for real: [Render and Docker Compose guides](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/guides/deploiement.md).

## Connect your AI chat (MCP)

Not wired yet: the MCP server arrives with the first release. This is the shape of the configuration it will use, for any MCP client that speaks HTTP.

```json
{ "mcpServers": { "sym": { "url": "https://YOUR-INSTANCE/mcp",
  "headers": { "Authorization": "Bearer YOUR-KEY" } } } }
```

## Verify what you download

<details>
<summary>Signature, provenance, checksums</summary>

Nothing is published yet: there is no release or image to verify until the first release. This is the check you will run, with the version in place of `X.Y.Z`.

```bash
cosign verify ghcr.io/scrap-yo-mama/sym:X.Y.Z \
  --certificate-identity=https://github.com/scrap-yo-mama/sym/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/scrap-yo-mama/sym:X.Y.Z -R scrap-yo-mama/sym
sha256sum -c SHA256SUMS
```

Images will be pinned to `X.Y.Z`, with no floating `latest`.
</details>

## How it's built

Much of this code and documentation was written with AI assistance, then reviewed, tested and run through CI. If something looks off, say so.

## Licenses

| What | License |
|---|---|
| Server, worker, console, extension, command line | [AGPL-3.0](https://github.com/scrap-yo-mama/sym/blob/main/LICENSE) |
| `runtime/packages/client`, `runtime/packages/schemas` | MIT |
| Name and logo | [Trademark policy](https://github.com/scrap-yo-mama/sym/blob/main/runtime/TRADEMARK.md) |

[Responsible use](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/explications/usage-responsable.md) (in French).

## Contribute

Read [CONTRIBUTING.md](https://github.com/scrap-yo-mama/sym/blob/main/runtime/CONTRIBUTING.md). Report a vulnerability privately through [SECURITY.md](https://github.com/scrap-yo-mama/sym/blob/main/runtime/SECURITY.md), never in a public issue. Questions and ideas: [Discussions](https://github.com/scrap-yo-mama/sym/discussions).
