<div align="center">

# Scrapyomama (SYM 👻)

**Describe the data. SYM 👻 handles the rest.**

English · [Français](https://github.com/scrap-yo-mama/sym/blob/main/.github/README.fr.md)

</div>

SYM is a self-hosted data runtime, still being built. The goal for the first release: you'll ask your AI, over MCP, for the data you want. SYM will investigate the site the cheapest way first (plain fetch, then a real browser, then an agent only if it has to), show you the schema it found, and wait for your OK. Then it will compile a replayable API that runs without an LLM when the strategy allows it, and repair that API when the site changes.

You host it and bring your own model. Your instance, your keys, your data.

> SYM 👻: you'll say what you need, I'll do the digging. You approve before anything gets built.

> [!WARNING]
> **Status: pre-release, work in progress. Not ready for production.**
> There is no stable release yet, interfaces and database schema will change, and nothing here has been battle-tested. The core path (ask over MCP, investigate, approve, replay, repair) is not wired up yet: see what works today below. Look around, run it locally, tell us what breaks. Please do not build anything critical on it today.

## What works today

These building blocks are on `main` and covered by CI. The path that ties them together is not there yet.

- **Executors E1 to E6.** HTTP fetch with declarative extraction, fetch inside a real browser page, sandboxed Playwright scripts, LLM-shaped extraction, script-plus-agent steps and a full agent. A successful agent run (E6) compiles into a replayable script-plus-agent strategy (E5).
- **Guard rails.** A sandbox for strategy code, an SSRF guard on outgoing requests, per-domain pacing, and an access module that reads robots.txt and reports what a site allows.
- **Accounts.** Users, invitations, two-factor authentication, API keys, OIDC single sign-on and an audit log.
- **Console, extension and tunnel.** The web console (English and French), and a Chrome extension that pairs your browser and runs steps through your own session, with consent per domain.
- **Operations.** The `runtime` command line (migrations, `doctor`, diagnostics, backup and restore, catalog export) and deployment templates for Docker Compose, Render, Railway and Heroku.

**Not delivered yet.** The investigation (cheapest-first search, schema approval), pagination, repair, step-by-step resume, the REST API for APIs and runs, and the MCP server. Until they land, you cannot ask your AI for data through SYM.

## How it will work

1. **Ask.** Tell your AI what data you want from which site.
2. **Investigate.** SYM will look for the cheapest route to that data and report what it found.
3. **Approve.** You'll review the proposed schema and say yes, or ask for changes.
4. **Replay.** SYM will compile an API you can call on a schedule or on demand, with no LLM when the strategy allows it.
5. **Repair.** If the site drifts, SYM will notice and repair the API.

## Planned for the first release

- **Cheapest-first investigation.** Fetch, then browser, then agent. The expensive step will only run when the cheaper ones can't do the job.
- **Schema approval.** SYM will show you the schema and wait for your OK. No surprise API will appear behind your back.
- **Replayable APIs.** Once approved, runs will be deterministic and need no LLM when the strategy allows it: fast, cheap and repeatable.
- **Bounded repair.** When a replay breaks, SYM will propose a bounded fix, check it against the approved schema and escalate only if it has to, instead of silently returning garbage.
- **MCP and REST.** You'll plug it into your AI, or call it like any other API.
- **Stays yours.** Self-hosted, bring your own model, no telemetry sent to the maintainers. This part is true today.

## What is in the repository

Everything lives under [`runtime/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime):

- `apps/server` and `apps/worker`: the HTTP server (accounts, extension, tunnel, health) and the worker that runs strategies. The REST API for APIs and the MCP endpoint will live in the server.
- `apps/web`, `apps/extension`, `apps/cli`: the console, the Chrome extension and the command line.
- `packages/client` and `packages/schemas`: the MIT-licensed client and shared schemas.

## Quickstart

The docs live in [`runtime/docs/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime/docs) and deployment files in [`runtime/deploy/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime/deploy). Good starting points:

- [Deployment guide](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/deploiement.md)
- [Operations](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/exploitation.md)
- [Environment variables](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/variables-env.md)
- [Deployment files](https://github.com/scrap-yo-mama/sym/blob/main/runtime/deploy/README.md)

The documentation is currently in French.

### Deploy to Render

A one-click Blueprint ([`render.yaml`](https://github.com/scrap-yo-mama/sym/blob/main/render.yaml)) sets up Postgres, a web service and a 2 GB worker (the browser needs the room). The monthly cost depends on the Render plans it reserves; see the [deployment guide](https://github.com/scrap-yo-mama/sym/blob/main/runtime/docs/deploiement.md#render).

**Coming with the first release.** The Blueprint exists, but nobody has deployed it for real yet, so the button is not promised to work today.

## License

- **Core (server, worker, console, extension, CLI): [AGPL-3.0](https://github.com/scrap-yo-mama/sym/blob/main/LICENSE).**
- **Client and schemas packages (`runtime/packages/client`, `runtime/packages/schemas`): MIT.**

Licenses grant rights on the code, not on the name or logo; see the [trademark policy](https://github.com/scrap-yo-mama/sym/blob/main/runtime/TRADEMARK.md). The legal texts (trademark, contributor agreement, notice) are drafts still waiting for a lawyer's review.

Responsible use: see the [responsible-use page](https://github.com/scrap-yo-mama/sym/blob/main/runtime/apps/docs/content/explications/usage-responsable.md) (in French).

## Community

- [Security](https://github.com/scrap-yo-mama/sym/blob/main/runtime/SECURITY.md): report vulnerabilities privately through [GitHub's private reporting](https://github.com/scrap-yo-mama/sym/security/advisories/new), never in a public issue.
- [Contributing](https://github.com/scrap-yo-mama/sym/blob/main/runtime/CONTRIBUTING.md): contributions open with the first release.
- [Code of Conduct](https://github.com/scrap-yo-mama/sym/blob/main/runtime/CODE_OF_CONDUCT.md)

## Built with AI assistance

Much of this code and documentation was written with AI assistance, then reviewed, tested and run through CI by a human. If you spot something off, say so.
