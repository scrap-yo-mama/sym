// SPDX-License-Identifier: AGPL-3.0-only
// Images sociales de la landing (22 § 2.8) : 1200×630 par langue, auto-hébergées (content/public/og/). Rendues par Chromium
// depuis les jetons et les polices de packages/ui (aucune requête réseau) ; le résultat est versionné, `pnpm --filter
// @runtime/docs landing:og` le régénère. Aucun logo de tiers : le nom, la phrase de la page et l'icône SYM.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { SYM_GHOST_PATH, SYM_GHOST_VIEWBOX } from '@runtime/ui/sym-ghost';
import { buildLanding } from '../src/landing/content.ts';
import { buildInputs, siteEnv } from '../src/landing/site.ts';
import { LANGS } from '../src/landing/types.ts';

const themeUrl = new URL('../../../packages/ui/src/theme.css', import.meta.url).href;
const outDir = fileURLToPath(new URL('../content/public/og/', import.meta.url));
const inputs = buildInputs(siteEnv(process.env));
const dir = mkdtempSync(join(tmpdir(), 'zz_test_og-'));
const browser = await chromium.launch();
try {
  for (const lang of LANGS) {
    const landing = buildLanding(lang, inputs);
    const title = landing.page.hero.title.replace('👻', '').replace(/\s+/g, ' ');
    const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="${themeUrl}"><style>
      body{margin:0;width:1200px;height:630px;background:var(--background);color:var(--foreground);font-family:var(--sym-font-sans);position:relative;overflow:hidden}
      .bar{position:absolute;left:0;right:0;top:0;height:96px;background:var(--sym-ink);color:var(--sym-paper);display:flex;align-items:center;padding:0 64px;gap:16px;font-family:var(--sym-font-display);font-weight:800;font-size:40px;letter-spacing:-1px}
      .badge{display:inline-flex;align-items:center;gap:8px;background:var(--sym-yellow);color:var(--sym-ink);border-radius:999px;padding:6px 18px 6px 14px;font-size:24px;font-family:var(--sym-font-sans);font-weight:700}
      .badge svg{width:30px;height:30px}
      h1{position:absolute;left:64px;top:180px;width:700px;margin:0;font-family:var(--sym-font-display);font-weight:800;font-size:84px;line-height:1.02;letter-spacing:-3px}
      p{position:absolute;left:64px;bottom:64px;width:700px;margin:0;font-size:30px;line-height:1.35;color:var(--muted-foreground)}
      .art{position:absolute;right:64px;top:150px;width:300px;height:420px;border-radius:40px;background:var(--sym-blue);overflow:hidden}
      .c{position:absolute;left:-80px;bottom:-100px;width:300px;height:300px;border-radius:50%;background:var(--sym-orange)}
      .s{position:absolute;right:-60px;top:-60px;width:240px;height:240px;border-radius:60px;background:var(--sym-lilac);transform:rotate(18deg)}
      .d{position:absolute;right:50px;bottom:60px;width:96px;height:96px;border-radius:50%;background:var(--sym-yellow)}
    </style></head><body><div class="bar">scrapyomama <span class="badge"><svg viewBox="${SYM_GHOST_VIEWBOX}" fill="currentColor"><path fill-rule="evenodd" d="${SYM_GHOST_PATH}"/></svg>SYM</span></div>
    <h1>${title}</h1><p>${landing.page.hero.sub}</p><div class="art"><div class="c"></div><div class="s"></div><div class="d"></div></div></body></html>`;
    const file = join(dir, `og-${lang}.html`);
    writeFileSync(file, html);
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.goto(`file://${file}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(outDir, `og-${lang}.png`), type: 'png' });
    await page.close();
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
