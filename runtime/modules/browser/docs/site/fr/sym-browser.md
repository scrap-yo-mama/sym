---
title: SYM Browser
description: Des navigateurs Chromium à distance, à la demande, une adresse wss:// par session, pour Playwright, Puppeteer, Stagehand et tout client CDP. Open source et auto-hébergé.
---

<!-- Page du site SYM (tâche 5.5). Le contenu fait foi dans le README du module. -->

# SYM Browser

[English](../en/sym-browser.md) · Français

**Demande un navigateur. Reçois une adresse `wss://`. Pilote-le avec le client que tu utilises déjà.**

SYM Browser est le service de navigateurs de la famille SYM. Il lance Chromium à la demande, isole chaque session derrière son propre egress réseau et détruit tout à la fin de la session. Il parle CDP, le protocole que tes outils connaissent déjà : rien de nouveau à apprendre côté client.

> SYM 👻 : tu demandes un navigateur, je te donne une adresse. Quand tu as fini, je range derrière toi.

**Pré-version.** SYM Browser est en plein développement et pas encore prêt pour la production.

## Comment ça marche

1. **Crée une session.** Un appel REST à `/v1/sessions`, avec une clé d'API. Options : durée, politique réseau, proxy amont, profil, enregistrements.
2. **Connecte-toi.** La réponse contient une adresse `wss://` avec un jeton de courte durée. Branche-y Playwright, Puppeteer, Stagehand ou browser-use.
3. **Libère.** Libère-la, laisse-la expirer, ou laisse le SDK la libérer à la sortie de ton process. Le navigateur, ses fichiers et ses tunnels sont détruits ; l'usage est compté à la seconde.

## Essaie

```ts
import { chromium } from 'playwright-core';

// un appel REST, puis l'adresse wss:// de la session
const session = await fetch('https://browser.example.com/v1/sessions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.SYMB_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ timeoutSeconds: 600 }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.connectUrls.cdp);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
```

## Pourquoi SYM Browser

- **Ton client, tel quel.** CDP pour [Playwright](https://playwright.dev/), [Puppeteer](https://pptr.dev/), [Stagehand](https://github.com/browserbase/stagehand), [browser-use](https://github.com/browser-use/browser-use) ; Playwright natif pour les sessions `shared` légères.
- **Un réseau gouverné par session.** Hôtes autorisés, proxys amont (HTTP, HTTPS, SOCKS5), budgets d'octets, adresses privées refusées.
- **Rien ne traîne.** Processus, profil, fichiers et tunnels détruits à la fin de chaque session.
- **À toi.** Open source (AGPL-3.0, SDK MIT), auto-hébergé, sans télémétrie.

## Seul ou avec SYM

Installe SYM Browser seul, pour tes scrapers, tes tests et tes agents, ou à côté de [SYM](https://github.com/scrap-yo-mama/sym), qui s'en sert comme fournisseur de navigateurs. La même API dans les deux cas.

## Pour aller plus loin

- [README](../../../README.fr.md) : ce qu'il fait, exemples avec le SDK et avec tout client CDP, licence.
- [Code source](https://github.com/scrap-yo-mama/sym) : SYM Browser vit dans `runtime/modules/browser/` jusqu'à l'ouverture de son miroir public.
