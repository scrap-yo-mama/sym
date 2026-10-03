// SPDX-License-Identifier: AGPL-3.0-only
// ffmpeg livré avec les navigateurs de Playwright (révision lue dans `playwright-core/browsers.json`), le même que celui de
// `recordVideo` : il encode en webm (VP8) les images du screencast CDP. Présent dans l'image (`/ms-playwright`) et après
// `playwright install chromium`, sous `PLAYWRIGHT_BROWSERS_PATH` (variable de Playwright) ou son cache par défaut. Un autre
// ffmpeg se passe par l'option `ffmpeg` de l'enregistreur.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type BrowsersJson = { browsers: { name: string; revision: string }[] };

function ffmpegRevision(): string {
  const manifest = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'browsers.json');
  const revision = (JSON.parse(readFileSync(manifest, 'utf8')) as BrowsersJson).browsers.find((b) => b.name === 'ffmpeg')?.revision;
  if (revision === undefined) throw new Error('ffmpeg absent de browsers.json (playwright-core)');
  return revision;
}

const EXECUTABLE: Partial<Record<NodeJS.Platform, string>> = { linux: 'ffmpeg-linux', darwin: 'ffmpeg-mac', win32: 'ffmpeg-win64.exe' };

export function ffmpegPath(env: Readonly<Record<string, string | undefined>> = process.env, options: { platform?: NodeJS.Platform } = {}): string {
  const platform = options.platform ?? process.platform;
  const executable = EXECUTABLE[platform];
  if (executable === undefined) throw new Error(`ffmpeg de Playwright : plateforme ${platform} non prise en charge`);
  const root = env['PLAYWRIGHT_BROWSERS_PATH'] || join(env['HOME'] ?? homedir(), platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  return join(root, `ffmpeg-${ffmpegRevision()}`, executable);
}
