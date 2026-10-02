// SPDX-License-Identifier: AGPL-3.0-only
// Vidéo d'une page produite par le nœud (04d § 2.1, 04f § 5) : screencast CDP (`Page.startScreencast`, JPEG) sur la
// connexion interne du nœud, images posées à 25 i/s (la dernière image est répétée jusqu'à l'instant de la suivante) et
// encodées en webm VP8 1280x720 par le ffmpeg de Playwright, avec les réglages de son `recordVideo`. Fonctionne pour une
// page créée par n'importe quel client (Playwright natif ou CDP), là où `connectOverCDP` côté client perd la vidéo.
// ffmpeg est un enfant de ce processus : arrêté par son objet ChildProcess s'il ne se termine pas.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { statSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

const VIDEO_SIZE = Object.freeze({ width: 1280, height: 720 });
const FPS = 25;
const FINALIZE_TIMEOUT_MS = 30_000;

type Frame = { data: string; sessionId: number; metadata: { timestamp?: number } };

export class PageVideo {
  readonly path: string;
  truncated = false;
  frames = 0;
  readonly #ffmpeg: ChildProcessByStdio<Writable, null, Readable>;
  readonly #maxBytes: number;
  #cdp: CDPSession | undefined;
  #start: number | undefined;
  #last: Buffer | undefined;
  #written = 0;
  #writing: Promise<void> = Promise.resolve();
  #stopped: Promise<void> | undefined;
  #stderr = '';

  private constructor(path: string, ffmpeg: string, maxBytes: number) {
    this.path = path;
    this.#maxBytes = maxBytes;
    const { width, height } = VIDEO_SIZE;
    this.#ffmpeg = spawn(
      ffmpeg,
      ['-loglevel', 'error', '-f', 'image2pipe', '-avioflags', 'direct', '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0', '-c:v', 'mjpeg', '-i', 'pipe:0', '-y', '-an', '-r', String(FPS), '-c:v', 'vp8', '-qmin', '0', '-qmax', '50', '-crf', '8', '-deadline', 'realtime', '-speed', '8', '-b:v', '1M', '-threads', '1', '-vf', `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`, path],
      { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } },
    );
    this.#ffmpeg.stdin.on('error', () => undefined);
    this.#ffmpeg.stderr.on('data', (d: Buffer) => (this.#stderr = (this.#stderr + d.toString()).slice(-2000)));
  }

  static async start(context: BrowserContext, page: Page, options: { path: string; ffmpeg: string; maxBytes: number }): Promise<PageVideo> {
    const video = new PageVideo(options.path, options.ffmpeg, options.maxBytes);
    try {
      const cdp = await context.newCDPSession(page);
      video.#cdp = cdp;
      cdp.on('Page.screencastFrame', (frame: Frame) => {
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
        video.#onFrame(Buffer.from(frame.data, 'base64'), frame.metadata.timestamp ?? Date.now() / 1000);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: VIDEO_SIZE.width, maxHeight: VIDEO_SIZE.height, everyNthFrame: 1 });
    } catch {
      // Page fermée avant le début : vidéo vide, finalisée à l'arrêt.
    }
    return video;
  }

  #push(frame: Buffer): void {
    this.#writing = this.#writing.then(
      () =>
        new Promise<void>((resolve) => {
          if (this.#ffmpeg.stdin.destroyed || this.#ffmpeg.stdin.writableEnded) return resolve();
          if (this.#ffmpeg.stdin.write(frame)) resolve();
          else this.#ffmpeg.stdin.once('drain', resolve);
        }),
    );
    this.#written += 1;
    if (this.#written % FPS === 0) {
      try {
        if (statSync(this.path).size > this.#maxBytes) this.truncated = true;
      } catch {
        // Fichier pas encore créé par ffmpeg.
      }
    }
  }

  /** Répète l'image précédente jusqu'à l'instant `timestamp` (secondes), au rythme de 25 i/s. */
  #fill(timestamp: number): void {
    if (this.#start === undefined || this.#last === undefined) return;
    const target = Math.floor((timestamp - this.#start) * FPS);
    while (this.#written < target && !this.truncated) this.#push(this.#last);
  }

  #onFrame(frame: Buffer, timestamp: number): void {
    if (this.#stopped !== undefined || this.truncated) return;
    this.frames += 1;
    if (this.#start === undefined) {
      this.#start = timestamp;
      this.#last = frame;
      this.#push(frame);
      return;
    }
    this.#fill(timestamp);
    this.#last = frame;
  }

  /** Fin : screencast arrêté, images comblées jusqu'à maintenant, encodage terminé. Idempotent. */
  stop(): Promise<void> {
    this.#stopped ??= (async () => {
      await this.#cdp?.send('Page.stopScreencast').catch(() => undefined);
      await this.#cdp?.detach().catch(() => undefined);
      this.#fill(Date.now() / 1000);
      if (this.#last !== undefined && !this.truncated) this.#push(this.#last);
      await this.#writing;
      const exited = new Promise<number | null>((resolve) => {
        if (this.#ffmpeg.exitCode !== null) resolve(this.#ffmpeg.exitCode);
        else this.#ffmpeg.once('exit', (code) => resolve(code));
      });
      this.#ffmpeg.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([exited, new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), FINALIZE_TIMEOUT_MS)))]);
      clearTimeout(timer);
      if (code === 'timeout') {
        this.#ffmpeg.kill('SIGKILL');
        throw new Error('ffmpeg : encodage non terminé dans le délai');
      }
      if (code !== 0 && this.frames > 0) throw new Error(`ffmpeg : code ${code} (${this.#stderr.trim()})`);
    })();
    return this.#stopped;
  }
}
