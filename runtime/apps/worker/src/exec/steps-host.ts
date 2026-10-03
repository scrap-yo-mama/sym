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
import { computeSideEffect, extractByLabels, isPaginationName, type StepDef, type StepFailure, type StepPost, type StepSource, type StepsSpec, type StepTarget } from '@runtime/core';
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
  /**
   * Garde de classification seule (INV6) : classements en cours terminés, document courant classé ; lève `access_refused`
   * au premier refus. Présente sur les outils de l'agent d'étape (hors d'un appel de l'isolat).
   */
  guard?(): Promise<void>;
  /** Arrêt de l'essai (annulation, refus retenu) : la boucle de l'agent d'étape s'arrête au premier refus. */
  readonly signal?: AbortSignal;
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
  /** Porte V4 : un document du run servi depuis un cache ancien (en-tête `age`, service worker). */
  readonly stale: boolean;
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Requêtes dont une écriture compte comme l'effet d'une étape (une balise de mesure est coupée sans compter). */
const EFFECT_TYPES = new Set(['document', 'xhr', 'fetch', 'eventsource', 'websocket']);
/** Au-delà (secondes), une réponse servie par un cache est périmée (porte V4, à valider). */
const STALE_AGE_SECONDS = 3600;
const MAX_ELEMENTS = 300;
const MAX_TEXT = 20_000;
const MAX_INPUT = 2_000;
const NAVIGATION_SETTLE_MS = 1_500;

const stepFailed = (failure_class: 'extraction' | 'code_error', detail: string): ExecFailure => ({ failure_class, retryable: false, detail });

/** Séparateurs de la vue rendue par la page (caractères de contrôle, jamais présents dans les valeurs copiées). */
const SEP_FIELD = '\u0001';
const SEP_ELEMENT = '\u0002';
const SEP_TEXT = '\u0003';
const MAX_ROLE = 40;
const MAX_NAME = 300;
/** Plafond de la chaîne rendue par la page : éléments, séparateurs et texte (borne tenue dans la page, revérifiée ici). */
const MAX_VIEW = MAX_ELEMENTS * (MAX_ROLE + MAX_NAME + 2) + MAX_TEXT + 1;
/** Nœuds parcourus au plus (une liste de nœuds truquée ne fait pas tourner la boucle sans fin). */
const MAX_SCAN = 20_000;

/**
 * Éléments sémantiques et texte visibles : vue de l'agent d'étape et empreinte du début et de la fin de chaque étape.
 * Bornée DANS LA PAGE sur le modèle de browser/bounded.ts (1.6) : la page peut surcharger toute méthode (`slice`,
 * `replace`, `trim`, `split`, `push`, getters du DOM) ; seuls `typeof`, la longueur et l'indexation d'une chaîne
 * primitive, les comparaisons et la concaténation par `+` ne se surchargent pas. Chaque valeur lue est copiée caractère
 * par caractère jusqu'à sa borne (espaces normalisés, caractères de contrôle écartés), les éléments sont comptés par un
 * index, et la page ne rend qu'UNE chaîne primitive dont la longueur est contrôlée avant le transfert ; au-delà, rien.
 * Côté hôte, chaque rôle, nom, le nombre d'éléments et le texte sont revérifiés avant tout usage.
 */
async function observePage(page: Page): Promise<StepAgentObservation> {
  const raw: unknown = await page
    .evaluate(
      (a: { maxElements: number; maxRole: number; maxName: number; maxText: number; maxView: number; maxScan: number; fs: string; es: string; ts: string }) => {
        try {
          type El = { tagName: unknown; getAttribute(n: string): unknown; innerText?: unknown; textContent: unknown; labels?: unknown; checkVisibility?: unknown };
          const g = globalThis as unknown as { document: { body: { innerText: unknown } | null; querySelectorAll(s: string): { length: unknown; [i: number]: El | undefined }; getElementById(id: string): El | null } };
          const d = g.document;
          const isBlank = (c: string): boolean => c <= ' ' || c === ' ' || c === ' ' || c === ' ';
          /** Copie bornée d'une chaîne primitive : blancs réduits à une espace, bords nettoyés ; `null` si ce n'est pas une chaîne. */
          const clean = (v: unknown, max: number): string | null => {
            if (typeof v !== 'string') return null;
            const scan = v.length < max * 8 + 64 ? v.length : max * 8 + 64;
            let s = '';
            let blank = false;
            for (let i = 0; i < scan; i++) {
              const c = v[i] as string;
              if (isBlank(c)) {
                blank = s.length > 0;
                continue;
              }
              if (blank) {
                if (s.length + 1 >= max) break;
                s += ' ';
                blank = false;
              }
              if (s.length >= max) break;
              s += c;
            }
            return s;
          };
          /** Premier mot d'une valeur nettoyée (rôle explicite, identifiant de `aria-labelledby`). */
          const firstWord = (v: string | null): string => {
            if (v === null) return '';
            let s = '';
            for (let i = 0; i < v.length; i++) {
              const c = v[i] as string;
              if (c === ' ') break;
              s += c;
            }
            return s;
          };
          const LOWER: Record<string, string> = { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e', F: 'f', G: 'g', H: 'h', I: 'i', J: 'j', K: 'k', L: 'l', M: 'm', N: 'n', O: 'o', P: 'p', Q: 'q', R: 'r', S: 's', T: 't', U: 'u', V: 'v', W: 'w', X: 'x', Y: 'y', Z: 'z' };
          const lower = (v: string | null): string => {
            if (v === null) return '';
            let s = '';
            for (let i = 0; i < v.length; i++) {
              const c = v[i] as string;
              const l = c >= 'A' && c <= 'Z' ? LOWER[c] : c;
              s += typeof l === 'string' && l.length === 1 ? l : c;
            }
            return s;
          };
          const attr = (el: El, n: string, max: number): string | null => {
            const v: unknown = el.getAttribute(n);
            return clean(v, max);
          };
          const role = (el: El): string | null => {
            const explicit = firstWord(attr(el, 'role', a.maxRole));
            if (explicit !== '') return explicit;
            const tag = lower(clean(el.tagName, 16));
            if (tag === 'a' && el.getAttribute('href') !== null) return 'link';
            if (tag === 'button') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
            if (tag === 'input') {
              const raw = attr(el, 'type', 16);
              const t = raw === null ? 'text' : lower(raw);
              if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
              if (t === 'search') return 'searchbox';
              if (t === 'checkbox') return 'checkbox';
              if (t === 'radio') return 'radio';
              if (t === 'text' || t === 'email' || t === 'url' || t === 'tel' || t === '') return 'textbox';
            }
            return null;
          };
          const nameOf = (el: El, tag: string): string => {
            const label = attr(el, 'aria-label', a.maxName);
            if (label !== null && label !== '') return label;
            const by = firstWord(attr(el, 'aria-labelledby', 200));
            if (by !== '') {
              const ref = d.getElementById(by);
              if (ref !== null && ref !== undefined) return clean(ref.textContent, a.maxName) ?? '';
            }
            const labels = el.labels as { length?: unknown; [i: number]: { innerText?: unknown } | undefined } | null | undefined;
            if (labels !== null && labels !== undefined && typeof labels.length === 'number' && labels.length > 0) return clean(labels[0]?.innerText, a.maxName) ?? '';
            if (tag === 'input') return attr(el, 'value', a.maxName) ?? attr(el, 'placeholder', a.maxName) ?? '';
            return clean(el.innerText, a.maxName) ?? clean(el.textContent, a.maxName) ?? '';
          };
          const nodes = d.querySelectorAll('a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role]');
          const total = typeof nodes.length === 'number' ? nodes.length : 0;
          let out = '';
          let count = 0;
          for (let i = 0; i < total && i < a.maxScan && count < a.maxElements; i++) {
            const el = nodes[i];
            if (el === undefined || el === null) continue;
            if (typeof el.checkVisibility === 'function' && (el.checkVisibility as () => unknown)() === false) continue;
            const r = role(el);
            if (r === null || r === '' || r.length > a.maxRole) continue;
            const n = nameOf(el, lower(clean(el.tagName, 16)));
            if (typeof n !== 'string' || n.length > a.maxName) continue;
            const piece = (count === 0 ? '' : a.es) + r + a.fs + n;
            if (out.length + piece.length > a.maxView) return null;
            out += piece;
            count += 1;
          }
          // Texte : copie des premiers caractères (retours à la ligne gardés), séparateurs et contrôles écartés.
          let text = '';
          const body = d.body;
          const inner: unknown = body === null ? '' : body.innerText;
          if (typeof inner === 'string') {
            for (let i = 0; i < inner.length && i < a.maxText * 4 && text.length < a.maxText; i++) {
              const c = inner[i] as string;
              if (c < ' ' && c !== '\n' && c !== '\t') continue;
              text += c;
            }
          }
          const view = out + a.ts + text;
          return typeof view === 'string' && view.length <= a.maxView ? view : null;
        } catch {
          return null;
        }
      },
      { maxElements: MAX_ELEMENTS, maxRole: MAX_ROLE, maxName: MAX_NAME, maxText: MAX_TEXT, maxView: MAX_VIEW, maxScan: MAX_SCAN, fs: SEP_FIELD, es: SEP_ELEMENT, ts: SEP_TEXT },
    )
    .catch(() => null);
  const empty: StepAgentObservation = { url: page.url(), elements: [], text: '' };
  if (typeof raw !== 'string' || raw.length > MAX_VIEW) return empty;
  const cut = raw.indexOf(SEP_TEXT);
  if (cut < 0) return empty;
  const text = raw.slice(cut + 1);
  if (text.length > MAX_TEXT) return empty;
  const list = cut === 0 ? [] : raw.slice(0, cut).split(SEP_ELEMENT);
  if (list.length > MAX_ELEMENTS) return empty;
  const elements: { role: string; name: string }[] = [];
  for (const entry of list) {
    const at = entry.indexOf(SEP_FIELD);
    const role = at < 0 ? '' : entry.slice(0, at);
    const name = at < 0 ? '' : entry.slice(at + 1);
    if (role === '' || role.length > MAX_ROLE || name.length > MAX_NAME || name.includes(SEP_FIELD)) return empty;
    elements.push({ role, name });
  }
  return { url: page.url(), elements, text };
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
  #executed = false;
  #agentPhase = false;
  #stale = false;
  readonly #allowWrite: boolean;
  readonly #pages = new Set<string>();
  /** Enregistrements extraits par l'hôte (les seuls retenus : ce que l'isolat émet n'est pas lu). */
  readonly records: Record<string, unknown>[] = [];

  constructor(options: { spec: StepsSpec; source: readonly StepSource[]; runInput: unknown; stopBefore?: number | null; allowWriteActions?: boolean }) {
    this.#allowWrite = options.allowWriteActions === true;
    this.#spec = options.spec;
    this.#post = new Map(options.source.map((s) => [s.id, s.post]));
    this.#inputs = typeof options.runInput === 'object' && options.runInput !== null && !Array.isArray(options.runInput) ? (options.runInput as Record<string, unknown>) : {};
    this.#stopBefore = options.stopBefore ?? null;
  }

  get info(): StepsTrialInfo {
    return { failure: this.#failure, observedWriteAt: this.#observedWriteAt, paused: this.#paused, passed: this.#passed, stale: this.#stale };
  }

  /** Entrée de l'isolat : plan d'étapes (opérations seulement) et arrêt éventuel avant une étape. */
  interpreterInput(): unknown {
    return { steps: this.#spec.steps.map((s) => ({ op: s.op })), stop_before: this.#stopBefore };
  }

  /**
   * Requête vue par le contexte du run, AVANT son départ : `true` = coupée. Toute requête hors GET/HEAD/OPTIONS est
   * coupée, sauf pendant une étape `write` d'une API qui autorise l'écriture ; pendant une étape (ou la phase de
   * l'agent), une écriture de document ou de données est notée comme l'effet observé de l'étape.
   */
  blockWrite(method: string, resourceType: string): boolean {
    if (READ_METHODS.has(method.toUpperCase())) return false;
    const step = this.#active === null ? undefined : this.#spec.steps[this.#active];
    if (step !== undefined && step.side_effect === 'write' && this.#allowWrite && !this.#agentPhase) return false;
    if ((this.#active !== null || this.#agentPhase) && EFFECT_TYPES.has(resourceType)) {
      this.#writes += 1;
      this.#flagWrite();
    }
    return true;
  }
  /** Document du cadre principal reçu : servi depuis un cache ancien ou un service worker → porte V4 en échec. */
  noteDocument(headers: Record<string, string>, fromServiceWorker: boolean): void {
    const age = Number(headers['age'] ?? '0');
    if (fromServiceWorker || (Number.isFinite(age) && age > STALE_AGE_SECONDS)) this.#stale = true;
  }
  /** Soumission coupée sans `allow_write_actions` pendant l'étape active. */
  noteBlockedWrite(): void {
    if (this.#active !== null) this.#writes += 1;
    this.#flagWrite();
  }

  #flagWrite(): void {
    const i = this.#active ?? (this.#agentPhase ? this.#paused : null);
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
      this.#executed = false;
      const obs = await observePage(tools.page);
      this.#before = { url: obs.url, digest: digestOf(obs) };
      return {};
    }
    if (this.#active !== index) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : étape inactive');
    if (action === 'end') {
      if (!this.#executed) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : étape sautée');
      return this.#end(step, index, tools);
    }
    // L'action doit être l'opération de l'étape, dans la copie de l'hôte : l'isolat ne choisit rien d'autre.
    if (action !== step.op) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : opération');
    // Une seule exécution par étape : l'isolat ne rejoue ni ne saute une action.
    if (this.#executed) throw new SandboxBridgeError('invalid_bridge_call', true, 'steps : exécution répétée');
    this.#executed = true;
    // Étape d'écriture sur une API qui ne l'autorise pas (08 §4 mesure 4) : refusée avant toute action.
    if (step.side_effect === 'write' && !this.#allowWrite) return this.#fail(index, stepFailed('code_error', 'write_action_blocked'));
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
    /** `type` et `select` : un champ dans un formulaire est une écriture possible (19 §4), sauf étape `write`. */
    const outOfForm = async (loc: Locator): Promise<Locator> => {
      const inForm = await loc.evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest('form') !== null).catch(() => true);
      if (inForm && step.side_effect !== 'write') {
        if (this.#observedWriteAt === null) this.#observedWriteAt = index;
        return this.#fail(index, stepFailed('code_error', 'write_step_broken'));
      }
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
        await (await outOfForm(await target())).fill(value, { timeout });
        return {};
      }
      case 'select': {
        const value = input();
        await (await outOfForm(await target())).selectOption(value, { timeout });
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
        this.records.push(out.record);
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
    const digest = digestOf(after);
    if ((step.op === 'click' || step.op === 'select') && after.url === before.url && digest === before.digest) {
      return this.#fail(index, stepFailed('extraction', 'no_effect'));
    }
    // Pagination qui revient sur une page déjà vue dans ce run.
    const t = step.target;
    if (step.op === 'click' && t !== undefined && 'name' in t && isPaginationName(t.name)) {
      if (this.#pages.has(digest)) return this.#fail(index, stepFailed('extraction', 'pagination_stalled'));
      this.#pages.add(before.digest);
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
    // Phase de l'agent : toute écriture est coupée et notée ; un clic dont l'effet calculé est `write` est refusé.
    this.#agentPhase = true;
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
    // Garde de classification (INV6, 19 §4 « sans jamais transmettre une page de défi ») : avant et après chaque
    // observation (le DOM part dans le prompt), après chaque action ; un refus lève `access_refused` et arrête l'agent.
    const guard = async (): Promise<void> => {
      await tools.guard?.();
    };
    return {
      observe: async () => {
        await guard();
        const obs = await observePage(page);
        await guard();
        return obs;
      },
      click: (t) =>
        guarded(async () => {
          if (computeSideEffect({ op: 'click', target: t }) === 'write') throw new SandboxBridgeError('page_failed', false, 'write_target');
          await tools.click(await single(t));
          // Comme une étape `click` : le document lancé par le clic est attendu, puis classé avant toute observation.
          await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_MS }).catch(() => undefined);
          await guard();
          if (this.#writes > 0) throw new SandboxBridgeError('page_failed', false, 'write_observed');
        }),
      // La valeur saisie est une entrée du run (contrôlée par l'agent d'étape) ; le champ ne doit pas être dans un formulaire.
      type: (t, text) =>
        guarded(async () => {
          if (!Object.values(runInputs).includes(text)) throw new SandboxBridgeError('page_failed', false, 'agent_request_blocked');
          const loc = await single(t);
          const inForm = await loc.evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest('form') !== null).catch(() => true);
          if (inForm) throw new SandboxBridgeError('page_failed', false, 'type_in_form');
          await guard();
          await loc.fill(text, { timeout: this.#spec.limits.step_timeout_ms });
          await guard();
        }),
      scroll: (direction) =>
        guarded(async () => {
          await guard();
          await page.mouse.wheel(0, direction === 'up' ? -800 : 800);
          await guard();
        }),
    };
  }
}
