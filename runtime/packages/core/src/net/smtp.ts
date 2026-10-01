// SPDX-License-Identifier: AGPL-3.0-only
// Client SMTP minimal pour les alertes (08 § 5) : un message texte, un relais configuré par l'admin.
// - Garde SSRF (INV10), politique `operator-config` de 08b § 1 : le relais est réglé par l'admin, pas par un membre.
//   Adresses privées et boucle locale permises sans `ALLOWED_PRIVATE_HOSTS` (qui ouvrirait aussi l'hôte aux webhooks et à
//   `ctx.fetch` des membres) ; métadonnées cloud, 0.0.0.0, multicast et diffusion toujours refusés ; ports libres. Le nom
//   est résolu une fois, le socket s'ouvre sur l'adresse validée (jamais sur une nouvelle résolution), `servername` = nom
//   pour SNI et certificat, `remoteAddress` recontrôlée.
// - Sécurité : `tls` (implicite, 465), `starttls` (587, exigé : pas de repli en clair) ou `none` ; l'authentification
//   n'est jamais envoyée hors TLS ; mot de passe porté par `Secret`, jamais journalisé ; aucune expression régulière
//   sur le flux du serveur (lignes bornées, réponse bornée, délai global) ; en-têtes assainis contre l'injection de CRLF.
// - Pas de dépendance : nodemailer 10.0.13 corrige deux avis d'abord-DoS dans l'analyse des réponses et le choix SASL,
//   mais a moins de 7 jours (minimumReleaseAge) ; les 10.0.10 et moins les portent.
import { randomUUID } from 'node:crypto';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { findSsrfBlocked, SsrfBlockedError, type SsrfGuard } from './guard.js';
import { stripAddress } from './ip.js';
import type { Secret } from '../crypto/redact.js';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: Secret;
  /** Adresse d'expéditeur (enveloppe et En-tête From). */
  from: string;
  /** Nom annoncé à EHLO (défaut : `scrapyomama.local`). */
  helo?: string;
  /** Autorités de certification supplémentaires (PEM), pour un relais interne à certificat privé. */
  ca?: string[];
  timeoutMs?: number;
};

/**
 * Message : texte brut, plus une alternative HTML minimale et la langue du message (`Content-Language`, tâche 3.20). Aucun pixel
 * de suivi, aucune image distante (INV9) : l'appelant ne fournit que du HTML sans ressource externe.
 */
export type MailMessage = { to: readonly string[]; subject: string; text: string; html?: string; lang?: string };

export type SmtpFailure = 'ssrf_blocked' | 'connect' | 'tls' | 'auth' | 'rejected' | 'protocol' | 'timeout' | 'invalid_message' | 'insecure_auth';

export class SmtpError extends Error {
  override name = 'SmtpError';
  readonly code: SmtpFailure;
  /** Code de réponse SMTP, s'il y en a un. */
  readonly smtpCode: number | null;
  constructor(code: SmtpFailure, message: string, smtpCode: number | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.smtpCode = smtpCode;
  }
}

export type MailReceipt = { accepted: string[]; messageId: string; response: string };

const MAX_LINE = 8192;
const MAX_REPLY_LINES = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isMailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value);
}

/** Valeur d'en-tête sur une seule ligne ASCII ; non ASCII → mot encodé RFC 2047 (base64, UTF-8). */
export function encodeHeaderValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  // Mots de 45 octets au plus (75 caractères encodés), coupés sur des frontières de caractère.
  const words: string[] = [];
  let current = '';
  for (const ch of flat) {
    if (Buffer.byteLength(current + ch) > 45) {
      words.push(current);
      current = '';
    }
    current += ch;
  }
  if (current !== '') words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

function base64Lines(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
}

/** Message complet (en-têtes + corps base64), prêt pour DATA ; `\r\n` partout, aucune ligne ne commence par `.`. */
export function buildMessage(config: Pick<SmtpConfig, 'from' | 'helo'>, mail: MailMessage, at: Date, messageId: string = randomUUID()): { id: string; data: string } {
  if (!isMailAddress(config.from)) throw new SmtpError('invalid_message', 'adresse d\'expéditeur invalide');
  if (mail.to.length === 0 || mail.to.length > 50 || !mail.to.every(isMailAddress)) throw new SmtpError('invalid_message', 'destinataire invalide');
  const id = `<${messageId}@${(config.helo ?? 'scrapyomama.local').replace(/[^A-Za-z0-9.-]/g, '')}>`;
  const lang = mail.lang !== undefined && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(mail.lang) ? mail.lang : null;
  const common = [
    `From: ${config.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${at.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    ...(lang === null ? [] : [`Content-Language: ${lang}`]),
    'Auto-Submitted: auto-generated',
  ];
  if (mail.html === undefined) {
    const headers = [...common, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'];
    return { id, data: `${headers.join('\r\n')}\r\n\r\n${base64Lines(mail.text)}\r\n` };
  }
  // multipart/alternative : texte brut d'abord, HTML ensuite (le client affiche la dernière partie qu'il sait rendre).
  const boundary = `=_sym_${messageId.replace(/[^A-Za-z0-9]/g, '')}`;
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(body)].join('\r\n');
  const headers = [...common, `Content-Type: multipart/alternative; boundary="${boundary}"`];
  return { id, data: `${headers.join('\r\n')}\r\n\r\n${part('text/plain', mail.text)}\r\n${part('text/html', mail.html)}\r\n--${boundary}--\r\n` };
}

type Reply = { code: number; lines: string[] };

/** Lecteur de réponses SMTP (multi-lignes `250-…` puis `250 …`) sur un socket, borné en taille et en durée. */
class Wire {
  #socket: Socket | TLSSocket;
  #buffer = '';
  #lines: string[] = [];
  #waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  #error: Error | null = null;
  #ended = false;
  readonly #deadline: number;

  constructor(socket: Socket | TLSSocket, deadline: number) {
    this.#socket = socket;
    this.#deadline = deadline;
    this.#attach(socket);
  }

  #attach(socket: Socket | TLSSocket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      if (this.#buffer.length > MAX_LINE * 4 && !this.#buffer.includes('\n')) this.#fail(new SmtpError('protocol', 'ligne de réponse trop longue'));
      let index: number;
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index).replace(/\r$/, '');
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.length > MAX_LINE) return this.#fail(new SmtpError('protocol', 'ligne de réponse trop longue'));
        this.#lines.push(line);
        if (this.#lines.length > MAX_REPLY_LINES) return this.#fail(new SmtpError('protocol', 'réponse trop longue'));
      }
      this.#settle();
    });
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => {
      this.#ended = true;
      this.#fail(new SmtpError('protocol', 'connexion fermée par le relais'));
    });
  }

  /** Remplace le socket (STARTTLS) : l'ancien n'est plus lu. */
  swap(socket: Socket | TLSSocket): void {
    this.#socket.removeAllListeners('data');
    this.#socket.removeAllListeners('close');
    this.#socket.removeAllListeners('error');
    // Le socket d'origine est porté par la couche TLS : ses erreurs remontent par elle.
    this.#socket.on('error', () => undefined);
    this.#socket = socket;
    this.#buffer = '';
    this.#lines = [];
    this.#error = null;
    this.#ended = false;
    this.#attach(socket);
  }

  get socket(): Socket | TLSSocket {
    return this.#socket;
  }

  #fail(error: Error): void {
    if (this.#error === null) this.#error = error;
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w.reject(this.#error);
    }
  }

  /** Une réponse est complète quand sa dernière ligne est `NNN␠…` (ou `NNN` seul). */
  #settle(): void {
    if (!this.#waiting || this.#lines.length === 0) return;
    const last = this.#lines.at(-1) ?? '';
    const code = Number(last.slice(0, 3));
    if (!Number.isInteger(code) || last.length < 3 || (last.length > 3 && last[3] !== ' ' && last[3] !== '-')) {
      return this.#fail(new SmtpError('protocol', 'réponse SMTP mal formée'));
    }
    if (last[3] === '-') return;
    const w = this.#waiting;
    this.#waiting = null;
    const lines = this.#lines;
    this.#lines = [];
    w.resolve({ code, lines: lines.map((l) => l.slice(4)) });
  }

  read(): Promise<Reply> {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise<Reply>((resolve, reject) => {
      const remaining = this.#deadline - Date.now();
      if (remaining <= 0) return reject(new SmtpError('timeout', 'délai SMTP dépassé'));
      const timer = setTimeout(() => {
        this.#waiting = null;
        reject(new SmtpError('timeout', 'délai SMTP dépassé'));
      }, remaining);
      this.#waiting = {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.#settle();
      if (this.#ended && this.#waiting) this.#fail(new SmtpError('protocol', 'connexion fermée par le relais'));
    });
  }

  write(data: string): void {
    this.#socket.write(data);
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

async function command(wire: Wire, line: string, expect: readonly number[], failure: SmtpFailure = 'rejected'): Promise<Reply> {
  wire.write(`${line}\r\n`);
  const reply = await wire.read();
  if (!expect.includes(reply.code)) {
    throw new SmtpError(failure, `relais SMTP : ${reply.code} ${reply.lines[0] ?? ''}`.trim(), reply.code);
  }
  return reply;
}

function extensions(reply: Reply): { auth: Set<string>; starttls: boolean } {
  const auth = new Set<string>();
  let starttls = false;
  for (const line of reply.lines) {
    const [keyword, ...rest] = line.trim().split(' ');
    const upper = (keyword ?? '').toUpperCase();
    if (upper === 'STARTTLS') starttls = true;
    if (upper === 'AUTH') for (const m of rest) auth.add(m.toUpperCase());
  }
  return { auth, starttls };
}

/** SNI et vérification du certificat sur le nom ; jamais sur un littéral IP (RFC 6066). */
const sniOf = (config: Pick<SmtpConfig, 'host'>): { servername?: string } => (isIP(config.host) === 0 ? { servername: config.host } : {});

function open(config: SmtpConfig, address: string, family: 4 | 6, deadline: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const opts = { host: address, port: config.port, family };
    const socket =
      config.security === 'tls'
        ? tlsConnect({ ...opts, ...sniOf(config), ...(config.ca ? { ca: config.ca } : {}), minVersion: 'TLSv1.2' })
        : netConnect(opts);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError('timeout', 'connexion SMTP : délai dépassé'));
    }, remaining);
    socket.once(config.security === 'tls' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new SmtpError(config.security === 'tls' ? 'tls' : 'connect', `connexion SMTP impossible : ${error.message}`, null, { cause: error }));
    });
  });
}

function upgrade(config: SmtpConfig, socket: Socket, deadline: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new SmtpError('timeout', 'STARTTLS : délai dépassé'));
    }, Math.max(1, deadline - Date.now()));
    const tls = tlsConnect({ socket, host: config.host, ...sniOf(config), ...(config.ca ? { ca: config.ca } : {}), minVersion: 'TLSv1.2' });
    tls.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tls);
    });
    tls.once('error', (error) => {
      clearTimeout(timer);
      reject(new SmtpError('tls', `STARTTLS refusé : ${error.message}`, null, { cause: error }));
    });
  });
}

/**
 * Envoie un message. Lève `SmtpError` (jamais le mot de passe dans le message). `ssrf_blocked` : le relais résout vers
 * une adresse interdite (INV10) ; le détail est réservé au journal admin.
 */
export async function sendMail(config: SmtpConfig, mail: MailMessage, options: { guard: SsrfGuard; now?: Date }): Promise<MailReceipt> {
  const { id, data } = buildMessage(config, mail, options.now ?? new Date());
  if (config.username !== undefined && config.security === 'none') {
    throw new SmtpError('insecure_auth', 'authentification SMTP refusée hors TLS');
  }
  const deadline = Date.now() + (config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let pinned;
  try {
    pinned = await options.guard.resolveOperatorConfig(config.host, config.port);
  } catch (error) {
    throw findSsrfBlocked(error) ?? error;
  }
  const socket = await open(config, pinned.address, pinned.family, deadline);
  try {
    options.guard.checkOperatorAddress(config.host, stripAddress(socket.remoteAddress ?? ''), config.port);
  } catch (blocked) {
    socket.destroy();
    throw blocked instanceof SsrfBlockedError ? blocked : new SmtpError('ssrf_blocked', 'ssrf_blocked');
  }
  const wire = new Wire(socket, deadline);
  const helo = (config.helo ?? 'scrapyomama.local').replace(/[^A-Za-z0-9.-]/g, '');
  try {
    const greeting = await wire.read();
    if (greeting.code !== 220) throw new SmtpError('rejected', `relais SMTP : ${greeting.code} ${greeting.lines[0] ?? ''}`.trim(), greeting.code);
    let hello = await command(wire, `EHLO ${helo}`, [250]);
    let ext = extensions(hello);
    if (config.security === 'starttls') {
      // Exigé : sans STARTTLS annoncé, on s'arrête plutôt que d'écrire en clair.
      if (!ext.starttls) throw new SmtpError('tls', 'le relais n\'annonce pas STARTTLS');
      await command(wire, 'STARTTLS', [220], 'tls');
      wire.swap(await upgrade(config, wire.socket as Socket, deadline));
      hello = await command(wire, `EHLO ${helo}`, [250]);
      ext = extensions(hello);
    }
    if (config.username !== undefined) {
      const password = config.password?.reveal() ?? '';
      if (ext.auth.has('PLAIN')) {
        await command(wire, `AUTH PLAIN ${Buffer.from(`\0${config.username}\0${password}`).toString('base64')}`, [235], 'auth');
      } else if (ext.auth.has('LOGIN')) {
        await command(wire, 'AUTH LOGIN', [334], 'auth');
        await command(wire, Buffer.from(config.username).toString('base64'), [334], 'auth');
        await command(wire, Buffer.from(password).toString('base64'), [235], 'auth');
      } else {
        throw new SmtpError('auth', 'le relais n\'annonce ni AUTH PLAIN ni AUTH LOGIN');
      }
    }
    await command(wire, `MAIL FROM:<${config.from}>`, [250]);
    const accepted: string[] = [];
    let lastRefusal: number | null = null;
    for (const rcpt of mail.to) {
      wire.write(`RCPT TO:<${rcpt}>\r\n`);
      const reply = await wire.read();
      if (reply.code === 250 || reply.code === 251) accepted.push(rcpt);
      else if (reply.code < 400 || reply.code >= 600) throw new SmtpError('protocol', `RCPT : ${reply.code}`, reply.code);
      else lastRefusal = reply.code;
    }
    if (accepted.length === 0) throw new SmtpError('rejected', 'aucun destinataire accepté par le relais', lastRefusal);
    await command(wire, 'DATA', [354]);
    wire.write(`${data}.\r\n`);
    const done = await wire.read();
    if (done.code !== 250) throw new SmtpError('rejected', `relais SMTP : ${done.code} ${done.lines[0] ?? ''}`.trim(), done.code);
    wire.write('QUIT\r\n');
    return { accepted, messageId: id, response: `${done.code} ${done.lines[0] ?? ''}`.trim() };
  } finally {
    wire.destroy();
  }
}
