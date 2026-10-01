// SPDX-License-Identifier: AGPL-3.0-only
// Réglages de sécurité et SSO de l'instance (13 § 5, § 7, § 13.1), dans `settings`. Écriture par l'owner seul.
// Le secret du client OIDC est un secret d'instance chiffré (INV8, `secrets`) : `settings.sso` n'en garde que
// l'identifiant ; il n'est jamais relu par l'API (écriture seule).
import { API_KEY_MAX_LIFETIME_DAYS, type GroupRole } from '@runtime/core';
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

const SECURITY_SETTING = 'security';
const SSO_SETTING = 'sso';

export type SecuritySettings = {
  /** Inactivité (13 § 5 : 12 h, « à valider ») ; 5 min à 12 h. */
  session_idle_minutes: number;
  /** Durée absolue (7 jours) ; 1 h à 30 jours. */
  session_absolute_hours: number;
  /** Domaines autorisés pour les invitations et la création à la volée (vide : tous). */
  allowed_email_domains: string[];
  /** Plafond de durée des clés d'API (13 § 8 : 365 jours, « à valider »). */
  api_key_max_lifetime_days: number;
  /** Rétention du journal d'audit (13 § 9 : 12 mois). */
  audit_retention_months: number;
};

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  session_idle_minutes: 12 * 60,
  session_absolute_hours: 7 * 24,
  allowed_email_domains: [],
  api_key_max_lifetime_days: API_KEY_MAX_LIFETIME_DAYS,
  audit_retention_months: 12,
};

const SESSION_IDLE_MAX_MINUTES = 12 * 60;
const SESSION_ABSOLUTE_MAX_HOURS = 30 * 24;

const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class SettingsError extends Error {
  override name = 'SettingsError';
}

/** Valide et normalise ; lève `SettingsError` (champ en cause, jamais de valeur). */
function validateSecuritySettings(input: SecuritySettings): SecuritySettings {
  const int = (v: number, min: number, max: number, field: string) => {
    if (!Number.isInteger(v) || v < min || v > max) throw new SettingsError(`${field} : entier de ${min} à ${max}`);
    return v;
  };
  const domains = [...new Set(input.allowed_email_domains.map((d) => d.trim().toLowerCase()))];
  if (domains.length > 100 || !domains.every((d) => DOMAIN.test(d))) throw new SettingsError('allowed_email_domains : 100 noms de domaine au plus');
  return {
    session_idle_minutes: int(input.session_idle_minutes, 5, SESSION_IDLE_MAX_MINUTES, 'session_idle_minutes'),
    session_absolute_hours: int(input.session_absolute_hours, 1, SESSION_ABSOLUTE_MAX_HOURS, 'session_absolute_hours'),
    allowed_email_domains: domains,
    api_key_max_lifetime_days: int(input.api_key_max_lifetime_days, 1, API_KEY_MAX_LIFETIME_DAYS, 'api_key_max_lifetime_days'),
    audit_retention_months: int(input.audit_retention_months ?? DEFAULT_SECURITY_SETTINGS.audit_retention_months, 1, 120, 'audit_retention_months'),
  };
}

/** Cache par connexion (une instance = un pool) : 2 s, vidé à chaque écriture par la route de l'owner. */
const cache = new WeakMap<Queryable, { at: number; value: SecuritySettings }>();
const CACHE_MS = 2000;

/** Réglages courants (défauts de 13 § 5 si absents), mis en cache 2 s : relus par le garde à chaque requête. */
export async function readSecuritySettings(db: Queryable, opts: { fresh?: boolean } = {}): Promise<SecuritySettings> {
  const hit = cache.get(db);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows } = await db.query<{ value: Partial<SecuritySettings> }>('SELECT value FROM settings WHERE key = $1', [SECURITY_SETTING]);
  const value = { ...DEFAULT_SECURITY_SETTINGS, ...(rows[0]?.value ?? {}) };
  cache.set(db, { at: Date.now(), value });
  return value;
}

export async function writeSecuritySettings(db: Queryable, input: SecuritySettings): Promise<SecuritySettings> {
  const value = validateSecuritySettings(input);
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SECURITY_SETTING, JSON.stringify(value)],
  );
  cache.delete(db);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// SSO (OIDC générique, un fournisseur en V1)
// ---------------------------------------------------------------------------------------------------------------

export type SsoSettings = {
  enabled: boolean;
  slug: string;
  label: string;
  issuer_url: string;
  client_id: string;
  /** Identifiant du secret chiffré (jamais rendu par l'API). */
  client_secret_id: string | null;
  sso_required: boolean;
  jit_provisioning: { enabled: boolean; domains: string[] };
  group_roles: GroupRole[];
};

export async function readSsoSettings(db: Queryable): Promise<SsoSettings | null> {
  const { rows } = await db.query<{ value: SsoSettings }>('SELECT value FROM settings WHERE key = $1', [SSO_SETTING]);
  return rows[0]?.value ?? null;
}

export async function writeSsoSettings(db: Queryable, value: SsoSettings): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SSO_SETTING, JSON.stringify(value)],
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Valide un réglage SSO saisi par l'owner ; `owner` n'est jamais attribuable par un groupe (schéma : member | admin). */
export function validateSso(input: Omit<SsoSettings, 'client_secret_id'>): Omit<SsoSettings, 'client_secret_id'> {
  if (!SLUG.test(input.slug)) throw new SettingsError('slug : [a-z0-9-], 32 signes au plus');
  let issuer: URL;
  try {
    issuer = new URL(input.issuer_url);
  } catch {
    throw new SettingsError('issuer_url : URL invalide');
  }
  if (issuer.protocol !== 'https:' && issuer.protocol !== 'http:') throw new SettingsError('issuer_url : https attendu');
  if (issuer.username || issuer.password || issuer.hash || issuer.search) throw new SettingsError('issuer_url : ni identifiants, ni requête, ni fragment');
  if (input.client_id.trim() === '') throw new SettingsError('client_id : requis');
  const domains = [...new Set(input.jit_provisioning.domains.map((d) => d.trim().toLowerCase()))];
  if (!domains.every((d) => DOMAIN.test(d))) throw new SettingsError('jit_provisioning.domains : noms de domaine attendus');
  // 13 § 7 : création à la volée « activable avec liste de domaines ». Sans liste, un IdP public (Google…) ouvrirait
  // l'instance à toute adresse vérifiée.
  if (input.jit_provisioning.enabled && domains.length === 0) throw new SettingsError('jit_provisioning.domains : au moins un domaine');
  for (const g of input.group_roles) {
    if (g.role !== 'member' && g.role !== 'admin') throw new SettingsError('group_roles : rôle member ou admin seulement (owner jamais attribuable)');
    if (g.group.trim() === '' || g.group.length > 256) throw new SettingsError('group_roles : nom de groupe requis');
  }
  return {
    enabled: input.enabled,
    slug: input.slug,
    label: input.label.trim() || input.slug,
    issuer_url: issuer.href,
    client_id: input.client_id.trim(),
    sso_required: input.sso_required,
    jit_provisioning: { enabled: input.jit_provisioning.enabled, domains },
    group_roles: input.group_roles.map((g) => ({ group: g.group.trim(), role: g.role })),
  };
}
