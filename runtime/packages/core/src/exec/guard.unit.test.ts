// SPDX-License-Identifier: AGPL-3.0-only
// Garde de classification AVANT réparation (tâche 1.7, 04 §5 et §7, INV6) : la suite de chaque classe, l'agent n'est
// invoqué que pour `extraction`, `code_error` et `not_found`, jamais sur une preuve qui est une page de défi ;
// aucune page de défi n'entre dans un prompt. Disjoncteur : un refus compte comme un 429 (04 §7).
import { describe, expect, it, vi } from 'vitest';
import { FAILURE_CLASSES, type FailureClass } from '../model/enums.js';
import { networkDecision } from '../net/modes/ladder.js';
import { BLOCKING_CLASSES, INVESTIGATION_ACTION_CLASSES } from '../status/types.js';
import { DomainPacer, type PacingStore } from '../pacing/pacer.js';
import { outcomeKindOfResponse } from '../pacing/policy.js';
import {
  assertPromptSafe,
  ClassificationGuardError,
  classifyExchange,
  domainRequestPacer,
  failureRoute,
  guardAgentInvocation,
  invokeAgentGuarded,
  type ExecFailure,
  type HttpExchange,
} from './index.js';

const f = (failure_class: FailureClass, detail = 'x'): ExecFailure => ({ failure_class, retryable: false, detail });
const CHALLENGE: HttpExchange = {
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: '<html><head><title>Security check</title></head><body><p>Please verify you are human to continue.</p></body></html>',
  url: 'http://zz_test_x.localhost/',
};
const NORMAL: HttpExchange = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[]}', url: 'http://zz_test_x.localhost/api' };

describe('assert_no_circumvention : suite de chaque classe (04 §7)', () => {
  it('refus et défis : arrêt, aucun agent, aucun changement de réseau, statut bloquee', () => {
    for (const cls of ['blocked_by_protection', 'forbidden', 'robots_disallowed'] as const) {
      expect(failureRoute(cls), cls).toEqual({ next: 'stop', agent: false, network: 'stop', status: 'bloquee' });
    }
  });

  it('401, 402, limite de compte : la main revient à l’utilisateur (action_requise), aucun agent', () => {
    for (const cls of ['auth_required', 'payment_required', 'account_limit'] as const) {
      expect(failureRoute(cls), cls).toEqual({ next: 'action_required', agent: false, network: 'action_required', status: 'action_requise' });
    }
  });

  it('429 : ralentir sur la même IP ; transient : réessais sans réparation ; network : barreau suivant', () => {
    expect(failureRoute('rate_limited')).toMatchObject({ next: 'slow_down', agent: false, network: 'slow_down' });
    expect(failureRoute('transient')).toMatchObject({ next: 'retry', agent: false, network: 'same_network', status: 'warning' });
    expect(failureRoute('network')).toMatchObject({ next: 'next_network', agent: false, network: 'escalate' });
    expect(failureRoute('robots_unreachable')).toMatchObject({ next: 'abstain', agent: false, status: 'erreur' });
  });

  it('seules extraction, code_error et not_found ouvrent la réparation (agent)', () => {
    const withAgent = FAILURE_CLASSES.filter((c) => failureRoute(c).agent);
    expect(withAgent.sort()).toEqual(['code_error', 'extraction', 'not_found']);
    expect(failureRoute('llm_context_length')).toMatchObject({ next: 'retry', agent: false });
    for (const cls of ['llm_refused', 'llm_auth', 'llm_quota_exhausted'] as const) expect(failureRoute(cls).next, cls).toBe('stop');
  });

  it('cohérence avec la machine à états (BLOCKING / ACTION) et l’échelle réseau (1.4)', () => {
    for (const cls of FAILURE_CLASSES) {
      const route = failureRoute(cls);
      expect(route.network, cls).toBe(networkDecision(cls));
      expect(route.status === 'bloquee', cls).toBe((BLOCKING_CLASSES as readonly string[]).includes(cls));
      expect(route.status === 'action_requise', cls).toBe((INVESTIGATION_ACTION_CLASSES as readonly string[]).includes(cls));
      // Jamais un changement de réseau hors `network` (X4).
      if (cls !== 'network') expect(route.network, cls).not.toBe('escalate');
    }
  });
});

describe('assert_no_circumvention : agent jamais invoqué sur un refus (garde avant réparation)', () => {
  it('défi en 200 : l’agent n’est jamais appelé', async () => {
    const agent = vi.fn(async () => 'patch');
    const out = await invokeAgentGuarded(f('blocked_by_protection', 'challenge_page'), [CHALLENGE], agent);
    expect(out).toEqual({ invoked: false, failure: f('blocked_by_protection', 'challenge_page') });
    expect(agent).not.toHaveBeenCalled();
  });

  it('une extraction dont la preuve est une page de défi est reclassée blocked_by_protection, sans agent', async () => {
    const agent = vi.fn(async () => 'patch');
    const out = await invokeAgentGuarded(f('extraction', 'no_records'), [CHALLENGE], agent);
    expect(out).toMatchObject({ invoked: false, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_page' } });
    expect(agent).not.toHaveBeenCalled();
    // Preuve textuelle (journal, instantané) : même garde.
    expect(guardAgentInvocation(f('code_error'), ['heading "Security check" text "verify you are human"'])).toMatchObject({ failure_class: 'blocked_by_protection' });
  });

  it('preuve AWS WAF (202 + x-amzn-waf-action: challenge) ou défi en 400 / 405 / 404 : reclassée blocked_by_protection, agent jamais invoqué', async () => {
    const waf: HttpExchange = { status: 202, headers: { 'content-type': 'text/html', 'x-amzn-waf-action': 'challenge' }, body: '<div id="challenge-container"></div>', url: 'http://zz_test_x.localhost/' };
    for (const failure of [f('extraction', 'no_records'), f('not_found', 'http_404'), f('code_error')]) {
      const agent = vi.fn(async () => 'patch');
      expect(await invokeAgentGuarded(failure, [waf], agent)).toMatchObject({ invoked: false, failure: { failure_class: 'blocked_by_protection', detail: 'challenge_header' } });
      expect(agent).not.toHaveBeenCalled();
    }
    for (const status of [400, 404, 405]) {
      const agent = vi.fn(async () => 'patch');
      const out = await invokeAgentGuarded(f(status === 404 ? 'not_found' : 'extraction'), [{ ...CHALLENGE, status }], agent);
      expect(out, String(status)).toMatchObject({ invoked: false, failure: { failure_class: 'blocked_by_protection', status } });
      expect(agent).not.toHaveBeenCalled();
    }
  });

  it('chaque classe de refus bloque l’agent ; une extraction sur une page normale l’autorise', async () => {
    for (const cls of FAILURE_CLASSES.filter((c) => !['extraction', 'code_error', 'not_found'].includes(c))) {
      const agent = vi.fn(async () => 1);
      expect((await invokeAgentGuarded(f(cls), [NORMAL], agent)).invoked, cls).toBe(false);
      expect(agent, cls).not.toHaveBeenCalled();
    }
    const agent = vi.fn(async () => 'ok');
    expect(await invokeAgentGuarded(f('extraction', 'schema_mismatch'), [NORMAL], agent)).toEqual({ invoked: true, value: 'ok' });
    expect(agent).toHaveBeenCalledOnce();
  });

  it('2xx : signal faible (phrase dans un JSON, widget sur une page courte) → extraction gardée, agent invoqué, preuve retirée de ce qu’il reçoit', async () => {
    const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
    const weak: HttpExchange[] = [
      // API JSON (< 4000 caractères) qui cite la phrase : jamais une recherche de phrase sur du JSON en 2xx.
      { ...NORMAL, body: JSON.stringify({ items: [], faq: "Why do I see I'm not a robot on checkout?" }) },
      // Page courte avec un formulaire de contact protégé par un widget.
      { ...NORMAL, headers: { 'content-type': 'text/html' }, body: html('Contact', `<p>${'Écrivez-nous, nous répondons sous 48 heures. '.repeat(12)}</p><form><div class="g-recaptcha" data-sitekey="zz_test"></div><button>Envoyer</button></form>`) },
    ];
    for (const page of weak) {
      const agent = vi.fn(async (_failure: ExecFailure, _evidence: readonly unknown[]) => 'patch');
      expect(guardAgentInvocation(f('extraction', 'no_records'), [page]), page.body.slice(0, 60)).toBeNull();
      expect(await invokeAgentGuarded(f('extraction', 'no_records'), [page, NORMAL], agent)).toEqual({ invoked: true, value: 'patch' });
      // L'agent reçoit les autres preuves, jamais celle qui porte un signal de défi (aucune page de défi dans un prompt).
      expect(agent.mock.calls[0]?.[1]).toEqual([NORMAL]);
    }
    // Signal fort en 2xx (titre + phrase) : toujours reclassé.
    expect(guardAgentInvocation(f('extraction'), [CHALLENGE])).toMatchObject({ failure_class: 'blocked_by_protection' });
  });

  it('2xx, extraction en échec : un titre qui COMMENCE comme un interstitiel (article long) laisse la réparation ; le titre ENTIER d’un interstitiel (signal unique, page courte) la refuse (revue de 1.7)', async () => {
    const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
    const article: HttpExchange = { ...NORMAL, headers: { 'content-type': 'text/html' }, body: html('Security check: 10 tips to secure your shop', `<article>${'<p>Conseil pratique pour votre boutique.</p>'.repeat(40)}</article>`) };
    // Article au titre exact d'un interstitiel, mais page de contenu longue (> 4000 caractères visibles) : jamais un refus.
    const longArticle: HttpExchange = { ...article, body: html('Just a moment', `<article>${'<p>Récit de voyage, troisième jour, sous la pluie de Brest.</p>'.repeat(90)}</article>`) };
    for (const page of [article, longArticle]) {
      const agent = vi.fn(async (_failure: ExecFailure, _evidence: readonly unknown[]) => 'patch');
      expect(guardAgentInvocation(f('extraction', 'no_records'), [page]), page.body.slice(0, 80)).toBeNull();
      expect(await invokeAgentGuarded(f('extraction', 'no_records'), [page, NORMAL], agent)).toEqual({ invoked: true, value: 'patch' });
      // La preuve qui porte le signal est retirée de ce que l'agent reçoit.
      expect(agent.mock.calls[0]?.[1]).toEqual([NORMAL]);
    }
    // Interstitiel en 200, un seul signal (titre exact), ~450 caractères d'explication : au-dessus de la page quasi vide du
    // mode strict, donc passé avant l'extraction ; la garde de réparation le refuse.
    const explanation = '<p>As you were browsing something about your browser made us think you were a bot. There are a few reasons this might happen, such as a super-human speed of browsing or a browser extension that blocks some content.</p><p>To regain access, please make sure that cookies and JavaScript are enabled before reloading the page, then wait a few seconds before trying again.</p><p>If you keep seeing this page, contact the site owner and quote the reference below.</p><p>Reference zz_test_0001.</p>';
    const interstitials: HttpExchange[] = [
      { ...article, body: html('Pardon Our Interruption', `<h1>Pardon Our Interruption</h1>${explanation}`) },
      // Titre exact suivi d'un suffixe de marque.
      { ...article, body: html('Attention Required! | zz_test Shield', `<h1>Sorry, you have been blocked</h1>${explanation}`) },
      { ...article, body: html('Just a moment...', explanation) },
    ];
    for (const page of interstitials) {
      // Passé par la garde avant extraction (mode strict : un seul signal, page au-dessus de la page quasi vide).
      expect(classifyExchange(page), page.body.slice(0, 80)).toBeNull();
      for (const failure of [f('extraction', 'no_records'), f('code_error'), f('not_found', 'http_404')]) {
        const agent = vi.fn(async () => 'patch');
        const out = await invokeAgentGuarded(failure, [NORMAL, page], agent);
        expect(out, page.body.slice(0, 80)).toEqual({ invoked: false, failure: { failure_class: 'blocked_by_protection', retryable: false, detail: 'challenge_page', status: 200 } });
        expect(agent).not.toHaveBeenCalled();
      }
    }
  });

  it('assertPromptSafe : une page de défi n’entre dans aucun prompt', () => {
    expect(() => assertPromptSafe(CHALLENGE.body)).toThrow(ClassificationGuardError);
    try {
      assertPromptSafe(CHALLENGE.body);
    } catch (error) {
      expect((error as ClassificationGuardError).failure.failure_class).toBe('blocked_by_protection');
    }
    expect(() => assertPromptSafe(NORMAL.body)).not.toThrow();
  });
});

describe('disjoncteur par domaine : un refus compte comme un 429 (04 §7)', () => {
  it('outcomeKindOfResponse : refus (403, défi) → refused ; 401 et 404 ne sont pas des refus', () => {
    expect(outcomeKindOfResponse(200, 'blocked_by_protection')).toBe('refused');
    expect(outcomeKindOfResponse(403, 'forbidden')).toBe('refused');
    expect(outcomeKindOfResponse(403)).toBe('refused');
    expect(outcomeKindOfResponse(429, 'rate_limited')).toBe('rate_limited');
    expect(outcomeKindOfResponse(503, 'transient')).toBe('server_error');
    expect(outcomeKindOfResponse(401, 'auth_required')).toBe('ok');
    expect(outcomeKindOfResponse(404, 'not_found')).toBe('ok');
    expect(outcomeKindOfResponse(200, null)).toBe('ok');
  });

  it('domainRequestPacer rapporte la classe : un défi en 200 est un refus pour le disjoncteur', async () => {
    const kinds: string[] = [];
    const store: PacingStore = {
      reserve: async () => ({ granted: true, slot: new Date(0), dbNow: new Date(0), probe: false }),
      record: async (_domain, outcome) => {
        kinds.push(outcome.kind);
        return { circuit: 'closed', opened: false, consecutiveFailures: 0, penaltyUntil: null, adaptiveDelayMs: 0 };
      },
    };
    const pacer = domainRequestPacer(new DomainPacer(store, { clock: { now: () => new Date(0), sleep: async () => undefined } }));
    await pacer.report('http://zz_test_x.localhost/', { status: 200, retryAfter: null, failureClass: 'blocked_by_protection' });
    await pacer.report('http://zz_test_x.localhost/', { status: 200, retryAfter: null, failureClass: null });
    await pacer.report('http://zz_test_x.localhost/', { status: 403, retryAfter: null });
    expect(kinds).toEqual(['refused', 'ok', 'refused']);
  });
});
