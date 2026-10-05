// SPDX-License-Identifier: AGPL-3.0-only
// Test de validité d'une session (B1) : lecture de la réponse, sans réseau.
import { describe, expect, test } from 'vitest';
import { judgeProbeResponse, PROBE_MAX_HOPS, probeSession, sessionProbeUrl, type ProbeResponse } from './session-probe.js';

const DOMAIN = 'zz-probe.example.test';
const res = (status: number, location: string | null = null, protection = false): ProbeResponse => ({ status, location, protection });
const start = sessionProbeUrl(DOMAIN);

describe('judgeProbeResponse', () => {
  test('401 et 403 : morte ; 2xx : vivante', () => {
    expect(judgeProbeResponse(res(401), start, DOMAIN)).toEqual({ done: true, outcome: 'dead_http_401' });
    expect(judgeProbeResponse(res(403), start, DOMAIN)).toEqual({ done: true, outcome: 'dead_http_403' });
    expect(judgeProbeResponse(res(200), start, DOMAIN)).toEqual({ done: true, outcome: 'alive' });
  });

  test('redirection vers une page de connexion : morte, que ce soit sur le domaine ou ailleurs', () => {
    expect(judgeProbeResponse(res(302, '/login?next=/'), start, DOMAIN)).toEqual({ done: true, outcome: 'dead_login_redirect' });
    expect(judgeProbeResponse(res(302, `https://www.${DOMAIN}/connexion`), start, DOMAIN)).toEqual({ done: true, outcome: 'dead_login_redirect' });
    expect(judgeProbeResponse(res(303, 'https://sso.autre.example.test/login'), start, DOMAIN)).toEqual({ done: true, outcome: 'dead_login_redirect' });
  });

  test('redirection dans le domaine hors connexion : on suit ; hors du domaine : non concluante', () => {
    const next = judgeProbeResponse(res(301, '/dashboard'), start, DOMAIN);
    expect(next).toMatchObject({ done: false });
    expect(!next.done && next.next.href).toBe(`https://${DOMAIN}/dashboard`);
    expect(judgeProbeResponse(res(302, 'https://autre.example.test/home'), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_redirect_offsite' });
    expect(judgeProbeResponse(res(302, 'ftp://x/'), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_redirect_offsite' });
    expect(judgeProbeResponse(res(302, null), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_http_302' });
  });

  test('défi de protection, 404, 429, 5xx : non concluants, jamais « morte »', () => {
    expect(judgeProbeResponse(res(403, null, true), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_protection' });
    expect(judgeProbeResponse(res(404), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_http_404' });
    expect(judgeProbeResponse(res(429), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_rate_limited' });
    expect(judgeProbeResponse(res(503), start, DOMAIN)).toEqual({ done: true, outcome: 'inconclusive_http_5xx' });
  });
});

describe('probeSession', () => {
  test('suit une redirection du domaine puis conclut ; la première cible est l’origine du domaine', async () => {
    const seen: string[] = [];
    const outcome = await probeSession({
      domain: DOMAIN,
      send: async (url) => {
        seen.push(url.href);
        return url.pathname === '/' ? res(302, '/home') : res(200);
      },
    });
    expect(outcome).toBe('alive');
    expect(seen).toEqual([`https://${DOMAIN}/`, `https://${DOMAIN}/home`]);
  });

  test('boucle de redirections : bornée', async () => {
    let n = 0;
    const outcome = await probeSession({ domain: DOMAIN, send: async () => (n++, res(302, `/p${n}`)) });
    expect(outcome).toBe('inconclusive_redirect_loop');
    expect(n).toBe(PROBE_MAX_HOPS + 1);
  });

  test('envoi non fait (cadence) ou en erreur (SSRF, réseau) : non concluant, jamais une exception', async () => {
    expect(await probeSession({ domain: DOMAIN, send: async () => null })).toBe('inconclusive_paced');
    expect(
      await probeSession({
        domain: DOMAIN,
        send: async () => {
          throw new Error('SsrfBlockedError zz_secret');
        },
      }),
    ).toBe('inconclusive_network');
  });
});
