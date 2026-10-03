// SPDX-License-Identifier: AGPL-3.0-only
// Test de connectivité du proxy amont (cdc/sym-browser 04c § 2.3) : un tunnel authentifié par l'amont vers le point d'écho
// (`SYMB_IP_ECHO_URL`, HTTPS en production ; http admis pour les fixtures), GET, lecture de l'IP de sortie (JSON `{ip}` ou
// texte brut) et de la latence. L'hôte d'écho s'ajoute à la politique pour ce seul test ; la garde du nom s'applique.
import { isIP, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { connect as tlsConnect } from 'node:tls';
import type { UpstreamTarget } from '../proxy.js';
import { UpstreamError } from './shared.js';

/** Point d'écho par défaut (04c § 2.3, fixé par la tâche 1.6) : renvoie `{"ip": "…"}` en HTTPS. Réglable par l'admin. */
export const DEFAULT_IP_ECHO_URL = 'https://api.ipify.org/?format=json';

const MAX_ECHO_BYTES = 64 * 1024;

export type ProbeResult = { exitIp: string; latencyMs: number };

export type ProbeOptions = {
  /** Délai total du test (tunnel, TLS, réponse), 10 s par défaut (à valider). */
  timeoutMs?: number;
  /** Autorités de certification du point d'écho (tests) ; sinon le magasin du système. */
  ca?: string | Buffer;
};

function readReply(stream: Socket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    stream.on('data', (part: Buffer) => {
      size += part.length;
      if (size > MAX_ECHO_BYTES) {
        stream.destroy();
        reject(new UpstreamError('echo_failed'));
        return;
      }
      parts.push(part);
    });
    stream.once('error', () => reject(new UpstreamError('echo_failed')));
    stream.once('close', () => {
      const text = Buffer.concat(parts).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? '0'), body: split === -1 ? '' : text.slice(split + 4) });
    });
  });
}

/** Corps sans découpage `chunked` (réponse HTTP/1.1 du point d'écho) : on ne garde que la partie qui ressemble à une IP. */
function exitIpOf(body: string): string | undefined {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as { ip?: unknown };
    if (typeof parsed.ip === 'string' && isIP(parsed.ip) !== 0) return parsed.ip;
  } catch {
    /* texte brut */
  }
  if (isIP(trimmed) !== 0) return trimmed;
  // Corps découpé (`chunked`) : taille en hexadécimal, puis le contenu.
  const match = /\{[^{}]*"ip"\s*:\s*"([^"]+)"[^{}]*\}/.exec(trimmed) ?? /^[0-9a-f]+\r\n([^\r\n]+)\r\n/i.exec(trimmed);
  const candidate = match?.[1]?.trim();
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : undefined;
}

/**
 * Teste l'amont : `dial` ouvre le tunnel (même relais que la session), puis GET du point d'écho. Rend l'IP de sortie et la
 * latence (tunnel compris), ou `UpstreamError` (motif `timeout`, `upstream_auth_failed`, `echo_failed`…).
 */
export async function probeExitIp(dial: (target: UpstreamTarget) => Promise<Socket>, echoUrl: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const url = new URL(echoUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UpstreamError('echo_failed');
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const started = performance.now();
  let socket: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new UpstreamError('timeout'));
    }, options.timeoutMs ?? 10_000);
  });
  const run = async (): Promise<ProbeResult> => {
    const tunnel = await dial({ host, port });
    socket = tunnel;
    // Tunnel ouvert après le délai : fermé aussitôt, rien ne reste ouvert vers l'amont.
    if (expired) tunnel.destroy();
    let stream: Socket = tunnel;
    if (url.protocol === 'https:') {
      stream = await new Promise<Socket>((resolve, reject) => {
        const tls = tlsConnect({ socket: tunnel, ...(isIP(host) === 0 ? { servername: host } : {}), ...(options.ca === undefined ? {} : { ca: options.ca }) });
        tls.once('secureConnect', () => resolve(tls));
        tls.once('error', () => reject(new UpstreamError('echo_failed')));
      });
      socket = stream;
    }
    const reading = readReply(stream);
    stream.resume();
    stream.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: application/json, text/plain\r\nUser-Agent: sym-browser-egress-probe\r\nConnection: close\r\n\r\n`);
    const reply = await reading;
    const exitIp = reply.status === 200 ? exitIpOf(reply.body) : undefined;
    if (exitIp === undefined) throw new UpstreamError('echo_failed');
    return { exitIp, latencyMs: Math.max(0, Math.round(performance.now() - started)) };
  };
  try {
    return await Promise.race([run(), deadline]);
  } catch (error) {
    throw error instanceof UpstreamError ? error : new UpstreamError('echo_failed');
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}
