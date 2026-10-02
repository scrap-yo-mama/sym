// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm assets:render` : rend les PNG de .github/assets/brand depuis les sources SVG de .github/assets/src (Chromium local).
import { renderAssets } from './lib/render.ts';

const written = await renderAssets();
for (const name of written) console.log(`rendu : .github/assets/${name}`);
