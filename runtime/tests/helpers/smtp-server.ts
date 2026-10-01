// SPDX-License-Identifier: AGPL-3.0-only
// Faux relais SMTP pour les tests (alertes, 08 § 5) : écoute sur 127.0.0.1 (port éphémère), enregistre les messages
// reçus. Modes : clair, STARTTLS ou TLS implicite (certificat jetable généré par openssl au moment du test).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket, type TlsOptions } from 'node:tls';

type ReceivedMail ={ from: string; to: string[]; raw: string; headers: Record<string, string>; text: string };

export type FakeSmtpOptions = {
  mode?: 'plain' | 'starttls' | 'tls';
  /** Identifiants acceptés ; absent : AUTH non annoncé. */
  auth?: { user: string; pass: string };
  /** Destinataires refusés (550). */
  rejectRcpt?: string[];
  /** Ne répond jamais après le message d'accueil (test de délai). */
  mute?: boolean;
};

export type FakeSmtp = {
  port: number;
  /** Certificat PEM (modes TLS), à passer en `ca`. */
  ca: string | null;
  mails: ReceivedMail[];
  /** Commandes reçues, `AUTH` : mot de passe masqué. */
  commands: string[];
  connections: () => number;
  close: () => Promise<void>;
};

export function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeCertificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zz_test_smtp_'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=smtp.zz-test', '-addext', 'subjectAltName=DNS:smtp.zz-test,IP:127.0.0.1'],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseMail(raw: string): { headers: Record<string, string>; text: string } {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = raw.slice(split + 4).replace(/\r\n/g, '');
  return { headers, text: headers['content-transfer-encoding'] === 'base64' ? Buffer.from(body, 'base64').toString('utf8') : body };
}

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const mode = options.mode ?? 'plain';
  const certificate = mode === 'plain' ? null : makeCertificate();
  const tlsOptions: TlsOptions | null = certificate ? { key: certificate.key, cert: certificate.cert } : null;
  const mails: ReceivedMail[] = [];
  const commands: string[] = [];
  let connections = 0;
  const sockets = new Set<Socket>();

  const serve = (socket: Socket, secured: boolean) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let current: Socket = socket;
    let buffer = '';
    let from = '';
    let to: string[] = [];
    let dataMode = false;
    let data = '';
    let authStep: 'none' | 'login_user' | 'login_pass' = 'none';
    let loginUser = '';
    let isSecure = secured;
    const say = (line: string) => current.write(`${line}\r\n`);
    const ehlo = () => {
      const lines = ['smtp.zz-test'];
      if (mode === 'starttls' && !isSecure) lines.push('STARTTLS');
      if (options.auth && (isSecure || mode === 'plain')) lines.push('AUTH PLAIN LOGIN');
      lines.push('8BITMIME');
      lines.forEach((l, i) => say(`250${i === lines.length - 1 ? ' ' : '-'}${l}`));
    };
    if (!options.mute) say('220 smtp.zz-test ESMTP');
    const onData = (chunk: Buffer) => {
      if (options.mute) return;
      buffer += chunk.toString('utf8');
      for (;;) {
        if (dataMode) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          dataMode = false;
          mails.push({ from, to, raw: data, ...parseMail(data) });
          say('250 2.0.0 queued');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (authStep === 'login_user') {
          loginUser = Buffer.from(line, 'base64').toString();
          authStep = 'login_pass';
          commands.push('AUTH LOGIN <user>');
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (authStep === 'login_pass') {
          const ok = options.auth && loginUser === options.auth.user && Buffer.from(line, 'base64').toString() === options.auth.pass;
          authStep = 'none';
          commands.push('AUTH LOGIN <pass>');
          say(ok ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
          continue;
        }
        const upper = line.toUpperCase();
        const verb = upper.split(' ')[0];
        commands.push(verb === 'AUTH' ? `AUTH ${upper.split(' ')[1] ?? ''} <masqué>` : line);
        if (verb === 'EHLO') ehlo();
        else if (verb === 'STARTTLS' && tlsOptions && mode === 'starttls') {
          say('220 go ahead');
          current.removeAllListeners('data');
          const secure = new TLSSocket(current, { isServer: true, ...tlsOptions });
          secure.on('error', () => undefined);
          sockets.add(secure);
          current = secure;
          isSecure = true;
          buffer = '';
          secure.on('data', onData);
        } else if (verb === 'AUTH') {
          const parts = line.split(' ');
          if (!options.auth || !(isSecure || mode === 'plain')) say('504 5.5.4 no auth');
          else if (parts[1]?.toUpperCase() === 'PLAIN') {
            const [, user, pass] = Buffer.from(parts[2] ?? '', 'base64').toString().split('\0');
            say(user === options.auth.user && pass === options.auth.pass ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
          } else if (parts[1]?.toUpperCase() === 'LOGIN') {
            authStep = 'login_user';
            say('334 VXNlcm5hbWU6');
          } else say('504 5.5.4 mechanism');
        } else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          say('250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          const rcpt = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (options.rejectRcpt?.includes(rcpt)) say('550 5.1.1 no such user');
          else {
            to.push(rcpt);
            say('250 2.1.5 ok');
          }
        } else if (verb === 'DATA') {
          dataMode = true;
          data = '';
          say('354 end with <CRLF>.<CRLF>');
        } else if (verb === 'QUIT') {
          say('221 bye');
          current.end();
        } else say('502 5.5.2 unknown');
      }
    };
    current.on('data', onData);
  };

  const server: Server =
    mode === 'tls' && tlsOptions
      ? createTlsServer(tlsOptions, (socket) => {
          connections += 1;
          serve(socket, true);
        })
      : createServer((socket) => {
          connections += 1;
          serve(socket, false);
        });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: certificate?.cert ?? null,
    mails,
    commands,
    connections: () => connections,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
