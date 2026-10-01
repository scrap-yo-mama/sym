// SPDX-License-Identifier: AGPL-3.0-only
// Dépendances partagées par les routes.
import type { Kek, Secret } from '@runtime/core';
import type pg from 'pg';
import type { Auth } from './auth/better-auth.js';

export type ServerContext = {
  /** Connexion de l'identité système (propriétaire des tables). Le contenu se lit via `withActor` seulement. */
  pool: pg.Pool;
  auth: Auth;
  /** Origine publique (`PUBLIC_URL`), comparée à l'en-tête Origin des mutations d'interface. */
  publicUrl: string;
  bootstrapToken: Secret | null;
  adminEmail: string | null;
  /** Empreinte de MASTER_KEY, affichée une fois par l'assistant (13 § 4). */
  keyFingerprint: string;
  expectedSchemaVersion: number;
  /** KEK des cookies de sites (libellé `site_sessions`, génération vérifiée par keyCheck) : scellement seul côté web. */
  siteSessionKek: Kek;
  /** Vrai dès qu'un owner existe (mis en cache : l'état ne revient jamais en arrière). */
  isInitialized: () => Promise<boolean>;
};

export function initializedProbe(pool: pg.Pool): () => Promise<boolean> {
  let initialized = false;
  return async () => {
    if (initialized) return true;
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'owner'");
    initialized = (rows[0]?.n ?? 0) > 0;
    return initialized;
  };
}
