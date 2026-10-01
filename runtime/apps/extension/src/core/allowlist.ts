// SPDX-License-Identifier: AGPL-3.0-only
// Liste blanche CDP de l'extension (07 § 3) : la liste figée et versionnée vit dans `@runtime/core/tunnel`
// (packages/core/src/tunnel/allowlist.ts), partagée avec la passerelle qui la revérifie avant d'émettre. Toute addition
// passe en revue ; `assert_cdp_allowlist` (allowlist.unit.test.ts) vérifie qu'aucune autre méthode CDP n'apparaît dans
// le code ni dans le paquet construit de l'extension.
export { CDP_ALLOWED_EVENTS, CDP_ALLOWLIST, CDP_ALLOWLIST_VERSION, checkCdpCommand } from '@runtime/core/tunnel';
