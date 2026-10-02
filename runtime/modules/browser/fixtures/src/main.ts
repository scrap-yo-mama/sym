// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée d'un conteneur de fixtures : `node src/main.ts site|http-proxy|socks5|local`.
// `local` lance les trois services dans ce processus sur 127.0.0.1 (sans Docker : IP de sortie identiques, pour le
// développement seulement). Variables : PORT, HOST, PROXY_USER, PROXY_PASSWORD (identifiants de TEST : préfixe zz_test_).
import { PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS, SITE_PORT, type Credentials } from './config.ts';
import { startHttpProxy } from './http-proxy.ts';
import { startSite } from './site.ts';
import { startSocks5Proxy } from './socks5-proxy.ts';

const emit = (kind: string) => (event: unknown): void => console.log(JSON.stringify({ kind, ...(event as object) }));

function credentialsFrom(fallback: Credentials): Credentials {
  const username = process.env.PROXY_USER ?? fallback.username;
  const password = process.env.PROXY_PASSWORD ?? fallback.password;
  if (!username.startsWith('zz_test_')) throw new Error('Identifiants de proxy de test uniquement : le nom d’utilisateur doit commencer par zz_test_.');
  return { username, password };
}

const role = process.argv[2];
const host = process.env.HOST ?? '0.0.0.0';
const port = (fallback: number): number => Number(process.env.PORT ?? fallback);

if (role === 'site') {
  const site = await startSite({ port: port(SITE_PORT), host, onRequest: emit('site.request') });
  console.log(JSON.stringify({ kind: 'ready', role, port: site.port }));
} else if (role === 'http-proxy') {
  const proxy = await startHttpProxy({ port: port(3128), host, credentials: credentialsFrom(PROXY_HTTP_CREDENTIALS), onEvent: emit('http-proxy') });
  console.log(JSON.stringify({ kind: 'ready', role, port: proxy.port }));
} else if (role === 'socks5') {
  const proxy = await startSocks5Proxy({ port: port(1080), host, credentials: credentialsFrom(PROXY_SOCKS5_CREDENTIALS), onEvent: emit('socks5') });
  console.log(JSON.stringify({ kind: 'ready', role, port: proxy.port }));
} else if (role === 'local') {
  const site = await startSite({ port: 18_080, host: '127.0.0.1' });
  const http = await startHttpProxy({ port: 18_081, host: '127.0.0.1', credentials: PROXY_HTTP_CREDENTIALS });
  const socks = await startSocks5Proxy({ port: 18_082, host: '127.0.0.1', credentials: PROXY_SOCKS5_CREDENTIALS });
  console.log(`site http://127.0.0.1:${site.port}  proxy HTTP 127.0.0.1:${http.port}  proxy SOCKS5 127.0.0.1:${socks.port} (identifiants de test dans fixtures/src/config.ts)`);
} else {
  console.error('usage : node src/main.ts site|http-proxy|socks5|local');
  process.exit(2);
}
