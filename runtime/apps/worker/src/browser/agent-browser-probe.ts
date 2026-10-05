// SPDX-License-Identifier: AGPL-3.0-only
// Test « Navigateur » du worker (U1.12, reste d'UX-23) : lance le Chromium dédié de l'agent, comme un essai `agent`, puis le
// ferme. Il dit si le moteur agentique peut démarrer SUR CE WORKER (HOME, bac à sable, binaire), avec la classe d'échec
// en code fermé, sans attendre un essai d'enquête de 60 s. Aucune page, aucune requête sortante, aucun modèle appelé : le
// serveur d'egress est une adresse inerte et la liste de domaines est vide.
import { launchAgentBrowser, type AgentBrowserOptions } from './agent-browser.js';
import { agentEngineErrorClass } from '../exec/agent-error-class.js';

export type BrowserProbe = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly class: string; readonly ms: number };

export async function probeAgentBrowser(options: Pick<AgentBrowserOptions, 'executablePath' | 'launchTimeoutMs' | 'env'> = {}): Promise<BrowserProbe> {
  const started = Date.now();
  try {
    const browser = await launchAgentBrowser({
      egressServer: 'http://127.0.0.1:9',
      allowedHosts: [],
      allowWriteActions: false,
      checkRequest: async () => false,
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: options.launchTimeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    await browser.close();
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, class: agentEngineErrorClass(error), ms: Date.now() - started };
  }
}
