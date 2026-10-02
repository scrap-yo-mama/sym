---
name: browser-contract-change
description: Procédure pour changer le contrat @sym/contracts/browser (champ, type, énumération, OpenAPI) sans casser SYM ni le SDK. À utiliser dès qu'une tâche du module demande un nouveau champ d'API, un nouvel événement ou un nouveau code d'erreur.
---

# Changer le contrat `@sym/contracts/browser`

Le contrat vit hors du module (`runtime/packages/contracts`, MIT). Le module le consomme ; SYM aussi (tâches 4.x).

1. Tâche séparée : lance la session avec `--add-dir ../../packages/contracts` depuis `runtime/modules/browser`.
2. Écris d'abord le test qui échoue : fixture valide ou invalide dans `src/browser/openapi.contract.test.ts`.
3. Énumération : modifie la constante `as const` ; le type et le schéma OpenAPI en dérivent. Jamais de liste recopiée à la main.
4. Changement de forme (champ, type, enum) : incrémente `BROWSER_PROTOCOL_VERSION` (`src/browser/version.ts`). Changement cassant : ajoute la nouvelle forme à côté de l'ancienne, migre les consommateurs, retire l'ancienne plus tard.
5. Aucun nouveau sous-chemin dans `exports` sans décision de l'ADR 23 ; le test `exports.unit.test.ts` le refuse.
6. Vérifie : `pnpm --filter @sym/contracts build`, `pnpm --filter @sym/contracts test`, `pnpm --filter @sym/contracts typecheck`, puis la CI locale du module (skill `browser-ci`).
