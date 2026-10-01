// SPDX-License-Identifier: AGPL-3.0-only
// Actions proposées sur une ligne de la liste des utilisateurs. Ce n'est qu'une aide de présentation : elle évite de montrer un
// bouton qui répondrait toujours 403. Le serveur applique la hiérarchie à chaque requête, en base (13 § 2, « règles de
// hiérarchie ») ; aucune de ces actions ne donne accès au contenu d'un autre compte (INV5, A3).
import type { Role } from '@/lib/roles';

export type UserAction = 'makeAdmin' | 'makeMember' | 'disable' | 'enable' | 'delete' | 'revokeAccess' | 'resetTwoFactor' | 'resetLink';

export type Viewer = { id: string; role: Role; canSetRole: boolean };
export type Target = { id: string; role: Role; status: 'invited' | 'active' | 'disabled'; mfa_enabled: boolean };

/**
 * Actions utiles de `viewer` sur `target`, dans l'ordre d'affichage. Personne n'agit sur soi-même ni sur l'owner (transfert d'abord) ;
 * un admin ne peut, sur un autre admin, que fermer les sessions et révoquer clés et jetons ; seul l'owner change un rôle.
 */
export function actionsFor(viewer: Viewer, target: Target): UserAction[] {
  if (target.id === viewer.id || target.role === 'owner') return [];
  const actions: UserAction[] = [];
  const adminOnAdmin = viewer.role !== 'owner' && target.role === 'admin';
  if (!adminOnAdmin) {
    if (viewer.canSetRole && target.status === 'active') actions.push(target.role === 'admin' ? 'makeMember' : 'makeAdmin');
    if (target.status === 'active') actions.push('disable');
    if (target.status === 'disabled') actions.push('enable', 'delete');
  }
  if (target.status === 'active') actions.push('revokeAccess');
  if (!adminOnAdmin && target.status === 'active' && target.mfa_enabled) actions.push('resetTwoFactor', 'resetLink');
  return actions;
}
