// SPDX-License-Identifier: MIT
// Sessions (cdc/sym-browser 04 § 3 à § 5) : champs de création (tous facultatifs), réponse, machine à états.
import type { EgressPolicy } from './egress.js';

export const SESSION_TYPES = ['shared', 'dedicated'] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export const SESSION_STATES = ['pending', 'running', 'ended', 'timed_out', 'failed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** États terminaux : la session est détruite (BINV3) et son usage clôturé. */
export const TERMINAL_SESSION_STATES = ['ended', 'timed_out', 'failed'] as const satisfies readonly SessionState[];

export const END_REASONS = ['released', 'timeout', 'idle', 'budget_exceeded', 'node_shutdown', 'crash', 'node_lost', 'quota'] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Liste fermée des arguments de lancement admis (figée par la tâche 1.4) ; implique `dedicated`. */
export const LAUNCH_ARGS = ['mute-audio', 'hide-scrollbars', 'disable-gpu', 'force-color-profile-srgb', 'disable-smooth-scrolling'] as const;
export type LaunchArg = (typeof LAUNCH_ARGS)[number];

export const COLOR_SCHEMES = ['light', 'dark', 'no-preference'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export const PROFILE_MODES = ['read', 'write'] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

/** Profil persistant : `write` exclusif, `read` partagé ; implique `dedicated`. */
export type ProfileRef = { id: string; mode: ProfileMode };

export type Viewport = { width: number; height: number };
export type Geolocation = { latitude: number; longitude: number; accuracy?: number };
export type RecordingOptions = { trace?: boolean; har?: boolean; video?: boolean; console?: boolean; network?: boolean };

/** `storageState` Playwright (cookies et origines), importé tel quel à la création. */
export type StorageState = {
  cookies: Record<string, unknown>[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
};

/** Corps de `POST /v1/sessions`. Les valeurs par défaut sont celles de l'instance. */
export type CreateSessionRequest = {
  type?: SessionType;
  id?: string;
  region?: string;
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  viewport?: Viewport;
  locale?: string;
  timezoneId?: string;
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  geolocation?: Geolocation;
  colorScheme?: ColorScheme;
  acceptDownloads?: boolean;
  launchArgs?: LaunchArg[];
  egress?: EgressPolicy;
  profile?: ProfileRef;
  storageState?: StorageState;
  recordings?: RecordingOptions;
  liveView?: { interactive?: boolean };
  metadata?: Record<string, string>;
};

/** URL `wss://` à jeton court ; `cdp` présent pour toute session `dedicated`. */
export type ConnectUrls = { playwright: string; cdp?: string };

export type SessionUsage = { seconds: number; bytesIn: number; bytesOut: number };

/** Réponse de `POST /v1/sessions` et de `GET /v1/sessions/{id}`. Dates ISO 8601 UTC. */
export type Session = {
  id: string;
  state: SessionState;
  type: SessionType;
  nodeRegion?: string;
  connectUrls?: ConnectUrls;
  liveViewUrl?: string;
  egress?: { exitIp: string; latencyMs: number };
  expiresAt: string;
  createdAt: string;
  endReason?: EndReason;
  usage?: SessionUsage;
  metadata?: Record<string, string>;
};

/** Page de `GET /v1/sessions` (curseur opaque, tri par `createdAt` décroissant). */
export type SessionPage = { data: Session[]; nextCursor: string | null };

/** Corps de `POST /v1/sessions/{id}/extend`. */
export type ExtendSessionRequest = { timeoutSeconds: number };
