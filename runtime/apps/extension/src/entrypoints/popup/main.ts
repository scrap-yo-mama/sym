// SPDX-License-Identifier: AGPL-3.0-only
// Popup (07 § 1-2, § 7) en Vue 3, fonctions de rendu (pas de compilateur de gabarits : CSP MV3). Appairage, identité
// « Connected as », consentement par domaine AVANT toute lecture de cookie, liste des domaines et déconnexion.
// Les permissions d'hôte sont demandées ici, au clic de l'utilisateur (`chrome.permissions.request` exige un geste).
// Aucune lecture de cookie dans ce contexte : elle n'a lieu que dans le service worker, après consentement.
import { decodePairingCode } from '@runtime/core/tunnel';
import { SYM_GHOST_PATH, SYM_GHOST_VIEWBOX } from '@runtime/ui/sym-ghost';
import { createApp, defineComponent, h, reactive, type VNode } from 'vue';
import { browser } from 'wxt/browser';
import type { SiteMode, SiteState, Status } from '../../core/controller.ts';
import { originPatterns, siteDomainOf } from '../../core/host-guard.ts';
import { checkInstanceUrl, instancePattern } from '../../core/instance.ts';
import type { Request, Response } from '../../core/messages.ts';

// Thème de la charte (packages/ui) : la classe `dark` suit le thème du système ; le popup se rend en JavaScript, donc avant son premier contenu.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const applyScheme = () => document.documentElement.classList.toggle('dark', darkQuery.matches);
applyScheme();
darkQuery.addEventListener('change', applyScheme);

/** Signature SYM en badge (20 § 2.3) : l'icône unique de packages/ui, décorative, à côté du texte « SYM ». */
function symBadge(): VNode {
  return h('span', { class: 'sym-signature', 'data-sym-signature': '', 'data-variant': 'badge' }, [
    h('svg', { class: 'sym-signature__icon', xmlns: 'http://www.w3.org/2000/svg', viewBox: SYM_GHOST_VIEWBOX, fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false' }, [
      h('path', { 'fill-rule': 'evenodd', d: SYM_GHOST_PATH }),
    ]),
    h('span', { class: 'sym-signature__text' }, 'SYM'),
  ]);
}

class PopupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function send<T>(request: Request): Promise<T> {
  const res = (await browser.runtime.sendMessage(request)) as Response<T>;
  if (!res.ok) throw new PopupError(res.code, res.message);
  return res.data;
}

/** Site visé : onglet actif http(s), sinon le dernier onglet http(s) consulté (popup ouvert dans un onglet). */
async function targetDomain(): Promise<string | null> {
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  const fromActive = siteDomainOf(active?.url);
  if (fromActive) return fromActive;
  const tabs = (await browser.tabs.query({})).filter((t) => siteDomainOf(t.url) !== null);
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return siteDomainOf(tabs[0]?.url);
}

const App = defineComponent({
  setup() {
    const state = reactive({
      loading: true,
      // État inconnu (erreur inattendue) : ni écran d'appairage ni vue appairée, juste l'erreur et « Retry ».
      failed: false,
      busy: false,
      error: '',
      // Révocation faite ici mais pas sur l'instance (injoignable) : avertissement gardé jusqu'au geste suivant.
      notice: '',
      status: { paired: false } as Status,
      /** Code d'appairage en un collage (`sym-pair:v1:…`, U3.1) : le seul champ de l'écran d'appairage. */
      pasted: '',
      /** Origine décodée en attente de confirmation explicite avant l'appairage (collage). */
      pending: null as { origin: string; code: string } | null,
      instanceUrl: '',
      code: '',
      deviceLabel: '',
      domain: null as string | null,
      consentOpen: false,
      mode: 'tunnel' as SiteMode,
    });

    async function run(action: () => Promise<void>) {
      state.busy = true;
      state.error = '';
      state.notice = '';
      try {
        await action();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.busy = false;
      }
    }

    async function refresh() {
      state.error = '';
      state.failed = false;
      try {
        // Instance injoignable ou en erreur : le service worker répond « appairé » avec `instanceError` ; l'écran
        // d'appairage n'apparaît que si l'extension n'est pas (ou plus) appairée.
        state.status = await send<Status>({ type: 'status' });
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        if (error instanceof PopupError && (error.code === 'unauthorized' || error.code === 'not_paired')) state.status = { paired: false };
        else state.failed = true;
      }
      state.domain = await targetDomain();
      state.loading = false;
    }

    const pair = () =>
      run(async () => {
        const instance = checkInstanceUrl(state.instanceUrl);
        if (!instance.ok) throw new Error('Instance URL refused: https:// is required.');
        // Accès à l'API de l'instance saisie (et à elle seule), demandé au clic.
        if (!(await browser.permissions.request({ origins: [instancePattern(instance.origin)] }))) throw new Error('Access to the instance was not granted.');
        state.status = await send<Status>({ type: 'pair', instanceUrl: instance.origin, code: state.code, deviceLabel: state.deviceLabel.trim() || null });
        state.code = '';
      });

    /**
     * Appairage en UN collage (U3.1, 05 § 2) : l'adresse de l'instance et le code sont lus dans le texte collé, sans saisie
     * d'URL. Contrôles locaux AVANT toute requête : forme du code, version, `https://` (boucle locale exceptée) ; l'adresse
     * refusée n'est jamais contactée. Un code à l'ancienne (`XXXXX-XXXXX`) renvoie vers la saisie à la main.
     */
    const pairByPaste = () =>
      run(async () => {
        const decoded = decodePairingCode(state.pasted);
        if (!decoded.ok) {
          if (decoded.reason === 'version') throw new Error('This pairing code comes from a newer version: update the extension.');
          if (decoded.reason === 'format') throw new Error('This is not a pairing code. Copy the whole code that starts with "sym-pair:" from your console, or open "Enter by hand".');
          throw new Error('This pairing code is damaged: generate a new one in your console.');
        }
        const instance = checkInstanceUrl(decoded.url);
        if (!instance.ok) throw new Error('Instance URL refused: https:// is required. No request was sent to this address.');
        // Revue sécurité : l'adresse n'est plus tapée, donc elle est montrée (forme ASCII/punycode de `URL.origin`) et confirmée
        // AVANT toute permission d'hôte ou requête ; un code hostile ne peut pas se faire passer pour votre instance.
        state.pending = { origin: instance.origin, code: decoded.code };
      });

    const confirmPair = () =>
      run(async () => {
        const pending = state.pending;
        if (!pending) return;
        if (!(await browser.permissions.request({ origins: [instancePattern(pending.origin)] }))) throw new Error('Access to the instance was not granted.');
        state.status = await send<Status>({ type: 'pair', instanceUrl: pending.origin, code: pending.code, deviceLabel: state.deviceLabel.trim() || null });
        state.pasted = '';
        state.pending = null;
      });

    const accept = () =>
      run(async () => {
        const domain = state.domain;
        if (!domain) return;
        // Clic explicite de consentement : permission d'hôte demandée maintenant, jamais à l'installation.
        if (!(await browser.permissions.request({ origins: originPatterns(domain) }))) throw new Error(`Access to ${domain} was not granted.`);
        await send<SiteState>({ type: 'connectSite', domain, mode: state.mode });
        state.consentOpen = false;
        state.status = await send<Status>({ type: 'status' });
      });

    const disconnect = (domain: string) =>
      run(async () => {
        state.status = await send<Status>({ type: 'disconnectSite', domain });
        state.notice = state.status.notice ?? '';
      });

    const unpair = () =>
      run(async () => {
        state.status = await send<Status>({ type: 'unpair' });
        state.notice = state.status.notice ?? '';
      });

    void refresh();

    const field = (id: string, label: string, key: 'pasted' | 'instanceUrl' | 'code' | 'deviceLabel', placeholder: string): VNode =>
      h('label', { for: id }, [
        label,
        h('input', {
          id,
          value: state[key],
          placeholder,
          autocomplete: 'off',
          onInput: (e: Event) => {
            state[key] = (e.target as HTMLInputElement).value;
          },
        }),
      ]);

    function pairingView(): VNode {
      if (state.pending) {
        const origin = state.pending.origin;
        return h('section', { id: 'pair-confirm-view', role: 'dialog', 'aria-label': 'Confirm pairing' }, [
          h('h2', ['Pair with ', h('strong', { id: 'pair-confirm-origin' }, origin), '?']),
          h('p', 'Check that this is the address of YOUR instance. A code from someone else would hand this browser to their server.'),
          h('button', { id: 'pair-confirm', type: 'button', disabled: state.busy, onClick: confirmPair }, 'Pair with this instance'),
          h('button', { id: 'pair-cancel', type: 'button', onClick: () => (state.pending = null) }, 'Cancel'),
        ]);
      }
      return h('div', { id: 'pairing' }, [
        h('form', { id: 'pairing-paste-form', onSubmit: (e: Event) => (e.preventDefault(), void pairByPaste()) }, [
          h('p', 'Pair this browser with your Scrapyomama instance. In your console, open Settings › Extension, copy the pairing code and paste it here.'),
          field('pairing-paste', 'Pairing code', 'pasted', 'sym-pair:v1:…'),
          h('button', { id: 'pair-paste', type: 'submit', disabled: state.busy }, 'Pair'),
        ]),
        // Saisie à la main (secours) : adresse de l'instance et code séparés, comme avant.
        h('details', { id: 'manual' }, [
          h('summary', 'Enter by hand'),
          h('form', { id: 'pairing-manual', onSubmit: (e: Event) => (e.preventDefault(), void pair()) }, [
            field('instance-url', 'Instance URL', 'instanceUrl', 'https://runtime.example.org'),
            field('pairing-code', 'Pairing code', 'code', 'XXXXX-XXXXX'),
            field('device-label', 'Device name (optional)', 'deviceLabel', 'Work laptop'),
            h('button', { id: 'pair', type: 'submit', disabled: state.busy }, 'Pair'),
          ]),
        ]),
      ]);
    }

    function consentView(domain: string, origin: string): VNode {
      const radio = (mode: SiteMode, label: string) =>
        h('label', [
          h('input', { type: 'radio', name: 'mode', id: `mode-${mode}`, checked: state.mode === mode, onChange: () => (state.mode = mode) }),
          label,
        ]);
      return h('section', { id: 'consent', role: 'dialog', 'aria-label': `Connect ${domain}` }, [
        h('h2', `Connect ${domain}?`),
        h('dl', [
          h('dt', 'Site'),
          h('dd', { id: 'consent-domain' }, domain),
          h('dt', 'Use'),
          h('dd', [
            radio('tunnel', 'Tunnel (default): runs go through this browser; cookies stay here.'),
            radio('server', 'Server: cookies are read and sent, encrypted, to your instance.'),
          ]),
          h('dt', 'Cookies sent to'),
          h('dd', { id: 'recipient' }, state.mode === 'server' ? origin : 'Nobody: cookies stay in this browser.'),
        ]),
        h('button', { id: 'consent-accept', type: 'button', disabled: state.busy, onClick: accept }, 'I agree, connect this site'),
        h('button', { id: 'consent-cancel', type: 'button', onClick: () => (state.consentOpen = false) }, 'Cancel'),
      ]);
    }

    function pairedView(status: Extract<Status, { paired: true }>): VNode {
      // Connecté depuis CE navigateur (consentement local) ; un domaine connecté ailleurs peut être connecté ici aussi.
      const connected = status.sites.some((s) => s.domain === state.domain && s.onThisBrowser);
      return h('div', { id: 'paired' }, [
        h('p', { id: 'identity' }, `Connected as ${status.email} to ${status.origin}`),
        status.instanceError ? h('p', { id: 'instance-error', role: 'status' }, status.instanceError) : null,
        h('section', [
          h('h2', 'This site'),
          state.domain
            ? h('p', [h('span', { id: 'site-domain' }, state.domain), connected ? ' — connected' : ''])
            : h('p', { id: 'no-site' }, 'No site that can be connected in this tab.'),
          state.domain && !connected && !state.consentOpen
            ? h('button', { id: 'connect-site', type: 'button', onClick: () => ((state.mode = 'tunnel'), (state.consentOpen = true)) }, 'Connect this site')
            : null,
          state.domain && state.consentOpen ? consentView(state.domain, status.origin) : null,
        ]),
        h('section', [
          h('h2', 'Connected sites'),
          status.sites.length === 0
            ? h('p', 'None yet.')
            : h(
                'ul',
                { id: 'sites' },
                status.sites.map((s) =>
                  h('li', { 'data-domain': s.domain }, [
                    h('span', `${s.domain} (${s.mode === 'server' ? 'server' : 'tunnel'})${s.onThisBrowser ? '' : ' — connected from another browser'}`),
                    h('button', { type: 'button', class: 'disconnect', disabled: state.busy, onClick: () => disconnect(s.domain) }, 'Disconnect'),
                  ]),
                ),
              ),
        ]),
        h('button', { id: 'unpair', type: 'button', disabled: state.busy, onClick: unpair }, 'Sign out of this instance'),
      ]);
    }

    return () =>
      h('main', [
        h('header', { class: 'brand' }, [h('h1', 'Scrapyomama'), symBadge()]),
        state.error ? h('p', { id: 'error', role: 'alert' }, state.error) : null,
        state.notice ? h('p', { id: 'notice', role: 'status' }, state.notice) : null,
        state.loading
          ? h('p', 'Loading…')
          : state.failed
            ? h('button', { id: 'retry', type: 'button', onClick: () => void refresh() }, 'Retry')
            : state.status.paired
              ? pairedView(state.status)
              : pairingView(),
      ]);
  },
});

createApp(App).mount('#app');
