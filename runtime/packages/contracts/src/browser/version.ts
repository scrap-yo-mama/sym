// SPDX-License-Identifier: MIT
// Version du contrat `browser` (ADR 23 § 3 : versionné avec le module Browser). Un changement de forme (champ, type, enum)
// la fait changer ; les fixtures valides et invalides de toutes les versions servies sont rejouées des deux côtés.

/** Version du protocole du contrat `@sym/contracts/browser`. */
export const BROWSER_PROTOCOL_VERSION = '0.1.0';

/** Version majeure de l'API REST servie sous `/v1` (`GET /v1/version` → `api`). */
export const BROWSER_API_VERSION = '1';

/** Versions du moteur, figées (cdc/sym-browser 03 § 1) : `browserType.connect` exige la même version majeure.mineure. */
export const BROWSER_ENGINE = { playwright: '1.63.0', chromium: '153.0.8010.12' } as const;

/** Réponse de `GET /v1/version` (cdc/sym-browser 04 § 2). */
export type VersionInfo = {
  api: string;
  playwright: string;
  chromium: string;
  platform: string;
  minSdk: string;
};
