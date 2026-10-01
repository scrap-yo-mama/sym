# Chrome Web Store listing: Scrapyomama

Text to paste into the Chrome Web Store developer dashboard (task 2.9, unlisted visibility). Each `##` heading below
matches a field of the dashboard. The submission itself is a human step: nothing in this repository sends it.

Package to upload: `pnpm package:extension` in `runtime/` builds and audits `apps/extension/dist/scrapyomama-<version>-chrome.zip`
and prints its SHA-256. Images: `store/assets/promo-small-440x280.png` (small promotional tile) and `public/icons/128.png`
(store icon). Regenerate with `node scripts/extension-icons.ts`.

## Name

Scrapyomama

## Summary (132 characters max)

Connects the sites you choose to your own Scrapyomama instance.

## Category

Developer Tools

## Language

English

## Visibility

Unlisted. The extension is installed from a direct link given by the operator of a Scrapyomama instance. It is not
searchable in the Chrome Web Store.

## Single purpose

Connect the websites you choose to your own Scrapyomama instance: relay requests through your own browser, or share a
site session with your instance, on your explicit consent, one site at a time.

## Detailed description

Scrapyomama turns web sites into APIs on an instance that you or your organisation run. This extension is the bridge
between your browser and your own Scrapyomama instance. It does nothing until you pair it, and it acts only on the
sites you choose to connect.

What it does

- Pairs with your own Scrapyomama instance using a one-time code generated in the instance console. The code works once
  and expires after 10 minutes. The extension then holds a token bound to you and to this device, valid for 90 days,
  that you or an administrator can revoke at any time.
- Shows who you are connected as, the list of connected sites, and a Disconnect button for each site.
- For each site, asks for your consent before anything is read, and shows the domain, the usage you picked and the
  recipient of the data. Two usages exist:
  - Tunnel (default): your instance sends commands, and your browser runs them on the site from your own network
    connection, with your own session. Cookies stay in your browser and are never sent to the instance.
  - Server: you explicitly allow the extension to send the site cookies to your instance, which stores them encrypted.
    Off unless you switch it on for that site.
- Runs commands from a closed list only (fetch a page, read the page structure, click, type, scroll). The extension
  never executes code sent by a server. Commands to other domains, to private network addresses or to localhost are
  refused, even for a connected site.
- Never writes on a site on its own: a click on a send, buy or delete button is blocked unless the API owner confirmed
  that the API may perform write actions.
- When a site shows a verification page, the extension stops sending commands on that tab and hands control back to
  you, who then browse the site normally.

Who it is for

People who run Scrapyomama (an open source, self-hosted runtime) and need their own browser session or their own
network connection to reach a site they are allowed to use. Without a Scrapyomama instance, the extension has no use.

Your data

No analytics, no advertising, no sale of data. The extension talks only to the instance you paired and to the sites you
connected. The full policy covers self-hosted instances: see the privacy policy URL.

## Permission justifications

The Chrome Web Store asks for one justification per permission. Paste each line into its field.

- `cookies`: Server usage only. After the explicit per-site consent where the user chooses to share a session with their own instance, the extension reads the cookies of that one connected site and sends them to the paired instance. Never read before consent, never read in tunnel usage.
- `scripting`: Runs functions that are packaged inside the extension (no code from a server) in a background tab of a connected site, so that a page request is made with the origin, headers and tokens of the site itself.
- `debugger`: Drives a background tab of a connected site one command at a time (navigate, read the accessibility tree, click, type, scroll) from a fixed allow-list of protocol methods. Attached only while a run executes and detached right after.
- `storage`: Keeps the pairing token, the instance address, the device name and the consent given for each site on the device, in the extension storage only.
- `alarms`: A 30 second alarm reconnects the connection to the paired instance after Chrome stops the extension service worker, so that a run in progress is resumed instead of being lost.
- `tabs`: Reads the address of the current tab to propose Connect this site, and opens, wakes and closes the background tabs used for a run. Addresses are not sent anywhere unless the site is connected.
- `tabGroups`: Puts every automation tab in a group named Scrapyomama so that the user always sees which tabs the extension controls, and can close them.
- `optional_host_permissions`: Requested at runtime, per site, when the user clicks Connect this site and accepts the consent dialog (the instance address is requested when pairing). The extension declares no host permission statically and no all-sites permission.

There is no content script, no host permission at install time and no externally connectable page.

## Remote code

No. The extension does not load or execute remote code. All scripts are packaged in the extension. Commands received from
the instance come from a closed list and are never evaluated as code.

## Data usage disclosures

Dashboard tab Privacy practices. Select exactly these data types, with this usage.

- Authentication information: the pairing token (stored on the device and sent to the paired instance) and, only in server usage for a site the user connected, that site cookies.
- Website content: the page content or response a command asks for, relayed in tunnel usage to the paired instance on a site the user connected.
- Personally identifiable information: the e-mail address of the account on the instance, displayed after pairing. It is received from the instance and not collected elsewhere.
- Web history: the domain of the current tab is read locally to propose Connect this site, and the domains of connected sites are stored on the device. No browsing history is sent.

Certifications to tick:

- Data is not sold to third parties, outside of the approved use cases.
- Data is not used or transferred for purposes that are unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

The recipient of the data is the Scrapyomama instance the user paired, which the user or their organisation operates.
The extension developer receives no data.

## Privacy policy URL

Must be a stable public URL that covers self-hosted instances. Source text: `store/privacy-policy.md` in this
repository (`runtime/apps/extension/store/privacy-policy.md`). Publish it at a permanent address (the public repository
blob URL once the repository is public, or the project site) and paste that address here. Do not submit with a
temporary address.

## Test instructions for the reviewer

The extension needs a Scrapyomama instance to be paired with. Provide the reviewer with a running instance address and
a one-time pairing code, or a demo account, in the Store field Test instructions. Without them the popup stays on the
pairing form. Provide fixture or demo sites only; never ask the reviewer to use a real third-party account.

## Before submitting (human)

1. The extension in the zip must be the one that does what the justifications say. Submit the zip built after task 2.7
   (tunnel gateway) is merged: today the permissions `scripting`, `debugger`, `alarms`, `tabs` and `tabGroups` are
   declared for the tunnel but not yet used by the code, and the reviewers reject permissions without a use.
2. Publish the privacy policy and fill in its contact line.
3. Create or open the developer account (one-time registration fee, two-step verification), then upload the zip, the
   images, the text above and the test instructions, with visibility set to Unlisted. Expect a review of about 4 weeks
   (to be validated).
4. Record the submission acknowledgement in `cdc/scrapyomama-runtime/.executed/journal.md` (the deliverable of task
   2.9), with the zip SHA-256 printed by `pnpm package:extension`. Until the review passes, install in developer mode
   with the same zip.
