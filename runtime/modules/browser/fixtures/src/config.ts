// SPDX-License-Identifier: AGPL-3.0-only
// Constantes des fixtures de SYM Browser (tâche 0.5 ; cdc/sym-browser 08-recette §2). Identifiants de TEST uniquement
// (préfixe zz_test_) : jamais de vrais identifiants de proxy ici.
export const SITE_HOST = 'fixtures.local';
export const SITE_PORT = 8080;
export const EGRESS_IPS = { site: '10.88.0.10', http: '10.88.0.11', socks5: '10.88.0.12' } as const;

export interface Credentials {
  username: string;
  password: string;
}

/** Compte de la page de connexion de la fixture. */
export const LOGIN: Credentials = { username: 'zz_test_user', password: 'zz_test_login_pw' };
export const PROXY_HTTP_CREDENTIALS: Credentials = { username: 'zz_test_proxy_http', password: 'zz_test_http_pw' };
export const PROXY_SOCKS5_CREDENTIALS: Credentials = { username: 'zz_test_proxy_socks', password: 'zz_test_socks_pw' };

export const HEAVY_BYTES = 5 * 1024 * 1024;
export const DOWNLOAD_BYTES = 256 * 1024;
