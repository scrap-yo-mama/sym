// SPDX-License-Identifier: AGPL-3.0-only
// `access_policy` (17 §4), identité du robot (17 §5), signaux d'accès et offre 402 (17 §2) : sans I/O.
import { describe, expect, it } from 'vitest';
import { AccessPolicyError, DEFAULT_ACCESS_POLICY, parseAccessPolicy } from './policy.js';
import { buildUserAgent, EngineUserAgentError, identityFromEnv, InstanceContactError, normalizeInstanceContact, requireInstanceContact, resolveIdentifyInstance, resolveInstanceContact, robotFrom } from './identity.js';
import { detectAccessSignals, parsePaymentOffer, sanitizeSignalValue } from './signals.js';

describe('access_policy : champs réservés refusés en V1, champ retiré robots toléré (D-91)', () => {
  it('défauts de 17 §4', () => {
    expect(parseAccessPolicy(undefined)).toEqual(DEFAULT_ACCESS_POLICY);
    expect(parseAccessPolicy({})).toMatchObject({ on_ai_signal: 'warn', intended_use: 'context', prefer_official: true, payment: { mode: 'never' } });
    expect(parseAccessPolicy({ robots: 'respect', report_id: '00000000-0000-4000-8000-000000000001', user_agent_contact: 'from_settings' })).toMatchObject({ report_id: '00000000-0000-4000-8000-000000000001' });
    expect(parseAccessPolicy({ prefer_official: false }).prefer_official).toBe(false);
  });

  it('robots : champ retiré par D-91, toléré et ignoré (politique écrite avant), jamais produit', () => {
    expect(DEFAULT_ACCESS_POLICY).not.toHaveProperty('robots');
    for (const robots of ['respect', 'ignore', false, null]) {
      expect(parseAccessPolicy({ robots, prefer_official: false }), String(robots)).toEqual({ ...DEFAULT_ACCESS_POLICY, prefer_official: false });
    }
    expect(() => parseAccessPolicy({ ignore_robots: true })).toThrow(/champ inconnu/);
  });

  it('valeurs réservées V2 refusées : enforce, train, paiement', () => {
    expect(() => parseAccessPolicy({ on_ai_signal: 'enforce' })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ intended_use: 'train' })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ payment: { mode: 'ask' } })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ payment: { mode: 'auto_under_cap' } })).toThrow(AccessPolicyError);
    expect(() => parseAccessPolicy({ user_agent_contact: 'me@zz-test.example' })).toThrow(AccessPolicyError);
  });
});

describe('identité du robot : User-Agent réel du moteur, identification de l’instance en option', () => {
  const LINUX = { version: '153.0.8010.12', platform: 'linux' };

  it('par défaut : la chaîne standard de Chromium (version majeure, plateforme réelle), sans HeadlessChrome ni jeton', () => {
    expect(buildUserAgent({ engine: LINUX })).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    expect(buildUserAgent({ engine: { version: '153.0.8010.12', platform: 'darwin' } })).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    expect(buildUserAgent({ engine: { version: '153.0.8010.12', platform: 'win32' } })).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    // Une autre version du moteur change la chaîne (elle ne dépend que de lui) ; la même version donne toujours la même.
    expect(buildUserAgent({ engine: { version: '154.0.1.2', platform: 'linux' } })).toContain('Chrome/154.0.0.0');
    expect(buildUserAgent({ engine: LINUX })).toBe(buildUserAgent({ engine: { ...LINUX } }));
    expect(buildUserAgent({ engine: LINUX })).not.toMatch(/Headless|Scrapyomama/);
  });

  it('moteur illisible ou plateforme inconnue : refus net, jamais une chaîne inventée', () => {
    expect(() => buildUserAgent({ engine: { version: 'abc', platform: 'linux' } })).toThrow(EngineUserAgentError);
    expect(() => buildUserAgent({ engine: { version: '153.0.0.0', platform: 'plan9' } })).toThrow(EngineUserAgentError);
  });

  it('identify_instance : le jeton compatible; Scrapyomama/<version>; +<contact> suit la chaîne du moteur', () => {
    const base = buildUserAgent({ engine: LINUX });
    expect(buildUserAgent({ engine: LINUX, identify: { version: '1.0.0', contact: 'https://ops.zz-test.example/robot' } })).toBe(`${base} (compatible; Scrapyomama/1.0.0; +https://ops.zz-test.example/robot)`);
    expect(buildUserAgent({ engine: LINUX, identify: { version: '1.0.0', contact: 'ops@zz-test.example' } })).toBe(`${base} (compatible; Scrapyomama/1.0.0; +mailto:ops@zz-test.example)`);
    expect(buildUserAgent({ engine: LINUX, identify: { version: '1.0.0', contact: null } })).toBe(`${base} (compatible; Scrapyomama/1.0.0)`);
    expect(buildUserAgent({ engine: LINUX, identify: { version: 'v1\r\nX: y', contact: null } })).toBe(`${base} (compatible; Scrapyomama/0.0.0)`);
  });

  it('From (RFC 9110) : seulement une adresse électronique ; un contact URL ne tient que dans le jeton', () => {
    expect(robotFrom('ops@zz-test.example')).toBe('ops@zz-test.example');
    expect(robotFrom('mailto:ops@zz-test.example')).toBe('ops@zz-test.example');
    expect(robotFrom('https://ops.zz-test.example/robot')).toBeNull();
    expect(robotFrom(null)).toBeNull();
  });

  it('identify_instance désactivé par défaut ; réglage admin prioritaire sur IDENTIFY_INSTANCE ; valeur inconnue : désactivé', () => {
    expect(resolveIdentifyInstance(undefined, {})).toBe(false);
    expect(resolveIdentifyInstance(undefined, { IDENTIFY_INSTANCE: 'true' })).toBe(true);
    expect(resolveIdentifyInstance(undefined, { IDENTIFY_INSTANCE: 'oui' })).toBe(false);
    expect(resolveIdentifyInstance(true, {})).toBe(true);
    expect(resolveIdentifyInstance({ enabled: true }, {})).toBe(true);
    expect(resolveIdentifyInstance(false, { IDENTIFY_INSTANCE: 'true' })).toBe(false);
    expect(resolveIdentifyInstance({ enabled: false }, { IDENTIFY_INSTANCE: 'true' })).toBe(false);
    expect(resolveIdentifyInstance('n’importe quoi', {})).toBe(false);
  });

  it('replis lus dans l’environnement du worker (publiés pour la console, tâche 3.8b) : mêmes règles que resolveIdentifyInstance et resolveInstanceContact, null si absent ou illisible', () => {
    expect(identityFromEnv({})).toEqual({ identifyInstance: null, instanceContact: null });
    expect(identityFromEnv({ IDENTIFY_INSTANCE: ' TRUE ', INSTANCE_CONTACT: 'ops@zz-test.example' })).toEqual({ identifyInstance: true, instanceContact: 'mailto:ops@zz-test.example' });
    expect(identityFromEnv({ IDENTIFY_INSTANCE: 'false' }).identifyInstance).toBe(false);
    expect(identityFromEnv({ IDENTIFY_INSTANCE: 'oui', INSTANCE_CONTACT: 'ops @zz-test.example' })).toEqual({ identifyInstance: null, instanceContact: null });
    expect(identityFromEnv({ INSTANCE_CONTACT: '   ' }).instanceContact).toBeNull();
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
