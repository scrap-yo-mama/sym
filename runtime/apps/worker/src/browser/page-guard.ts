// SPDX-License-Identifier: AGPL-3.0-only
// Garde des documents d'un run (revue de 1.11, INV11) : script injecté par `context.addInitScript` dans CHAQUE document du
// contexte (cadre principal, cadres, cadres hors processus, about:blank, srcdoc, data:), avant tout code du site ou du
// script. Il ferme deux voies que ni `context.route`, ni l'interception CDP Fetch, ni le proxy d'egress ne voient.
//
// 1. Workers blob: et data:. Un WebSocket ouvert depuis un worker échappe à `routeWebSocket` ; le contrôle CDP pose sur le
//    script de tout worker http(s) une CSP sans ws: ni wss: (request-guard.ts), dont héritent ses workers blob:. Un worker
//    blob: ou data: créé par un document hériterait de la CSP du document, qui permet les WebSocket (contrôlés par
//    `routeWebSocket` dans la page) : il est refusé (`SecurityError`), comme le ferait une CSP `worker-src http: https:`
//    (Chromium n'applique pas une CSP ajoutée à la réponse d'un document par CDP). Les workers http(s) restent permis.
// 2. Règles de spéculation (speculation rules). Le préchargement (prefetch) qu'elles déclenchent part du navigateur
//    lui-même : ni `context.route`, ni l'interception CDP Fetch (de la page ou du navigateur), ni `Network.setBlockedURLs`,
//    ni l'émulation réseau ne le voient, et Chromium 153 (headless shell) n'a ni commutateur, ni politique, ni réglage
//    `PreloadingConfig` qui le coupe sous DevTools (constaté). Le prérendu et le préchargement qui le précède sont coupés au
//    lancement (launch.ts) ; les règles chargées par l'en-tête `Speculation-Rules` sont coupées (request-guard.ts).
//    Chromium n'applique les règles que dans le cadre principal. Chaque `<script type=speculationrules>` est retiré dès son
//    insertion par un MutationObserver (racines fantômes ouvertes et racines créées par `attachShadow`, même fermées,
//    comprises), avant que Chromium ne transmette ses candidats (dans une microtâche mise en file APRÈS celle de
//    l'observateur). `document.write`, `setHTMLUnsafe` et `parseHTMLUnsafe` refusent `shadowrootmode` (racine fantôme
//    déclarative, invisible de l'observateur si elle est fermée).
//    Hors de portée (risque résiduel, journal D-33) : une racine fantôme déclarative FERMÉE dans un HTML que le parseur lit
//    pour le cadre principal (HTML servi par le site, document blob: ou javascript: vers lequel un script navigue, nœud
//    d'un autre document adopté avec sa racine) ; seule une interception TLS au proxy d'egress couvrirait ce cas.
//
// 3. Service workers (revue de fix-inv11-agent) : `ServiceWorkerContainer.prototype.register` et celui de l'instance sont
//    figés sur un refus (`SecurityError`) ; la coupure qui fait foi est celle du CDP au niveau du navigateur
//    (`blockBackgroundWorkers`, request-guard.ts), qui coupe aussi le script principal d'un service worker.
// Un SharedWorker blob: ou data: est refusé comme un worker dédié (point 1) : ses WebSocket échapperaient à tout contrôle.
//
// Les fonctions natives sont capturées avant tout code de la page, et la garde n'emprunte aucun mécanisme remplaçable par
// la page (itérateurs de tableau, accesseurs des prototypes, setters d'Object.prototype). Aucun masquage (X2) : des
// capacités sont retirées, rien n'est maquillé.
import type { BrowserContext } from 'playwright-core';

/** Code de la garde (JavaScript du navigateur, écrit tel quel : aucune transformation de compilation). */
const GUARD = String.raw`function () {
  'use strict';
  const G = globalThis;
  if (typeof G.document !== 'object' || G.document === null || typeof G.Element !== 'function') return;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor;
  const create = Object.create;
  const Str = String;
  const toLower = String.prototype.toLowerCase;
  const trim = String.prototype.trim;
  const indexOf = String.prototype.indexOf;
  const slice = String.prototype.slice;
  const lower = (s) => apply(toLower, s, []);
  const cut = (s, from) => apply(slice, s, [from]);
  const getter = (proto, name) => describe(proto, name).get;
  /** Objet sans prototype : ni setter ni getter hérité qu'aurait posé la page. */
  const record = (entries) => {
    const out = create(null);
    for (let i = 0; i < entries.length; i += 2) out[entries[i]] = entries[i + 1];
    return out;
  };
  const NativeDOMException = G.DOMException;
  const refuse = () => {
    throw new NativeDOMException('scrapyomama: shadowrootmode refusé (robots.txt)', 'NotSupportedError');
  };
  const mentionsShadowRoot = (text) => apply(indexOf, lower(text), ['shadowrootmode']) !== -1;

  // 1. Workers (dédiés et SharedWorker) blob: et data: refusés ; l'URL est résolue une seule fois et passée par valeur
  //    (aucune double lecture).
  const NativeURL = G.URL;
  const href = getter(NativeURL.prototype, 'href');
  const protocol = getter(NativeURL.prototype, 'protocol');
  const baseURI = getter(G.Node.prototype, 'baseURI');
  const doc0 = G.document;
  const guardWorker = (name) => {
    const NativeWorker = G[name];
    if (typeof NativeWorker !== 'function') return;
    const Wrapped = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const resolved = construct(NativeURL, [Str(args[0]), apply(baseURI, doc0, [])]);
        const scheme = apply(protocol, resolved, []);
        if (scheme !== 'http:' && scheme !== 'https:') throw new NativeDOMException('scrapyomama: worker ' + scheme + ' refusé (robots.txt)', 'SecurityError');
        return construct(target, args.length > 1 ? [apply(href, resolved, []), args[1]] : [apply(href, resolved, [])], newTarget);
      },
    });
    define(NativeWorker.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true, enumerable: false });
    define(G, name, { value: Wrapped, writable: true, configurable: true, enumerable: false });
  };
  guardWorker('Worker');
  guardWorker('SharedWorker');

  // 2. Règles de spéculation.

  const doc = G.document;
  const getAttribute = G.Element.prototype.getAttribute;
  const remove = G.Element.prototype.remove;
  const localName = getter(G.Element.prototype, 'localName');
  const shadowRoot = getter(G.Element.prototype, 'shadowRoot');
  const nodeType = getter(G.Node.prototype, 'nodeType');
  const parentNode = getter(G.Node.prototype, 'parentNode');
  const elementQuery = G.Element.prototype.querySelectorAll;
  const fragmentQuery = G.DocumentFragment.prototype.querySelectorAll;
  const documentQuery = G.Document.prototype.querySelectorAll;
  const listLength = getter(G.NodeList.prototype, 'length');
  const listItem = G.NodeList.prototype.item;
  const recordType = getter(G.MutationRecord.prototype, 'type');
  const recordTarget = getter(G.MutationRecord.prototype, 'target');
  const recordAdded = getter(G.MutationRecord.prototype, 'addedNodes');
  const NativeMutationObserver = G.MutationObserver;
  const observe = NativeMutationObserver.prototype.observe;
  const attachShadow = G.Element.prototype.attachShadow;
  const NativeWeakSet = G.WeakSet;
  const weakHas = NativeWeakSet.prototype.has;
  const weakAdd = NativeWeakSet.prototype.add;
  const ELEMENT = 1;
  const DOCUMENT = 9;
  const FRAGMENT = 11;
  const typeOf = (node) => (node === null || node === undefined ? 0 : apply(nodeType, node, []));
  const isRules = (node) =>
    typeOf(node) === ELEMENT &&
    apply(localName, node, []) === 'script' &&
    lower(apply(trim, Str(apply(getAttribute, node, ['type']) ?? ''), [])) === 'speculationrules';
  const each = (list, fn) => {
    const n = apply(listLength, list, []);
    for (let i = 0; i < n; i++) fn(apply(listItem, list, [i]));
  };
  /** Liste de filtre d'attributs : objet indexé dont l'itérateur est le nôtre (celui des tableaux est remplaçable). */
  const typeOnly = record([
    Symbol.iterator,
    () => {
      let done = false;
      return record(['next', () => (done ? record(['value', undefined, 'done', true]) : ((done = true), record(['value', 'type', 'done', false])))]);
    },
  ]);
  const watched = new NativeWeakSet();
  const watch = (root) => {
    if (apply(weakHas, watched, [root])) return;
    apply(weakAdd, watched, [root]);
    apply(observe, observer, [root, record(['childList', true, 'subtree', true, 'characterData', true, 'attributes', true, 'attributeFilter', typeOnly])]);
  };
  const visitRoot = (element) => {
    const root = apply(shadowRoot, element, []);
    if (root !== null) {
      watch(root);
      sweep(root);
    }
  };
  const sweep = (node) => {
    const type = typeOf(node);
    if (isRules(node)) {
      apply(remove, node, []);
      return;
    }
    if (type === ELEMENT) visitRoot(node);
    const query = type === ELEMENT ? elementQuery : type === FRAGMENT ? fragmentQuery : type === DOCUMENT ? documentQuery : undefined;
    if (query === undefined) return;
    each(apply(query, node, ['*']), (element) => {
      if (isRules(element)) apply(remove, element, []);
      else visitRoot(element);
    });
  };
  const observer = new NativeMutationObserver((records) => {
    for (let i = 0; i < records.length; i++) {
      const entry = records[i];
      const target = apply(recordTarget, entry, []);
      const subject = apply(recordType, entry, []) === 'characterData' ? apply(parentNode, target, []) : target;
      if (isRules(subject)) {
        apply(remove, subject, []);
        continue;
      }
      each(apply(recordAdded, entry, []), sweep);
    }
  });
  // Racine fantôme créée par le code (même fermée) : observée dès sa création.
  define(G.Element.prototype, 'attachShadow', {
    value: function attachShadow_(init) {
      const root = apply(attachShadow, this, [init]);
      watch(root);
      return root;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  watch(doc);
  sweep(doc);

  // Racines fantômes déclaratives créées par le code : refusées (fermées, l'observateur ne les verrait pas).
  // document.write : refusé même coupé entre deux appels.
  let tail = '';
  const writes = ['write', 'writeln'];
  for (let m = 0; m < writes.length; m++) {
    const original = G.Document.prototype[writes[m]];
    if (typeof original !== 'function') continue;
    define(G.Document.prototype, writes[m], {
      value: function (...parts) {
        let text = '';
        for (let i = 0; i < parts.length; i++) text += Str(parts[i]);
        const seen = lower(tail + text);
        if (mentionsShadowRoot(seen)) refuse();
        tail = cut(seen, -13);
        return apply(original, this, [text]);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const unsafe = [
    [G.Element.prototype, 'setHTMLUnsafe'],
    [G.ShadowRoot && G.ShadowRoot.prototype, 'setHTMLUnsafe'],
    [G.Document, 'parseHTMLUnsafe'],
  ];
  for (let u = 0; u < unsafe.length; u++) {
    const owner = unsafe[u][0];
    const name = unsafe[u][1];
    const original = owner ? owner[name] : undefined;
    if (typeof original !== 'function') continue;
    define(owner, name, {
      value: function (html, options) {
        const text = Str(html);
        if (mentionsShadowRoot(text)) refuse();
        return apply(original, this, arguments.length > 1 ? [text, options] : [text]);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  // 3. Service workers jamais enregistrés (revue de fix-inv11-agent) : register figé (non configurable, non modifiable)
  //    sur le PROTOTYPE et sur l'instance, avant tout code de la page ; serviceWorkers: 'block' de Playwright ne
  //    remplace que celui de l'instance. Couche JS en complément de la coupure CDP au niveau du navigateur (request-guard.ts).
  const Container = G.ServiceWorkerContainer;
  if (typeof Container === 'function') {
    const NativePromise = G.Promise;
    const reject = NativePromise.reject;
    const register = function register() {
      return apply(reject, NativePromise, [new NativeDOMException('scrapyomama: service worker refusé (robots.txt)', 'SecurityError')]);
    };
    try {
      define(Container.prototype, 'register', { value: register, writable: false, configurable: false, enumerable: true });
    } catch (e) {
      // Déjà figé (script de page du Chromium agentique, posé avant) : refus déjà en place.
    }
    try {
      const container = G.navigator && G.navigator.serviceWorker;
      if (container) define(container, 'register', { value: register, writable: false, configurable: false, enumerable: false });
    } catch (e) {
      // Idem.
    }
  }
}`;

/** Script injecté dans chaque document du contexte (`context.addInitScript`). */
const PAGE_GUARD_SCRIPT = `(${GUARD})();`;

/** Pose la garde sur chaque document du contexte (à appeler AVANT la création de la page du run). */
export async function installPageGuard(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: PAGE_GUARD_SCRIPT });
}
