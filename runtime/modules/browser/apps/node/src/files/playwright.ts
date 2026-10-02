// SPDX-License-Identifier: AGPL-3.0-only
// Liaison Playwright des fichiers de session : identifiant CDP du contexte (`browserContextId`, lu sur une page temporaire
// du contexte, que Playwright n'expose pas) et session CDP de navigateur de la connexion interne du nœud. Sans contexte
// Playwright (session dedicated : les clients CDP utilisent le contexte par défaut, invisible pour `connect`), le contexte par
// défaut est lu sur une cible temporaire créée par CDP.
import type { Browser, BrowserContext } from 'playwright-core';
import type { SessionDir } from '../dedicated/index.js';
import type { AttachedFiles, CdpLike, SessionFiles } from './session-files.js';

export async function browserContextIdOf(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    await cdp.detach();
    if (targetInfo.browserContextId === undefined) throw new Error('contexte CDP introuvable');
    return targetInfo.browserContextId;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** `browserContextId` du contexte par défaut d'un Chromium (celui des clients CDP d'une session dedicated). */
export async function defaultBrowserContextIdOf(browser: Browser): Promise<string> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    try {
      const { targetInfo } = await cdp.send('Target.getTargetInfo', { targetId });
      if (targetInfo.browserContextId === undefined) throw new Error('contexte CDP par défaut introuvable');
      return targetInfo.browserContextId;
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Branche les téléchargements d'un contexte (shared : celui de la session ; dedicated, sans `context` : le contexte par défaut). */
export async function attachBrowserFiles(
  files: SessionFiles,
  target: { sessionId: string; tenantId: string; dir: SessionDir; acceptDownloads: boolean; browser: Browser; context?: BrowserContext },
): Promise<AttachedFiles> {
  const browserContextId = target.context === undefined ? await defaultBrowserContextIdOf(target.browser) : await browserContextIdOf(target.context);
  return files.attach({
    sessionId: target.sessionId,
    tenantId: target.tenantId,
    dir: target.dir,
    acceptDownloads: target.acceptDownloads,
    browserKey: target.browser,
    openCdp: async () => (await target.browser.newBrowserCDPSession()) as unknown as CdpLike,
    browserContextId,
  });
}
