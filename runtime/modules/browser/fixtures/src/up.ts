// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm fixtures` (démarre tout en Docker Compose) et `pnpm fixtures:down` (arrête). Ports publiés sur 127.0.0.1 seulement.
import { composeDown, composeUp, dockerAvailable, DEFAULT_PORTS, DEFAULT_PROJECT } from './compose.ts';
import { EGRESS_IPS, PROXY_HTTP_CREDENTIALS, PROXY_SOCKS5_CREDENTIALS, SITE_HOST, SITE_PORT } from './config.ts';

const options = { project: DEFAULT_PROJECT, ports: DEFAULT_PORTS };
const action = process.argv[2] ?? 'up';

if (!(await dockerAvailable())) {
  console.error('Docker (avec le plugin compose) est requis pour les fixtures.');
  process.exit(1);
}
if (action === 'down') {
  await composeDown(options);
  console.log('Fixtures arrêtées.');
} else if (action === 'up') {
  await composeUp(options);
  console.log(`Fixtures prêtes (réseau Docker 10.88.0.0/24).
  site              http://127.0.0.1:${DEFAULT_PORTS.site}  (dans le réseau : http://${SITE_HOST}:${SITE_PORT}, IP ${EGRESS_IPS.site})
  proxy HTTP        127.0.0.1:${DEFAULT_PORTS.http}  utilisateur ${PROXY_HTTP_CREDENTIALS.username}  IP de sortie ${EGRESS_IPS.http}
  proxy SOCKS5      127.0.0.1:${DEFAULT_PORTS.socks5}  utilisateur ${PROXY_SOCKS5_CREDENTIALS.username}  IP de sortie ${EGRESS_IPS.socks5}
  journal des IP    GET http://127.0.0.1:${DEFAULT_PORTS.site}/__ips   (remise à zéro : POST /__reset)
Arrêt : pnpm fixtures:down`);
} else {
  console.error('usage : node fixtures/src/up.ts [up|down]');
  process.exit(2);
}
