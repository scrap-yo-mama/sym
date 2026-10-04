// SPDX-License-Identifier: AGPL-3.0-only
// Journal d'audit (13 § 9) : ajout seul. Écrit sous `runtime_app` (INSERT seul, ni SELECT, ni UPDATE, ni DELETE).
// `meta` passe par `redact` (couche 3) puis perd toute clé au nom sensible : ni secret, ni cookie, ni jeton (INV8).
import { redact, REDACTED } from '@runtime/core';
import type pg from 'pg';
import { assertCodesOnly } from './codes-only.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type AuditEvent = {
  actorUserId: string | null;
  actorVia: 'ui' | 'apikey' | 'mcp' | 'sso' | 'system' | 'extension';
  /** Référence non secrète de l'acteur (ex. préfixe de clé `sy_live_xxxx`). */
  actorRef?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: 'success' | 'denied' | 'error';
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
};

/** Noms de champs dont la valeur n'entre jamais dans `meta` (13 § 9 : « nom du champ, jamais la valeur »). */
const SENSITIVE_KEY = /secret|token|passw|cookie|authorization|ciphertext|nonce|^key$|api_?key$|key_?hash|dek/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? REDACTED : scrub(v)]));
}

/** Méta d'audit nettoyée (exportée pour les tests d'INV8). */
export function auditMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
  return scrub(redact(meta)) as Record<string, unknown>;
}

/** Ajoute une ligne à `audit_events`. `db` doit être une transaction `withActor` (rôle `runtime_app`). */
export async function appendAudit(db: Queryable, event: AuditEvent): Promise<void> {
  // `action` et `meta` : code et paramètres, jamais une phrase (21b § 1, `assert_audit_export_codes_only`).
  assertCodesOnly('audit_events', { action: event.action, meta: event.meta ?? {} });
  await db.query(
    `INSERT INTO audit_events (actor_user_id, actor_via, actor_ref, action, target_type, target_id, outcome, ip, user_agent, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      event.actorUserId,
      event.actorVia,
      event.actorRef ?? null,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      event.outcome,
      event.ip ?? null,
      event.userAgent ? event.userAgent.slice(0, 512) : null,
      JSON.stringify(auditMeta(event.meta)),
    ],
  );
}
