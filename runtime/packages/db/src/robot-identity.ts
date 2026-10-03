// SPDX-License-Identifier: AGPL-3.0-only
// Réglages d'identité du robot (tâche 3.8b, 17 §5) : écriture des réglages admin `identify_instance` et `instance_contact`
// (lus par le worker : `readIdentifyInstanceSetting`, `readInstanceContactSetting`), et moteur embarqué publié par le worker
// (`robot_engine`, version de Chromium et plateforme réelle) pour que la console affiche le User-Agent réel en lecture seule.
// La validation du contact (`normalizeInstanceContact`) est faite par l'appelant : ici, aucune règle, seulement le stockage.
import type pg from 'pg';
import { appendAudit, type AuditEvent } from './audit.js';

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

/** Interrupteur tel que le worker le lit (booléen, ou `{ enabled }`) ; `null` s'il n'est pas posé ou illisible. */
function storedIdentify(value: unknown): boolean | null {
  const raw = typeof value === 'object' && value !== null && 'enabled' in value ? (value as { enabled?: unknown }).enabled : value;
  return typeof raw === 'boolean' ? raw : null;
}

/** Contact tel qu'il est stocké (chaîne, ou `{ contact }`) ; `null` s'il n'est pas posé. */
function storedContact(value: unknown): string | null {
  const raw = typeof value === 'object' && value !== null && 'contact' in value ? (value as { contact?: unknown }).contact : value;
  return typeof raw === 'string' ? raw : null;
}

/** Champ réellement modifié par une écriture des réglages d'identité (nom de l'API). */
export type RobotIdentityField = 'identify_instance' | 'instance_contact';

/**
 * Écrit les réglages d'identité fournis, dans UNE transaction (tout ou rien) : l'interrupteur `identify_instance` et/ou le contact
 * `instance_contact` (déjà normalisé ; `null` l'efface). Seuls les champs dont la valeur change sont écrits et rendus ; l'entrée
 * d'audit (`audit`, construite à partir de ces champs) est ajoutée dans la MÊME transaction : un audit impossible annule l'écriture.
 * La transaction est ouverte ici, pas par la route (une route n'ouvre pas de connexion système, assert_routes_use_rls).
 */
export async function writeRobotIdentitySettings(
  pool: pg.Pool,
  input: { identifyInstance?: boolean; contact?: string | null },
  audit?: (changed: readonly RobotIdentityField[]) => AuditEvent,
): Promise<{ changed: RobotIdentityField[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Écritures concurrentes sérialisées (les lignes peuvent ne pas encore exister : verrou consultatif de transaction).
    await client.query("SELECT pg_advisory_xact_lock(hashtext('settings.robot_identity'))");
    const { rows } = await client.query<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE key IN ('identify_instance', 'instance_contact')");
    const before = new Map(rows.map((row) => [row.key, row.value]));
    const changed: RobotIdentityField[] = [];
    if (input.identifyInstance !== undefined && storedIdentify(before.get('identify_instance')) !== input.identifyInstance) {
      await writeIdentifyInstanceSetting(client, input.identifyInstance);
      changed.push('identify_instance');
    }
    if (input.contact !== undefined && storedContact(before.get('instance_contact')) !== input.contact) {
      await writeInstanceContactSetting(client, input.contact);
      changed.push('instance_contact');
    }
    if (audit !== undefined) await appendAudit(client, audit(changed));
    await client.query('COMMIT');
    return { changed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Moteur embarqué tel que le worker le publie : version de Chromium et plateforme réelle (`process.platform`). */
export type RobotEngineSetting = { readonly version: string; readonly platform: string };

/**
 * Ce que le worker publie au démarrage : son moteur, la version qu'il annonce dans le jeton (`RUNTIME_VERSION` du worker) et les
 * replis de SON environnement (`IDENTIFY_INSTANCE`, `INSTANCE_CONTACT` normalisé ; `null` : absent ou illisible), que le serveur
 * ne voit pas. La console en déduit ce qui part réellement quand aucun réglage n'est posé.
 */
export type RobotEnginePublication = RobotEngineSetting & {
  readonly productVersion?: string;
  readonly identifyInstanceEnv?: boolean | null;
  readonly instanceContactEnv?: string | null;
  /** `INSTANCE_CONTACT` posé mais illisible (UX-05) : le worker refusera l'enquête ; `instanceContactEnv` vaut alors `null`. */
  readonly instanceContactEnvInvalid?: boolean;
};

/** Dernière publication lue : `productVersion` et `env` à `null` pour un worker qui ne les publiait pas encore. */
export type RobotEngineView = RobotEngineSetting & {
  readonly productVersion: string | null;
  readonly env: { readonly identifyInstance: boolean | null; readonly instanceContact: string | null; readonly instanceContactInvalid: boolean } | null;
};

/** Publié par le worker au démarrage (best-effort) : la console en tire le User-Agent réel, sans embarquer de navigateur. */
export async function publishRobotEngine(db: Queryable, engine: RobotEnginePublication): Promise<void> {
  const value: Record<string, unknown> = { version: engine.version, platform: engine.platform };
  if (engine.productVersion !== undefined) value['product_version'] = engine.productVersion;
  if (engine.identifyInstanceEnv !== undefined || engine.instanceContactEnv !== undefined) {
    value['env'] = { identify_instance: engine.identifyInstanceEnv ?? null, instance_contact: engine.instanceContactEnv ?? null, ...(engine.instanceContactEnvInvalid === true ? { instance_contact_invalid: true } : {}) };
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ROBOT_ENGINE_SETTING, JSON.stringify(value)],
  );
}

/** Dernier moteur publié par un worker ; `null` si aucun worker n'a encore démarré. */
export async function readRobotEngine(db: Queryable): Promise<RobotEngineView | null> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [ROBOT_ENGINE_SETTING]);
  const value = rows[0]?.value as { version?: unknown; platform?: unknown; product_version?: unknown; env?: { identify_instance?: unknown; instance_contact?: unknown; instance_contact_invalid?: unknown } } | undefined;
  if (typeof value?.version !== 'string' || typeof value.platform !== 'string') return null;
  const env = typeof value.env === 'object' && value.env !== null ? value.env : null;
  return {
    version: value.version,
    platform: value.platform,
    productVersion: typeof value.product_version === 'string' ? value.product_version : null,
    env:
      env === null
        ? null
        : {
            identifyInstance: typeof env.identify_instance === 'boolean' ? env.identify_instance : null,
            instanceContact: typeof env.instance_contact === 'string' ? env.instance_contact : null,
            instanceContactInvalid: env.instance_contact_invalid === true,
          },
  };
}
