// SPDX-License-Identifier: AGPL-3.0-only
// Chromium commun aux deux bras (protocole §3 « même Chromium ») : le binaire de Playwright 1.63, lancé par le harnais
// avec un port CDP, un profil jetable et un résolveur fermé (seuls les hôtes *.localhost vont vers 127.0.0.1, tout le
// reste échoue : réseau limité, INV9). Le harnais s'y connecte par Playwright (connectOverCDP) pour poser le verrou de
// domaines et compter les requêtes ; le bras A pilote la même connexion, le bras B (Stagehand) se connecte par cdpUrl.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDomainGuard, hostOf, type DomainGuard } from '@runtime/agent';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

interface BrowserRequest {
  readonly url: string;
  readonly host: string | null;
  readonly method: string;
}

export interface SpikeBrowser {
  readonly cdpUrl: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly guard: DomainGuard;
  /** Requêtes vues par Playwright sur le contexte (tous onglets), bloquées ou non. */
  readonly requests: readonly BrowserRequest[];
  close(): Promise<void>;
}

export interface LaunchOptions {
  readonly allowedHosts: readonly string[];
  readonly allowWriteActions: boolean;
  readonly headless?: boolean;
}

const CHROMIUM_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--metrics-recording-only',
  '--no-pings',
  '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
  // Résolveur fermé : fixtures et domaine piège vers le serveur local, tout autre hôte introuvable.
  '--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--window-size=1280,900',
];

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes('\n')) return text;
    } catch {
      /* pas encore écrit */
    }
    if (Date.now() > end) throw new Error(`Chromium : ${path} absent après ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function launchSpikeBrowser(options: LaunchOptions): Promise<SpikeBrowser> {
  const profile = await mkdtemp(join(tmpdir(), 'zz_test_spike_chromium_'));
  const args = [
    ...CHROMIUM_ARGS,
    ...(options.headless === false ? [] : ['--headless=new']),
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const child: ChildProcess = spawn(chromium.executablePath(), args, { stdio: 'ignore' });
  let browser: Browser | undefined;
  try {
    const [port, path] = (await waitForFile(join(profile, 'DevToolsActivePort'), 15_000)).trim().split('\n');
    const cdpUrl = `ws://127.0.0.1:${port}${path}`;
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Chromium : aucun contexte par défaut');
    const requests: BrowserRequest[] = [];
    context.on('request', (r) => requests.push({ url: r.url(), host: hostOf(r.url()), method: r.method() }));
    const guard = await installDomainGuard(context, { allowedHosts: options.allowedHosts, allowWriteActions: options.allowWriteActions });
    const opened = browser;
    return {
      cdpUrl,
      browser: opened,
      context,
      guard,
      requests,
      close: async () => {
        await guard.dispose();
        await opened.close().catch(() => undefined);
        child.kill('SIGKILL');
        await rm(profile, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
