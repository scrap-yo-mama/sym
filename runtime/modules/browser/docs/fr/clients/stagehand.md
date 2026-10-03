# Stagehand

Stagehand pilote un navigateur distant en mode `LOCAL` via `localBrowserLaunchOptions.cdpUrl`. Il n'envoie aucun en-tête d'authentification : le jeton reste dans l'URL (`?token=`), et c'est exactement ce que contient `connectUrls.cdp`.

```ts
import { Stagehand } from '@browserbasehq/stagehand';

// session : réponse de POST /v1/sessions (connectUrls.cdp se termine par ?token=…)
const stagehand = new Stagehand({
  env: 'LOCAL',
  localBrowserLaunchOptions: { cdpUrl: session.connectUrls.cdp },
});
await stagehand.init();

const page = stagehand.page;
await page.goto('https://example.com');
console.log(await page.title());

await stagehand.close();
```

## Remarques

- Les fonctions d'IA de Stagehand demandent ta propre clé de fournisseur de modèle ; SYM Browser ne fournit que le navigateur.
- `stagehand.close()` ferme le navigateur, ce qui libère la session. Crée une nouvelle session pour l'exécution suivante.
- Restreins l'egress de la session aux sites que ton agent doit visiter (`egress.allowedHosts` à la création).
