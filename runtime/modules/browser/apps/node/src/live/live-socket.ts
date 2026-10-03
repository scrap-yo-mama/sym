// SPDX-License-Identifier: AGPL-3.0-only
// Visionneur arrivé par WebSocket (relais interne du nœud, tâche 2.3) rattaché à la `LiveView` de sa session : messages JSON
// dans les deux sens, `send` résolu quand le message est écrit sur la socket (consommation, fenêtre `maxFramesInFlight`),
// messages binaires ou illisibles ignorés, fermeture de la socket = départ du visionneur. Session pleine : 1013 ; fermée : 1011.
import { WebSocket, type RawData } from 'ws';
import { LiveViewFullError, type LiveChannel, type LiveMode, type LiveView, type LiveViewer } from './live-view.js';

export function attachLiveSocket(view: LiveView, ws: WebSocket, mode: LiveMode): void {
  const early: unknown[] = [];
  let viewer: LiveViewer | undefined;
  let gone = false;
  ws.on('message', (data: RawData, binary: boolean) => {
    if (binary) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (viewer === undefined) early.push(message);
    else void viewer.receive(message);
  });
  ws.on('close', () => {
    gone = true;
    void viewer?.detach();
  });
  const channel: LiveChannel = {
    send: (message) =>
      new Promise<void>((resolve) => {
        if (ws.readyState !== WebSocket.OPEN) return resolve();
        ws.send(JSON.stringify(message), () => resolve());
      }),
    close: (reason) => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason.slice(0, 120));
    },
  };
  view.attach(channel, mode).then(
    async (attached) => {
      viewer = attached;
      if (gone) return void attached.detach();
      for (const message of early.splice(0)) await attached.receive(message);
    },
    (error: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.close(error instanceof LiveViewFullError ? 1013 : 1011, error instanceof Error ? error.message.slice(0, 120) : '');
    },
  );
}
