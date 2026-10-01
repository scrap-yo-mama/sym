// Canal agent_step côté serveur sur un vrai Chromium (Playwright 1.63) et les fixtures du spike : stale_ref sans
// exécution, verrou de domaines (tentatives comptées même bloquées), refus des écritures. Aucun LLM.
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../../fixtures/src/server.ts';
import { installDomainGuard, PlaywrightStepChannel, type DomainGuard } from './playwright-channel.js';

const E5 = 'zz_test_agent_mobile_next.localhost';
const INJ = 'zz_test_agent_prompt_injection.localhost';
const TRAP = 'zz_test_evil.localhost';
const hasChromium = existsSync(chromium.executablePath());

let fx: FixtureServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let guard: DomainGuard;

const stats = async (): Promise<{ hosts: Record<string, { total: number; paths: Record<string, number> }> }> =>
  (await fetch(`http://127.0.0.1:${fx.port}/__stats`)).json() as Promise<{ hosts: Record<string, { total: number; paths: Record<string, number> }> }>;

describe.skipIf(!hasChromium)('PlaywrightStepChannel (contrat agent_step, 07 §3)', () => {
  beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 });
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await fx?.close();
  });
  beforeEach(async () => {
    await fetch(`http://127.0.0.1:${fx.port}/__reset`, { method: 'POST' });
    await context?.close();
    context = await browser.newContext();
    guard = await installDomainGuard(context, { allowedHosts: [E5, INJ], allowWriteActions: false });
    page = await context.newPage();
  });

  it('pagination par interaction : le clic sur « Suivant » vise un ref de l\'instantané courant', async () => {
    const channel = new PlaywrightStepChannel({ page, allowedHosts: [E5] });
    const opened = await channel.execute({ kind: 'navigate', url: `http://${E5}:${fx.port}/` });
    expect(opened.ok).toBe(true);
    const snap = await channel.snapshot();
    expect(snap.snapshotId).toMatch(/^s\d+-[0-9a-f]{6}$/);
    expect(snap.accessibilityTree).toContain('Page 1 / 3');
    const ref = /button "Suivant" [^\n]*?\[ref=(\w+)\]|button "Suivant" \[ref=(\w+)\]/.exec(snap.accessibilityTree);
    const target = ref?.[1] ?? ref?.[2] ?? '';
    expect(channel.semanticTarget(snap.snapshotId, target)).toEqual({ role: 'button', name: 'Suivant' });
    const next = await channel.execute({ kind: 'click', target: { snapshotId: snap.snapshotId, ref: target } });
    expect(next.ok && next.snapshot.accessibilityTree).toContain('Page 2 / 3');
  }, 60_000);

  it('stale_ref : un ref d\'un ancien instantané est refusé, rien n\'est exécuté, un nouvel instantané est rendu', async () => {
    const channel = new PlaywrightStepChannel({ page, allowedHosts: [E5] });
    await channel.execute({ kind: 'navigate', url: `http://${E5}:${fx.port}/` });
    const first = await channel.snapshot();
    const target = /button "Suivant"[^\n]*\[ref=(\w+)\]/.exec(first.accessibilityTree)?.[1] ?? '';
    const moved = await channel.execute({ kind: 'click', target: { snapshotId: first.snapshotId, ref: target } });
    expect(moved.ok).toBe(true);
    const stale = await channel.execute({ kind: 'click', target: { snapshotId: first.snapshotId, ref: target } });
    expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(stale.snapshot?.accessibilityTree).toContain('Page 2 / 3');
    // La page n'a pas bougé : le clic refusé n'a pas été exécuté.
    expect((await channel.snapshot()).accessibilityTree).toContain('Page 2 / 3');
    const unknown = await channel.execute({ kind: 'click', target: { snapshotId: (await channel.snapshot()).snapshotId, ref: 'e9999' } });
    expect(unknown).toMatchObject({ ok: false, error: 'stale_ref' });
    // Page modifiée par elle-même (script) entre l'instantané et l'action : stale_ref aussi.
    const before = await channel.snapshot();
    await page.evaluate("document.body.append('zz_test mutation')");
    expect(await channel.execute({ kind: 'scroll', snapshotId: before.snapshotId, direction: 'down' })).toMatchObject({ ok: false, error: 'stale_ref' });
  }, 60_000);

  it('verrou de domaines : navigation du moteur refusée sans requête ; navigation initiée par la page bloquée et comptée', async () => {
    const channel = new PlaywrightStepChannel({ page, allowedHosts: [INJ] });
    await channel.execute({ kind: 'navigate', url: `http://${INJ}:${fx.port}/` });
    expect(await channel.execute({ kind: 'navigate', url: `http://${TRAP}:${fx.port}/collect` })).toMatchObject({ ok: false, error: 'domain_not_allowed' });
    expect((await stats()).hosts[TRAP]).toBeUndefined();
    // Clic sur le lien piège de la page : la requête part du navigateur, la garde la bloque et la compte.
    await page.getByRole('link', { name: 'Vérifier mon compte' }).click();
    await page.waitForTimeout(300);
    expect(guard.blocked.filter((b) => b.host === TRAP && b.reason === 'domain')).toHaveLength(1);
    expect(guard.attemptsTo(TRAP)).toBe(1);
    expect((await stats()).hosts[TRAP]).toBeUndefined();
  }, 60_000);

  it('pas d\'écriture : la soumission de formulaire (POST) est refusée', async () => {
    const guardSameHost = guard;
    await page.goto(`http://${INJ}:${fx.port}/`);
    await page.evaluate("(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '/zz_test_write'; document.body.append(f); f.submit(); })()");
    await page.waitForTimeout(300);
    expect(guardSameHost.blocked.filter((b) => b.reason === 'write' && b.method === 'POST')).toHaveLength(1);
    expect((await stats()).hosts[INJ]?.paths['/zz_test_write']).toBeUndefined();
  }, 60_000);
});
