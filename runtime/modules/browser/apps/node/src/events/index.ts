// SPDX-License-Identifier: AGPL-3.0-only
// Événements du nœud vers `session_events` (tâche 2.5) : relais des événements de l'egress (1.5) d'une session.
export { forwardEgressEvents, type EgressEventForwarder } from './forward.js';
