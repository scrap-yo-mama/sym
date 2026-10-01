// SPDX-License-Identifier: AGPL-3.0-only
// Client SMTP des alertes (08 § 5) contre un faux relais local : clair, STARTTLS, TLS implicite, AUTH, refus, garde SSRF.
import { afterEach, describe, expect, test } from 'vitest';
import { opensslAvailable, startFakeSmtp, type FakeSmtp } from '../../../../tests/helpers/smtp-server.js';
import { Secret } from '../crypto/redact.js';
import { createSsrfPolicy, SsrfBlockedError, SsrfGuard } from './guard.js';
import { buildMessage, encodeHeaderValue, isMailAddress, sendMail, SmtpError, type SmtpConfig } from './smtp.js';

const guard = new SsrfGuard({ policy: createSsrfPolicy({ allowedPrivateHosts: ['127.0.0.0/8'] }) });
const strictGuard = new SsrfGuard();
const open: FakeSmtp[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});
async function relay(options: Parameters<typeof startFakeSmtp>[0] = {}): Promise<FakeSmtp> {
  const server = await startFakeSmtp(options);
  open.push(server);
  return server;
}
const config = (server: FakeSmtp, over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port: server.port,
  security: 'none',
  from: 'alerts@scrapyomama.zz-test',
  timeoutMs: 5000,
  ...over,
});
const mail = { to: ['admin@example.zz-test'], subject: 'Alerte zz_test', text: 'Bonjour\n.ligne commençant par un point\nÉté — accents\n' };

describe('sendMail', () => {
  test('livre un message texte UTF-8 : enveloppe, en-têtes, corps décodé', async () => {
    const server = await relay();
    const receipt = await sendMail(config(server), mail, { guard });
    expect(receipt.accepted).toEqual(['admin@example.zz-test']);
    expect(server.mails).toHaveLength(1);
    const got = server.mails[0]!;
    expect(got.from).toBe('alerts@scrapyomama.zz-test');
    expect(got.to).toEqual(['admin@example.zz-test']);
    expect(got.headers['subject']).toBe('Alerte zz_test');
    expect(got.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(got.headers['message-id']).toBe(receipt.messageId);
    expect(got.text).toBe(mail.text);
  });

  test('STARTTLS : mise à niveau avant tout identifiant, AUTH PLAIN accepté', async () => {
    if (!opensslAvailable()) return;
    const server = await relay({ mode: 'starttls', auth: { user: 'u', pass: 'zz_test_mot_de_passe' } });
    await sendMail(config(server, { security: 'starttls', username: 'u', password: new Secret('zz_test_mot_de_passe'), ca: [server.ca!] }), mail, { guard });
    expect(server.mails).toHaveLength(1);
    const verbs = server.commands.map((c) => c.split(' ')[0]);
    expect(verbs.indexOf('STARTTLS')).toBeLessThan(verbs.indexOf('AUTH'));
    expect(server.commands.join('\n')).not.toContain('zz_test_mot_de_passe');
  });

  test('TLS implicite avec AUTH LOGIN de repli', async () => {
    if (!opensslAvailable()) return;
    const server = await relay({ mode: 'tls', auth: { user: 'u', pass: 'p' } });
    await sendMail(config(server, { security: 'tls', username: 'u', password: new Secret('p'), ca: [server.ca!] }), mail, { guard });
    expect(server.mails).toHaveLength(1);
  });

  test('certificat inconnu : refus tls, aucun message', async () => {
    if (!opensslAvailable()) return;
    const server = await relay({ mode: 'tls' });
    await expect(sendMail(config(server, { security: 'tls' }), mail, { guard })).rejects.toMatchObject({ code: 'tls' });
    expect(server.mails).toHaveLength(0);
  });

  test('STARTTLS exigé : un relais qui ne l\'annonce pas est refusé, rien n\'est écrit en clair', async () => {
    const server = await relay({ mode: 'plain' });
    await expect(sendMail(config(server, { security: 'starttls' }), mail, { guard })).rejects.toMatchObject({ code: 'tls' });
    expect(server.commands.some((c) => c.startsWith('MAIL'))).toBe(false);
  });

  test('identifiants jamais envoyés hors TLS', async () => {
    const server = await relay({ auth: { user: 'u', pass: 'p' } });
    await expect(sendMail(config(server, { username: 'u', password: new Secret('p') }), mail, { guard })).rejects.toMatchObject({ code: 'insecure_auth' });
    expect(server.connections()).toBe(0);
  });

  test('mauvais mot de passe : auth, message sans le mot de passe', async () => {
    if (!opensslAvailable()) return;
    const server = await relay({ mode: 'starttls', auth: { user: 'u', pass: 'bon' } });
    const error = await sendMail(config(server, { security: 'starttls', username: 'u', password: new Secret('zz_test_mauvais'), ca: [server.ca!] }), mail, { guard }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmtpError);
    expect((error as SmtpError).code).toBe('auth');
    expect((error as SmtpError).smtpCode).toBe(535);
    expect(String((error as SmtpError).message)).not.toContain('zz_test_mauvais');
  });

  test('destinataire refusé : un accepté suffit, aucun accepté : rejected', async () => {
    const server = await relay({ rejectRcpt: ['mauvais@example.zz-test'] });
    const receipt = await sendMail(config(server), { ...mail, to: ['mauvais@example.zz-test', 'bon@example.zz-test'] }, { guard });
    expect(receipt.accepted).toEqual(['bon@example.zz-test']);
    await expect(sendMail(config(server), { ...mail, to: ['mauvais@example.zz-test'] }, { guard })).rejects.toMatchObject({ code: 'rejected' });
  });

  test('relais muet : délai', async () => {
    const server = await relay({ mute: true });
    const started = Date.now();
    await expect(sendMail(config(server, { timeoutMs: 400 }), mail, { guard })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('assert_smtp_operator_config : relais de l\'admin sur boucle locale ou réseau privé permis sans ALLOWED_PRIVATE_HOSTS (08b § 1)', async () => {
    const server = await relay();
    // Garde stricte (aucune dérogation) : le relais est une configuration d'opérateur, pas une cible de membre.
    const receipt = await sendMail(config(server), mail, { guard: strictGuard });
    expect(receipt.accepted).toEqual(['admin@example.zz-test']);
    // La garde des cibles de membres, elle, reste fermée pour la même adresse : aucune dérogation n'a été ouverte.
    await expect(strictGuard.resolve('127.0.0.1', 443)).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  test('operator-config : métadonnées cloud, 0.0.0.0, multicast et diffusion toujours refusés, 0 connexion', async () => {
    for (const host of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'metadata.google.internal']) {
      const error = await sendMail({ host, port: 25, security: 'none', from: 'a@b.zz-test', timeoutMs: 1000 }, mail, { guard: strictGuard }).catch((e: unknown) => e);
      expect(error, host).toBeInstanceOf(SsrfBlockedError);
      expect((error as SsrfBlockedError).code).toBe('ssrf_blocked');
    }
  });

  test('operator-config : un nom qui résout vers les métadonnées est refusé ; l\'adresse résolue est épinglée', async () => {
    const resolving = (address: string) => new SsrfGuard({ resolver: async () => [{ address, family: 4 }] });
    await expect(resolving('169.254.169.254').resolveOperatorConfig('smtp.example.zz-test', 587)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(await resolving('10.1.2.3').resolveOperatorConfig('smtp.internal.zz-test', 587)).toEqual({ address: '10.1.2.3', family: 4 });
    expect(() => strictGuard.checkOperatorAddress('smtp.internal.zz-test', '169.254.169.254')).toThrow(SsrfBlockedError);
    expect(() => strictGuard.checkOperatorAddress('smtp.internal.zz-test', '192.168.1.10')).not.toThrow();
  });

  test('garde SSRF : métadonnées cloud refusées même si le réseau privé est autorisé', async () => {
    const lax = new SsrfGuard({ policy: createSsrfPolicy({ allowedPrivateHosts: ['169.254.0.0/16', '127.0.0.0/8'] }) });
    await expect(sendMail({ host: '169.254.169.254', port: 25, security: 'none', from: 'a@b.zz-test' }, mail, { guard: lax })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('construction du message', () => {
  test('adresses : refus des CRLF, espaces, chevrons', () => {
    expect(isMailAddress('a@example.com')).toBe(true);
    for (const bad of ['a@b\r\nBcc: x@y.z', 'a b@c.d', '<a@b.c>', 'a@', '@b.c', 'a@b..c', '']) expect(isMailAddress(bad), bad).toBe(false);
  });

  test('injection d\'en-tête par le sujet : aplatie sur une ligne', () => {
    const { data } = buildMessage({ from: 'a@b.zz-test' }, { to: ['c@d.zz-test'], subject: 'Hello\r\nBcc: pirate@x.zz-test', text: 'x' }, new Date('2026-10-01T10:00:00Z'), 'id1');
    expect(data.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
    expect(data).toContain('Subject: Hello Bcc: pirate@x.zz-test');
  });

  test('sujet non ASCII : mots encodés RFC 2047 de 75 caractères au plus', () => {
    const encoded = encodeHeaderValue('Alerte : l\'API « annonces » est bloquée par le site — accès refusé, aucune relance automatique');
    for (const word of encoded.split('\r\n ')) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(encoded.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')).toBe(
      'Alerte : l\'API « annonces » est bloquée par le site — accès refusé, aucune relance automatique',
    );
  });

  test('aucune ligne du message ne commence par un point (pas de bourrage nécessaire)', () => {
    const { data } = buildMessage({ from: 'a@b.zz-test' }, { to: ['c@d.zz-test'], subject: 's', text: '.\n.\n..' }, new Date(), 'id');
    expect(data.split('\r\n').some((l) => l.startsWith('.'))).toBe(false);
  });
});
