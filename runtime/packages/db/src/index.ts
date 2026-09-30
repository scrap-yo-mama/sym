// Schéma Drizzle, migrations, runner verrouillé (tâche 0.2). Squelette tâche 0.1.
export const PACKAGE_NAME = '@runtime/db';

/** Extrait le nom de la base d'une URL PostgreSQL, sans exposer le mot de passe. */
export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}
