// SPDX-License-Identifier: AGPL-3.0-only
// Interpréteur des stratégies E5 `hybrid` (tâche 2.4 ; 04 §3.1) sur une page Playwright déjà ouverte dans un contexte
// verrouillé (proxy d'egress de l'essai + route, 08 §4 mesure 2). Étapes en liste fermée, AUCUN code généré : `goto`
// (par la navigation gardée de l'appelant), `click` par rôle ARIA et nom accessible exact (une seule cible, sinon
// échec), `scroll`, `wait`, et `agent` (étape déléguée au moteur, fournie par l'appelant). La page finale est lue
// bornée (texte rendu, titres) puis extraite par libellés (sans LLM) ou par le rôle `extract` (délégation).
import { extractByLabels, type HybridSpec, type HybridStep, type PageView } from '@runtime/core';
import type { Page } from 'playwright-core';

export type HybridFailure = { readonly failure_class: 'extraction' | 'code_error'; readonly detail: string };

export type HybridHooks = {
  /** Navigation gardée (garde SSRF, schéma) ; lève en cas de refus. */
  goto(url: string): Promise<void>;
  /** Étape déléguée à l'agent ; absente : une stratégie qui en contient échoue (`agent_unavailable`). */
  agentStep?(instruction: string): Promise<{ ok: true } | { ok: false; failure: HybridFailure }>;
  signal?: AbortSignal;
};

const NAVIGATION_SETTLE_MS = 1500;
const MAX_HEADINGS = 50;
const MAX_HEADING_CHARS = 1000;

/** Texte rendu et titres de la page, lus et bornés DANS la page (primitives seulement) ; `null` au-delà du plafond. */
export async function readPageView(page: Page, maxChars: number): Promise<PageView | null> {
  const view = await page.evaluate(
    (a: { max: number; maxHeadings: number; maxHeading: number }) => {
      try {
        const g = globalThis as unknown as { document: { body: { innerText: unknown } | null; querySelectorAll(s: string): ArrayLike<{ tagName: unknown; innerText: unknown }> } };
        const text: unknown = g.document.body === null ? '' : g.document.body.innerText;
        if (typeof text !== 'string' || text.length > a.max) return null;
        const list = g.document.querySelectorAll('h1,h2,h3,h4,h5,h6');
        const headings: { level: number; text: string }[] = [];
        for (let i = 0; i < list.length && headings.length < a.maxHeadings; i++) {
          const h = list[i];
          const tag: unknown = h?.tagName;
          const t: unknown = h?.innerText;
          if (typeof tag === 'string' && typeof t === 'string' && t.length <= a.maxHeading) headings.push({ level: Number(tag.slice(1)), text: t });
        }
        return { text, headings };
      } catch {
        return null;
      }
    },
    { max: maxChars, maxHeadings: MAX_HEADINGS, maxHeading: MAX_HEADING_CHARS },
  );
  if (view === null || typeof view.text !== 'string' || view.text.length > maxChars) return null;
  const headings = Array.isArray(view.headings)
    ? view.headings.filter((h) => Number.isInteger(h.level) && h.level >= 1 && h.level <= 6 && typeof h.text === 'string').slice(0, MAX_HEADINGS)
    : [];
  return { text: view.text, headings };
}

async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
}

async function runStep(page: Page, step: HybridStep, hooks: HybridHooks, stepTimeoutMs: number): Promise<HybridFailure | null> {
  switch (step.op) {
    case 'goto':
      await hooks.goto(step.url);
      await settle(page, stepTimeoutMs);
      return null;
    case 'click': {
      const locator = page.getByRole(step.target.role, { name: step.target.name, exact: true });
      const count = await locator.count();
      if (count === 0) return { failure_class: 'extraction', detail: 'target_not_found' };
      if (count > 1) return { failure_class: 'extraction', detail: 'target_ambiguous' };
      const navigated = page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_MS }).catch(() => null);
      await locator.click({ timeout: stepTimeoutMs });
      await navigated;
      await settle(page, stepTimeoutMs);
      return null;
    }
    case 'scroll':
      await page.mouse.wheel(0, step.direction === 'down' ? 800 : -800);
      return null;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return null;
    case 'agent': {
      if (hooks.agentStep === undefined) return { failure_class: 'code_error', detail: 'agent_unavailable' };
      const done = await hooks.agentStep(step.instruction);
      return done.ok ? null : done.failure;
    }
  }
}

/** Joue les étapes depuis `start_url` ; `null` si toutes ont abouti. */
export async function runHybridSteps(page: Page, spec: HybridSpec, hooks: HybridHooks): Promise<HybridFailure | null> {
  page.setDefaultTimeout(spec.limits.step_timeout_ms);
  await hooks.goto(spec.start_url);
  await settle(page, spec.limits.step_timeout_ms);
  for (const step of spec.steps) {
    hooks.signal?.throwIfAborted();
    const failure = await runStep(page, step, hooks, spec.limits.step_timeout_ms);
    if (failure !== null) return failure;
  }
  return null;
}

/** Extraction par libellés de la page finale (sans LLM) : un enregistrement, ou l'échec classé `extraction`. */
export async function extractLabelsFromPage(page: Page, spec: HybridSpec): Promise<{ ok: true; records: unknown[] } | { ok: false; failure: HybridFailure }> {
  if (spec.extract.mode !== 'labels') return { ok: false, failure: { failure_class: 'code_error', detail: 'extract_mode' } };
  const view = await readPageView(page, spec.limits.max_input_chars * 10);
  if (view === null) return { ok: false, failure: { failure_class: 'extraction', detail: 'response_too_large' } };
  const out = extractByLabels(view, spec.extract.fields);
  return out.ok ? { ok: true, records: [out.record] } : { ok: false, failure: { failure_class: 'extraction', detail: `field_${out.reason}` } };
}
