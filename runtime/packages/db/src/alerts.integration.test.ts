// SPDX-License-Identifier: AGPL-3.0-only
// Alertes SMTP sur base réelle (tâche 2.5, 08 § 5, 08 § 7) : réglages chiffrés, alerte actionnable (api, run,
// failure_class, lien console), un run dégradé isolé n'alerte pas, regroupement sur une fenêtre (une alerte par API et par
// cause), règle propre de l'API, `alert_on`, `warning` au-delà de D, échecs SMTP définitifs et transitoires.
import { randomBytes, randomUUID } from 'node:crypto';
import { generateMasterKey, MasterKey, secretValues, type Keyring } from '@runtime/core';
import { createSsrfPolicy, SsrfGuard } from '@runtime/core/net';
import pg from 'pg';
import { TestClock } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startFakeSmtp, type FakeSmtp } from '../../../tests/helpers/smtp-server.js';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import {
  ALERT_QUEUE,
  alertQueueDefinition,
  checkLongWarnings,
  loadSmtpConfig,
  queueAlert,
  saveAlertSettings,
  saveSmtpSettings,
  sendAlertEmail,
  testSmtp,
  type AlertContext,
  type AlertJob,
} from './alerts.js';
import { migrateUp } from './migrate.js';
import { notifyRunFinished, notifyStatusChange, toStatusTransitions } from './notify.js';
import { PgBossJobQueue } from './queue.js';
import { runQueueDefinition } from './runs.js';
import { keyCheck, secretStore } from './secrets.js';
import { applyStatusTransition } from './status.js';
import { createWebhookSubscription, webhookDeliveryQueueDefinition } from './webhooks.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
let store: ReturnType<typeof secretStore>;
let smtp: FakeSmtp;
const A = randomUUID();
const ADMIN = randomUUID();
const guard = new SsrfGuard({ policy: createSsrfPolicy({ allowedPrivateHosts: ['127.0.0.0/8'], allowedPorts: [80, 443] }) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Réglage écrit hors console (commande serveur, tests) : sans effet sur la réinitialisation par e-mail (tâche 3.7). */
const OPERATOR = { userId: null, role: 'operator' } as const;
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const DAY = 86_400_000;

beforeAll(async () => {
  tdb = await createTestDatabase('alerts');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 6 });
  for (const [id, email] of [[A, 'zz_test_a@example.test'], [ADMIN, 'zz_test_admin@example.test']] as const) {
    await pool.query("INSERT INTO users (id, email, status) VALUES ($1, $2, 'active')", [id, email]);
  }
  const keyring: Keyring = { current: MasterKey.parse(generateMasterKey()) };
  store = secretStore(pool, keyring, await keyCheck(pool, keyring));
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 3, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
  await queue.createQueue(alertQueueDefinition());
  await queue.createQueue(webhookDeliveryQueueDefinition());
});

afterAll(async () => {
  secretValues.clear();
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

beforeEach(async () => {
  smtp = await startFakeSmtp();
  await pool.query('DELETE FROM settings WHERE key IN ($1, $2)', ['smtp', 'alerts']);
  await pool.query('DELETE FROM webhook_deliveries');
  await pool.query('DELETE FROM webhook_subscriptions');
  await pool.query('DELETE FROM schedules');
});

afterEach(async () => {
  await smtp.close();
});

const ctx = (over: Partial<AlertContext> = {}): AlertContext => ({ pool, queue, store, guard, now: () => NOW, ...over });
async function configure(over: { window?: number; to?: string[]; baseUrl?: string | null } = {}) {
  await saveSmtpSettings(pool, store, { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'alerts@scrapyomama.zz-test' }, OPERATOR);
  await saveAlertSettings(pool, { to: over.to ?? ['admin@example.zz-test'], window_seconds: over.window ?? 120, locale: 'en', base_url: over.baseUrl === undefined ? 'https://runtime.example' : over.baseUrl });
}
async function api(status: string, slug = `zz_test_${randomBytes(4).toString('hex')}`): Promise<string> {
  return (await pool.query<{ id: string }>('INSERT INTO apis (slug, owner_id, status) VALUES ($1, $2, $3) RETURNING id', [slug, A, status])).rows[0]!.id;
}
async function failedRun(apiId: string, failureClass = 'extraction', scheduleId: string | null = null): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, outcome, failure_class, retryable, schedule_id, finished_at)
       VALUES ($1, $2, $2, $3, 'failed', 'failed', $4, false, $5, now()) RETURNING id`,
      [apiId, A, scheduleId ? 'schedule' : 'rest', failureClass, scheduleId],
    )
  ).rows[0]!.id;
}
/** Applique un événement de statut et annonce les transitions dans la même transaction (comme le fera l'exécuteur). */
const transition = (apiId: string, event: Parameters<typeof applyStatusTransition>[1]['event'], at: Date = NOW, runId?: string) => {
  let alerts = 0;
  return applyStatusTransition(pool, {
    apiId,
    ...(runId ? { runId } : {}),
    event,
    clock: { now: () => at },
    afterTransition: async (client, events) => {
      alerts = (await notifyStatusChange(client, queue, { apiId, ...(runId ? { runId } : {}), transitions: toStatusTransitions(events) }, { now: () => at })).alerts;
    },
  }).then((result) => ({ result, alerts }));
};

describe('réglages', () => {
  test('mot de passe SMTP chiffré (secret d\'instance), jamais dans `settings` ni ailleurs en clair (INV8)', async () => {
    const canary = `zz_test_smtp_${randomBytes(8).toString('hex')}`;
    await saveSmtpSettings(pool, store, { host: 'smtp.example.zz-test', port: 587, security: 'starttls', username: 'alerts', password: canary, from: 'alerts@scrapyomama.zz-test' }, OPERATOR);
    const hits = await pool.query<{ t: string }>(
      `SELECT 'settings' AS t FROM settings WHERE strpos(value::text, $1) > 0
       UNION ALL SELECT 'secrets' FROM secrets WHERE strpos(to_jsonb(secrets)::text, $1) > 0 OR position(convert_to($1, 'UTF8') in ciphertext) > 0`,
      [canary],
    );
    expect(hits.rows).toEqual([]);
    const secret = (await pool.query<{ kind: string; owner_id: string | null }>("SELECT kind, owner_id FROM secrets WHERE kind = 'smtp_password'")).rows[0];
    expect(secret).toEqual({ kind: 'smtp_password', owner_id: null });
    const config = await loadSmtpConfig(pool, store);
    expect(config?.password?.reveal()).toBe(canary);
    expect(String(config?.password)).toBe('[REDACTED]');
    expect(JSON.stringify(config)).not.toContain(canary);
  });

  test('validation : hôte, port, sécurité, expéditeur, identifiants hors TLS, destinataires, fenêtre', async () => {
    const ok = { host: 'smtp.example.zz-test', port: 587, security: 'starttls' as const, from: 'a@b.zz-test' };
    await expect(saveSmtpSettings(pool, store, { ...ok, host: 'bad host; DROP' }, OPERATOR)).rejects.toThrow('hôte');
    await expect(saveSmtpSettings(pool, store, { ...ok, port: 70000 }, OPERATOR)).rejects.toThrow('port');
    await expect(saveSmtpSettings(pool, store, { ...ok, security: 'ssl' as never }, OPERATOR)).rejects.toThrow('security');
    await expect(saveSmtpSettings(pool, store, { ...ok, from: 'pas une adresse' }, OPERATOR)).rejects.toThrow('from');
    await expect(saveSmtpSettings(pool, store, { ...ok, security: 'none', username: 'u', password: 'p' }, OPERATOR)).rejects.toThrow('sans TLS');
    await expect(saveSmtpSettings(pool, store, { ...ok, username: 'u' }, OPERATOR)).rejects.toThrow('password');
    await expect(saveAlertSettings(pool, { to: ['x\r\nBcc: y@z.zz-test'] })).rejects.toThrow('alerts.to');
    await expect(saveAlertSettings(pool, { to: ['a@b.zz-test'], window_seconds: -1 })).rejects.toThrow('window_seconds');
    expect(await loadSmtpConfig(pool, store)).toBeNull();
  });

  test('« Tester » le SMTP : message reçu, `tested_at` renseigné ; en échec, code sans détail sensible', async () => {
    await configure();
    expect(await testSmtp(ctx(), 'admin@example.zz-test')).toEqual({ ok: true });
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]!.headers['subject']).toBe('[Scrapyomama] SMTP test');
    expect((await pool.query("SELECT value ->> 'tested_at' AS t FROM settings WHERE key = 'smtp'")).rows[0].t).not.toBeNull();

    await smtp.close();
    smtp = await startFakeSmtp({ rejectRcpt: ['refuse@example.zz-test'] });
    await configure();
    expect(await testSmtp(ctx(), 'refuse@example.zz-test')).toMatchObject({ ok: false, code: 'rejected' });
    // Relais réglé par l'admin (operator-config) : métadonnées cloud refusées, sans détail sensible.
    await saveSmtpSettings(pool, store, { host: '169.254.169.254', port: smtp.port, security: 'none', from: 'alerts@scrapyomama.zz-test' }, OPERATOR);
    expect(await testSmtp(ctx({ guard: new SsrfGuard() }), 'admin@example.zz-test')).toEqual({ ok: false, code: 'ssrf_blocked', smtpCode: null });
  });
});

describe('alertes actionnables', () => {
  test('assert_alert_actionable : API sans règle → erreur : e-mail avec api, run, failure_class et lien console ; un run dégradé isolé n\'alerte pas', async () => {
    await configure();
    const id = await api('reparation', 'zz_test_annonces');
    const run = await failedRun(id, 'extraction');
    const { result, alerts } = await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' }, NOW, run);
    expect(result.ok && result.state.status).toBe('erreur');
    expect(alerts).toBe(1);

    const sent = await sendAlertEmail(ctx(), { api_id: id, cause: 'status_erreur', since: NOW.toISOString() });
    // Le résultat est journalisé par le worker : un compteur, jamais les adresses des destinataires (données personnelles).
    expect(sent).toEqual({ sent: true, recipients: 1 });
    expect(JSON.stringify(sent)).not.toContain('@');
    expect(smtp.mails).toHaveLength(1);
    const mail = smtp.mails[0]!;
    expect(mail.to).toEqual(['admin@example.zz-test']);
    expect(mail.headers['subject']).toBe('[Scrapyomama] zz_test_annonces: needs attention (error)');
    expect(mail.text).toContain('API: zz_test_annonces');
    expect(mail.text).toContain(`Run: ${run}`);
    expect(mail.text).toContain('Failure class: extraction');
    expect(mail.text).toContain('Console: https://runtime.example/apis/zz_test_annonces');
    expect(mail.text).toMatch(/repair_budget_exhausted/);

    // Un run dégradé isolé (sain → warning) n'alerte pas.
    const healthy = await api('sain');
    const degraded = await transition(healthy, { type: 'run_succeeded', signals: ['escalated'] });
    expect(degraded.result.ok && degraded.result.state.status).toBe('warning');
    expect(degraded.alerts).toBe(0);
  });

  test('le run cité est celui de la transition (ou du job), pas le dernier run de l\'API lancé pendant la fenêtre', async () => {
    await configure();
    const id = await api('reparation', 'zz_test_run_cite');
    const cause = await failedRun(id, 'extraction');
    expect((await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' }, NOW, cause)).alerts).toBe(1);
    // Le job mis en file porte le run de la transition.
    const queued = (await pool.query<{ data: AlertJob }>("SELECT data FROM pgboss.job WHERE name = $1 AND data->>'api_id' = $2", [ALERT_QUEUE, id])).rows;
    expect(queued.map((j) => j.data.run_id)).toEqual([cause]);
    // Pendant la fenêtre, un autre run de l'API démarre puis échoue autrement : il ne remplace pas le run de la transition.
    const later = await failedRun(id, 'transient');
    await pool.query("UPDATE runs SET created_at = now() + interval '1 minute' WHERE id = $1", [later]);
    await sendAlertEmail(ctx(), { api_id: id, cause: 'status_erreur', since: NOW.toISOString() });
    const text = smtp.mails.at(-1)!.text;
    expect(text).toContain(`Run: ${cause}`);
    expect(text).toContain('Failure class: extraction');
    expect(text).not.toContain(later);
    // Échec de run planifié : le run porté par le job, même si un autre run est plus récent.
    await sendAlertEmail(ctx(), { api_id: id, cause: 'run_failed', since: NOW.toISOString(), run_id: cause });
    expect(smtp.mails.at(-1)!.text).toContain(`Run: ${cause}`);
    expect(smtp.mails.at(-1)!.text).not.toContain(later);
  });

  test('bloquee et action_requise alertent aussi ; l\'e-mail reste factuel et ne propose aucun changement de réseau', async () => {
    await configure();
    const blocked = await api('enquete', 'zz_test_bloquee');
    const first = await transition(blocked, { type: 'run_failed', failureClass: 'blocked_by_protection' });
    expect(first.alerts).toBe(1);
    const needs = await api('enquete');
    expect((await transition(needs, { type: 'run_failed', failureClass: 'auth_required' })).alerts).toBe(1);

    await sendAlertEmail(ctx(), { api_id: blocked, cause: 'status_bloquee', since: NOW.toISOString() });
    const text = smtp.mails.at(-1)!.text;
    expect(smtp.mails.at(-1)!.headers['subject']).toContain('blocked by the site');
    expect(text).not.toMatch(/tunnel|proxy|residential|bypass|retry now/i);
    expect(text).toContain('does not change IP address after a refusal');
  });

  test('regroupement : une alerte par API et par cause sur la fenêtre, résumant toutes les transitions', async () => {
    await configure({ window: 120 });
    const id = await api('reparation', 'zz_test_groupe');
    const t0 = NOW;
    const first = await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' }, t0);
    expect(first.alerts).toBe(1);
    // Dans la fenêtre : ré-enquête manuelle puis nouvel échec → deux transitions de plus, aucune nouvelle alerte.
    await transition(id, { type: 'reinvestigate', trigger: 'manual' }, new Date(t0.getTime() + 20_000));
    const again = await transition(id, { type: 'investigation_failed', cause: 'budget_exhausted' }, new Date(t0.getTime() + 40_000));
    expect(again.alerts).toBe(0);

    await sendAlertEmail(ctx(), { api_id: id, cause: 'status_erreur', since: t0.toISOString() });
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]!.text).toContain('Transitions: 2');
    // Une autre API et une autre cause ont leur propre alerte.
    const other = await api('reparation');
    expect((await transition(other, { type: 'repair_failed', cause: 'budget_exhausted' }, t0)).alerts).toBe(1);
  });

  test('la fenêtre est tenue par la file : rien avant son terme, un seul e-mail après trois événements', async () => {
    await configure({ window: 120 });
    const id = await api('reparation', 'zz_test_fenetre');
    const clock = new TestClock(Date.now());
    const q = new PgBossJobQueue({ connectionString: tdb.url, max: 3, clock, supervise: false, application_name: 'zz_test_alert_clock' });
    let handled = 0;
    try {
      await q.start();
      await q.createQueue(alertQueueDefinition());
      await q.work<AlertJob>(ALERT_QUEUE, { concurrency: 1, pollingIntervalSeconds: 0.5 }, async (job) => {
        // Les jobs laissés par les autres tests passent aussi par ce worker : on ne compte que ceux de cette API.
        if (job.data.api_id === id) handled += 1;
        await sendAlertEmail(ctx({ queue: q }), job.data);
      });
      const at = (s: number) => new Date(NOW.getTime() + s * 1000);
      const runner = (event: Parameters<typeof applyStatusTransition>[1]['event'], when: Date) =>
        applyStatusTransition(pool, {
          apiId: id,
          event,
          clock: { now: () => when },
          afterTransition: async (client, events) => {
            await notifyStatusChange(client, q, { apiId: id, transitions: toStatusTransitions(events) }, { now: () => when });
          },
        });
      await runner({ type: 'repair_failed', cause: 'budget_exhausted' }, at(0));
      await runner({ type: 'reinvestigate', trigger: 'manual' }, at(10));
      await runner({ type: 'investigation_failed', cause: 'budget_exhausted' }, at(20));
      const step = async (ms: number) => {
        for (let t = 0; t < ms; t += 5000) {
          await clock.tick(5000);
          await sleep(20);
        }
        await sleep(300);
      };
      const mine = () => smtp.mails.filter((m) => m.headers['subject']?.includes('zz_test_fenetre'));
      await step(60_000);
      expect(handled).toBe(0);
      expect(mine()).toHaveLength(0);
      await step(90_000); // t = 150 s : la fenêtre de 120 s est close
      expect(handled).toBe(1);
      expect(mine()).toHaveLength(1);
      expect(mine()[0]!.text).toContain('Transitions: 2');
    } finally {
      await q.stop({ timeoutMs: 1000 }).catch(() => undefined);
    }
  }, 60_000);

  test('règle propre : une cible webhook du propriétaire abonnée à api.status_changed remplace l\'alerte par défaut', async () => {
    await configure();
    await createWebhookSubscription(pool, store, guard, { ownerId: A, url: 'http://127.0.0.1/hook', events: ['api.status_changed'] });
    const id = await api('reparation');
    const { alerts } = await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' });
    expect(alerts).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE event = 'api.status_changed'")).rows[0].n).toBe(1);
  });

  test('alerte d\'instance par défaut en webhook : livrée à la cible désignée par l\'admin, sans e-mail', async () => {
    await saveAlertSettings(pool, { to: [], window_seconds: 0 });
    const admin = await createWebhookSubscription(pool, store, guard, { ownerId: ADMIN, url: 'http://127.0.0.1/admin-hook', events: ['run.failed'] });
    await saveAlertSettings(pool, { to: [], window_seconds: 0, webhook_subscription_id: admin.id });
    const id = await api('reparation');
    const { alerts } = await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' });
    expect(alerts).toBe(0); // pas d'e-mail : aucun destinataire
    const rows = (await pool.query<{ subscription_id: string; event: string }>("SELECT subscription_id, event FROM webhook_deliveries WHERE event = 'api.status_changed'")).rows;
    expect(rows).toEqual([{ subscription_id: admin.id, event: 'api.status_changed' }]);
    // Une transition non actionnable (warning) n'atteint pas la cible par défaut.
    const healthy = await api('sain');
    await transition(healthy, { type: 'run_succeeded', signals: ['escalated'] });
    expect((await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE event = 'api.status_changed'")).rows[0].n).toBe(1);
  });

  test('sans SMTP ou sans destinataire : aucune alerte en file', async () => {
    const id = await api('reparation');
    expect((await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' })).alerts).toBe(0);
    await saveSmtpSettings(pool, store, { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'alerts@scrapyomama.zz-test' }, OPERATOR);
    const id2 = await api('reparation');
    expect((await transition(id2, { type: 'repair_failed', cause: 'budget_exhausted' })).alerts).toBe(0);
  });

  test('alert_on d\'une planification : sans status_change, pas d\'alerte de statut ; error → alerte d\'échec de run', async () => {
    await configure();
    const id = await api('reparation');
    const insertSchedule = async (rules: unknown) =>
      (await pool.query<{ id: string }>("INSERT INTO schedules (api_id, owner_id, cron, rules) VALUES ($1, $2, '0 * * * *', $3::jsonb) RETURNING id", [id, A, JSON.stringify(rules)])).rows[0]!.id;

    const onlyItems = await insertSchedule({ alert_on: ['new_items'] });
    const runItems = await failedRun(id, 'extraction', onlyItems);
    expect((await transition(id, { type: 'repair_failed', cause: 'budget_exhausted' }, NOW, runItems)).alerts).toBe(0);

    const withStatus = await api('reparation');
    const sid = (await pool.query<{ id: string }>("INSERT INTO schedules (api_id, owner_id, cron, rules) VALUES ($1, $2, '0 * * * *', $3::jsonb) RETURNING id", [withStatus, A, JSON.stringify({ alert_on: ['status_change', 'error'] })])).rows[0]!.id;
    const run = await failedRun(withStatus, 'extraction', sid);
    expect((await transition(withStatus, { type: 'repair_failed', cause: 'budget_exhausted' }, NOW, run)).alerts).toBe(1);
    // L'échec du run planifié lui-même alerte (cause run_failed) ; sans `error` dans alert_on, jamais.
    const created = await notifyRunFinished(pool, queue, run, { now: () => NOW });
    expect(created.events).toEqual(['run.failed']);
    const noError = await notifyRunFinished(pool, queue, runItems, { now: () => NOW });
    expect(noError.events).toEqual(['run.failed']);
    await sendAlertEmail(ctx(), { api_id: withStatus, cause: 'run_failed', since: NOW.toISOString() });
    expect(smtp.mails.at(-1)!.headers['subject']).toContain('scheduled run failed');
    // Un run non planifié n'alerte jamais par e-mail pour son seul échec ; un run planifié avec `error` : oui, une seule fois.
    const manual = await failedRun(withStatus, 'extraction', null);
    const apiRef = { id: withStatus, owner_id: A, slug: 'zz_test_alert_on' };
    expect(await queueAlert(pool, queue, { api: apiRef, cause: 'run_failed', since: NOW, runId: manual })).toBe(false);
    expect(await queueAlert(pool, queue, { api: apiRef, cause: 'run_failed', since: NOW, runId: runItems })).toBe(false);
    expect(await queueAlert(pool, queue, { api: apiRef, cause: 'run_failed', since: NOW, runId: run })).toBe(false); // déjà en attente (regroupée)
  });
});

describe('warning au-delà de D', () => {
  // Les API en warning laissées par les autres tests ne doivent pas entrer dans le contrôle.
  beforeEach(async () => {
    await pool.query("UPDATE apis SET status = 'sain', warning_alerted_at = NULL WHERE status = 'warning'");
  });

  async function warningApi(since: Date, slug?: string): Promise<string> {
    const id = await api('warning', slug);
    await pool.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason, at) VALUES ($1, $2, 'sain', 'warning', 'escalated', $3)", [id, A, since]);
    return id;
  }

  test('sans planification D = 7 j : rien avant, une alerte après, jamais deux pour le même épisode', async () => {
    await configure();
    const id = await warningApi(NOW, 'zz_test_warning');
    expect(await checkLongWarnings({ pool, queue, now: () => new Date(NOW.getTime() + 6 * DAY) })).toEqual([]);
    expect(await checkLongWarnings({ pool, queue, now: () => new Date(NOW.getTime() + 8 * DAY) })).toEqual([id]);
    expect(await checkLongWarnings({ pool, queue, now: () => new Date(NOW.getTime() + 9 * DAY) })).toEqual([]);
    const sent = await sendAlertEmail(ctx(), { api_id: id, cause: 'warning_stale', since: NOW.toISOString() });
    expect(sent.sent).toBe(true);
    expect(smtp.mails[0]!.headers['subject']).toBe('[Scrapyomama] zz_test_warning : warning for too long');
    expect(smtp.mails[0]!.text).toContain('In warning since');
  });

  test('planification hebdomadaire : D = 21 j', async () => {
    await configure();
    const id = await warningApi(NOW);
    await pool.query("INSERT INTO schedules (api_id, owner_id, cron) VALUES ($1, $2, '0 8 * * 1')", [id, A]);
    expect(await checkLongWarnings({ pool, queue, now: () => new Date(NOW.getTime() + 8 * DAY) })).toEqual([]);
    expect(await checkLongWarnings({ pool, queue, now: () => new Date(NOW.getTime() + 22 * DAY) })).toEqual([id]);
  });

  test('nouvel épisode de warning : nouvelle alerte possible ; épisode résolu avant l\'envoi : rien n\'est envoyé', async () => {
    await configure();
    const id = await warningApi(NOW);
    await checkLongWarnings({ pool, queue, now: () => new Date(NOW.getTime() + 8 * DAY) });
    await pool.query("UPDATE apis SET status = 'sain' WHERE id = $1", [id]);
    expect(await sendAlertEmail(ctx(), { api_id: id, cause: 'warning_stale', since: NOW.toISOString() })).toEqual({ sent: false, reason: 'resolved_before_send' });
    // Nouvel épisode, 20 jours plus tard.
    const later = new Date(NOW.getTime() + 20 * DAY);
    await pool.query("UPDATE apis SET status = 'warning' WHERE id = $1", [id]);
    await pool.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason, at) VALUES ($1, $2, 'sain', 'warning', 'escalated', $3)", [id, A, later]);
    expect(await checkLongWarnings({ pool, queue, now: () => new Date(later.getTime() + 8 * DAY) })).toEqual([id]);
  });

  test('deux workers en même temps : une seule alerte (le gagnant de la ligne)', async () => {
    await configure();
    const id = await warningApi(NOW);
    const at = () => new Date(NOW.getTime() + 8 * DAY);
    const results = await Promise.all([checkLongWarnings({ pool, queue, now: at }), checkLongWarnings({ pool, queue, now: at }), checkLongWarnings({ pool, queue, now: at })]);
    expect(results.flat()).toEqual([id]);
  });
});

describe('échecs SMTP', () => {
  const job = (apiId: string): AlertJob => ({ api_id: apiId, cause: 'status_erreur', since: NOW.toISOString() });
  async function erroredApi(): Promise<string> {
    const id = await api('erreur');
    await pool.query("INSERT INTO status_events (api_id, owner_id, from_status, to_status, reason, at) VALUES ($1, $2, 'reparation', 'erreur', 'repair_budget_exhausted', $3)", [id, A, NOW]);
    return id;
  }

  test('non configuré, API supprimée, statut déjà quitté : rien n\'est envoyé, pas d\'erreur', async () => {
    const id = await erroredApi();
    expect(await sendAlertEmail(ctx(), job(id))).toEqual({ sent: false, reason: 'not_configured' });
    await configure();
    expect(await sendAlertEmail(ctx(), job(randomUUID()))).toEqual({ sent: false, reason: 'api_missing' });
    await pool.query("UPDATE apis SET status = 'sain' WHERE id = $1", [id]);
    expect(await sendAlertEmail(ctx(), job(id))).toEqual({ sent: false, reason: 'resolved_before_send' });
    expect(smtp.mails).toHaveLength(0);
  });

  test('échecs définitifs (SSRF, destinataires refusés en 5xx) : pas de relance ; échec transitoire (relais coupé) : relancé par la file', async () => {
    const id = await erroredApi();
    await configure();
    // Relais réglé par l'admin (operator-config, 08b § 1) : boucle locale permise même sous une garde stricte ; métadonnées cloud refusées.
    expect(await sendAlertEmail(ctx({ guard: new SsrfGuard() }), job(id))).toEqual({ sent: true, recipients: 1 });
    await saveSmtpSettings(pool, store, { host: '169.254.169.254', port: smtp.port, security: 'none', from: 'alerts@scrapyomama.zz-test' }, OPERATOR);
    expect(await sendAlertEmail(ctx({ guard: new SsrfGuard() }), job(id))).toEqual({ sent: false, reason: 'ssrf_blocked' });
    await configure();
    // Relais coupé : l'erreur remonte, la file (retryLimit 3) rejoue.
    await smtp.close();
    await expect(sendAlertEmail(ctx(), job(id))).rejects.toMatchObject({ code: 'connect' });
    smtp = await startFakeSmtp({ rejectRcpt: ['admin@example.zz-test'] });
    await configure();
    expect(await sendAlertEmail(ctx(), job(id))).toEqual({ sent: false, reason: 'rejected' });
    expect(alertQueueDefinition()).toMatchObject({ retryLimit: 3, policy: 'short' });
  });
});
