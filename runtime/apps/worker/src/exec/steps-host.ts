// SPDX-License-Identifier: AGPL-3.0-only
// Hôte des stratégies `steps` (E5, tâche 2.13, 19 §4). L'interpréteur (steps-interpreter.ts) tourne dans le bac à sable
// (INV7) et demande, étape par étape, `ctx.steps.run(action, index)` ; l'hôte CONTRÔLE chaque demande contre SA copie de
// la stratégie (ordre des étapes, opération, cible, entrée du run : jamais une valeur venue de l'isolat) et l'exécute
// sur la page du run avec les gardes du pont `ctx.page` (verrou de domaines, garde de classification avant et après,
// navigation attendue, écriture refusée sans `allow_write_actions`).
// - Cible : rôle ARIA + nom accessible EXACT (`getByRole`), ou texte exact ; 0 élément → `target_not_found`, plusieurs →
//   `target_ambiguous` (identité de l'élément, porte V2) : jamais « le premier ».
// - `type` et `select` : la valeur est l'ENTRÉE DU RUN nommée par la stratégie, lue ici ; jamais un texte de l'isolat.
// - `post` de chaque étape (source, immuable) évaluée par l'hôte à la fin de l'étape, sans LLM ; un clic sans effet
//   (même URL, même contenu) est un faux succès (`no_effect`).
// - Effet observé : une requête de méthode autre que GET/HEAD/OPTIONS ou une soumission pendant une étape dont
//   `side_effect` n'est pas `write` → l'étape échoue (`write_step_broken`, 19 §4 : « l'effet observé change »).
// - Agent d'étape (niveaux 2 et 3) : après un arrêt AVANT l'étape cassée (`stopBefore`), l'hôte expose une vue
//   (`StepAgentPage`) dont chaque action passe par les mêmes contrôles ; la page n'est jamais donnée au modèle.
import { createHash } from 'node:crypto';
import type { ExecFailure } from '@runtime/core/exec';
import { extractByLabels, type StepDef, type StepFailure, type StepPost, type StepSource, type StepsSpec, type StepTarget } from '@runtime/core';
import type { StepAgentObservation, StepAgentPage } from '@runtime/agent';
import type { Locator, Page } from 'playwright-core';
import { readPageView } from '@runtime/agent';
import { SandboxBridgeError } from '../sandbox/bridges.js';

/** Outils du pont `ctx.page` réutilisés par les étapes (mêmes gardes). */
export type StepPageTools = {
  readonly page: Page;
  /** Navigation demandée par la stratégie (`ctx.page.goto` : domaine de l'API, garde SSRF, navigation attendue). */
  goto(url: string): Promise<void>;
  /** Clic de l'hôte : contrôle d'envoi refusé sans `allow_write_actions`, navigation du dispatch attendue. */
  click(locator: Locator): Promise<void>;
  readonly timeoutMs: number;
};

export type StepsTrialInfo = {
  /** Première étape en échec (classe `extraction` ou `code_error`), `null` sinon. */
  readonly failure: StepFailure | null;
  /** Étape dont l'effet observé est une écriture alors que son `side_effect` ne l'est pas. */
  readonly observedWriteAt: number | null;
  /** Interprète arrêté avant cette étape (agent d'étape). */
  readonly paused: number | null;
  /** Étapes passées (post comprise). */
  readonly passed: number;
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_ELEMENTS = 300;
const MAX_TEXT = 20_000;
const MAX_INPUT = 2_000;
const NAVIGATION_SETTLE_MS = 1_500;

const stepFailed = (failure_class: 'extraction' | 'code_error', detail: string): ExecFailure => ({ failure_class, retryable: false, detail });

/** Éléments sémantiques et texte visibles, BORNÉS dans la page (primitives seulement) : vue de l'agent et empreinte. */
async function observePage(page: Page): Promise<StepAgentObservation> {
  const raw = await page
    .evaluate(
      (a: { maxElements: number; maxText: number }) => {
        try {
          type El = { tagName: string; getAttribute(n: string): string | null; innerText?: string; textContent: string | null; type?: string; labels?: ArrayLike<{ innerText?: string }> | null; checkVisibility?: () => boolean };
          const g = globalThis as unknown as { document: { body: { innerText: string } | null; querySelectorAll(s: string): ArrayLike<El>; getElementById(id: string): El | null } };
          const d = g.document;
          const out: { role: string; name: string }[] = [];
          const implicit = (el: El): string | null => {
            const explicit = el.getAttribute('role');
            if (explicit !== null && explicit !== '') return explicit.split(' ')[0] ?? null;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a' && el.getAttribute('href') !== null) return 'link';
            if (tag === 'button') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (/^h[1-6]$/.test(tag)) return 'heading';
            if (tag === 'input') {
              const t = (el.getAttribute('type') ?? 'text').toLowerCase();
              if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
              if (t === 'search') return 'searchbox';
              if (t === 'checkbox') return 'checkbox';
              if (t === 'radio') return 'radio';
              if (t === 'text' || t === 'email' || t === 'url' || t === 'tel' || t === '') return 'textbox';
            }
            return null;
          };
          const nameOf = (el: El): string => {
            const label = el.getAttribute('aria-label');
            if (label !== null && label.trim() !== '') return label;
            const by = el.getAttribute('aria-labelledby');
            if (by !== null) {
              const ref = d.getElementById(by.split(' ')[0] ?? '');
              if (ref !== null) return ref.textContent ?? '';
            }
            const labels = el.labels;
            if (labels !== null && labels !== undefined && labels.length > 0) return labels[0]?.innerText ?? '';
            const tag = el.tagName.toLowerCase();
            if (tag === 'input') return el.getAttribute('value') ?? el.getAttribute('placeholder') ?? '';
            return el.innerText ?? el.textContent ?? '';
          };
          const nodes = d.querySelectorAll('a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role]');
          for (let i = 0; i < nodes.length && out.length < a.maxElements; i++) {
            const el = nodes[i]!;
            if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
            const role = implicit(el);
            if (role === null) continue;
            const name = nameOf(el).replace(/\s+/g, ' ').trim().slice(0, 300);
            out.push({ role, name });
          }
          const text = d.body === null ? '' : String(d.body.innerText).slice(0, a.maxText);
          return { elements: out, text };
        } catch {
          return { elements: [], text: '' };
        }
      },
      { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT },
    )
    .catch(() => ({ elements: [] as { role: string; name: string }[], text: '' }));
  const elements = Array.isArray(raw.elements) ? raw.elements.filter((e) => typeof e?.role === 'string' && typeof e?.name === 'string').slice(0, MAX_ELEMENTS) : [];
  return { url: page.url(), elements, text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '' };
}

const digestOf = (o: StepAgentObservation): string => createHash('sha256').update(JSON.stringify([o.url, o.text, o.elements])).digest('hex');

function locatorOf(page: Page, target: { role: string; name: string } | { text: string }): Locator {
  return 'text' in target ? page.getByText(target.text, { exact: true }) : page.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name, exact: true });
}

export class StepsHost {
  readonly #spec: StepsSpec;
  readonly #post: ReadonlyMap<string, readonly StepPost[]>;
  readonly #inputs: Readonly<Record<string, unknown>>;
  readonly #stopBefore: number | null;
  #expected = 0;
  #active: number | null = null;
  #before: { url: string; digest: string } | null = null;
  #writes = 0;
  #failure: StepFailure | null = null;
  #observedWriteAt: number | null = null;
  #paused: number | null = null;
  #passed = 0;

  constructor(options: { spec: StepsSpec; source: readonly StepSource[]; runInput: unknown; stopBefore?: number | null }) {
    this.#spec = options.spec;
    this.#post = new Map(options.source.map((s) => [s.id, s.post]));
    this.#inputs = typeof options.runInput === 'object' && options.runInput !== null && !Array.isArray(options.runInput) ? (options.runInput as Record<string, unknown>) : {};
    this.#stopBefore = options.stopBefore ?? null;
  }

  get info(): StepsTrialInfo {
    return { failure: this.#failure, observedWriteAt: this.#observedWriteAt, paused: this.#paused, passed: this.#passed };
  }

  /** Entrée de l'isolat : plan d'étapes (opérations seulement) et arrêt éventuel avant une étape. */
  interpreterInput(): unknown {
    return { steps: this.#spec.steps.map((s) => ({ op: s.op })), stop_before: this.#stopBefore };
  }

  /** Requête vue par le contexte du run (hôte) : une écriture pendant une étape qui n'en attend pas est notée. */
  noteRequest(method: string): void {
    if (this.#active !== null && !READ_METHODS.has(method.toUpperCase())) this.#writes += 1;
  }
  /** Soumission coupée sans `allow_write_actions` pendant l'étape active. */
  noteBlockedWrite(): void {
    if (this.#active !== null) this.#writes += 1;
    this.#flagWrite();
  }

  #flagWrite(): void {
    const i = this.#active;
    if (i === null || this.#writes === 0) return;
    if (this.#spec.steps[i]?.side_effect === 'write') return;
    if (this.#observedWriteAt === null) this.#observedWriteAt = i;
  }

  #fail(index: number, failure: ExecFailure): never {
    if (this.#failure === null) this.#failure = { index, failure };
    throw new SandboxBridgeError('step_failed', false, failure.detail);
  }

  /** L'opération demandée navigue-t-elle (guet de l'hôte) ? */
  navigates(args: Record<string, unknown>): 'goto' | 'click' | null {
    const step = typeof args['index'] === 'number' ? this.#spec.steps[args['index']] : undefined;
    if (step === undefined || args['action'] !== step.op) return null;
    return step.op === 'goto' ? 'goto' : step.op === 'click' ? 'click' : null;
  }

  /** Demande de l'isolat : `{ action, index }`, contrôlée contre la stratégie de l'hôte. */
  async handle(args: Record<string, unknown>, tools: StepPageTools): Promise<unknown> {
    const action = args['action'];
    const index = args['index'];
    if (typeof action !== 'string' || typeof index !== 'number' || !Number.isInteger(index)) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : demande');
    const step = this.#spec.steps[index];
    if (step === undefined) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : étape');
    if (action === 'pause') {
      if (index !== this.#expected || index !== this.#stopBefore) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : pause');
      this.#paused = index;
      return {};
    }
    if (action === 'begin') {
      if (index !== this.#expected || this.#active !== null || index === this.#stopBefore) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : ordre');
      this.#active = index;
      this.#writes = 0;
      const obs = await observePage(tools.page);
      this.#before = { url: obs.url, digest: digestOf(obs) };
      return {};
    }
    if (this.#active !== index) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : étape inactive');
    if (action === 'end') return this.#end(step, index, tools);
    // L'action doit être l'opération de l'étape, dans la copie de l'hôte : l'isolat ne choisit rien d'autre.
    if (action !== step.op) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : opération');
    return this.#exec(step, index, tools);
  }

  async #exec(step: StepDef, index: number, tools: StepPageTools): Promise<unknown> {
    const page = tools.page;
    const timeout = this.#spec.limits.step_timeout_ms;
    const target = async (): Promise<Locator> => {
      const t = step.target as StepTarget;
      const loc = locatorOf(page, t);
      const n = await loc.count();
      if (n === 0) return this.#fail(index, stepFailed('extraction', 'target_not_found'));
      if (n > 1) return this.#fail(index, stepFailed('extraction', 'target_ambiguous'));
      return loc;
    };
    const input = (): string => {
      const name = step.value?.input ?? '';
      const v = this.#inputs[name];
      if (typeof v !== 'string' && typeof v !== 'number') return this.#fail(index, stepFailed('code_error', 'run_input_missing'));
      const s = String(v);
      return s.length > MAX_INPUT ? this.#fail(index, stepFailed('code_error', 'run_input_too_long')) : s;
    };
    switch (step.op) {
      case 'goto':
        await tools.goto(step.url!);
        return {};
      case 'click': {
        const loc = await target();
        await tools.click(loc);
        await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_MS }).catch(() => undefined);
        return {};
      }
      case 'type': {
        const value = input();
        await (await target()).fill(value, { timeout });
        return {};
      }
      case 'select': {
        const value = input();
        await (await target()).selectOption(value, { timeout });
        return {};
      }
      case 'scroll':
        await page.mouse.wheel(0, step.direction === 'up' ? -800 : 800);
        return {};
      case 'wait_for': {
        const loc = locatorOf(page, step.target as StepTarget);
        const ok = await loc
          .first()
          .waitFor({ state: 'visible', timeout })
          .then(() => true)
          .catch(() => false);
        if (!ok) return this.#fail(index, stepFailed('extraction', 'target_not_found'));
        return {};
      }
      case 'extract': {
        const view = await readPageView(page, this.#spec.limits.max_input_chars * 10);
        if (view === null) return this.#fail(index, stepFailed('extraction', 'response_too_large'));
        const out = extractByLabels(view, step.fields ?? {});
        if (!out.ok) return this.#fail(index, stepFailed('extraction', `field_${out.reason}`));
        return { record: out.record };
      }
    }
  }

  async #end(step: StepDef, index: number, tools: StepPageTools): Promise<unknown> {
    const page = tools.page;
    this.#flagWrite();
    if (this.#observedWriteAt === index) return this.#fail(index, stepFailed('code_error', 'write_step_broken'));
    const after = await observePage(page);
    const before = this.#before ?? { url: '', digest: '' };
    // `post` : conditions fermées, évaluées par l'hôte (getByRole exact pour les éléments).
    for (const p of this.#post.get(step.id) ?? []) {
      let ok: boolean;
      switch (p.kind) {
        case 'url_changed':
          ok = after.url !== before.url;
          break;
        case 'url_contains':
          ok = after.url.includes(p.value);
          break;
        case 'text_present':
          ok = after.text.includes(p.value);
          break;
        case 'element_present':
        case 'element_absent': {
          const n = await locatorOf(page, { role: p.role, name: p.name }).count().catch(() => 0);
          ok = p.kind === 'element_present' ? n > 0 : n === 0;
          break;
        }
      }
      if (!ok) return this.#fail(index, stepFailed('extraction', 'post_failed'));
    }
    // Faux succès sans LLM : un clic ou une sélection qui ne change rien.
    if ((step.op === 'click' || step.op === 'select') && after.url === before.url && digestOf(after) === before.digest) {
      return this.#fail(index, stepFailed('extraction', 'no_effect'));
    }
    this.#active = null;
    this.#before = null;
    this.#expected = index + 1;
    this.#passed += 1;
    return {};
  }

  /** Vue de l'agent d'étape sur la page arrêtée avant l'étape cassée : actions contrôlées, mêmes gardes. */
  agentPage(tools: StepPageTools, runInputs: Readonly<Record<string, string>>): StepAgentPage {
    const page = tools.page;
    const guarded = async (fn: () => Promise<void>): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await fn();
        return { ok: true };
      } catch (error) {
        if (error instanceof SandboxBridgeError && (error.violation || error.code === 'access_refused')) throw error;
        return { ok: false, error: error instanceof SandboxBridgeError ? error.code : 'action_failed' };
      }
    };
    const single = async (t: { role: string; name: string }): Promise<Locator> => {
      const loc = locatorOf(page, t);
      const n = await loc.count();
      if (n !== 1) throw new SandboxBridgeError('page_failed', false, n === 0 ? 'target_not_found' : 'target_ambiguous');
      return loc;
    };
    return {
      observe: () => observePage(page),
      click: (t) => guarded(async () => tools.click(await single(t))),
      // La valeur saisie est une entrée du run (contrôlée par l'agent d'étape) ; le champ ne doit pas être dans un formulaire.
      type: (t, text) =>
        guarded(async () => {
          if (!Object.values(runInputs).includes(text)) throw new SandboxBridgeError('page_failed', false, 'agent_request_blocked');
          const loc = await single(t);
          const inForm = await loc.evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest('form') !== null).catch(() => true);
          if (inForm) throw new SandboxBridgeError('page_failed', false, 'type_in_form');
          await loc.fill(text, { timeout: this.#spec.limits.step_timeout_ms });
        }),
      scroll: (direction) => guarded(async () => page.mouse.wheel(0, direction === 'up' ? -800 : 800)),
    };
  }
}
