# Scrapyomama extension: privacy policy

Draft, to be reviewed by a lawyer before publication. Applies to the Scrapyomama browser extension (Chrome and
compatible browsers). Last updated: 2026-10-01.

The extension is a client for a Scrapyomama instance that you, or your organisation, install and operate. The author of
the extension does not run a Scrapyomama service for you and receives none of your data.

## What the extension stores on your device

In the extension storage (`chrome.storage.local`), on your device only:

- the address of the instance you paired, the e-mail address of your account on that instance and the pairing token
  (bound to your account and to this device, valid 90 days);
- the device name you typed, if any, and a random identifier of this installation;
- for each site you connected: the domain, the usage you chose (tunnel or server), the recipient shown in the consent
  dialog and the time of your consent.

## Cookies

The extension reads the cookies of a site in one case only: you connected that site, you chose the Server usage in the
consent dialog, and you clicked the confirmation button. It then sends the cookies of that single site to the instance
you paired, which stores them encrypted. In every other case the extension does not read cookies.

You can switch a site back to tunnel usage or disconnect it at any time. Disconnecting deletes the site and its cookies
on the instance and on the device.

## Tunnel mode

In tunnel usage (the default), the instance sends commands that your browser runs on the connected site: it fetches a
page, reads the structure of a page, clicks, types or scrolls, in a background tab, with your own session and from your
own network connection. Your cookies are never sent to the instance in this usage: the browser attaches them itself.
What the commands return (the content that the site shows you) is sent to your instance.

The extension runs a closed list of commands. It does not execute code sent by a server. It refuses commands to any
domain you did not connect, to private network addresses and to localhost. If a site shows a verification page, it
stops and hands control back to you.

## Self-hosted instances

Your instance is operated by you or by your organisation (the operator of the instance). The operator decides where the
data goes, how long it is kept and who can access it, under the policy of that instance. Ask the operator of your
instance for its policy: the operator, not the extension author, is the controller of the data the instance holds.
Administrators of the instance can revoke your token. They cannot read or use it.

The extension connects to the address of the instance over an encrypted connection (https and wss). Plain http is
accepted only for an instance on your own machine, for development.

## No sale, no advertising, no analytics

The extension contains no analytics, no telemetry, no advertising and no third-party script. It never sells or shares
data with third parties, never uses data for purposes unrelated to its single purpose (connecting the sites you choose
to your own instance), and never uses data to determine creditworthiness or for lending.

## Revocation and deletion

- Disconnect a site in the extension popup: removes the consent, the site and its cookies.
- Unpair in the popup, or revoke the device in the instance console: the token stops working at once. Unpairing deletes
  the pairing and the consents stored by the extension and withdraws the site permissions it had requested.
- Remove the extension: Chrome deletes its storage on the device. Ask the operator of your instance to delete the data
  that the instance holds about you.

## Contact

[Contact address of the publisher: to be filled in before the Chrome Web Store submission.] For a security issue, use
the private reporting channel described in `SECURITY.md`; do not post it in a public issue.
