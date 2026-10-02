// SPDX-License-Identifier: AGPL-3.0-only
// Enregistrements d'une session produits CÔTÉ NŒUD (cdc/sym-browser 04d § 2, 04f § 5, tâche 3.3), sur le contexte
// Playwright de la session tenu par la connexion interne du nœud, indépendamment du transport et du client :
// - session shared : le contexte créé par le nœud (tâche 1.3) ;
// - session dedicated : le contexte par défaut du Chromium dédié, vu par une connexion `connectOverCDP` propre au nœud
//   (`connectRecordingContext`), où naissent les pages des clients CDP.
// Types : `trace` (tracing Playwright, captures et instantanés, réseau masqué après coup), `har` (HAR 1.2 construit depuis
// les événements réseau), `network` et `console` (NDJSON masqués), `video` (screencast CDP encodé en webm, une vidéo par
// page). Fichiers dans `sessions/{id}/recordings` (0700) ; à l'arrêt (étape 5 de la destruction, AVANT l'arrêt du Chromium) :
// trace arrêtée et masquée, vidéos finalisées, journaux fermés, chaque artefact déposé chiffré dans le coffre, répertoire
// supprimé. Plafond par enregistrement `SYMB_RECORDING_MAX_BYTES` : écriture arrêtée, `recording.truncated {type}`.
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordingOptions, RecordingType } from '@sym/contracts/browser';
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page, type Request, type WebError } from 'playwright-core';
import { ffmpegPath } from './ffmpeg.js';
import { HarBuilder } from './har.js';
import { anyRecording, recordingOptions } from './options.js';
import { LimitedLog, consoleLine, networkLine, sanitizeTraceZip } from './sanitize.js';
import type { RecordingInfo, RecordingVault } from './vault.js';
import { PageVideo } from './video.js';

export type SessionRecorderOptions = {
  vault: RecordingVault;
  /** `SYMB_RECORDING_MAX_BYTES` (200 Mo par défaut, à valider). */
  maxBytes: number;
  ffmpeg?: string;
  /** Version annoncée dans le créateur du HAR. */
  appVersion?: string;
};

export type StartRecording = {
  sessionId: string;
  tenantId: string;
  context: BrowserContext;
  /** `sessions/{id}/recordings`. */
  workDir: string;
  options: RecordingOptions | undefined;
};

export type ActiveRecording = {
  readonly types: readonly RecordingType[];
  /** Arrêt et dépôt chiffré de chaque artefact ; à appeler avant de fermer le contexte ou d'arrêter le Chromium. Idempotent. */
  stop(): Promise<RecordingInfo[]>;
};

/** Connexion d'enregistrement du nœud à un Chromium dédié (point CDP local) : contexte par défaut de la session. */
export async function connectRecordingContext(cdpEndpoint: string): Promise<{ browser: Browser; context: BrowserContext; close(): Promise<void> }> {
  if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser\/[A-Za-z0-9-]+$/.test(cdpEndpoint)) throw new RangeError('point CDP local attendu (ws://127.0.0.1:{port}/devtools/browser/{id})');
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  if (context === undefined) {
    await browser.close().catch(() => undefined);
    throw new Error('contexte par défaut du Chromium dédié introuvable');
  }
  // `close` d'une connexion `connectOverCDP` détache le nœud sans arrêter le Chromium (la destruction appartient au pool).
  return { browser, context, close: () => browser.close().catch(() => undefined) };
}

const NO_RECORDING: ActiveRecording = Object.freeze({ types: [], stop: () => Promise.resolve([]) });

export class SessionRecorder {
  readonly #options: SessionRecorderOptions;

  constructor(options: SessionRecorderOptions) {
    this.#options = options;
  }

  async start(request: StartRecording): Promise<ActiveRecording> {
    const options = recordingOptions(request.options);
    if (!anyRecording(options)) return NO_RECORDING;
    const { context, workDir, sessionId, tenantId } = request;
    const max = this.#options.maxBytes;
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const vault = this.#options.vault;
    const cleanups: (() => void)[] = [];
    const pending = new Set<Promise<unknown>>();
    const track = (work: Promise<unknown>): void => {
      const tracked = work.catch(() => undefined).finally(() => pending.delete(tracked));
      pending.add(tracked);
    };
    let stopping = false;

    if (options.trace) await context.tracing.start({ screenshots: true, snapshots: true });

    const consoleLog = options.console ? new LimitedLog(join(workDir, 'console.ndjson'), max) : undefined;
    if (consoleLog !== undefined) {
      const onConsole = (message: ConsoleMessage): void => void consoleLog.write(consoleLine({ ts: Date.now(), type: message.type(), text: message.text(), url: message.location().url }));
      const onError = (error: WebError): void => void consoleLog.write(consoleLine({ ts: Date.now(), type: 'pageerror', text: error.error().message, url: error.page()?.url() ?? '' }));
      context.on('console', onConsole);
      context.on('weberror', onError);
      cleanups.push(() => {
        context.off('console', onConsole);
        context.off('weberror', onError);
      });
    }

    const networkLog = options.network ? new LimitedLog(join(workDir, 'network.ndjson'), max) : undefined;
    const har = options.har ? new HarBuilder({ name: 'SYM Browser', version: this.#options.appVersion ?? '0.0.0' }, max) : undefined;
    if (networkLog !== undefined || har !== undefined) {
      const record = async (req: Request, failed: boolean): Promise<void> => {
        const timing = req.timing();
        const response = failed ? null : await req.response().catch(() => null);
        const sizes = failed ? undefined : await req.sizes().catch(() => undefined);
        const requestHeaders = await req.allHeaders().catch(() => req.headers());
        const responseHeaders = response === null ? {} : await response.allHeaders().catch(() => response.headers());
        const status = response?.status() ?? 0;
        const bytes = sizes?.responseBodySize ?? 0;
        const send = timing.requestStart >= 0 ? timing.requestStart : 0;
        const wait = timing.responseStart >= 0 && timing.requestStart >= 0 ? timing.responseStart - timing.requestStart : 0;
        const receive = timing.responseEnd >= 0 && timing.responseStart >= 0 ? timing.responseEnd - timing.responseStart : 0;
        const failure = failed ? (req.failure()?.errorText ?? 'failed') : undefined;
        networkLog?.write(networkLine({ ts: Math.round(timing.startTime), method: req.method(), url: req.url(), status, durationMs: send + wait + receive, bytes, ...(failure === undefined ? {} : { failure }) }));
        har?.add({
          startedAt: new Date(timing.startTime > 0 ? timing.startTime : Date.now()),
          method: req.method(),
          url: req.url(),
          requestHeaders,
          status,
          statusText: response?.statusText() ?? '',
          responseHeaders,
          mimeType: responseHeaders['content-type'] ?? '',
          bodySize: bytes,
          timings: { send, wait, receive },
          ...(failure === undefined ? {} : { failure }),
        });
      };
      const onFinished = (req: Request): void => track(record(req, false));
      const onFailed = (req: Request): void => track(record(req, true));
      context.on('requestfinished', onFinished);
      context.on('requestfailed', onFailed);
      cleanups.push(() => {
        context.off('requestfinished', onFinished);
        context.off('requestfailed', onFailed);
      });
    }

    const videos: PageVideo[] = [];
    if (options.video) {
      const ffmpeg = this.#options.ffmpeg ?? ffmpegPath();
      const startVideo = (page: Page): void => {
        if (stopping) return;
        const started = PageVideo.start(context, page, { path: join(workDir, `video-${videos.length + 1}.webm`), ffmpeg, maxBytes: max });
        track(
          started.then((video) => {
            videos.push(video);
            page.once('close', () => track(video.stop()));
          }),
        );
      };
      for (const page of context.pages()) startVideo(page);
      context.on('page', startVideo);
      cleanups.push(() => context.off('page', startVideo));
    }

    let stopped: Promise<RecordingInfo[]> | undefined;
    const types = (Object.keys(options) as RecordingType[]).filter((t) => options[t]);
    return {
      types,
      stop: () =>
        (stopped ??= (async () => {
          stopping = true;
          const produced: { type: RecordingType; path: string; name: string; truncated: boolean }[] = [];
          if (options.trace) {
            const path = join(workDir, 'trace.zip');
            try {
              await context.tracing.stop({ path });
              sanitizeTraceZip(path);
              // Une trace ne se coupe pas : au-delà du plafond, elle n'est pas déposée.
              if ((await stat(path)).size > max) vault.truncated(sessionId, 'trace');
              else produced.push({ type: 'trace', path, name: 'trace.zip', truncated: false });
            } catch {
              // Contexte déjà perdu (plantage) : pas de trace.
            }
          }
          for (const cleanup of cleanups) cleanup();
          while (pending.size > 0) await Promise.allSettled([...pending]);
          for (const video of videos) {
            await video.stop().catch(() => undefined);
            if (video.frames > 0) produced.push({ type: 'video', path: video.path, name: video.path.slice(workDir.length + 1), truncated: video.truncated });
          }
          if (consoleLog !== undefined) {
            consoleLog.close();
            produced.push({ type: 'console', path: consoleLog.path, name: 'console.ndjson', truncated: consoleLog.truncated });
          }
          if (networkLog !== undefined) {
            networkLog.close();
            produced.push({ type: 'network', path: networkLog.path, name: 'network.ndjson', truncated: networkLog.truncated });
          }
          if (har !== undefined) {
            const path = join(workDir, 'session.har');
            await writeFile(path, har.serialize(), { mode: 0o600 });
            produced.push({ type: 'har', path, name: 'session.har', truncated: har.truncated });
          }
          const infos: RecordingInfo[] = [];
          try {
            for (const item of produced) infos.push(await vault.deposit({ sessionId, tenantId, type: item.type, path: item.path, name: item.name, truncated: item.truncated }));
          } finally {
            await rm(workDir, { recursive: true, force: true });
          }
          return infos;
        })()),
    };
  }
}
