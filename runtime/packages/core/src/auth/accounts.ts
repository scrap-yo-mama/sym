// SPDX-License-Identifier: AGPL-3.0-only
// Cycle de vie des comptes (13 § 2 et § 6, tâche 3.7) : jetons à usage unique (invitation, réinitialisation, appareil
// reconnu), règles de hiérarchie vérifiées côté serveur, rôle issu des groupes d'un IdP (jamais `owner`).
import { createHash, randomBytes } from 'node:crypto';
import type { Role } from './roles.js';

/** Invitation : 48 h, usage unique, adresse exacte (13 § 6). */
export const INVITATION_TTL_HOURS = 48;
/** Lien de réinitialisation : 24 h, usage unique. */
export const RESET_LINK_TTL_HOURS = 24;
/** Appareil reconnu (D-15) : 180 jours glissants. */
export const KNOWN_DEVICE_TTL_DAYS = 180;

/** Jeton opaque (256 bits) : le clair ne vit que dans le lien ou le cookie ; seule l'empreinte est stockée. */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Forme d'un jeton opaque (sinon : refus sans requête en base). */
export function isOpaqueTokenFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type AccountAction =
  /** Désactiver, réactiver, supprimer, lien de réinitialisation, réinitialisation de la 2FA. */
  | 'manage'
  /** Fermer sessions, clés et jetons de tunnel. */
  | 'revoke_access'
  /** Changer le rôle (member ↔ admin). */
  | 'set_role';

/**
 * Règles de hiérarchie (13 § 2), relues en base par l'appelant (rôle courant de l'acteur ET de la cible) :
 * - personne n'agit sur lui-même par ces routes, personne n'agit sur l'owner ;
 * - un admin gère les membres ; sur un autre admin, il ne fait que révoquer sessions, clés et jetons ;
 * - seul l'owner change un rôle (member ↔ admin).
 */
export function canActOnAccount(actor: { id: string; role: Role }, target: { id: string; role: Role }, action: AccountAction): boolean {
  if (actor.id === target.id || target.role === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (actor.role !== 'admin') return false;
  if (action === 'set_role') return false;
  if (action === 'revoke_access') return true;
  return target.role === 'member';
}

/** Rôle qu'un invitant peut proposer : `admin` seulement si l'invitant est l'owner (13 § 6). */
export function canInviteAs(inviter: Role, role: 'member' | 'admin'): boolean {
  if (inviter === 'owner') return true;
  return inviter === 'admin' && role === 'member';
}

/** Correspondance groupe d'IdP → rôle (13 § 7). `owner` n'y figure jamais. */
export type GroupRole = { group: string; role: 'member' | 'admin' };

/**
 * Rôle d'un compte OIDC d'après ses groupes : `admin` si un groupe y mène, sinon `member`. Un owner le reste : aucun
 * groupe ne donne ni ne retire `owner`. Sans table de correspondance, le rôle courant est gardé.
 */
export function roleFromGroups(current: Role | null, groups: unknown, mapping: readonly GroupRole[]): Role {
  if (current === 'owner') return 'owner';
  if (mapping.length === 0) return current ?? 'member';
  const list = Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
  return mapping.some((m) => m.role === 'admin' && list.includes(m.group)) ? 'admin' : 'member';
}

/** Domaine d'une adresse autorisé par `allowed_email_domains` (liste vide : tous). */
export function emailDomainAllowed(email: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return domains.some((d) => d.toLowerCase() === domain);
}
