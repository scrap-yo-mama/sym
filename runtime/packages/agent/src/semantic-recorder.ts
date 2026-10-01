// SPDX-License-Identifier: AGPL-3.0-only
// Enregistreur de cibles sémantiques (tâche 2.4, compilation E6 → E5) : un moteur tiers (Stagehand) clique par son
// propre client CDP, sur des sélecteurs positionnels qui ne survivent pas à un DOM instable. On consigne à la place, pour
// chaque clic RÉEL (`isTrusted` : un événement d'entrée du navigateur, jamais un `click()` de script), le rôle ARIA et le
// nom accessible de l'élément interactif visé. Ces cibles servent la compilation ; la stratégie compilée est ensuite
// rejouée sans LLM et n'est retenue que si elle reproduit la sortie validée (une cible fausse ne passe pas).
// Défense : le script et la liaison vivent dans un MONDE ISOLÉ (CDP `worldName`, `executionContextName`) : la page ne
// voit ni la fonction, ni le script, ni les prototypes qu'il utilise ; elle ne peut ni forger un événement (le contrôle
// `isTrusted` est fait avec les objets du monde isolé) ni lire ce qui est consigné. Rien n'est envoyé au LLM.
import { randomBytes } from 'node:crypto';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

export type SemanticClick = {
  readonly role: string;
  readonly name: string;
  /** Horodatage de réception côté worker (ms). */
  readonly at: number;
};

export interface SemanticRecorder {
  readonly clicks: readonly SemanticClick[];
  dispose(): void;
}

const MAX_EVENTS = 500;
const MAX_NAME = 300;

/** Script d'initialisation (chaîne figée, paramètres sérialisés en JSON). */
function initScript(binding: string): string {
  return `(() => {
  const B = ${JSON.stringify(binding)};
  const send = globalThis[B];
  if (typeof send !== 'function') return;
  const closest = Element.prototype.closest; const getAttr = Element.prototype.getAttribute; const hasAttr = Element.prototype.hasAttribute;
  const getById = Document.prototype.getElementById;
  const innerTextGet = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').get;
  const textGet = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').get;
  const tagGet = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName').get;
  const stringify = JSON.stringify; const addListener = EventTarget.prototype.addEventListener;
  const targetGet = Object.getOwnPropertyDescriptor(Event.prototype, 'target').get;
  const INTERACTIVE = 'a[href],button,[role],input[type=button],input[type=submit],input[type=reset],input[type=image],input[type=checkbox],input[type=radio],summary,option';
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, ${MAX_NAME});
  const roleOf = (el) => {
    const explicit = getAttr.call(el, 'role');
    if (explicit) return String(explicit).trim().split(/\\s+/)[0].toLowerCase();
    const tag = String(tagGet.call(el)).toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = String(getAttr.call(el, 'type') || '').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'button';
    }
    return '';
  };
  const nameOf = (el) => {
    const label = getAttr.call(el, 'aria-label');
    if (label && norm(label)) return norm(label);
    const by = getAttr.call(el, 'aria-labelledby');
    if (by) {
      const parts = String(by).split(/\\s+/).map((id) => getById.call(document, id)).filter(Boolean).map((n) => norm(textGet.call(n)));
      if (parts.join(' ').trim()) return norm(parts.join(' '));
    }
    const tag = String(tagGet.call(el)).toLowerCase();
    if (tag === 'input') return norm(getAttr.call(el, 'value') || getAttr.call(el, 'title') || '');
    const text = norm(innerTextGet.call(el));
    return text || norm(getAttr.call(el, 'title') || '');
  };
  addListener.call(globalThis, 'click', (event) => {
    try {
      // isTrusted : propriété « unforgeable » de l'instance, vraie pour un événement d'entrée du navigateur seulement.
      if (event.isTrusted !== true) return;
      const target = targetGet.call(event);
      if (!target || typeof target !== 'object' || !('nodeType' in target) || target.nodeType !== 1) return;
      const el = closest.call(target, INTERACTIVE);
      if (!el) { send(stringify({ role: '', name: '' })); return; }
      send(stringify({ role: roleOf(el), name: hasAttr.call(el, 'aria-hidden') ? '' : nameOf(el) }));
    } catch (e) {}
  }, true);
})();`;
}

/**
 * Pose l'enregistreur sur un contexte (pages existantes et futures). À appeler AVANT que le moteur n'ouvre ses pages :
 * le script d'initialisation ne s'applique qu'aux documents chargés ensuite.
 */
export async function installSemanticRecorder(context: BrowserContext, now: () => number = Date.now): Promise<SemanticRecorder> {
  const binding = `__zz_rec_${randomBytes(8).toString('hex')}`;
  const world = `zz_rec_${randomBytes(8).toString('hex')}`;
  const source = initScript(binding);
  const clicks: SemanticClick[] = [];
  const sessions: CDPSession[] = [];
  let disposed = false;
  const onBinding = (event: { name: string; payload: string }) => {
    if (disposed || event.name !== binding || clicks.length >= MAX_EVENTS || typeof event.payload !== 'string' || event.payload.length > 2000) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload);
    } catch {
      return;
    }
    const m = parsed as { role?: unknown; name?: unknown };
    if (typeof m.role !== 'string' || typeof m.name !== 'string') return;
    clicks.push({ role: m.role.slice(0, 40), name: m.name.slice(0, MAX_NAME), at: now() });
  };
  const attach = async (page: Page) => {
    const cdp = await context.newCDPSession(page);
    sessions.push(cdp);
    cdp.on('Runtime.bindingCalled', onBinding);
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: binding, executionContextName: world });
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: world, runImmediately: true });
  };
  for (const page of context.pages()) await attach(page);
  const onPage = (page: Page) => void attach(page).catch(() => undefined);
  context.on('page', onPage);
  return {
    clicks,
    dispose: () => {
      disposed = true;
      context.off('page', onPage);
      for (const s of sessions) void s.detach().catch(() => undefined);
    },
  };
}
