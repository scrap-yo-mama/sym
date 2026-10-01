// SPDX-License-Identifier: AGPL-3.0-only
// Crochet de journal réseau pour un PROCESSUS enfant (`node --import tests/helpers/net-log-hook.ts …`) : écrit une ligne
// `hôte:port` dans le fichier `NET_LOG` à chaque connexion TCP sortante, sans rien bloquer. Le test lit ensuite le fichier et
// vérifie qu'aucune destination ne sort de la machine (INV9). Contrepartie, pour les processus réels, de captureNetwork().
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const file = process.env['NET_LOG'];
if (file) {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const raw = args[0] as unknown;
    const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string | undefined;
    if (typeof first === 'object' && first !== null && first.path) {
      appendFileSync(file, `unix ${first.path}\n`);
    } else {
      const host = typeof first === 'object' && first !== null ? (first.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost';
      const port = typeof first === 'object' && first !== null ? first.port : first;
      appendFileSync(file, `${host}:${String(port ?? '')}\n`);
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
