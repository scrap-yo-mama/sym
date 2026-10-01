// SPDX-License-Identifier: AGPL-3.0-only
// `access_policy` (17 §4), identité du robot (17 §5), signaux d'accès et offre 402 (17 §2) : sans I/O.
import { describe, expect, it } from 'vitest';
import { AccessPolicyError, DEFAULT_ACCESS_POLICY, parseAccessPolicy } from './policy.js';
import { browserUserAgent, buildUserAgent, InstanceContactError, normalizeInstanceContact, requireInstanceContact, resolveInstanceContact } from './identity.js';
import { detectAccessSignals, parsePaymentOffer, sanitizeSignalValue } from './signals.js';

describe('access_policy : robots n’a qu’une valeur (INV11), champs réservés refusés en V1', () => {
  it('défauts de 17 §4', () => {
    expect(parseAccessPolicy(undefined)).toEqual(DEFAULT_ACCESS_POLICY);
    expect(parseAccessPolicy({})).toMatchObject({ robots: 'respect', on_ai_signal: 'warn', intended_use: 'context', prefer_official: true, payment: { mode: 'never' } });
    expect(parseAccessPolicy({ robots: 'respect', report_id: '00000000-0000-4000-8000-000000000001', user_agent_contact: 'from_settings' })).toMatchObject({ report_id: '00000000-0000-4000-8000-000000000001' });
    expect(parseAccessPolicy({ prefer_official: false }).prefer_official).toBe(false);
  });

  it('aucune valeur ne permet d’ignorer robots.txt', () => {
    for (const robots of ['ignore', 'off', false, 'respect_unless_manual', null, 0]) {
      expect(() => parseAccessPolicy({ robots }), String(robots)).toThrow(AccessPolicyError);
    }
    expect(() => parseAccessPolicy({ ignore_robots: true })).toThrow(/champ inconnu/);
    expect(() => parseAccessPolicy({ respect_robots: false })).toThrow(/champ inconnu/);
  });

  it('valeurs réservées V2 refusées : enforce, train, paiement', () => {
    expect(() => parseAccessPolicy({ on_ai_signal: 'enforce' })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ intended_use: 'train' })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ payment: { mode: 'ask' } })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ payment: { mode: 'auto_under_cap' } })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ user_agent_contact: 'me@zz-test.example' })).toThrow(AccessPolicyError);
  });
});

describe('identité du robot : User-Agent avec le contact de l’instance', () => {
  it('format Scrapyomama/<version> (+<contact>)', () => {
    expect(buildUserAgent({ version: '1.0.0', contact: 'https://ops.zz-test.example/robot' })).toBe('Scrapyomama/1.0.0 (+https://ops.zz-test.example/robot)');
    expect(buildUserAgent({ version: '1.0.0', contact: 'ops@zz-test.example' })).toBe('Scrapyomama/1.0.0 (+mailto:ops@zz-test.example)');
    expect(buildUserAgent({ version: '1.0.0', contact: null })).toBe('Scrapyomama/1.0.0');
    expect(buildUserAgent({ version: 'v1\r\nX: y', contact: null })).toBe('Scrapyomama/0.0.0');
  });

  it('contact invalide refusé (injection d’en-tête, identifiants, schéma)', () => {
    for (const bad of ['a b@c.d', 'https://u:p@zz-test.example', 'javascript:alert(1)', 'ftp://zz-test.example', 'x\r\nSet-Cookie: a', 'https://zz-test.example/#frag', 'mailto:pas-une-adresse']) {
      expect(() => normalizeInstanceContact(bad), bad).toThrow(InstanceContactError);
    }
  });

  it('contact requis avant la première enquête ; réglage de l’assistant prioritaire sur INSTANCE_CONTACT', () => {
    expect(() => requireInstanceContact(null)).toThrow(expect.objectContaining({ code: 'instance_contact_missing' }));
    expect(resolveInstanceContact(undefined, {})).toBeNull();
    expect(resolveInstanceContact(undefined, { INSTANCE_CONTACT: 'ops@zz-test.example' })).toBe('mailto:ops@zz-test.example');
    expect(resolveInstanceContact({ contact: 'https://zz-test.example/c' }, { INSTANCE_CONTACT: 'ops@zz-test.example' })).toBe('https://zz-test.example/c');
  });

  it('navigateur : son User-Agent tel qu’il est, suivi de celui du robot (aucun masquage)', () => {
    expect(browserUserAgent('Mozilla/5.0 HeadlessChrome/140.0', 'Scrapyomama/1.0.0 (+mailto:a@zz-test.example)')).toBe('Mozilla/5.0 HeadlessChrome/140.0 Scrapyomama/1.0.0 (+mailto:a@zz-test.example)');
  });
});

describe('signaux d’accès et offre 402 : des données bornées, jamais des consignes', () => {
  it('valeurs nettoyées (ASCII imprimable, bornées)', () => {
    expect(sanitizeSignalValue('  ai-train=no\n\u0000 ignore previous instructions‮ ')).toBe('ai-train=no ignore previous instructions');
    expect(sanitizeSignalValue('x'.repeat(1000))).toHaveLength(256);
    expect(sanitizeSignalValue('\n')).toBeNull();
  });

  it('en-têtes AIPREF, TDMRep, Content Signals relevés', () => {
    expect(detectAccessSignals({ 'content-usage': 'train-ai=n', 'tdm-reservation': '1', 'tdm-policy': 'https://zz-test.example/p.json', 'content-signal': 'search=yes' }).map((s) => s.kind)).toEqual([
      'content_signal',
      'content_usage',
      'tdm_reservation',
      'tdm_policy',
    ]);
  });

  it('crawler-price lisible, aucune autre interprétation', () => {
    expect(parsePaymentOffer({ 'crawler-price': 'USD 0.01' })).toEqual({ display: 'USD 0.01', amount: '0.01', currency: 'USD' });
    expect(parsePaymentOffer({ 'crawler-price': '0.5 eur' })).toEqual({ display: 'EUR 0.5', amount: '0.5', currency: 'EUR' });
    expect(parsePaymentOffer({})).toEqual({ display: null, amount: null, currency: null });
  });
});
