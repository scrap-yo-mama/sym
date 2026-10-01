// SPDX-License-Identifier: AGPL-3.0-only
// Rôle de cluster de la RLS (migration 0003_rls_app_role, INV12). Un rôle appartient au CLUSTER, pas à la base : un
// `pg_dump` n'en emporte ni la définition ni l'appartenance de l'utilisateur de l'application. Restaurer sur un autre
// cluster (cas général : une restauration gérée crée toujours une base neuve) sans le recréer fait échouer les GRANT
// du dump et rend `SET ROLE runtime_app` impossible. `runtime restore-prepare` le recrée AVANT `pg_restore`.
// Les instructions reprennent celles de la migration 0003 (idempotentes) ; un test garde leur équivalence.
import type pg from 'pg';

export const APP_ROLE_NAME = 'runtime_app';

export class AppRoleError extends Error {
  override name = 'AppRoleError';
}

export type EnsureAppRoleResult = { created: boolean; member: boolean };

export async function ensureAppRole(client: Pick<pg.ClientBase, 'query'>): Promise<EnsureAppRoleResult> {
  const { rows: before } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'runtime_app'");
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'runtime_app') THEN
        CREATE ROLE runtime_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN NULL;
    END
    $$`);
  const { rows: unsafe } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'runtime_app' AND (rolsuper OR rolbypassrls)");
  if ((unsafe[0]?.n ?? 0) > 0) throw new AppRoleError('le rôle runtime_app existe avec SUPERUSER ou BYPASSRLS : la RLS serait ignorée, refusé.');
  await client.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT runtime_app TO %I', current_user);
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN NULL;
    END
    $$`);
  const { rows: member } = await client.query<{ m: boolean }>("SELECT pg_has_role(current_user, 'runtime_app', 'member') AS m");
  return { created: (before[0]?.n ?? 0) === 0, member: member[0]?.m === true };
}
