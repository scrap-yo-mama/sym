// SPDX-License-Identifier: AGPL-3.0-only
// Accès des écrans au service API typé (tâche 3.6) : `ConsoleApi` fournie par app.ts (HTTP en production, simulation en
// développement et en test).
import { inject, type InjectionKey } from 'vue';
import type { ConsoleApi } from '../api/console.js';

export const CONSOLE_API_KEY: InjectionKey<ConsoleApi> = Symbol('sym-browser-console-api');

export function useConsoleApi(): ConsoleApi {
  const api = inject(CONSOLE_API_KEY);
  if (!api) throw new Error('ConsoleApi absente : createConsoleApp({ consoleApi })');
  return api;
}
