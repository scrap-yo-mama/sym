// SPDX-License-Identifier: AGPL-3.0-only
// assert_session_live_status (B1) : la règle d'état d'une session, fonction pure, tous les cas.
import { describe, expect, test } from 'vitest';
import {
  checkVerdictOf,
  computeSessionState,
  SESSION_PROOF_MAX_AGE_MS,
  SESSION_RENEW_WINDOW_MS,
  SESSION_STATE_LABELS,
  SESSION_STATES,
  type SessionStateInput,
} from './site-session-state.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const H = 3600 * 1000;
const D = 24 * H;

const base: SessionStateInput = {
  serverUseAllowed: true,
  hasServerCookies: true,
  capturedAt: ago(2 * D),
  expiresAt: ahead(30 * D),
  lastCheckAt: null,
  lastCheckOutcome: null,
  lastUseOkAt: null,
  refreshPending: false,
};
const state = (over: Partial<SessionStateInput>) => computeSessionState({ ...base, ...over }, NOW);

describe('assert_session_live_status : état d’une session', () => {
  test('libellés français pour les quatre états', () => {
    expect(SESSION_STATES).toEqual(['active', 'a_renouveler', 'expiree', 'a_verifier']);
    expect(SESSION_STATE_LABELS).toEqual({ active: 'Active', a_renouveler: 'À renouveler', expiree: 'Expirée', a_verifier: 'À vérifier' });
  });

  test('mode tunnel : aucun état serveur', () => {
    expect(state({ serverUseAllowed: false, hasServerCookies: false })).toBeNull();
  });

  test('expirée : aucun cookie stocké, expires_at passé ou égal à maintenant, dernier test « morte »', () => {
    expect(state({ hasServerCookies: false, expiresAt: null, capturedAt: null })).toBe('expiree');
    expect(state({ expiresAt: ago(1000) })).toBe('expiree');
    expect(state({ expiresAt: NOW })).toBe('expiree');
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'dead_http_401' })).toBe('expiree');
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'dead_login_redirect' })).toBe('expiree');
    // « morte » l'emporte sur une demande de renouvellement et sur un rejeu réussi plus ancien
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'dead_http_403', refreshPending: true, lastUseOkAt: ago(2 * H) })).toBe('expiree');
  });

  test('un test « morte » antérieur à la dernière capture ne compte plus : la session est neuve', () => {
    expect(state({ capturedAt: ago(H), lastCheckAt: ago(2 * H), lastCheckOutcome: 'dead_http_401' })).toBe('a_verifier');
  });

  test('à renouveler : refresh_requested en attente, ou expiration sous 24 h', () => {
    expect(state({ refreshPending: true })).toBe('a_renouveler');
    expect(state({ refreshPending: true, lastCheckAt: ago(H), lastCheckOutcome: 'alive' })).toBe('a_renouveler');
    expect(state({ expiresAt: ahead(SESSION_RENEW_WINDOW_MS - 1000) })).toBe('a_renouveler');
    expect(state({ expiresAt: ahead(SESSION_RENEW_WINDOW_MS + 1000), lastCheckAt: ago(H), lastCheckOutcome: 'alive' })).toBe('active');
  });

  test('active : preuve de vie récente (test vivant ou rejeu réussi) postérieure à la capture', () => {
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'alive' })).toBe('active');
    expect(state({ lastUseOkAt: ago(H) })).toBe('active');
    expect(state({ expiresAt: null, lastCheckAt: ago(H), lastCheckOutcome: 'alive' })).toBe('active');
  });

  test('à vérifier : jamais testée, test trop ancien, non concluant, ou preuve antérieure à la capture', () => {
    expect(state({})).toBe('a_verifier');
    expect(state({ lastCheckAt: ago(SESSION_PROOF_MAX_AGE_MS + 1000), lastCheckOutcome: 'alive' })).toBe('a_verifier');
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'inconclusive_http_5xx' })).toBe('a_verifier');
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'inconclusive_paced' })).toBe('a_verifier');
    expect(state({ lastCheckAt: ago(H), lastCheckOutcome: 'code_inconnu' })).toBe('a_verifier');
    expect(state({ capturedAt: ago(H), lastCheckAt: ago(2 * H), lastCheckOutcome: 'alive', lastUseOkAt: ago(3 * H) })).toBe('a_verifier');
    expect(state({ lastUseOkAt: ago(SESSION_PROOF_MAX_AGE_MS + 1000) })).toBe('a_verifier');
  });

  test('verdict d’un code de résultat', () => {
    expect(checkVerdictOf('alive')).toBe('alive');
    expect(checkVerdictOf('dead_http_401')).toBe('dead');
    expect(checkVerdictOf('inconclusive_network')).toBe('inconclusive');
    expect(checkVerdictOf('ok')).toBeNull();
    expect(checkVerdictOf(null)).toBeNull();
  });

  test('la fonction est pure : elle ne modifie pas son entrée et donne le même résultat à entrée égale', () => {
    const input = Object.freeze({ ...base, lastCheckAt: ago(H), lastCheckOutcome: 'alive' });
    expect(computeSessionState(input, NOW)).toBe(computeSessionState(input, NOW));
  });
});
