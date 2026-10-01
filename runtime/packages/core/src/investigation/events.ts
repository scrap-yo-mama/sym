// SPDX-License-Identifier: AGPL-3.0-only
// Récit de l'enquête (`investigation_events`, 03 et 05 §2) : source unique du SSE de la console, de la progression MCP
// et du replay. Noms d'événements du flux (OpenAPI `EventName`) quand ils existent ; `access_report` est l'étape 0
// (contrainte de la migration 0015 : aucun `attempt*` ni `reconnaissance*` avant lui). Les charges ne portent ni corps
// de page, ni en-tête, ni cookie, ni prompt : des codes, des coûts, des chemins et, pour `schema.proposed`, le schéma et
// l'échantillon (données de l'utilisateur, purgées à `RETENTION_SAMPLES_DAYS`, 17 §6).
export const INVESTIGATION_EVENTS = Object.freeze({
  started: 'investigation.started',
  phase: 'phase.started',
  accessReport: 'access_report',
  reconnaissance: 'reconnaissance.finished',
  schemaProposed: 'schema.proposed',
  schemaValidated: 'schema.validated',
  attemptFinished: 'attempt.finished',
  attemptPruned: 'attempt.pruned',
  statusChanged: 'status.changed',
  actionRequired: 'action.required',
  finished: 'investigation.finished',
} as const);

export type InvestigationEventKind = (typeof INVESTIGATION_EVENTS)[keyof typeof INVESTIGATION_EVENTS];

/** URL réduite à l'origine et au chemin (ni requête, ni fragment, ni identifiants) pour le récit. */
export function narrativeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}
