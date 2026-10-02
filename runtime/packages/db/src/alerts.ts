// SPDX-License-Identifier: AGPL-3.0-only
// Alertes SMTP (tâche 2.5, 08 § 5) : réglages, regroupement, envoi.
// - Réglages d'instance dans `settings` : `smtp` (le mot de passe est un secret chiffré, INV8, jamais dans `settings`) et
//   `alerts` (destinataires, fenêtre de regroupement, langue, base d'URL de la console, cible webhook par défaut).
// - Une seule alerte externe par API et par cause, agrégée sur la fenêtre : le premier événement met en file un job retardé
//   de la fenêtre (clé d'unicité `alert:<api>:<cause>`, politique `short`) ; les suivants, tant qu'il attend, sont écartés ;
//   au départ du job, l'e-mail résume les transitions de la fenêtre.
// - L'alerte d'instance par défaut s'applique à toute API sans règle propre (pas de cible webhook du propriétaire abonnée à
//   `api.status_changed`). Une planification dont `alert_on` ne contient pas `status_change` n'alerte pas.
// - Le relais SMTP passe par la garde SSRF en politique `operator-config` (08b § 1 : réglé par l'admin, privé permis,
//   métadonnées cloud refusées ; `sendMail`). Échec définitif (auth, SSRF, adresse) : pas de relance ; échec transitoire
//   (délai, connexion, 4xx) : pg-boss relance.
// - L'e-mail cite le run de la transition (`status_events.run_id`) ou celui porté par le job, jamais « le dernier run » de
//   l'API (un run lancé pendant la fenêtre de regroupement ne le remplace pas).
// - « Marquer comme attendu » (08 § 5, 04 § 6 : exclure un run de la base de calcul) n'est pas livré ici : la base de calcul
//   des signaux de run dégradé (`volume_anomaly`…) n'existe pas encore ; reporté à la tâche qui la calcule (voir README).
import {
  alertCauseForTransition,
  alertGroupKey,
  DEFAULT_ALERT_WINDOW_SECONDS,
  quietPeriodMs,
  renderAlertEmail,
  type AlertCause,
  type AlertDigest,
  type AlertLocale,
  type ApiStatus,
  type JobQueue,
  type QueryClient,
  type QueueDefinition,
} from '@runtime/core';
import { isMailAddress, sendMail, SmtpError, type SmtpConfig, type SmtpSecurity, type SsrfGuard } from '@runtime/core/net';
import type pg from 'pg';
import { schedulePeriodMs, type ScheduleRow } from './schedules.js';
import type { SecretStore } from './webhooks.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export const ALERT_QUEUE = 'alert-email';
/** Politique `short` : un seul job en attente par clé (regroupement) ; trois reprises pour les échecs transitoires. */
export function alertQueueDefinition(): QueueDefinition {
  return { name: ALERT_QUEUE, expireInSeconds: 120, heartbeatSeconds: 30, retryLimit: 3, policy: 'short' };
}

export type AlertJob = {
  api_id: string;
  cause: AlertCause;
  /** Début de la fenêtre (ISO). */
  since: string;
  /** Run de l'événement qui a ouvert la fenêtre (transition ou échec de run planifié). */
  run_id?: string | null;
};

export const SMTP_SETTING = 'smtp';
export const ALERTS_SETTING = 'alerts';

export class AlertConfigError extends Error {
  override name = 'AlertConfigError';
  /** Code d'erreur stable de la route de réglage (`invalid_smtp` par défaut, `password_required` : secret à ressaisir). */
  readonly code: string;

  constructor(message: string, code = 'invalid_smtp') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------------------------------------------

export type SmtpSettings = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password_secret_id: string | null;
  from: string;
  helo: string | null;
  /** Dernier test réussi (« non testé » tant qu'il ne l'a pas été). */
  tested_at: string | null;
  /**
   * Auteur du dernier changement (tâche 3.7, INV5) : un relais réglé par un admin suspend 24 h les liens de
   * réinitialisation par e-mail des comptes sans 2FA (`smtpResetHoldActive`). Absent : réglage d'avant 3.7.
   */
  changed_by_role?: SmtpChangedBy['role'];
  changed_by?: string | null;
  changed_at?: string;
};

/**
 * Auteur d'un changement du relais SMTP : `owner` ou `admin` (route de réglage, tâche 3.1), `operator` (commande
 * serveur, tests). Obligatoire : un relais choisi par un admin verrait passer les liens de réinitialisation (INV5).
 */
export type SmtpChangedBy = { userId: string | null; role: 'owner' | 'admin' | 'operator' };

/** Durée pendant laquelle un relais SMTP réglé par un admin ne transporte aucun lien de réinitialisation d'un compte sans 2FA. */
export const SMTP_ADMIN_CHANGE_HOLD_HOURS = 24;

export type AlertSettings = {
  to: string[];
  window_seconds: number;
  locale: AlertLocale;
  base_url: string | null;
  /** Cible webhook de l'alerte d'instance par défaut (alternative ou complément à l'e-mail). */
  webhook_subscription_id: string | null;
};

const SECURITIES: readonly SmtpSecurity[] = ['tls', 'starttls', 'none'];
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;

async function readSetting<T>(db: Queryable, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function writeSetting(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Enregistre le relais SMTP de l'instance. Le mot de passe est chiffré avant l'écriture (secret d'instance). */
export async function saveSmtpSettings(
  db: Queryable,
  store: SecretStore,
  input: { host: string; port: number; security: SmtpSecurity; username?: string; password?: string; from: string; helo?: string; /** Mot de passe absent : garder celui en place (même identifiant, même hôte et même port, route de réglage 3.1). */ keepPassword?: boolean },
  changedBy: SmtpChangedBy,
): Promise<SmtpSettings> {
  const previous = await readSetting<SmtpSettings>(db, SMTP_SETTING);
  // Mot de passe gardé seulement pour le MÊME relais (hôte et port) et le même identifiant (INV8) : un mot de passe ne part
  // jamais, par AUTH, vers un autre relais que celui pour lequel il a été saisi.
  const sameRelay = previous !== null && previous.host === input.host.toLowerCase() && previous.port === input.port;
  const keepable = input.password === undefined && input.keepPassword === true && previous !== null && previous.username !== null && previous.username === (input.username ?? null);
  const kept = keepable && sameRelay ? previous.password_secret_id : null;
  if (!HOST.test(input.host)) throw new AlertConfigError('smtp.host : nom d\'hôte invalide');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new AlertConfigError('smtp.port : 1 à 65535');
  if (!SECURITIES.includes(input.security)) throw new AlertConfigError(`smtp.security : ${SECURITIES.join(' | ')}`);
  if (!isMailAddress(input.from)) throw new AlertConfigError('smtp.from : adresse invalide');
  if (input.username !== undefined && input.security === 'none') throw new AlertConfigError('smtp : identifiants refusés sans TLS');
  if (input.username !== undefined && (input.password ?? '') === '' && kept === null) {
    throw keepable && previous?.password_secret_id
      ? new AlertConfigError('smtp.password : hôte ou port changé, ressaisissez le mot de passe', 'password_required')
      : new AlertConfigError('smtp.password : requis avec un identifiant');
  }
  const passwordSecretId =
    input.password === undefined ? kept : await store.put({ ownerId: null, kind: 'smtp_password', label: `smtp ${input.host}`, value: input.password });
  const settings: SmtpSettings = {
    host: input.host.toLowerCase(),
    port: input.port,
    security: input.security,
    username: input.username ?? null,
    password_secret_id: passwordSecretId,
    from: input.from,
    helo: input.helo ?? null,
    tested_at: null,
    changed_by_role: changedBy.role,
    changed_by: changedBy.userId,
    changed_at: new Date().toISOString(),
  };
  await writeSetting(db, SMTP_SETTING, settings);
  // Ancien mot de passe remplacé ou retiré : sa ligne `secrets` disparaît (aucun matériel de clé inutile).
  if (previous?.password_secret_id && previous.password_secret_id !== passwordSecretId) await db.query('DELETE FROM secrets WHERE id = $1 AND owner_id IS NULL', [previous.password_secret_id]);
  return settings;
}

/**
 * Vrai si le relais SMTP a été réglé par un admin il y a moins de `SMTP_ADMIN_CHANGE_HOLD_HOURS` : un admin qui
 * pointerait l'instance vers son propre relais ne lit pas le lien de réinitialisation d'un compte sans 2FA (INV5,
 * « administrer n'est pas accéder » ; même règle que le lien copiable, réservé aux comptes à 2FA). L'owner, la
 * commande serveur et un réglage d'avant 3.7 ne suspendent rien.
 */
export async function smtpResetHoldActive(db: Queryable, now: Date = new Date()): Promise<boolean> {
  const s = await readSetting<SmtpSettings>(db, SMTP_SETTING);
  if (!s || s.changed_by_role === undefined || s.changed_by_role === 'owner' || s.changed_by_role === 'operator') return false;
  const at = Date.parse(s.changed_at ?? '');
  // Date illisible : échec fermé (suspendu).
  return !Number.isFinite(at) || now.getTime() - at < SMTP_ADMIN_CHANGE_HOLD_HOURS * 3_600_000;
}

export async function saveAlertSettings(db: Queryable, input: Partial<AlertSettings> & { to: readonly string[] }): Promise<AlertSettings> {
  if (input.to.length > 20 || !input.to.every(isMailAddress)) throw new AlertConfigError('alerts.to : 20 adresses valides au plus');
  const window = input.window_seconds ?? DEFAULT_ALERT_WINDOW_SECONDS;
  if (!Number.isInteger(window) || window < 0 || window > 86_400) throw new AlertConfigError('alerts.window_seconds : 0 à 86400');
  const settings: AlertSettings = {
    to: [...input.to],
    window_seconds: window,
    locale: input.locale === 'fr' ? 'fr' : 'en',
    base_url: input.base_url ?? null,
    webhook_subscription_id: input.webhook_subscription_id ?? null,
  };
  await writeSetting(db, ALERTS_SETTING, settings);
  return settings;
}

export async function loadAlertSettings(db: Queryable): Promise<AlertSettings | null> {
  return readSetting<AlertSettings>(db, ALERTS_SETTING);
}

/** Configuration d'envoi (mot de passe ouvert à l'instant de l'usage). `null` : SMTP non configuré. */
export async function loadSmtpConfig(db: Queryable, store: SecretStore): Promise<SmtpConfig | null> {
  const s = await readSetting<SmtpSettings>(db, SMTP_SETTING);
  if (!s) return null;
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    from: s.from,
    ...(s.username !== null ? { username: s.username } : {}),
    ...(s.password_secret_id !== null ? { password: await store.get(s.password_secret_id) } : {}),
    ...(s.helo !== null ? { helo: s.helo } : {}),
  };
}

export type AlertContext = {
  pool: pg.Pool;
  queue: JobQueue;
  store: SecretStore;
  guard: SsrfGuard;
  now?: () => Date;
  /** Autorités supplémentaires du relais (certificat privé) : tests et relais internes. */
  smtpCa?: string[];
};

/** « Tester » le SMTP : envoie un message au destinataire demandé, renseigne `tested_at` en cas de succès. */
export async function testSmtp(ctx: AlertContext, to: string): Promise<{ ok: true } | { ok: false; code: string; smtpCode: number | null }> {
  const config = await loadSmtpConfig(ctx.pool, ctx.store);
  if (!config) return { ok: false, code: 'not_configured', smtpCode: null };
  try {
    await sendMail({ ...config, ...(ctx.smtpCa ? { ca: ctx.smtpCa } : {}) }, { to: [to], subject: '[Scrapyomama] SMTP test', text: 'Test message from your Scrapyomama instance.\n' }, { guard: ctx.guard });
  } catch (error) {
    if (error instanceof SmtpError) return { ok: false, code: error.code, smtpCode: error.smtpCode };
    const blocked = (error as { code?: unknown } | null)?.code === 'ssrf_blocked';
    return { ok: false, code: blocked ? 'ssrf_blocked' : 'connect', smtpCode: null };
  }
  await ctx.pool.query(
    "UPDATE settings SET value = jsonb_set(value, '{tested_at}', to_jsonb(now()::text)), updated_at = now() WHERE key = $1",
    [SMTP_SETTING],
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Mise en file (regroupement)
// ---------------------------------------------------------------------------------------------------------------

type ApiRef = { id: string; owner_id: string; slug: string };

/** L'API a une règle propre : une cible webhook active de son propriétaire est abonnée à `api.status_changed`. */
async function hasOwnStatusRule(db: Queryable, ownerId: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM webhook_subscriptions WHERE owner_id = $1 AND status = 'active' AND 'api.status_changed' = ANY(events) LIMIT 1", [ownerId]);
  return (rowCount ?? 0) > 0;
}

/** `alert_on` de la planification qui a produit le run : null si le run n'est pas planifié ou si la liste est absente. */
async function scheduleAlertOn(db: Queryable, runId: string | null | undefined): Promise<readonly string[] | null | 'unscheduled'> {
  if (!runId) return 'unscheduled';
  const { rows } = await db.query<{ schedule_id: string | null; alert_on: string[] | null }>(
    `SELECT r.schedule_id, CASE WHEN jsonb_typeof(s.rules -> 'alert_on') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(s.rules -> 'alert_on')) END AS alert_on
     FROM runs r LEFT JOIN schedules s ON s.id = r.schedule_id WHERE r.id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row || row.schedule_id === null) return 'unscheduled';
  return row.alert_on;
}

export type QueueAlertInput = { api: ApiRef; cause: AlertCause; since: Date; runId?: string | null };

/**
 * Met l'alerte en file si l'instance a un destinataire, si l'API n'a pas de règle propre et si la planification d'origine
 * l'autorise. Regroupement : un seul job en attente par (API, cause). Rend vrai si un nouveau job a été créé.
 */
export async function queueAlert(tx: Queryable, queue: JobQueue, input: QueueAlertInput): Promise<boolean> {
  const settings = await loadAlertSettings(tx);
  if (!settings || settings.to.length === 0) return false;
  if (!(await readSetting<SmtpSettings>(tx, SMTP_SETTING))) return false;
  const alertOn = await scheduleAlertOn(tx, input.runId);
  if (input.cause === 'run_failed') {
    // Seulement pour un run planifié dont la planification le demande.
    if (alertOn === 'unscheduled' || alertOn === null || !alertOn.includes('error')) return false;
  } else {
    if (alertOn !== 'unscheduled' && alertOn !== null && !alertOn.includes('status_change')) return false;
    if (await hasOwnStatusRule(tx, input.api.owner_id)) return false;
  }
  const job: AlertJob = { api_id: input.api.id, cause: input.cause, since: input.since.toISOString(), run_id: input.runId ?? null };
  const id = await queue.enqueueOnce(ALERT_QUEUE, job, {
    singletonKey: alertGroupKey(input.api.id, input.cause),
    startAfterSeconds: settings.window_seconds,
    tx: tx as QueryClient,
  });
  return id !== null;
}

export type StatusTransition = { from: ApiStatus | null; to: ApiStatus; reason: string | null; at: Date };

/** Alertes d'une série de transitions : une cause actionnable par transition (les autres n'alertent pas). */
export async function queueStatusAlerts(tx: Queryable, queue: JobQueue, input: { api: ApiRef; runId?: string | null; transitions: readonly StatusTransition[] }): Promise<number> {
  let created = 0;
  for (const t of input.transitions) {
    const cause = alertCauseForTransition(t.to);
    if (cause === null) continue;
    if (await queueAlert(tx, queue, { api: input.api, cause, since: t.at, ...(input.runId !== undefined ? { runId: input.runId } : {}) })) created += 1;
  }
  return created;
}

// ---------------------------------------------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------------------------------------------

/** Résultat journalisé par le worker : un compteur de destinataires, jamais leurs adresses (données personnelles). */
export type AlertSendResult = { sent: true; recipients: number } | { sent: false; reason: string };

/** Échecs que rejouer ne corrige pas : l'admin doit agir (réglages). */
const FINAL_SMTP_FAILURES = new Set(['ssrf_blocked', 'auth', 'insecure_auth', 'invalid_message', 'tls']);

/**
 * Départ du job : résume la fenêtre et envoie UN e-mail. Lève pour les échecs transitoires (pg-boss relance) ; rend
 * `sent: false` quand rien n'est à faire ou que l'admin doit corriger quelque chose.
 */
export async function sendAlertEmail(ctx: AlertContext, job: AlertJob): Promise<AlertSendResult> {
  const settings = await loadAlertSettings(ctx.pool);
  const config = await loadSmtpConfig(ctx.pool, ctx.store);
  if (!settings || settings.to.length === 0 || !config) return { sent: false, reason: 'not_configured' };
  const { rows: apiRows } = await ctx.pool.query<{ slug: string; status: ApiStatus }>('SELECT slug, status FROM apis WHERE id = $1', [job.api_id]);
  const api = apiRows[0];
  if (!api) return { sent: false, reason: 'api_missing' };

  const transitions: AlertDigest['transitions'] = [];
  let warningSince: string | null = null;
  let runId: string | null = job.run_id ?? null;
  if (job.cause.startsWith('status_')) {
    const to = job.cause.slice('status_'.length);
    const { rows } = await ctx.pool.query<{ from_status: ApiStatus | null; to_status: ApiStatus; reason: string | null; at: Date; run_id: string | null }>(
      'SELECT from_status, to_status, reason, at, run_id FROM status_events WHERE api_id = $1 AND to_status = $2 AND at >= $3 ORDER BY id',
      [job.api_id, to, job.since],
    );
    // Statut déjà quitté avant l'envoi (retour à sain pendant la fenêtre) : l'alerte n'a plus d'objet.
    if (rows.length === 0 || api.status !== to) return { sent: false, reason: 'resolved_before_send' };
    for (const r of rows) transitions.push({ from: r.from_status, to: r.to_status, reason: r.reason, at: r.at.toISOString() });
    // Le run de la dernière transition de la fenêtre qui en nomme un (sinon celui du job).
    runId = [...rows].reverse().find((r) => r.run_id !== null)?.run_id ?? runId;
  } else if (job.cause === 'warning_stale') {
    if (api.status !== 'warning') return { sent: false, reason: 'resolved_before_send' };
    warningSince = job.since;
  }
  if (runId === null && job.cause === 'warning_stale') {
    // Un warning qui dure n'a pas de run déclencheur : le dernier run exécuté de l'API, pour le contexte.
    const { rows } = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM runs WHERE api_id = $1 AND state NOT LIKE 'skipped\\_%' ORDER BY created_at DESC LIMIT 1",
      [job.api_id],
    );
    runId = rows[0]?.id ?? null;
  }
  const run =
    runId === null
      ? undefined
      : (await ctx.pool.query<{ id: string; failure_class: string | null }>('SELECT id, failure_class FROM runs WHERE id = $1 AND api_id = $2', [runId, job.api_id])).rows[0];
  const digest: AlertDigest = {
    api: api.slug,
    api_id: job.api_id,
    cause: job.cause,
    transitions,
    run_id: run?.id ?? null,
    failure_class: run?.failure_class ?? null,
    base_url: settings.base_url,
    warning_since: warningSince,
  };
  const message = renderAlertEmail(digest, settings.locale);
  try {
    await sendMail({ ...config, ...(ctx.smtpCa ? { ca: ctx.smtpCa } : {}) }, { to: settings.to, subject: message.subject, text: message.text }, { guard: ctx.guard });
  } catch (error) {
    const code = error instanceof SmtpError ? error.code : (error as { code?: unknown } | null)?.code === 'ssrf_blocked' ? 'ssrf_blocked' : null;
    if (code !== null && FINAL_SMTP_FAILURES.has(code)) return { sent: false, reason: code };
    // Refus définitif du relais (5xx) : rejouer ne change rien.
    if (error instanceof SmtpError && error.code === 'rejected' && error.smtpCode !== null && error.smtpCode >= 500) return { sent: false, reason: 'rejected' };
    throw error;
  }
  return { sent: true, recipients: settings.to.length };
}

// ---------------------------------------------------------------------------------------------------------------
// `warning` qui dure au-delà de D
// ---------------------------------------------------------------------------------------------------------------

/**
 * Une alerte par épisode de `warning` qui dépasse D = max(7 j, 3 × période de planification). Atomique entre workers :
 * `apis.warning_alerted_at` n'est posé que par celui qui gagne la ligne. Rend les API alertées.
 */
export async function checkLongWarnings(ctx: { pool: pg.Pool; queue: JobQueue; now?: () => Date }): Promise<string[]> {
  const now = (ctx.now ?? (() => new Date()))();
  const { rows } = await ctx.pool.query<ApiRef & { entered_at: Date }>(
    `SELECT a.id, a.owner_id, a.slug, e.at AS entered_at
     FROM apis a
     JOIN LATERAL (SELECT at FROM status_events WHERE api_id = a.id AND to_status = 'warning' ORDER BY id DESC LIMIT 1) e ON true
     WHERE a.status = 'warning' AND (a.warning_alerted_at IS NULL OR a.warning_alerted_at < e.at)`,
  );
  const alerted: string[] = [];
  for (const api of rows) {
    const { rows: schedules } = await ctx.pool.query<Pick<ScheduleRow, 'cron' | 'timezone' | 'enabled'>>('SELECT cron, timezone, enabled FROM schedules WHERE api_id = $1', [api.id]);
    const delay = quietPeriodMs(schedulePeriodMs(ctx.queue, schedules, now));
    if (now.getTime() - api.entered_at.getTime() < delay) continue;
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        'UPDATE apis SET warning_alerted_at = $2 WHERE id = $1 AND (warning_alerted_at IS NULL OR warning_alerted_at < $3) RETURNING id',
        [api.id, now, api.entered_at],
      );
      if (claim.rowCount === 1) {
        await queueAlert(client, ctx.queue, { api, cause: 'warning_stale', since: api.entered_at });
        alerted.push(api.id);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return alerted;
}
