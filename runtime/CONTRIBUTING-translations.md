# Contributing translations

Scrapyomama ships in English and French on every surface (console, extension, MCP replies, e-mails, docs). A third language is added **by data files only**: no TypeScript, Vue or SQL changes. CI proves it (`assert_third_locale_no_code_change`).

Everything lives in `packages/i18n/`.

## How the catalogs work

- `locales/en.json` is the **only source**. The team edits it; translations follow it.
- One sentence = one key. Named variables (`{name}`), no concatenation, no HTML inside a message.
- Keys are grouped by namespace: the historical console keys (no prefix), `ext.*` (extension), `srv.*` (server messages, REST errors), `narrative.*` (investigation story), `email.*`, `mcp.user.*` (what a person sees in their AI client).
- `mcp.model.*` is read by the model, not by a person. It exists **in English only** and is never translated.
- `narrative.light.*` (light touches) may be missing in a language: it is then omitted, never replaced by English.
- Plurals use vue-i18n syntax (`one | other`, or `none | one | other`). The rule that picks the form comes from `Intl.PluralRules`, so any language works.
- Use the `{sym}` marker for the SYM signature. No catalog contains the ghost character.

## Add a language

1. Copy `locales/fr.json` to `locales/<code>.json` and translate it. Use the ISO 639 code without region (`de`, not `de-DE`; `fr-CA` falls back to `fr`). For tests, `qaa` to `qtz` are reserved for local use.
2. Add one entry to `locales/registry.json`:
   ```json
   { "code": "de", "endonym": "Deutsch", "english_name": "German", "dir": "ltr", "maintainers": ["your-github-handle"], "gate": "draft", "completeness": 0.0 }
   ```
   `english_name` is what the LLM language block uses. It comes from this file, never from user input.
3. Add `locales/forbidden.<code>.txt` (words that must never appear: promises to circumvent protections). Start from the English one.
4. Add the documentation theme labels and pages for the language (`apps/docs`, see the docs contributing notes) and a style sheet / glossary lines (voice guide).
5. Run:
   ```sh
   pnpm --filter @runtime/i18n build
   pnpm --filter @runtime/i18n i18n:parity     # same keys and variables in every shipped language
   pnpm --filter @runtime/i18n i18n:pseudo     # pseudo-locale still keeps variables and plurals
   pnpm lint                                   # message syntax, no HTML, plural forms
   ```

## Gates

| `gate` | Meaning |
|---|---|
| `draft` | Not in language pickers. Machine pre-translations stay here until a human reviews them. |
| `shipped` | Appears in pickers, checked by parity in CI. Needs more than 90 % completeness, a named maintainer and a forbidden-words list. |
| `unmaintained` | No maintainer for 6 months. Kept working, flagged in the UI. |

Machine translations are suggestions marked "to review". They never ship unreviewed, and legal pages are never machine-translated.

## What is never translated

Data collected from sites, API names and descriptions typed by users, JSON keys, enum values, error codes, tool and prompt names, URLs, selectors. The language of the interface **never** reaches a target site: the engine sends the real `Accept-Language` of its own Chromium, and nothing sets a locale or a time zone on it.

## Tools

| Command (in `packages/i18n`) | What it does |
|---|---|
| `pnpm i18n:parity` | Parity of keys, variables, plurals and links across every shipped language, forbidden-words lists, `ext.manifest.*` |
| `pnpm i18n:pseudo` | Generates `qps-ploc` in memory (accents, `⟦ ⟧` brackets, expansion) and checks it |
| `pnpm i18n:types` | Writes `keys.d.ts` from `en.json`; an unknown key fails `tsc` (`--check` in CI) |
| `pnpm i18n:ext-locales [dir]` | Writes the extension's `_locales/<code>/messages.json` from `ext.manifest.*` |
| `pnpm i18n:doc-codes [lang]` | Prints the reason-codes table for the docs from the catalog |
