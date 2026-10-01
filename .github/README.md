<div align="center">

# Scrapyomama (SYM 👻)

**Describe the data. SYM 👻 handles the rest.**

English · [Français](https://github.com/scrap-yo-mama/sym/blob/main/.github/README.fr.md)

</div>

You ask your AI, over MCP, for the data you want. SYM investigates the site the cheapest way first (plain fetch, then a real browser, then an agent only if it has to), shows you the schema it found, and waits for your OK. Then it compiles a replayable API that runs without any LLM and repairs itself when the site changes.

It is self-hosted and you bring your own model. Your instance, your keys, your data.

> SYM 👻: you say what you need, I do the digging. You approve before anything gets built.

> [!WARNING]
> **Status: pre-release, work in progress. Not ready for production.**
> There is no stable release yet, interfaces and database schema will change, and nothing here has been battle-tested. Look around, run it locally, tell us what breaks. Please do not build anything critical on it today.

## How it works

1. **Ask.** Tell your AI what data you want from which site.
2. **Investigate.** SYM looks for the cheapest route to that data and reports what it found.
3. **Approve.** You review the proposed schema and say yes, or ask for changes.
4. **Replay.** SYM compiles an API you can call on a schedule or on demand, no LLM involved.
5. **Repair.** If the site drifts, SYM notices and repairs the API.

## What SYM does

- **Investigates cheapest-first.** Fetch, then browser, then agent. The expensive step only runs when the cheaper ones can't do the job.
- **Shows you the schema and waits for your OK.** No surprise API appears behind your back.
- **Compiles a replayable API.** Once approved, runs are deterministic and need no LLM, so they are fast, cheap and repeatable.
- **Repairs itself.** When a site changes, SYM notices and repairs the API instead of silently returning garbage.
- **Speaks MCP and REST.** Plug it into your AI, or call it like any other API.
- **Stays yours.** Self-hosted, bring your own model, no telemetry sent to the maintainers.

## What SYM can handle

- **JS-heavy pages.** A real browser opens the page when a plain fetch is not enough.
- **Sites behind an account.** The Chrome extension connects a site through your own browser session, so SYM works with the account you already have.
- **Self-repair, step by step.** When a replay breaks, SYM proposes a bounded fix, checks it against the original schema, and escalates only if it has to.
- **Tricky sites.** An agent drives the browser end to end, then its successful trace is compiled into an API that runs without an LLM whenever possible.

## What is in the repository

Everything lives under [`runtime/`](https://github.com/scrap-yo-mama/sym/tree/main/runtime):

- `apps/server` and `apps/worker`: the REST and MCP service, and the worker that investigates and runs.
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

A one-click Blueprint ([`render.yaml`](https://github.com/scrap-yo-mama/sym/blob/main/render.yaml)) sets up Postgres, a web service and a 2 GB worker (the browser needs the room). Expect roughly **38 USD per month**.

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
