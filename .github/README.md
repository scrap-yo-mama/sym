<a href="README.md">English</a> · <a href="README.fr.md">Français</a>

<p><picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/brand/banner-light.png">
  <img alt="SYM 👻 &quot;I won't do that.&quot; Too late, it's done. scrapyomama · open source · self-hosted" src="assets/brand/banner-light.png" width="100%"></picture></p>

<p><a href="https://github.com/scrap-yo-mama/sym/blob/main/LICENSE"><img alt="license: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-3A33F0?labelColor=24252D"></a> <img alt="status: pre-release" src="https://img.shields.io/badge/status-pre--release-FFC727?labelColor=24252D"> <img alt="protocol: MCP" src="https://img.shields.io/badge/protocol-MCP-D8BDF7?labelColor=24252D"> <img alt="deploy: self-hosted" src="https://img.shields.io/badge/deploy-self--hosted-A8E3EA?labelColor=24252D"> <img alt="releases: signed" src="https://img.shields.io/badge/releases-signed-FF5A1F?labelColor=24252D"></p>

You ask your AI for data. **SYM 👻** investigates the site cheapest-first (plain request, then browser, then agent), shows you the schema and waits for your OK. Then it compiles an API that replays **without an LLM** and repairs itself when the site changes. Your server, your database, your model.

> [!WARNING]
> **Pre-release.** SYM is under active development and not production-ready yet. Watch the repo for the first release.
>
> **Not delivered yet:** step-by-step repair. Until it lands, a repair patches the strategy, not a single step.

## How it feels

```text
you> Get the books on books.toscrape.com with title and price.
SYM 👻: On it.
1/4 describe · 2/4 recon (robots.txt ok) · 3/4 schema · 4/4 try: direct fetch, ok
SYM 👻: Done. 20 books, no model cost per replay.
```

<table>
<tr>
<td valign="top" width="50%">

## What SYM does

- Turns a request into a schema you validate first
- Picks the cheapest method that works
- Replays without an LLM, repairs step by step
- Uses your own browser session when you allow it
- Speaks MCP, REST, and has a console

</td>
<td valign="top" width="50%">

## What SYM can handle

- JavaScript-heavy pages, with a real browser
- Account sites, through your own session (Chrome extension)
- Tricky sites: an agent figures it out, then it compiles
- Sites that change: it repairs the step that broke
- Pagination, schedules, webhooks

</td>
</tr>
</table>

## Quickstart

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

<img alt="Deploy to Render" src="assets/brand/button-deploy-render.svg" height="32" align="middle"> <sub>coming with the first release · Render account required</sub>

## Verify what you run

```bash
cosign verify ghcr.io/scrap-yo-mama/sym:X.Y.Z \
  --certificate-identity=https://github.com/scrap-yo-mama/sym/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/scrap-yo-mama/sym:X.Y.Z -R scrap-yo-mama/sym
sha256sum -c SHA256SUMS
```

Replace `X.Y.Z` with a released version: nothing is published before the first release.

Core [AGPL-3.0](https://github.com/scrap-yo-mama/sym/blob/main/LICENSE), client and schemas MIT. [Responsible use](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/explications/usage-responsable.md): see the [docs](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/index.md). Security: [private vulnerability reporting](https://github.com/scrap-yo-mama/sym/blob/main/runtime/SECURITY.md) is on. Built with AI assistance, reviewed by humans. [Lire en français](README.fr.md).
