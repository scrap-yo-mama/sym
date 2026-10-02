// SPDX-License-Identifier: AGPL-3.0-only
// Réglages d'identité du robot (tâche 3.8b, 17 §5) : écriture des réglages admin `identify_instance` et `instance_contact`
// (lus par le worker : `readIdentifyInstanceSetting`, `readInstanceContactSetting`), et moteur embarqué publié par le worker
// (`robot_engine`, version de Chromium et plateforme réelle) pour que la console affiche le User-Agent réel en lecture seule.
// La validation du contact (`normalizeInstanceContact`) est faite par l'appelant : ici, aucune règle, seulement le stockage.
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

const ROBOT_ENGINE_SETTING = 'robot_engine';

/** Écrit `identify_instance` (booléen). Le réglage l'emporte sur `IDENTIFY_INSTANCE`, dans les deux sens. */
async function writeIdentifyInstanceSetting(db: Queryable, enabled: boolean): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('identify_instance', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(enabled)],
  );
}

/** Écrit `instance_contact` (contact déjà normalisé) ; `null` efface le réglage (repli : `INSTANCE_CONTACT`). */
export async function writeInstanceContactSetting(db: Queryable, contact: string | null): Promise<void> {
  if (contact === null) {
    await db.query("DELETE FROM settings WHERE key = 'instance_contact'");
    return;
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('instance_contact', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(contact)],
  );
}

/**
 * Écrit les réglages d'identité fournis, dans UNE transaction (tout ou rien) : l'interrupteur `identify_instance` et/ou le contact
 * `instance_contact` (déjà normalisé ; `null` l'efface). La transaction est ouverte ici, pas par la route (une route n'ouvre pas de
 * connexion système, assert_routes_use_rls).
 */
export async function writeRobotIdentitySettings(pool: pg.Pool, input: { identifyInstance?: boolean; contact?: string | null }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.identifyInstance !== undefined) await writeIdentifyInstanceSetting(client, input.identifyInstance);
    if (input.contact !== undefined) await writeInstanceContactSetting(client, input.contact);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Moteur embarqué tel que le worker le publie : version de Chromium et plateforme réelle (`process.platform`). */
export type RobotEngineSetting = { readonly version: string; readonly platform: string };

/** Publié par le worker au démarrage (best-effort) : la console en tire le User-Agent réel, sans embarquer de navigateur. */
export async function publishRobotEngine(db: Queryable, engine: RobotEngineSetting): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ROBOT_ENGINE_SETTING, JSON.stringify({ version: engine.version, platform: engine.platform })],
  );
}

/** Dernier moteur publié par un worker ; `null` si aucun worker n'a encore démarré. */
export async function readRobotEngine(db: Queryable): Promise<RobotEngineSetting | null> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [ROBOT_ENGINE_SETTING]);
  const value = rows[0]?.value as { version?: unknown; platform?: unknown } | undefined;
  return typeof value?.version === 'string' && typeof value.platform === 'string' ? { version: value.version, platform: value.platform } : null;
}
