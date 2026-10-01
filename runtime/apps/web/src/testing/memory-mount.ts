// SPDX-License-Identifier: AGPL-3.0-only
// Montage côté client d'un composant de la console dans un arbre en mémoire (renderer personnalisé de Vue), sans DOM ni
// navigateur. Contrairement au rendu serveur (`renderHtml`), les crochets `onMounted` s'exécutent : les composables
// lisent leurs listes (versions, runs, planifications) par le serveur factice `installApi`, et le HTML sérialisé montre
// l'écran chargé. À utiliser dans un fichier de test en environnement `vue-client.environment.ts`.
import { createRenderer, h, nextTick, type Component, type RendererOptions } from 'vue';
import { createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import { createAppI18n, setLocale, type Locale } from '@/i18n/index';
import { createAppRouter } from '@/router/index';

type MemoryNode = MemoryElement | MemoryText;

class MemoryText {
  parent: MemoryElement | null = null;
  readonly kind: 'text' | 'comment' | 'raw';
  text: string;
  constructor(kind: 'text' | 'comment' | 'raw', text: string) {
    this.kind = kind;
    this.text = text;
  }
}

/** Élément en mémoire : attributs, enfants, et les quelques propriétés que lisent les directives `v-model`. */
class MemoryElement {
  readonly kind = 'element';
  parent: MemoryElement | null = null;
  children: MemoryNode[] = [];
  attrs = new Map<string, string>();
  value: unknown = '';
  checked = false;
  selected = false;
  selectedIndex = -1;
  multiple = false;
  type = '';
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  /** Options d'un `<select>` (vModelSelect). */
  get options(): MemoryElement[] {
    const out: MemoryElement[] = [];
    const walk = (node: MemoryElement) => {
      for (const child of node.children) {
        if (child instanceof MemoryElement) {
          if (child.tag === 'option') out.push(child);
          else walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, '&quot;');

function serialize(node: MemoryNode): string {
  if (node instanceof MemoryText) return node.kind === 'text' ? escapeText(node.text) : node.kind === 'raw' ? node.text : `<!--${node.text}-->`;
  const attrs = [...node.attrs].map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`;
}

function detach(node: MemoryNode): void {
  const parent = node.parent;
  if (!parent) return;
  parent.children.splice(parent.children.indexOf(node), 1);
  node.parent = null;
}

function styleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== '')
    .map(([name, entry]) => `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${String(entry)}`)
    .join(';');
}

const options: RendererOptions<MemoryNode, MemoryElement> = {
  createElement: (tag) => new MemoryElement(tag),
  createText: (text) => new MemoryText('text', text),
  createComment: (text) => new MemoryText('comment', text),
  setText: (node, text) => {
    (node as MemoryText).text = text;
  },
  setElementText: (element, text) => {
    for (const child of [...element.children]) detach(child);
    if (text !== '') options.insert(new MemoryText('text', text), element, null);
  },
  insert: (child, parent, anchor) => {
    detach(child);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index === -1) parent.children.push(child);
    else parent.children.splice(index, 0, child);
    child.parent = parent;
  },
  remove: (child) => detach(child),
  parentNode: (node) => node.parent,
  nextSibling: (node) => {
    const parent = node.parent;
    if (!parent) return null;
    return parent.children[parent.children.indexOf(node) + 1] ?? null;
  },
  insertStaticContent: (content, parent, anchor) => {
    const raw = new MemoryText('raw', content);
    options.insert(raw, parent, anchor ?? null);
    return [raw, raw];
  },
  patchProp: (element, key, _previous, next) => {
    // Écouteurs : jamais sérialisés (comme dans le HTML d'un navigateur).
    if (/^on[A-Z]/.test(key)) return;
    if (key === 'value') {
      element.value = next;
      (element as unknown as { _value: unknown })._value = next;
    }
    if (key === 'checked' || key === 'selected' || key === 'multiple') element[key] = Boolean(next);
    if (key === 'type') element.type = String(next ?? '');
    const text = key === 'style' ? styleText(next) : next;
    if (text === null || text === undefined || text === false || (key === 'style' && text === '')) element.attrs.delete(key);
    else element.attrs.set(key, text === true ? '' : String(text as string | number));
  },
};

const renderer = createRenderer<MemoryNode, MemoryElement>(options);

/** Laisse passer les réponses du serveur factice et les rendus qui suivent. */
async function settle(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

export type MountedHtml = { html: () => string; unmount: () => void };

/**
 * Monte `component` côté client dans un arbre en mémoire, avec i18n chargée et le routeur de la console, attend que les
 * lectures du montage aboutissent, et renvoie le HTML de l'écran. `unmount` arrête les composables (flux, minuteries).
 */
export async function mountHtml(component: Component, props: Record<string, unknown> = {}, locale: Locale = 'fr', extra: { routes?: RouteRecordRaw[] } = {}): Promise<MountedHtml> {
  const i18n = createAppI18n();
  await setLocale(i18n.global, locale, { lang: '' } as HTMLElement);
  const router = createAppRouter(createMemoryHistory());
  for (const route of extra.routes ?? []) router.addRoute(route);
  const root = new MemoryElement('div');
  const app = renderer.createApp({ render: () => h(component, props) });
  app.use(i18n).use(router);
  app.mount(root);
  await settle();
  return { html: () => root.children.map(serialize).join(''), unmount: () => app.unmount() };
}
