<div align="center">

<img src="docs/assets/banner.svg" alt="SYM Browser (SYM 👻) : des navigateurs à distance, une adresse wss:// par session" width="860">

# SYM Browser (SYM 👻)

**Demande un navigateur. Reçois une adresse `wss://`. Pilote-le avec le client que tu utilises déjà.**

<img src="docs/assets/badges/license.svg" alt="licence : AGPL-3.0"> <img src="docs/assets/badges/sdk.svg" alt="sdk : MIT"> <img src="docs/assets/badges/status.svg" alt="statut : pré-version"> <img src="docs/assets/badges/protocol.svg" alt="protocole : CDP"> <img src="docs/assets/badges/deploy.svg" alt="déploiement : auto-hébergé">

[English](README.md) · Français

</div>

SYM Browser est un service qui lance des navigateurs Chromium à la demande et te laisse les piloter à distance. Tu crées une session par un appel REST et tu reçois une adresse `wss://` qui parle le protocole commun, CDP. Playwright, Puppeteer, Stagehand, browser-use et les autres clients CDP s'y connectent comme à un navigateur local. À la fin de la session, tout ce qu'elle a touché est détruit : processus, profil, fichiers, tunnels réseau.

C'est open source et auto-hébergé. Tu l'installes seul ou avec [SYM](https://github.com/scrap-yo-mama/sym), qui s'en sert comme l'un de ses fournisseurs de navigateurs. Tes serveurs, tes clés, ton trafic.

> SYM 👻 : tu demandes un navigateur, je te donne une adresse. Quand tu as fini, je range derrière toi.

> [!WARNING]
> **Statut : pré-version, en chantier. Pas prêt pour la production.**
> Il n'y a pas encore de version stable. L'API REST, le pool de nœuds et le relais WebSocket sont en construction et testés en CI ; le client du SDK TypeScript montré plus bas est l'interface prévue et n'est pas encore publié. Les interfaces et le schéma de base vont changer. Ne bâtis rien de critique dessus aujourd'hui.

## Ce que ça donne

```text
toi> Il me faut un navigateur pour mon scraper. Dix minutes, example.com seulement.
SYM 👻 : Voilà : wss://browser.example.com/v1/sessions/6f1c…/cdp?token=…
toi> C'est bon.
SYM 👻 : Libéré. 7 min 12 s de navigateur, 3,4 Mo sortis, rien ne traîne.
```

## Ce qu'il fait

Ce pour quoi SYM Browser est conçu. L'avertissement ci-dessus dit ce qui est prêt aujourd'hui.

- **Une adresse par session.** Chaque session a sa propre URL `wss://` avec un jeton de courte durée. Par défaut une session est `dedicated` (un Chromium entier), pilotée en CDP ; une session `shared` (un contexte dans un Chromium chaud) se pilote en Playwright natif.
- **Marche avec ton client.** Playwright `connectOverCDP`, Puppeteer `connect`, Stagehand `cdpUrl`, browser-use `cdp_url` : ni greffon, ni fork.
- **Un réseau gouverné par session.** Chaque session sort par son propre egress : hôtes autorisés, proxy amont (HTTP, HTTPS, SOCKS5), DNS résolu une fois et vérifié, budget d'octets, chaque connexion comptée.
- **Rien ne traîne.** Libération, délai, plantage ou arrêt du nœud : le navigateur, son profil, ses fichiers et ses tunnels sont détruits dans un ordre fixe.
- **Les secrets restent secrets.** Les clés d'API sont hachées, les mots de passe de proxy et les profils persistants sont chiffrés au repos, et les journaux sont masqués.
- **Compté à la seconde.** Chaque seconde de navigateur et chaque octet d'egress sont mesurés par le nœud et réconciliés.

## Coup d'œil

Avec le SDK (interface prévue de `@sym-browser/sdk`) :

```ts
import { SymBrowser } from '@sym-browser/sdk';

// url et apiKey valent SYMB_URL et SYMB_API_KEY par défaut
const symb = new SymBrowser({ url: 'https://browser.example.com', apiKey: process.env.SYMB_API_KEY });

// libérée à la fin du bloc (await using), ou à la sortie du process
await using session = await symb.sessions.create({
  timeoutSeconds: 120,
  egress: { allowedHosts: ['example.com'], budgetBytes: 50_000_000 },
  metadata: { job: 'demo' },
});

// dedicated par défaut : un Chromium entier, piloté en CDP
const browser = await symb.connectCDP(session);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
console.log(await page.title());

for await (const event of symb.events(session.id)) {
  if (event.type === 'egress.blocked') console.warn('blocked:', event.data.host);
  if (event.type === 'state' && event.data.state !== 'running') break;
}
```

Avec n'importe quel client CDP, sans SDK :

```ts
import { chromium } from 'playwright-core';
import puppeteer from 'puppeteer-core';

// un appel REST, puis l'adresse wss:// de la session
const session = await fetch('https://browser.example.com/v1/sessions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.SYMB_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ timeoutSeconds: 600 }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.connectUrls.cdp); // Playwright
const pptr = await puppeteer.connect({ browserWSEndpoint: session.connectUrls.cdp }); // Puppeteer
// Stagehand : localBrowserLaunchOptions: { cdpUrl: session.connectUrls.cdp }
```

## Clients compatibles

| Client | Comment il se connecte |
|---|---|
| [Playwright](https://playwright.dev/) | `chromium.connectOverCDP(url)`, ou `chromium.connect(url)` natif pour les sessions `shared` |
| [Puppeteer](https://pptr.dev/) | `puppeteer.connect({ browserWSEndpoint: url })` |
| [Stagehand](https://github.com/browserbase/stagehand) | `localBrowserLaunchOptions.cdpUrl` |
| [browser-use](https://github.com/browser-use/browser-use) | `Browser(cdp_url=url)` |
| Tout client [CDP](https://chromedevtools.github.io/devtools-protocol/) | l'adresse `wss://`, jeton dans la query ou en `Authorization: Bearer` |

## Seul ou avec SYM

SYM Browser est un produit à part entière. Il se déploie, tourne, compte son usage et s'administre sans SYM : sa propre image, sa propre base PostgreSQL, sa propre console, ses clients et ses clés d'API. Ses seules dépendances sont sa base, sa clé maîtresse et son stockage d'objets (disque local ou S3).

[SYM](https://github.com/scrap-yo-mama/sym) est un client comme un autre : il détient une clé d'API et appelle la même API `/v1`. Le même contrat sert sur le même hôte que SYM ou sur un autre serveur ; seule la configuration change.

## Auto-hébergé

- **Une image, trois rôles.** `all` (passerelle et nœud dans un seul processus), ou `gateway` et `node` sur des machines séparées. Vois le [Dockerfile](Dockerfile) et le [profil seccomp](deploy/seccomp-chromium.json).
- **Durci par défaut.** Chromium tourne sous un utilisateur non root avec son bac à sable actif, `tini` en PID 1, un profil seccomp et une liste fermée d'arguments de lancement.
- **Versions épinglées.** Playwright 1.63.0 et Chromium 153, vérifiées à la connexion.

## Ce que contient ce dossier

| Dossier | Paquet | Licence | Rôle |
|---|---|---|---|
| [`apps/gateway`](apps/gateway) | `@sym-browser/gateway` | AGPL-3.0 | REST `/v1`, relais WebSocket, quotas, routage |
| [`apps/node`](apps/node) | `@sym-browser/node` | AGPL-3.0 | Pool de Chromium, sessions, egress par session |
| [`apps/console`](apps/console) | `@sym-browser/console` | AGPL-3.0 | Console web (français et anglais) |
| [`packages/sdk`](packages/sdk) | `@sym-browser/sdk` | MIT | SDK TypeScript |
| [`packages/core`](packages/core) | `@sym-browser/core` | AGPL-3.0 | Chiffrement, configuration, journaux |
| [`packages/db`](packages/db) | `@sym-browser/db` | AGPL-3.0 | Schéma PostgreSQL et migrations |

## Licence

- **Service (passerelle, nœud, console, core, db) : [AGPL-3.0](LICENSE)** ([texte](https://www.gnu.org/licenses/agpl-3.0)).
- **SDK TypeScript (`packages/sdk`) : [MIT](packages/sdk/LICENSE)** ([texte](https://opensource.org/license/mit)). Le contrat d'API `@sym/contracts` est aussi sous MIT.

Les licences donnent des droits sur le code, pas sur le nom ni le logo.

## Écrit avec l’aide de l’IA

Une grande partie de ce code et de cette documentation a été écrite avec l'aide de l'IA, puis relue, testée et passée en CI par un humain. Si tu repères quelque chose de bizarre, dis-le.
