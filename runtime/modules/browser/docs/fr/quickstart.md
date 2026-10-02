# Démarrage rapide

SYM 👻 : Dix minutes, trois commandes et un script. À la fin, tu auras ouvert une page dans ton propre Chromium distant, puis tu me l'auras rendu.

Il te faut Docker, OpenSSL et Node.js 24 (ou 22). La session ci-dessous est de type `dedicated` (le défaut) : un Chromium à elle seule, piloté en CDP.

<!-- L'étape 1 est la seule que la CI ne rejoue pas : l'image publique et l'assemblage `SYMB_MODE=all` arrivent avec la tâche 5.1. Les étapes 3 à 5 sont extraites de cette page (code identique à la version anglaise) et exécutées telles quelles par tests/docs-quickstart.chromium.test.ts. -->

## 1. Démarre SYM Browser

SYM Browser a besoin de PostgreSQL, d'une clé maîtresse et d'une première clé d'API. La clé maîtresse chiffre tous les secrets au repos : **sauvegarde-la** hors de la machine, sans elle rien de chiffré ne se relit.

```bash
export MASTER_KEY="$(openssl rand -base64 32)"   # sauvegarde-la dans ton gestionnaire de mots de passe
export SYMB_API_KEY="symb_$(openssl rand -hex 24)"
curl -fsSLO https://raw.githubusercontent.com/scrap-yo-mama/sym-browser/main/deploy/seccomp-chromium.json

docker network create symb
docker run -d --name symb-db --network symb \
  -e POSTGRES_PASSWORD=symb -e POSTGRES_DB=sym_browser \
  postgres:16
docker run -d --name sym-browser --network symb -p 127.0.0.1:3000:3000 \
  --security-opt seccomp=seccomp-chromium.json --security-opt no-new-privileges --cap-drop ALL \
  -e SYMB_MODE=all \
  -e DATABASE_URL=postgres://postgres:symb@symb-db:5432/sym_browser \
  -e MASTER_KEY -e SYMB_BOOTSTRAP_API_KEY="$SYMB_API_KEY" \
  ghcr.io/scrap-yo-mama/sym-browser:1

export SYMB_URL=http://localhost:3000
curl -fsS "$SYMB_URL/readyz"
```

`/readyz` répond `200` quand l'instance est prête. `SYMB_BOOTSTRAP_API_KEY` crée la première clé d'API (scopes `sessions:write` et `sessions:read`) si la table des clés est vide.

## 2. Installe le client Playwright

```bash
mkdir symb-quickstart && cd symb-quickstart
npm init -y && npm pkg set type=module
npm install playwright-core@1.63.0
```

Seule la bibliothèque cliente est nécessaire : le navigateur tourne dans SYM Browser.

## 3. Crée une session

Copie les trois blocs ci-dessous, dans l'ordre, dans `quickstart.mjs`.

```js quickstart
// quickstart.mjs : SYMB_URL et SYMB_API_KEY viennent de l'étape 1.
import { chromium } from 'playwright-core';

const SYMB_URL = process.env.SYMB_URL ?? 'http://localhost:3000';
const SYMB_API_KEY = process.env.SYMB_API_KEY;
const target = new URL(process.env.TARGET_URL ?? 'https://example.com/');

// Une session dedicated (type par défaut) : un Chromium à elle seule, joignable en CDP.
// Son egress ne laisse passer que l'hôte et le port visés.
const created = await fetch(`${SYMB_URL}/v1/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${SYMB_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    timeoutSeconds: 120,
    egress: { allowedHosts: [target.hostname], ports: [Number(target.port || (target.protocol === 'https:' ? 443 : 80))] },
    metadata: { guide: 'quickstart' },
  }),
});
if (!created.ok) throw new Error(`POST /v1/sessions: ${created.status} ${await created.text()}`);
const session = await created.json();
console.log(`session ${session.id}: ${session.state} (${session.type})`);
```

La réponse porte `connectUrls` : `cdp` et `playwright` sont des URL `wss://` avec un jeton court dans `?token=`. Aucun autre en-tête n'est nécessaire pour les ouvrir.

## 4. Pilote-la en CDP

```js quickstart
// L'URL CDP se suffit à elle-même : le jeton est dans sa query.
const browser = await chromium.connectOverCDP(session.connectUrls.cdp);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.goto(target.href);
console.log(`title: ${await page.title()}`);
```

## 5. Libère la session

```js quickstart
// Libération : le navigateur, son profil et ses fichiers sont détruits ; l'usage final revient dans la réponse.
const released = await fetch(`${SYMB_URL}/v1/sessions/${session.id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${SYMB_API_KEY}` },
});
const ended = await released.json();
console.log(`session ${ended.id}: ${ended.state} (${ended.endReason})`);
await browser.close();
```

Lance-le :

```bash
node quickstart.mjs
```

```text
session 6f1c0a52-…: running (dedicated)
title: Example Domain
session 6f1c0a52-…: ended (released)
```

SYM 👻 : C'est fait ! La session n'existe plus, et tout ce qu'elle a touché non plus. Si tu oublies d'en libérer une, je la termine moi-même quand `timeoutSeconds` est écoulé.

## Et ensuite

- [Branche un autre client](clients/README.md) : Puppeteer, Stagehand, browser-use, Skyvern, serveurs MCP.
- [Utilise le SDK](sdk.md) au lieu de `fetch`.
- [Déploie pour de vrai](deployment.md), puis [ajoute des nœuds](nodes.md).
