// SPDX-License-Identifier: AGPL-3.0-only
// `apis.access_policy` (tâche 1.11, 17 §4, 04b §1) : politique d'accès d'une API, à côté de `network_policy`.
// `robots` n'a VOLONTAIREMENT qu'une valeur (`respect`) : un outil respectueux par conception n'expose aucun
// interrupteur d'ignorance (INV11). Les champs réservés existent pour ne pas casser le schéma en V2 ; toute valeur
// réservée est refusée en V1 (`enforce`, `train`, `ask`, `auto_under_cap`). La base porte les mêmes contraintes (CHECK
// `apis_access_policy_robots`, `apis_access_policy_payment`).

export type AccessPolicy = {
  readonly robots: 'respect';
  readonly on_ai_signal: 'warn';
  readonly intended_use: 'context';
  readonly prefer_official: boolean;
  readonly payment: { readonly mode: 'never' };
  /** Rapport d'accès de référence (04b §1). */
  readonly report_id: string | null;
  /** Contact du User-Agent : toujours celui de l'instance (`from_settings`). */
  readonly user_agent_contact: 'from_settings';
};

export const DEFAULT_ACCESS_POLICY: AccessPolicy = Object.freeze({
  robots: 'respect',
  on_ai_signal: 'warn',
  intended_use: 'context',
  prefer_official: true,
  payment: Object.freeze({ mode: 'never' as const }),
  report_id: null,
  user_agent_contact: 'from_settings',
});

export class AccessPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AccessPolicyError';
    this.code = code;
  }
}

const KEYS = new Set(['robots', 'on_ai_signal', 'intended_use', 'prefer_official', 'payment', 'report_id', 'user_agent_contact']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Politique d'accès validée, défauts appliqués. Lève `AccessPolicyError` sur tout champ inconnu ou toute valeur hors
 * V1 : en particulier `robots` autre que `respect` (il n'existe aucun moyen de l'ignorer, ni par API ni en base).
 */
export function parseAccessPolicy(raw: unknown): AccessPolicy {
  if (raw === undefined || raw === null) return DEFAULT_ACCESS_POLICY;
  if (!isRecord(raw)) throw new AccessPolicyError('invalid_access_policy', 'access_policy : objet attendu');
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new AccessPolicyError('invalid_access_policy', `access_policy : champ inconnu « ${key.slice(0, 64)} »`);
  }
  if (raw['robots'] !== undefined && raw['robots'] !== 'respect') {
    throw new AccessPolicyError('robots_respect_only', "access_policy.robots : seule la valeur « respect » existe (INV11)");
  }
  if (raw['on_ai_signal'] !== undefined && raw['on_ai_signal'] !== 'warn') {
    throw new AccessPolicyError('reserved_value', "access_policy.on_ai_signal : « warn » seul en V1 (« enforce » réservé à la V2)");
  }
  if (raw['intended_use'] !== undefined && raw['intended_use'] !== 'context') {
    throw new AccessPolicyError('reserved_value', "access_policy.intended_use : « context » seul en V1 (« train » réservé)");
  }
  if (raw['prefer_official'] !== undefined && typeof raw['prefer_official'] !== 'boolean') {
    throw new AccessPolicyError('invalid_access_policy', 'access_policy.prefer_official : booléen attendu');
  }
  const payment = raw['payment'];
  if (payment !== undefined) {
    if (!isRecord(payment) || Object.keys(payment).some((k) => k !== 'mode') || (payment['mode'] !== undefined && payment['mode'] !== 'never')) {
      throw new AccessPolicyError('reserved_value', "access_policy.payment.mode : « never » seul en V1 (aucun paiement)");
    }
  }
  const reportId = raw['report_id'];
  if (reportId !== undefined && reportId !== null && (typeof reportId !== 'string' || !UUID.test(reportId))) {
    throw new AccessPolicyError('invalid_access_policy', 'access_policy.report_id : uuid attendu');
  }
  if (raw['user_agent_contact'] !== undefined && raw['user_agent_contact'] !== 'from_settings') {
    throw new AccessPolicyError('invalid_access_policy', "access_policy.user_agent_contact : « from_settings » seul (contact de l'instance)");
  }
  return {
    ...DEFAULT_ACCESS_POLICY,
    ...(typeof raw['prefer_official'] === 'boolean' ? { prefer_official: raw['prefer_official'] } : {}),
    ...(typeof reportId === 'string' ? { report_id: reportId.toLowerCase() } : {}),
  };
}
