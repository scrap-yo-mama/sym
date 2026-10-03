// SPDX-License-Identifier: MIT
// Événements de session (cdc/sym-browser 03 § 5 `session_events`, 04 § 10, 04c § 1.5, 04d § 2.2) : flux SSE, table
// `session_events` et webhook de fin de session. Aucun jeton ni URL complète dans un événement (BINV6).
import type { EgressBlockReason, OnBudgetExceeded } from './egress.js';
import type { EndReason, SessionState } from './session.js';

export const SESSION_EVENT_TYPES = [
  'state',
  'egress.blocked',
  'egress.budget_exceeded',
  'download',
  'recording.ready',
  'recording.truncated',
  'profile.save_failed',
  'storage_state.exported',
  'live.input',
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export const DOWNLOAD_STATES = ['started', 'completed', 'canceled'] as const;
export type DownloadState = (typeof DOWNLOAD_STATES)[number];

export const RECORDING_TYPES = ['trace', 'har', 'video', 'console', 'network'] as const;
export type RecordingType = (typeof RECORDING_TYPES)[number];

/** Données de chaque type d'événement. Les formes non fixées par le CDC restent ouvertes jusqu'à leur tâche. */
export type SessionEventData = {
  state: { state: SessionState; endReason?: EndReason };
  'egress.blocked': { host: string; reason: EgressBlockReason; port?: number; count: number };
  'egress.budget_exceeded': { budgetBytes: number; bytesIn: number; bytesOut: number; action: OnBudgetExceeded };
  download: { id: string; name: string; state: DownloadState; bytes: number; reason?: 'size_exceeded' };
  'recording.ready': { recordingId: string; type: RecordingType; size: number; expiresAt: string };
  'recording.truncated': Record<string, unknown>;
  'profile.save_failed': Record<string, unknown>;
  'storage_state.exported': Record<string, unknown>;
  'live.input': Record<string, unknown>;
};

/** Événement d'une session, discriminé par `type`. */
export type SessionEvent = {
  [T in SessionEventType]: { type: T; sessionId: string; at: string; data: SessionEventData[T] };
}[SessionEventType];
