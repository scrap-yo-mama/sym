// SPDX-License-Identifier: AGPL-3.0-only
// Observateur des connexions sortantes du processus du banc (« aucune requête ne quitte l'instance », contrat IA 2.8) :
// chaque socket TCP cliente créée est suivie (diagnostics_channel `net.client.socket`) et chaque tentative de connexion
// relevée (`connectionAttempt`, y compris les échecs). Les sockets Unix (Docker, PostgreSQL local) n'ont pas d'adresse IP.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';

interface Connection {
  address: string;
  port: number;
}

export interface EgressObservation {
  connections(): Connection[];
  nonLocal(): Connection[];
  stop(): void;
}

export function isLocalAddress(address: string): boolean {
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return plain === '::1' || /^127\.\d+\.\d+\.\d+$/.test(plain);
}

export function observeEgress(): EgressObservation {
  const seen: Connection[] = [];
  const onSocket = (message: unknown): void => {
    const socket = (message as { socket: Socket }).socket;
    socket.on('connectionAttempt', (ip: string, port: number) => seen.push({ address: ip, port }));
  };
  subscribe('net.client.socket', onSocket);
  return {
    connections: () => [...seen],
    nonLocal: () => seen.filter((c) => !isLocalAddress(c.address)),
    stop: () => unsubscribe('net.client.socket', onSocket),
  };
}
