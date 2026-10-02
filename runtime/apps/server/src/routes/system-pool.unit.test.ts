// SPDX-License-Identifier: AGPL-3.0-only
// Garde de régression RLS (assert_routes_use_rls) : une route ne lit ni n'écrit une table de contenu (owner_id, ou
// api_keys) par la connexion système `ctx.pool` : elle doit passer par `withActor` (runtime_app, RLS). Analyse
// statique simple des appels `ctx.pool.query(...)` de routes/*.ts. Exceptions : lectures d'authentification légitimes.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const ROUTES_DIR = new URL('./', import.meta.url);
const MIGRATION = new URL('../../../../packages/db/migrations/0003_rls_app_role/up.sql', import.meta.url);

/** Tables sous RLS, lues dans la migration qui les protège (source unique). */
function rlsTables(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const list = /FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]/.exec(sql)?.[1] ?? '';
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).concat(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY;/.exec(sql)?.[1] ?? []);
}

/**
 * Exceptions commentées (fichier → fragment SQL normalisé). Toute autre requête système sur une table sous RLS échoue.
 */
const EXCEPTIONS: Record<string, string> = {
  // Authentification par clé d'API : lecture par l'empreinte AVANT de connaître l'utilisateur (étape système).
  'guard.ts|SELECT k.id, k.user_id, k.prefix, k.scopes': 'authentification',
  // Horodatage de dernière utilisation de la clé qui vient d'être authentifiée.
  'guard.ts|UPDATE api_keys SET last_used_at = now() WHERE id = $1': 'authentification',
  // Revalidation d'un flux SSE ouvert (06 § 3) : la clé déjà authentifiée est relue (révoquée, expirée, compte, rôle).
  'guard.ts|SELECT u.role, u.status, k.scopes': 'authentification',
  // Audit `denied` d'un accès à la clé d'autrui : existence seulement, la réponse reste 404 uniforme.
  'api-keys.ts|SELECT 1 FROM api_keys WHERE id = $1': 'audit denied',
  // Même audit `denied` pour l'appareil ou le domaine connecté d'autrui (tâche 2.6) : existence seulement, 404 uniforme.
  'extension.ts|SELECT 1 FROM tunnels WHERE id = $1': 'audit denied',
  'extension.ts|SELECT 1 FROM site_sessions WHERE id = $1': 'audit denied',
  // Secret du client OIDC remplacé par l'owner (tâche 3.7) : secret d'INSTANCE (owner_id NULL), jamais celui d'un membre.
  'sso.ts|DELETE FROM secrets WHERE id = $1 AND owner_id IS NULL': 'secret d’instance remplacé',
  // Réglages d’instance de l’admin (tâche 3.1) : secrets d’INSTANCE seulement (owner_id NULL), écriture seule.
  'settings.ts|DELETE FROM secrets WHERE id = ANY($1::uuid[]) AND owner_id IS NULL': 'secret d’instance remplacé',
  'settings.ts|SELECT id FROM secrets WHERE id = ANY($1::uuid[]) AND owner_id IS NULL AND state': 'état d’un secret d’instance',
  // Suppression d’un proxy d’instance : existence d’une API (de tout membre) qui le choisit, réponse 409 sans détail.
  'settings.ts|SELECT 1 FROM apis WHERE network_policy': 'proxy utilisé (existence)',
  // Planification d'un membre sur une API qui ne lui est plus visible (tâche 3.1) : l'API n'est retrouvée que par SA
  // planification (owner_id = l'acteur), pour la lire, la désactiver ou la supprimer ; aucune fuite d'existence.
  'schedules.ts|SELECT a.id, a.slug FROM apis a JOIN schedules s ON s.api_id = a.id': 'planification orpheline de l’acteur',
};

/**
 * Transactions système (`ctx.pool.connect`) permises, tâche 3.7 : tables d'authentification (hors runtime_app, 0003)
 * et actions d'administration sur le compte d'AUTRUI (désactivation, suppression, révocations), que la RLS
 * owner_isolation rendrait vides ; chaque requête y filtre par l'identifiant de la cible.
 */
const SYSTEM_TRANSACTIONS: Record<string, string> = {
  'apis.ts': 'suppression d’une API par son propriétaire (vérifié) : runs et datasets des membres sur une API instance (tâche 3.1)',
  'auth.ts': 'réinitialisation du mot de passe : lien consommé, mot de passe, révocations du compte (13 § 5)',
  'settings.ts': 'réglage llm de l’instance, écritures sérialisées : réglage (hors RLS) et secrets d’INSTANCE abandonnés (owner_id NULL) au même COMMIT (tâche 3.1)',
  'invitations.ts': 'acceptation : invitation verrouillée, compte et identifiant créés (13 § 6)',
  'sso.ts': 'OIDC : invitation acceptée ou compte créé à la volée (13 § 7)',
  'users.ts': 'administration : désactivation, suppression, lien de réinitialisation, révocations du compte cible (13 § 6)',
};

test('assert_routes_use_rls : aucune requête système sur une table de contenu hors exceptions commentées', () => {
  const tables = rlsTables();
  expect(tables).toEqual(expect.arrayContaining(['runs', 'datasets', 'site_sessions', 'secrets', 'api_keys']));
  const offending: string[] = [];
  const used = new Set<string>();
  const usedTransactions = new Set<string>();
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const source = readFileSync(new URL(file, ROUTES_DIR), 'utf8');
    for (const m of source.matchAll(/ctx\.pool\.query(?:<[^>]*>)?\(\s*([`'"])([\s\S]*?)\1/g)) {
      const sql = m[2]!.replace(/\s+/g, ' ').trim();
      const touched = tables.filter((t) => new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${t}\\b`, 'i').test(sql));
      if (touched.length === 0) continue;
      const exception = Object.keys(EXCEPTIONS).find((k) => k.startsWith(`${file}|`) && sql.includes(k.slice(file.length + 1)));
      if (exception) used.add(exception);
      else offending.push(`${file} : ${sql.slice(0, 120)} (${touched.join(', ')})`);
    }
    // Une connexion système détournée (`const pool = ctx.pool`, `ctx.pool.connect`) échappe à l'analyse : interdite.
    if (/=\s*ctx\.pool\b/.test(source) && file !== 'setup.ts') offending.push(`${file} : ctx.pool détourné`);
    if (/ctx\.pool\.connect\(/.test(source)) {
      if (file === 'setup.ts' || SYSTEM_TRANSACTIONS[file]) usedTransactions.add(file);
      else offending.push(`${file} : ctx.pool détourné`);
    }
  }
  expect(offending).toEqual([]);
  // Une exception devenue inutile est retirée (la liste reste exacte).
  expect([...used].sort()).toEqual(Object.keys(EXCEPTIONS).sort());
  expect([...usedTransactions].filter((f) => f !== 'setup.ts').sort()).toEqual(Object.keys(SYSTEM_TRANSACTIONS).sort());
});
