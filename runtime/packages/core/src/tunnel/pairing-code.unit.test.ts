// SPDX-License-Identifier: AGPL-3.0-only
// U3.1 : code d'appairage en un collage (`sym-pair:v1:<base64url({url, code})>`, 05 §7.1). Un seul texte porte l'adresse de
// l'instance et le code à usage unique ; l'extension le lit sans saisie d'URL (assert_pairing_single_paste, partie pure).
import { describe, expect, test } from 'vitest';
import { decodePairingCode, encodePairingCode, PAIRING_CODE_PREFIX } from './pairing-code.js';

const CODE = '7K3QM-X9D2P';
const URL_ = 'https://scrapyomama-runtime.onrender.com';

describe('sym-pair:v1 (assert_pairing_single_paste, partie pure)', () => {
  test('aller-retour : l’adresse et le code ressortent tels quels', () => {
    const text = encodePairingCode({ url: URL_, code: CODE });
    expect(text.startsWith(PAIRING_CODE_PREFIX)).toBe(true);
    expect(PAIRING_CODE_PREFIX).toBe('sym-pair:v1:');
    expect(decodePairingCode(text)).toEqual({ ok: true, url: URL_, code: CODE });
  });
  test('base64url sans remplissage : aucun +, / ni = (collable partout)', () => {
    const text = encodePairingCode({ url: 'https://runtime.zz-test.example:8443', code: CODE });
    expect(text.slice(PAIRING_CODE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  test('espaces, retours à la ligne et guillemets autour du collage tolérés', () => {
    const text = encodePairingCode({ url: URL_, code: CODE });
    expect(decodePairingCode(`  \n${text}\n `)).toMatchObject({ ok: true, code: CODE });
    expect(decodePairingCode(`"${text}"`)).toMatchObject({ ok: true, code: CODE });
  });
  test('l’adresse est ramenée à son origine (jamais de chemin, de requête ni d’identifiants)', () => {
    expect(encodePairingCode({ url: 'https://zz-test.example/console?x=1#y', code: CODE })).toBe(encodePairingCode({ url: 'https://zz-test.example', code: CODE }));
  });
  test('un code `XXXXX-XXXXX` seul n’est pas un code en un collage : format, pour que l’extension propose la saisie à la main', () => {
    expect(decodePairingCode(CODE)).toEqual({ ok: false, reason: 'format' });
    expect(decodePairingCode('')).toEqual({ ok: false, reason: 'format' });
  });
  test('version inconnue : refus nommé (mettre l’extension à jour)', () => {
    expect(decodePairingCode('sym-pair:v2:eyJ1cmwiOiJ4In0')).toEqual({ ok: false, reason: 'version' });
  });
  test('contenu illisible, champ manquant, champ en trop, code qui n’en est pas un : refusé', () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(decodePairingCode('sym-pair:v1:***')).toEqual({ ok: false, reason: 'invalid' });
    expect(decodePairingCode(`sym-pair:v1:${b64({ url: URL_ })}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(decodePairingCode(`sym-pair:v1:${b64({ url: URL_, code: CODE, extra: 1 })}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(decodePairingCode(`sym-pair:v1:${b64({ url: URL_, code: 'pas un code' })}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(decodePairingCode(`sym-pair:v1:${b64({ url: 42, code: CODE })}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(decodePairingCode(`sym-pair:v1:${b64([URL_, CODE])}`)).toEqual({ ok: false, reason: 'invalid' });
  });
  test('trop long : refusé sans décodage', () => {
    expect(decodePairingCode(`sym-pair:v1:${'A'.repeat(5000)}`)).toEqual({ ok: false, reason: 'invalid' });
  });
  test('encodage : refuse une adresse illisible', () => {
    expect(() => encodePairingCode({ url: 'pas une adresse', code: CODE })).toThrow();
  });
});
