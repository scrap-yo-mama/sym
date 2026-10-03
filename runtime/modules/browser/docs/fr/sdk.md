# SDK TypeScript

> **À relire avec la tâche 3.4.** Le client `SymBrowser` n'est pas encore publié : `@sym-browser/sdk` n'exporte pour l'instant que les types du contrat. Cette page décrit l'API fixée par la spécification (04 § 10) et le contrat `@sym/contracts/browser` 1.0.0 ; les exemples seront exécutés en CI avec le SDK. D'ici là, utilise l'API REST comme dans le [démarrage rapide](quickstart.md).

Le paquet `@sym-browser/sdk` (MIT) enveloppe l'API REST, les connexions et les événements. Ses types sont générés depuis le document OpenAPI du contrat.

```bash
npm install @sym-browser/sdk playwright-core@1.63.0
```

## Client

```ts
import { SymBrowser } from '@sym-browser/sdk';

// url et apiKey lisent par défaut les variables d'environnement SYMB_URL et SYMB_API_KEY.
const symb = new SymBrowser({ url: process.env.SYMB_URL, apiKey: process.env.SYMB_API_KEY });
```

| API | Rôle |
|---|---|
| `sessions.create(options)` · `get(id)` · `list(filter)` · `release(id)` · `extend(id, seconds)` | Cycle de vie des sessions, mêmes champs que `POST /v1/sessions` ([référence](reference/api.md)) |
| `connectCDP(session)` | Un `Browser` Playwright en `connectOverCDP` (sessions `dedicated`, le défaut) |
| `connect(session)` | Un `Browser` Playwright en Playwright natif (`chromium.connect`) ; vérifie la version par `GET /v1/version` |
| `events(sessionId)` | Itérateur asynchrone sur les événements envoyés par le serveur : `state`, `egress.blocked`, `download`, `recording.ready` |
| `sessions.egress.get(id)` · `put(id, policy)` | Compteurs et politique d'egress |
| `version()` | `GET /v1/version` |
| `profiles` · `files` | Profils persistants et fichiers de session |

## Libération automatique

Le SDK libère les sessions qu'il a créées à la sortie du process (`SIGINT`, `SIGTERM`, `beforeExit`) et à la fin d'un bloc `await using` (`Symbol.asyncDispose`).

```ts
import { SymBrowser } from '@sym-browser/sdk';

const symb = new SymBrowser();

await using session = await symb.sessions.create({
  timeoutSeconds: 120,
  egress: { allowedHosts: ['example.com'], budgetBytes: 50_000_000 },
  metadata: { job: 'demo' },
});

// Session dedicated (type par défaut) : connexion CDP.
const browser = await symb.connectCDP(session);
const page = await browser.contexts()[0].newPage();
await page.goto('https://example.com');
console.log(await page.title());

for await (const event of symb.events(session.id)) {
  if (event.type === 'state' && event.data.state !== 'running') break;
}
// Fin du bloc : release() est appelé ; l'usage final est dans symb.sessions.get(session.id).
```

## Playwright natif

Une session `shared` (un contexte neuf dans un Chromium chaud, moins coûteux) se pilote en Playwright natif seulement :

```ts
await using session = await symb.sessions.create({ type: 'shared', timeoutSeconds: 60 });
const browser = await symb.connect(session);
```

`connect(session)` exige Playwright 1.63.x de ton côté : le serveur refuse une autre version majeure.mineure avec `428 playwright_version_mismatch`.

## Erreurs

Tout appel en échec lève une erreur qui porte le `code` stable de l'API (`unauthorized`, `quota_exceeded`, `capacity_exceeded`, `no_node`…), `retryable` et `what_to_do`. La liste complète est dans la [référence de l'API](reference/api.md#codes-derreur).
