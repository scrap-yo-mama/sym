// SPDX-License-Identifier: AGPL-3.0-only
// Verdict robots.txt « tout permis » des tests qui appellent un exécuteur ou un contexte de run hors du `RunExecutor`
// (sans module d'accès de 1.11). La garde de Chromium reste posée telle qu'en production (contrôle CDP de chaque requête,
// WebSocket, workers, SharedWorker, garde des documents : `checkRequest` est obligatoire) ; seul le verdict permet. Les
// refus sont couverts par apps/worker/src/exec/robots.security.test.ts et agent-robots.security.test.ts.
import type { AccessCheck } from '@runtime/core/exec';

export const allowAllRobots: AccessCheck = async () => ({ allowed: true, crawlDelayMs: null });

/** `checkRequest` d'un contexte de run ouvert directement par un test (`openRunContext`, `launchAgentBrowser`). */
export const allowAllRequests = async (): Promise<boolean> => true;
