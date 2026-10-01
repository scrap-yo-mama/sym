// SPDX-License-Identifier: AGPL-3.0-only
// Manifeste MV3 (07 § 4) : permissions fixes ; aucun hôte statique, aucun <all_urls> : chaque site est une permission
// optionnelle demandée au clic « Connecter ce site » (assert_optional_hosts). Pas de content script, pas de code distant.
const PERMISSIONS = ['cookies', 'scripting', 'debugger', 'storage', 'alarms', 'tabs', 'tabGroups'] as const;

const OPTIONAL_HOST_PERMISSIONS = ['https://*/*', 'http://*/*'] as const;

export const MANIFEST = {
  name: 'Scrapyomama',
  description: 'Connects the sites you choose to your own Scrapyomama instance.',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  minimum_chrome_version: '120',
  permissions: [...PERMISSIONS],
  host_permissions: [] as string[],
  optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
};
