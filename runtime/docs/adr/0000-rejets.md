# ADR 0000 : choix écartés

- Statut : accepté
- Date : 2026-09-30
- Source : `cdc/scrapyomama-runtime/03-architecture.md`, section « Choix écartés » (tâche 0.1)

## Contexte

Avant d'écrire du code, on consigne ce qui a été examiné et rejeté, pour ne pas le ré-ouvrir sans fait nouveau. Les verdicts détaillés sont dans `docs/runtime-v2/` (recherches T1 à T10, U2, S1) et dans `_exclusions.md` du CDC.

## Décision

Les options suivantes sont écartées.

| Écarté | Raison | Source |
|---|---|---|
| Bun, Deno | Blocages Playwright et modules natifs (isolated-vm) | T1 |
| Hono, NestJS | Aucun gain sur Fastify pour REST + WSS + MCP | T1 |
| Go, Python | Une seule langue ; garde X6 (aucun `.py` ni `.ipynb` dans le dépôt) | T1, _exclusions X6 |
| Browser Use, Skyvern | Python ; ou service distant | T4 |
| Stagehand v4 | `agent()` retiré, cache réservé à Browserbase | T4 |
| Redis, BullMQ en V1 | Un seul service BYO (PostgreSQL) | T2 |
| S3 en V1 | jsonb suffit ; `BlobStore` en V2 | T3 |
| PrimeVue 5, `@n8n/design-system` | Licence ou accessibilité | U2 |
| Crawlee en dépendance | Surface et modèle d'acteur non nécessaires ; on reprend des idées (recyclage, sessions) | S1 |
| Services navigateur distants à anti-détection intégrée | Contraire à X2 | T4, _exclusions X2 |

## Conséquences

- Toute réouverture d'un de ces choix passe par un nouvel ADR qui cite le fait nouveau.
- La garde X6 (CI et pre-commit) applique mécaniquement le rejet de Python.
