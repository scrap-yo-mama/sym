// SPDX-License-Identifier: AGPL-3.0-only
// Multilingue côté base (tâche 3.20, 21b § 1) sur base réelle : migration 0020 (aller-retour compris), `runs.locale` posée par
// le déclencheur (le rôle applicatif ne lit pas `users`), événements et audit en codes seulement, RGPD des champs de langue
// et de fuseau (`users.locale`, `users.timezone`, `invitations.locale`, 17 § 6 : export, effacement, `assert_erasure_complete`).
import { randomBytes, randomUUID } from 'node:crypto';
import { PersonalValueRegistry } from '@runtime/core';
import { defaultI18n, findRenderedSentences, sentenceMatcher, type Catalog } from '@runtime/i18n';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { deleteOrAnonymizeUser } from './accounts.js';
import { appendAudit } from './audit.js';
import { RENDERED_SENTENCE_REMOVED, RenderedSentenceError } from './codes-only.js';
import { appendInvestigationEvent } from './investigation-events.js';
import { loadMigrations, migrateDown, migrateUp } from './migrate.js';
import { PgBossJobQueue } from './queue.js';
import { eraseSubject, exportSubject } from './retention/index.js';
import { appendRunLog, createRunLogger } from './run-logs.js';
import { withActor } from './rls.js';
import { createRun, recordSkippedRun, runQueueDefinition } from './runs.js';

let tdb: TestDatabase;
let pool: pg.Pool;
let queue: PgBossJobQueue;
const ALICE = randomUUID();
const BOB = randomUUID();
let apiId: string;
const asAlice = { userId: ALICE, role: 'member' as const };
const asBob = { userId: BOB, role: 'member' as const };

beforeAll(async () => {
  tdb = await createTestDatabase('i18n');
  await migrateUp({ connectionString: tdb.url });
  pool = new pg.Pool({ connectionString: tdb.url, max: 4 });
  await pool.query("INSERT INTO users (id, email, status, locale, timezone) VALUES ($1, 'zz_test_alice@example.test', 'active', 'fr', 'Europe/Paris'), ($2, 'zz_test_bob@example.test', 'active', 'en', NULL)", [ALICE, BOB]);
  apiId = (await pool.query<{ id: string }>("INSERT INTO apis (slug, owner_id, visibility) VALUES ('zz_test_shared', $1, 'instance') RETURNING id", [ALICE])).rows[0]!.id;
  queue = new PgBossJobQueue({ connectionString: tdb.url, max: 2, supervise: false });
  await queue.start();
  await queue.createQueue(runQueueDefinition());
});
afterAll(async () => {
  await queue?.stop({ timeoutMs: 1000 });
  await pool?.end();
  await tdb?.drop();
});

const localeOf = async (runId: string) => (await pool.query<{ locale: string }>('SELECT locale FROM runs WHERE id = $1', [runId])).rows[0]?.locale;

describe('migration 0020_i18n', () => {
  test('colonnes, formats et valeurs par défaut', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE (table_name, column_name) IN (('users','timezone'),('invitations','locale'),('runs','locale'))",
    );
    expect(cols.rows.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`).sort()).toEqual(['invitations.locale:NO', 'runs.locale:NO', 'users.timezone:YES']);
    // La liste fermée ('en', 'fr') est remplacée par un format : une 3e langue n'exige aucune migration (M14).
    await pool.query("UPDATE users SET locale = 'qaa' WHERE id = $1", [BOB]);
    await expect(pool.query("UPDATE users SET locale = 'FR' WHERE id = $1", [BOB])).rejects.toThrow(/users_locale_format/);
    await expect(pool.query("UPDATE users SET locale = 'fr-CA' WHERE id = $1", [BOB])).rejects.toThrow(/users_locale_format/);
    await pool.query("UPDATE users SET locale = 'en' WHERE id = $1", [BOB]);
    await expect(pool.query("UPDATE users SET timezone = 'Europe/Paris; DROP TABLE users' WHERE id = $1", [BOB])).rejects.toThrow(/users_timezone_format/);
    const invitation = await pool.query<{ locale: string }>("INSERT INTO invitations (email, role, token_hash, expires_at) VALUES ('zz_test_inv@example.test', 'member', 'h1', now() + interval '1 hour') RETURNING locale");
    expect(invitation.rows[0]?.locale).toBe('en');
    await expect(pool.query("INSERT INTO invitations (email, role, token_hash, expires_at, locale) VALUES ('zz_test_inv2@example.test', 'member', 'h2', now() + interval '1 hour', 'Français')")).rejects.toThrow(/invitations_locale_format/);
  });

  test('une montée de version n’écrit aucune donnée : aucune ligne de settings ajoutée (la langue de l’instance est écrite par l’application)', async () => {
    const db = await createTestDatabase('i18n_nodata');
    try {
      const target = loadMigrations().find((m) => m.name === 'i18n')!.version;
      await migrateUp({ connectionString: db.url, migrations: loadMigrations().filter((m) => m.version < target) });
      const p = new pg.Pool({ connectionString: db.url });
      await p.query("INSERT INTO users (email, role, status, locale) VALUES ('zz_test_o@example.test', 'owner', 'active', 'fr')");
      const before = (await p.query('SELECT count(*)::int AS n FROM settings')).rows[0]?.n;
      await migrateUp({ connectionString: db.url });
      expect((await p.query('SELECT count(*)::int AS n FROM settings')).rows[0]?.n).toBe(before);
      expect((await p.query('SELECT locale FROM users')).rows).toEqual([{ locale: 'fr' }]);
      await p.end();
    } finally {
      await db.drop();
    }
  }, 120_000);

  test('aller-retour : down retire les colonnes et restaure la liste fermée, up les remet', async () => {
    const db = await createTestDatabase('i18n_roundtrip');
    try {
      await migrateUp({ connectionString: db.url });
      const p = new pg.Pool({ connectionString: db.url });
      await p.query("INSERT INTO users (email, status, locale) VALUES ('zz_test_q@example.test', 'active', 'qaa')");
      const target = loadMigrations().find((m) => m.name === 'i18n')!.version;
      await migrateDown({ connectionString: db.url, steps: loadMigrations().length - (target - 1) });
      const cols = await p.query("SELECT 1 FROM information_schema.columns WHERE (table_name, column_name) IN (('users','timezone'),('invitations','locale'),('runs','locale'))");
      expect(cols.rowCount).toBe(0);
      // Une langue hors de la liste fermée est ramenée à `en` avant la CHECK d'origine.
      expect((await p.query("SELECT locale FROM users WHERE email = 'zz_test_q@example.test'")).rows).toEqual([{ locale: 'en' }]);
      await expect(p.query("UPDATE users SET locale = 'qaa'")).rejects.toThrow(/users_locale_check/);
      await p.end();
      await migrateUp({ connectionString: db.url });
    } finally {
      await db.drop();
    }
  }, 180_000);
});

describe('M6 : runs.locale', () => {
  test('assert_run_locale_recorded : la langue de l’appelant au lancement, posée même si le rôle applicatif ne lit pas users', async () => {
    const alice = await withActor(pool, asAlice, (tx) => createRun(tx, queue, { apiId, ownerId: ALICE, trigger: 'rest' }));
    const bob = await withActor(pool, asBob, (tx) => createRun(tx, queue, { apiId, ownerId: BOB, trigger: 'rest' }));
    expect(await localeOf(alice.runId)).toBe('fr');
    expect(await localeOf(bob.runId)).toBe('en');
    // Le rôle applicatif ne lit pas `users` : seul le déclencheur (SECURITY DEFINER) connaît la langue.
    await expect(withActor(pool, asAlice, (tx) => tx.query('SELECT locale FROM users'))).rejects.toThrow(/permission denied/);
    // Changer de langue après le lancement ne réécrit pas le run déjà créé.
    await pool.query("UPDATE users SET locale = 'en' WHERE id = $1", [ALICE]);
    expect(await localeOf(alice.runId)).toBe('fr');
    const later = await withActor(pool, asAlice, (tx) => createRun(tx, queue, { apiId, ownerId: ALICE, trigger: 'rest' }));
    expect(await localeOf(later.runId)).toBe('en');
    await pool.query("UPDATE users SET locale = 'fr' WHERE id = $1", [ALICE]);
  });

  test('assert_run_locale_recorded : le run prend la langue de son propriétaire (l’appelant, ou le propriétaire de la planification), jamais celle du propriétaire de l’API partagée ; run « skipped » compris', async () => {
    // Bob lance l'API partagée d'Alice : la langue du run est celle de Bob (propriétaire du run = appelant ou de la planification).
    const bobOnAlicesApi = await withActor(pool, asBob, (tx) => createRun(tx, queue, { apiId, ownerId: BOB, trigger: 'rest' }));
    expect(await localeOf(bobOnAlicesApi.runId)).toBe('en');
    const skipped = await withActor(pool, asAlice, (tx) => recordSkippedRun(tx, { apiId, ownerId: ALICE, trigger: 'schedule', state: 'skipped_overlap', reason: 'overlap_queue_full' }));
    expect(await localeOf(skipped)).toBe('fr');
  });

  test('une langue posée explicitement à l’insertion est respectée', async () => {
    const { rows } = await pool.query<{ locale: string }>(
      "INSERT INTO runs (api_id, owner_id, api_owner_id, trigger, state, locale) VALUES ($1, $2, $2, 'rest', 'queued', 'qaa') RETURNING locale",
      [apiId, BOB],
    );
    expect(rows[0]?.locale).toBe('qaa');
  });
});

describe('M5 : événements et audit en codes seulement', () => {
  test('assert_events_store_codes_only : une ligne de récit refuse une phrase rendue du catalogue, accepte un code et ses paramètres', async () => {
    const { runId } = await withActor(pool, asAlice, (tx) => createRun(tx, queue, { apiId, ownerId: ALICE, trigger: 'rest', kind: 'investigation' }));
    // Étape 0 obligatoire avant tout essai (1.11) ; ici seulement des événements de récit.
    const ok = await appendInvestigationEvent(pool, { runId, ownerId: ALICE, kind: 'phase.started', payload: { run_id: runId, phase: 'access_check', budget: { spent_usd: 0 } } });
    expect(ok.seq).toBe(1);
    const { renderer } = defaultI18n();
    const sentence = renderer.render('narrative.investigation_started', { domain: 'books.example' }, 'fr');
    await expect(appendInvestigationEvent(pool, { runId, ownerId: ALICE, kind: 'investigation.started', payload: { detail: sentence } })).rejects.toBeInstanceOf(RenderedSentenceError);
    await expect(appendInvestigationEvent(pool, { runId, ownerId: ALICE, kind: 'investigation.started', payload: { nested: { list: [`${sentence} fin`] } } })).rejects.toThrow(/phrase rendue/);
    // Chemin de l'enquête (mode scrub) : un détail d'erreur de tiers qui recoupe le catalogue ne fait pas échouer l'écriture (ni
    // finishFailed) ; la ligne porte un code à la place et les chemins refusés sont rendus pour être journalisés.
    const kept = await appendInvestigationEvent(pool, { runId, ownerId: ALICE, kind: 'investigation.finished', payload: { outcome: 'failed', detail: `Error: ${sentence}` } }, { onRenderedSentence: 'scrub' });
    expect(kept.scrubbed).toEqual(['$.detail']);
    const keptRow = await pool.query<{ payload: Record<string, unknown> }>('SELECT payload FROM investigation_events WHERE run_id = $1 AND seq = $2', [runId, kept.seq]);
    expect(keptRow.rows[0]?.payload).toEqual({ outcome: 'failed', detail: RENDERED_SENTENCE_REMOVED });
    // Non-régression (assert_events_codes_only_ignores_collected_data) : l'échantillon collecté (schema.proposed.sample) et le schéma proposé sont des DONNÉES du site, jamais contrôlées
    // comme des phrases, même quand un texte du site recoupe le catalogue (page de connexion, FAQ).
    const siteLine = renderer.render('narrative.investigation_started', { domain: 'shop.example' }, 'en');
    const sample = [{ title: 'How to reset your password on Amazon' }, { title: 'FAQ: Too many attempts, try again later.' }, { title: 'Le compte est inactif.' }, { title: siteLine }];
    const proposed = await appendInvestigationEvent(pool, {
      runId,
      ownerId: ALICE,
      kind: 'schema.proposed',
      payload: { run_id: runId, ok: true, output_schema: { type: 'object', properties: { title: { type: 'string', description: siteLine } } }, sample },
    });
    expect(proposed.seq).toBeGreaterThan(1);
    const stored = JSON.stringify((await pool.query('SELECT payload FROM investigation_events WHERE run_id = $1', [runId])).rows);
    expect(stored).not.toContain('books.example');
  });

  test('assert_audit_export_codes_only : appendAudit refuse une phrase rendue dans action ou meta', async () => {
    const sentence = defaultI18n().renderer.render('srv.error.not_ready', {}, 'en');
    await expect(withActor(pool, asAlice, (tx) => appendAudit(tx, { actorUserId: ALICE, actorVia: 'ui', action: 'zz.test', outcome: 'error', meta: { message: sentence } }))).rejects.toBeInstanceOf(RenderedSentenceError);
    await withActor(pool, asAlice, (tx) => appendAudit(tx, { actorUserId: ALICE, actorVia: 'ui', action: 'zz.test', outcome: 'error', meta: { reason: 'blocked_by_protection', n: 3 } }));
    expect((await pool.query("SELECT meta FROM audit_events WHERE action = 'zz.test'")).rows).toEqual([{ meta: { reason: 'blocked_by_protection', n: 3 } }]);
  });
});

describe('RGPD : users.locale, users.timezone, invitations.locale (17 § 6)', () => {
  const key = randomBytes(32);
  const admin = { userId: null, via: 'system' as const };
  let carol: string;
  const email = 'zz_test_carol@example.test';

  beforeAll(async () => {
    carol = (await pool.query<{ id: string }>("INSERT INTO users (email, status, locale, timezone) VALUES ($1, 'active', 'fr', 'Pacific/Auckland') RETURNING id", [email])).rows[0]!.id;
    await pool.query("INSERT INTO invitations (email, role, token_hash, expires_at, locale) VALUES ('zz_test_dan@example.test', 'member', 'hd', now() + interval '1 hour', 'fr')");
  });

  test('export_subject (portée instance) inclut langue, fuseau et langue d’invitation de la même adresse ; la portée d’un autre propriétaire n’y accède pas', async () => {
    const out = await exportSubject(pool, { values: [email, 'zz_test_dan@example.test'], key, actor: admin, scope: { instance: true } });
    expect(out.account).toEqual({ user: { locale: 'fr', timezone: 'Pacific/Auckland' }, invitations: [{ locale: 'fr', pending: true }] });
    const member = await exportSubject(pool, { values: [email], key, actor: { userId: BOB, via: 'ui' }, scope: { ownerId: BOB } });
    expect(member.account).toBeUndefined();
    // Le compte lui-même peut lire ses propres champs.
    const self = await exportSubject(pool, { values: [email], key, actor: { userId: carol, via: 'ui' }, scope: { ownerId: carol } });
    expect(self.account?.user).toEqual({ locale: 'fr', timezone: 'Pacific/Auckland' });
  });

  test('assert_erasure_complete : erase_subject supprime les invitations en attente de l’adresse et renvoie vers la suppression du compte, qui efface locale et fuseau ; 0 occurrence ensuite', async () => {
    const values = [email, 'zz_test_dan@example.test'];
    await pool.query("INSERT INTO invitations (email, role, token_hash, expires_at, locale) VALUES ($1, 'member', 'hc', now() + interval '1 hour', 'fr')", [email]);
    const plan = await eraseSubject(pool, { values, key, actor: admin, scope: { instance: true } }, { dryRun: true });
    expect(plan.dry_run).toBe(true);
    const report = await eraseSubject(pool, { values, key, actor: admin, scope: { instance: true } }, { confirm: plan.plan.confirmation });
    expect(report.account).toEqual({ invitations_deleted: 2, account_present: true });
    expect(await pool.query("SELECT 1 FROM invitations WHERE email = ANY($1::citext[])", [values])).toHaveProperty('rowCount', 0);
    // Le compte, lui, est supprimé par son propre chemin (13 § 6) : langue et fuseau disparaissent avec lui.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(['deleted', 'anonymized']).toContain(await deleteOrAnonymizeUser(client, carol, ALICE));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const left = await pool.query<{ email: string; locale: string; timezone: string | null }>('SELECT email, locale, timezone FROM users WHERE id = $1', [carol]);
    for (const row of left.rows) expect({ locale: row.locale, timezone: row.timezone, anonymous: row.email.endsWith('@deleted.invalid') }).toEqual({ locale: 'en', timezone: null, anonymous: true });
    // SQL brut : ni l'adresse ni le fuseau, nulle part dans users et invitations.
    const raw = await pool.query<{ n: string }>(
      "SELECT (SELECT count(*) FROM users WHERE to_jsonb(users)::text ~* 'carol@example|Pacific/Auckland') + (SELECT count(*) FROM invitations WHERE to_jsonb(invitations)::text ~* 'carol@example|dan@example') AS n",
    );
    expect(Number(raw.rows[0]?.n)).toBe(0);
    // `erase_subject` n'a pas touché le compte d'un autre.
    expect((await pool.query('SELECT locale, timezone FROM users WHERE id = $1', [ALICE])).rows).toEqual([{ locale: 'fr', timezone: 'Europe/Paris' }]);
  });
});

describe('M10 : journaux en codes anglais', () => {
  test('assert_logs_english_codes : 100 lignes de journal d’un run fr ne contiennent aucun texte du catalogue fr ; une phrase rendue est refusée à l’écriture', async () => {
    const { runId } = await withActor(pool, asAlice, (tx) => createRun(tx, queue, { apiId, ownerId: ALICE, trigger: 'rest' }));
    expect(await localeOf(runId)).toBe('fr');
    const personal = new PersonalValueRegistry();
    const events = ['fetch', 'robots_checked', 'llm_price_missing', 'tunnel_offline', 'items_written', 'rate_limited', 'attempt_started', 'attempt_finished'];
    for (let seq = 1; seq <= 100; seq++) await appendRunLog(pool, { runId, seq, ownerId: ALICE, level: 'info', event: `${events[seq % events.length]}`, data: { attempt: seq, network: 'direct', failure_class: seq % 7 === 0 ? 'rate_limited' : null } }, personal);
    const lines = (await pool.query<{ event: string; data: unknown }>('SELECT event, data FROM run_logs WHERE run_id = $1', [runId])).rows;
    expect(lines).toHaveLength(100);
    const matches = sentenceMatcher({ fr: defaultI18n().catalogs['fr'] as Catalog });
    for (const line of lines) expect(findRenderedSentences({ event: line.event, data: line.data }, matches)).toEqual([]);
    expect(lines.every((l) => /^[a-z][a-z0-9_.]*$/.test(l.event))).toBe(true);
    const sentence = defaultI18n().renderer.render('narrative.attempt_pruned', { n: 2 }, 'fr');
    await expect(appendRunLog(pool, { runId, seq: 101, ownerId: ALICE, level: 'warn', event: sentence, data: {} }, personal)).rejects.toBeInstanceOf(RenderedSentenceError);
    // Journal d'un run (chemin de l'enquête) : une prose de tiers qui recoupe le catalogue est remplacée par un code, l'entrée est
    // écrite (rien n'est perdu ni levé) et le refus est consigné par le nom des chemins (assert_events_codes_only_never_fails_investigation).
    const logger = await createRunLogger(pool, { runId, ownerId: ALICE, personal });
    await logger.log('warn', 'attempt_finished', { failure_class: 'extraction', detail: `TypeError: ${sentence}` });
    await logger.log('warn', sentence, {});
    expect(logger.dropped).toBe(0);
    const scrubbed = (await pool.query<{ event: string; data: Record<string, unknown> }>('SELECT event, data FROM run_logs WHERE run_id = $1 AND seq > 100 ORDER BY seq', [runId])).rows;
    expect(scrubbed).toEqual([
      { event: 'attempt_finished', data: { failure_class: 'extraction', detail: RENDERED_SENTENCE_REMOVED, codes_only_refused: ['$.data.detail'] } },
      { event: RENDERED_SENTENCE_REMOVED, data: { codes_only_refused: ['$.event'] } },
    ]);
  });
});
