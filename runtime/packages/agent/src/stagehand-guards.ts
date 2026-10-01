// SPDX-License-Identifier: AGPL-3.0-only
// Garde-fous de Stagehand en production (ADR 0001, obligations de la tâche 2.4 ; exclusion X1 ; 08 §4 mesure 3), repris
// du spike (eval/spike/src/guards.ts) :
// - mode LOCAL seulement : ni API ni session Browserbase, aucune résolution de captcha (`CaptchaSolver` et
//   `waitForCaptchaSolves` n'agissent qu'en `BROWSERBASE`), environnement sans clé Browserbase ni Brave ;
// - outils de l'agent en liste FERMÉE : chaque outil que Stagehand propose au modèle doit correspondre à une action de
//   `AGENT_TOOLS` (navigation dans les domaines, clic, saisie, défilement, attente, instantané, extraction, fin). Tout
//   autre outil (recherche web, outil ajouté par une version future) arrête le run avant l'appel au modèle.
import type { AgentToolName } from '@runtime/core';

/** Variables qui activent un service Browserbase ou la recherche Brave : refus de construire Stagehand. */
const FORBIDDEN_ENV = [
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'BB_API_KEY',
  'BB_PROJECT_ID',
  'BRAVE_API_KEY',
  'STAGEHAND_API_URL',
  'STAGEHAND_BASE_URL',
  'BROWSERBASE_FLOW_LOGS',
  'BROWSERBASE_CONFIG_DIR',
] as const;

export function forbiddenEnvPresent(env: NodeJS.ProcessEnv = process.env): string[] {
  return FORBIDDEN_ENV.filter((name) => env[name] !== undefined);
}

/** Options de Stagehand qui ouvrent une session Browserbase ou la résolution de captcha (X1) : interdites. */
const FORBIDDEN_STAGEHAND_OPTIONS = ['apiKey', 'projectId', 'browserbaseSessionCreateParams', 'browserbaseSessionID', 'keepAlive'] as const;

export class StagehandNotLocalError extends Error {
  override name = 'StagehandNotLocalError';
}

/**
 * Stagehand en local seulement : `env: 'LOCAL'`, `disableAPI: true`, aucune option de session Browserbase, aucune
 * option « captcha » active, aucune variable Browserbase ou Brave. Appelé avant chaque `new Stagehand(...)`.
 */
export function assertStagehandLocalOnly(options: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  if (options['env'] !== 'LOCAL') problems.push(`env doit valoir LOCAL (reçu : ${String(options['env'])})`);
  if (options['disableAPI'] !== true) problems.push('disableAPI doit valoir true');
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) continue;
    const forbidden = (FORBIDDEN_STAGEHAND_OPTIONS as readonly string[]).includes(key) || /browserbase/i.test(key) || (/captcha/i.test(key) && options[key] !== false);
    if (forbidden) problems.push(`option ${key} interdite`);
  }
  const vars = forbiddenEnvPresent(env);
  if (vars.length > 0) problems.push(`variables d'environnement interdites : ${vars.join(', ')}`);
  if (problems.length > 0) throw new StagehandNotLocalError(`Stagehand hors du mode local : ${problems.join(' ; ')}`);
}

/**
 * Outils de Stagehand 3.7.3 (mode `dom`) et l'action de la liste fermée qu'ils réalisent. `think` n'agit pas sur la
 * page (carnet de raisonnement) : il est rangé avec l'instantané. `search` (Browserbase / Brave) n'y figure pas et est
 * exclu à chaque run ; tout outil absent de cette table arrête le run.
 */
export const STAGEHAND_TOOL_ACTIONS: Readonly<Record<string, AgentToolName>> = Object.freeze({
  act: 'click',
  fillForm: 'type',
  keys: 'type',
  goto: 'navigate',
  navback: 'navigate',
  scroll: 'scroll',
  wait: 'wait',
  ariaTree: 'snapshot',
  screenshot: 'snapshot',
  think: 'snapshot',
  extract: 'extract',
  done: 'finish',
});

/** Outils de Stagehand jamais proposés au modèle. */
export const STAGEHAND_EXCLUDED_TOOLS: readonly string[] = Object.freeze(['search']);

export class AgentToolsetNotClosedError extends Error {
  override name = 'AgentToolsetNotClosedError';
  readonly tools: readonly string[];
  constructor(tools: readonly string[]) {
    super(`outils d'agent hors de la liste fermée : ${tools.join(', ')}`);
    this.tools = tools;
  }
}

/** Outils proposés hors de la liste fermée (vide si la liste est tenue). */
export function toolsOutsideClosedList(names: readonly string[]): string[] {
  return names.filter((n) => !Object.hasOwn(STAGEHAND_TOOL_ACTIONS, n));
}
