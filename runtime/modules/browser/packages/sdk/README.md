# @sym-browser/sdk

SDK TypeScript de SYM Browser, sous licence MIT. Il crée des sessions de navigateur, s'y connecte avec Playwright et les libère.

- Client REST généré depuis l'OpenAPI du contrat `@sym/contracts/browser` (`pnpm --filter @sym-browser/sdk gen`).
- `connect(session)` rend un `Browser` Playwright en protocole natif, `connectCDP(session)` en CDP (sessions `dedicated`, le type par défaut).
- `events(id)` itère sur le flux SSE d'une session ; `profiles` et `files` gèrent profils et fichiers.
- Les sessions créées sont libérées à la sortie du bloc `await using`, par `release()`, par `close()` et à la sortie du process (`SIGINT`, `SIGTERM`, `beforeExit`).
- Dépendances : `@sym/contracts` (MIT) et `playwright-core` 1.63 (Apache-2.0). Node 24 ou plus.

## Exemple

`SYMB_URL` et `SYMB_API_KEY` sont lus dans l'environnement. Cet exemple est exécuté tel quel en CI contre une instance en mode `all` (test `sdk_readme_example`).

<!-- sdk_readme_example -->
```ts
import { SymBrowser } from '@sym-browser/sdk';

const symb = new SymBrowser(); // SYMB_URL et SYMB_API_KEY
const target = new URL(process.env.SYMB_DEMO_URL ?? 'https://example.com/');
const port = Number(target.port) || (target.protocol === 'http:' ? 80 : 443);
let id;

{
  await using session = await symb.sessions.create({
    type: 'shared',
    timeoutSeconds: 120,
    egress: { allowedHosts: [target.hostname], ports: [port], budgetBytes: 50_000_000 },
    metadata: { job: 'demo' },
  });
  id = session.id;
  const browser = await symb.connect(session);
  const page = await browser.contexts()[0].newPage();
  await page.goto(target.href);
  console.log(await page.title());
} // fin du bloc : session libérée

const ended = await symb.sessions.get(id);
console.log(ended.state, ended.endReason); // ended released
```

## API

| API | Rôle |
|---|---|
| `new SymBrowser({ url, apiKey, releaseOnExit, timeoutMs })` | Client ; `url` et `apiKey` lisent `SYMB_URL` et `SYMB_API_KEY` si omis |
| `sessions.create(opts, { wait, idempotencyKey })` · `get(id)` · `list(filter)` · `release(id)` · `extend(id, seconds)` | Cycle de vie (champs de création : contrat `CreateSessionRequest`) |
| `sessions.egress.get(id)` · `sessions.egress.put(id, policy)` · `version()` | Compteurs et politique d'egress, `GET /v1/version` |
| `connect(session)` | `Browser` Playwright (`chromium.connect`) après contrôle de la version de Playwright ; ouvre un contexte si la connexion n'en a aucun |
| `connectCDP(session)` | `Browser` Playwright (`connectOverCDP`) ; `session.connectUrls.cdp` sert aussi Puppeteer, Stagehand et les autres clients CDP |
| `events(id?, { signal })` | Itérateur sur le flux SSE (`state`, `egress.blocked`, `download`, `recording.ready`…) ; s'arrête après l'état terminal |
| `profiles.create/list/get/delete/import/storageState` | Profils persistants |
| `files.list/download/delete/upload` | Téléchargements et envois de fichiers |
| `close()` | Libère les sessions créées par ce client |

Les erreurs sont des `SymBrowserError` : `code` (`quota_exceeded`, `no_node`…), `status`, `retryable`, `whatToDo`, `requestId`, `details`, `retryAfterSeconds`.
