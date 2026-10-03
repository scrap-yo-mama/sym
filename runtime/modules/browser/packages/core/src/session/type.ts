// SPDX-License-Identifier: AGPL-3.0-only
// Type effectif d'une session (cdc/sym-browser 03 § 3, 04 § 3, 04f § 1) : `dedicated` par défaut ; une session demandée
// `shared` bascule automatiquement en `dedicated` quand une option l'exige (profil persistant, `launchArgs` ; extensions
// en V1.1). Le type effectif est celui de la réponse (`Session.type`). Partagé par la passerelle (création, tâche 2.2) et
// le nœud (tâche 1.4).
import { DEFAULT_SESSION_TYPE, type CreateSessionRequest, type SessionType } from '@sym/contracts/browser';

export type ResolvedSessionType = { type: SessionType; switched: boolean; reason?: 'profile' | 'launchArgs' };

export function resolveSessionType(request: Pick<CreateSessionRequest, 'type' | 'profile' | 'launchArgs'>): ResolvedSessionType {
  const requested = request.type ?? DEFAULT_SESSION_TYPE;
  if (requested === 'dedicated') return { type: 'dedicated', switched: false };
  if (request.profile !== undefined) return { type: 'dedicated', switched: true, reason: 'profile' };
  if ((request.launchArgs?.length ?? 0) > 0) return { type: 'dedicated', switched: true, reason: 'launchArgs' };
  return { type: 'shared', switched: false };
}
