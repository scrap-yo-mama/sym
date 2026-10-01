// SPDX-License-Identifier: AGPL-3.0-only
// Actions proposées sur une ligne d'utilisateur (aide de présentation ; le serveur applique la hiérarchie, 13 § 2).
import { describe, expect, test } from 'vitest';
import { visibleNav } from '@/lib/nav';
import { ROLE_PERMISSIONS } from '@/testing/permissions';
import { actionsFor, type Target, type Viewer } from './user-actions';

const owner: Viewer = { id: 'o', role: 'owner', canSetRole: true };
const admin: Viewer = { id: 'a', role: 'admin', canSetRole: false };
const member = (over: Partial<Target> = {}): Target => ({ id: 'm', role: 'member', status: 'active', mfa_enabled: true, ...over });

describe('actionsFor', () => {
  test('l’owner agit sur un membre actif : rôle, désactivation, accès, 2FA, lien', () => {
    expect(actionsFor(owner, member())).toEqual(['makeAdmin', 'disable', 'revokeAccess', 'resetTwoFactor', 'resetLink']);
    expect(actionsFor(owner, member({ role: 'admin' }))).toEqual(['makeMember', 'disable', 'revokeAccess', 'resetTwoFactor', 'resetLink']);
  });

  test('un compte sans 2FA n’a ni réinitialisation de 2FA ni lien copiable (le serveur exige la 2FA)', () => {
    expect(actionsFor(owner, member({ mfa_enabled: false }))).toEqual(['makeAdmin', 'disable', 'revokeAccess']);
  });

  test('un compte désactivé se réactive ou se supprime ; rien d’autre', () => {
    expect(actionsFor(admin, member({ status: 'disabled', mfa_enabled: false }))).toEqual(['enable', 'delete']);
  });

  test('un admin ne change pas de rôle ; sur un autre admin il révoque seulement les accès', () => {
    expect(actionsFor(admin, member())).toEqual(['disable', 'revokeAccess', 'resetTwoFactor', 'resetLink']);
    expect(actionsFor(admin, member({ role: 'admin' }))).toEqual(['revokeAccess']);
  });

  test('personne n’agit sur soi-même ni sur l’owner (transfert d’abord)', () => {
    expect(actionsFor(owner, member({ id: owner.id }))).toEqual([]);
    expect(actionsFor(admin, member({ role: 'owner' }))).toEqual([]);
    expect(actionsFor(owner, member({ role: 'owner', id: 'autre' }))).toEqual([]);
  });

  test('aucune action ne donne accès au contenu d’un autre compte (INV5) : le catalogue d’actions est fermé', () => {
    const all = new Set([...actionsFor(owner, member()), ...actionsFor(owner, member({ status: 'disabled' })), ...actionsFor(owner, member({ role: 'admin' }))]);
    expect([...all].sort()).toEqual(['delete', 'disable', 'enable', 'makeAdmin', 'makeMember', 'resetLink', 'resetTwoFactor', 'revokeAccess']);
  });
});

describe('visibleNav : Utilisateurs et Audit selon can()', () => {
  const canOf = (role: keyof typeof ROLE_PERMISSIONS) => (permission: Parameters<Parameters<typeof visibleNav>[0]>[0]) => ROLE_PERMISSIONS[role].includes(permission);
  const labels = (role: keyof typeof ROLE_PERMISSIONS, mustEnroll = false) => visibleNav(canOf(role), mustEnroll).map((entry) => entry.label);

  test('un membre ne voit ni Utilisateurs ni Audit', () => {
    expect(labels('member')).toEqual(['nav.home', 'nav.catalog', 'nav.newApi', 'nav.runs', 'nav.account', 'nav.settings']);
  });

  test('un admin et l’owner voient Utilisateurs et Audit', () => {
    for (const role of ['admin', 'owner'] as const) expect(labels(role)).toEqual(expect.arrayContaining(['nav.users', 'nav.audit']));
  });

  test('enrôlement 2FA exigé : aucune entrée', () => {
    expect(labels('owner', true)).toEqual([]);
  });
});
