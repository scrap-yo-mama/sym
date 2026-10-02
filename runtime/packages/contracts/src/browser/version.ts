// SPDX-License-Identifier: MIT
// Version du contrat `browser` (ADR 23 § 3 : versionné avec le module Browser). Un changement de forme (champ, type, enum)
// la fait changer ; les fixtures valides et invalides de toutes les versions servies sont rejouées des deux côtés.
// 1.0.0 (tâche 2.2, CDC v1.2) : connectUrls à trois clés (cdp nul pour shared, bidi nul), type par défaut dedicated,
// VersionInfo avec product et contract, erreur protocol_not_served.

/** Version du protocole du contrat `@sym/contracts/browser`. */
export const BROWSER_PROTOCOL_VERSION = '1.0.0';

/** Version majeure de l'API REST servie sous `/v1` (`GET /v1/version` → `api`). */
export const BROWSER_API_VERSION = '1';

/** Versions du moteur, figées (cdc/sym-browser 03 § 1) : `browserType.connect` exige la même version majeure.mineure. */
export const BROWSER_ENGINE = { playwright: '1.63.0', chromium: '153.0.8010.12' } as const;

/** Nom du produit dans `GET /v1/version` : SYM reconnaît SYM Browser à ce champ (04f § 2, 04g § 2). */
export const BROWSER_PRODUCT = 'sym-browser';

/** Plus ancienne version du SDK servie par cette API. */
export const BROWSER_MIN_SDK = '1.0.0';

/** Réponse de `GET /v1/version` (cdc/sym-browser 04 § 2, 04f § 2) ; `contract` : `BROWSER_PROTOCOL_VERSION` servie. */
export type VersionInfo = {
  product: typeof BROWSER_PRODUCT;
  api: string;
  contract: string;
  playwright: string;
  chromium: string;
  platform: string;
  minSdk: string;
};
