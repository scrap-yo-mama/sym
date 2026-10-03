// SPDX-License-Identifier: AGPL-3.0-only
// Dépendances partagées par les routes.
import type { JobQueue, Kek, Keyring, MfaEnforced, Secret } from '@runtime/core';
import type { SsrfGuard } from '@runtime/core/net';
import type { KeyCheckResult, SecretStore } from '@runtime/db';
import type pg from 'pg';
import type { Auth } from './auth/better-auth.js';
import type { MetricsCollector } from './metrics.js';
import type { TunnelGateway } from './tunnel/gateway.js';

export type ServerContext = {
  /** Connexion de l'identité système (propriétaire des tables). Le contenu se lit via `withActor` seulement. */
  pool: pg.Pool;
  auth: Auth;
  /** Origine publique (`PUBLIC_URL`), comparée à l'en-tête Origin des mutations d'interface. */
  publicUrl: string;
  bootstrapToken: Secret | null;
  adminEmail: string | null;
  /** Empreinte de MASTER_KEY, affichée une fois par l'assistant (13 § 4). Posée à la fin de l'initialisation. */
  keyFingerprint: string;
  /** Version de l'application (`RUNTIME_VERSION`), seule version publiée par `/api/health`. */
  appVersion: string;
  /** Version minimale de l'extension acceptée à l'appairage (`min_extension` de `GET /api/version`, 16 §3). */
  minExtension: string;
  /**
   * Démarrage (14 § 5) : `ready()` vaut true dès que le schéma est à la version attendue et que l'initialisation
   * (keyCheck, contrôle d'amorçage) est faite. Tant que false, seules `/api/health` et `/api/ready` répondent.
   */
  startup: { ready(): Promise<boolean> };
  expectedSchemaVersion: number;
  /** Clés de ce processus : `/api/ready` vérifie `key_check` sans rien écrire. */
  keyring: Keyring;
  /** `METRICS_TOKEN` (null : `/metrics` fermé, 404). */
  metricsToken: Secret | null;
  metrics: MetricsCollector;
  /** KEK des cookies de sites (libellé `site_sessions`, génération vérifiée par keyCheck) : scellement seul côté web. */
  siteSessionKek: Kek;
  /** Passerelle tunnel WSS (null : `DISABLE_TUNNEL`, ou serveur de test sans passerelle). */
  tunnel: TunnelGateway | null;
  /** Vrai dès qu'un owner existe (mis en cache : l'état ne revient jamais en arrière). */
  isInitialized: () => Promise<boolean>;
  /** `MFA_ENFORCED` (13 § 7). */
  mfaEnforced: MfaEnforced;
  /** Garde SSRF : relais SMTP et fournisseur OIDC passent par la politique `operator-config` (08b § 1). */
  guard: SsrfGuard;
  /** KEK `secrets` de la génération vérifiée par keyCheck : graines TOTP (posée par finishInit). */
  secretsKek: Kek;
  /** Dépôt des secrets d'instance (mot de passe SMTP, secret du client OIDC) ; posé par finishInit. */
  secrets: SecretStore | null;
  /** Autorités supplémentaires (relais SMTP ou IdP à certificat privé) : tests et réseaux internes. */
  extraCa?: string[];
  /** Tests seulement : IdP OIDC en http (jamais en production : l'issuer doit être https). */
  oidcAllowHttp?: boolean;
  /** Résultat de keyCheck (posé par finishInit) : clé des sujets (RGPD, 17 § 6) et version de clé. */
  keyChecked: KeyCheckResult | null;
  /**
   * File pg-boss du `server` (tâche 3.1) : démarrée au premier usage (création de run, planification, annulation), sans
   * supervision ni planificateur (le worker les tient). Les files qu'il alimente sont créées si elles manquent, sans
   * écraser les réglages du worker.
   */
  jobs: () => Promise<JobQueue>;
  /** Bornes de l'API REST (05 § 2) et du flux SSE (06 § 3). */
  rest: RestLimits;
  /** Fichier du statut « modèle validé » (eval/validated-models.json, 15 § 11) ; tests : un autre fichier. */
  validatedModelsFile?: URL | string;
};

type RestLimits = {
  maxWaitSeconds: number;
  maxConcurrentRuns: number;
  /** Période de relecture d'une attente synchrone et du flux SSE (ms). */
  pollMs: number;
  /** Commentaire `: ping` du flux SSE (ms, 15 à 20 s en production). */
  pingMs: number;
  /** Flux SSE ouverts en même temps par un utilisateur (plafond, 06 § 3). */
  maxStreamsPerUser: number;
  /** Revalidation de l'identité d'un flux SSE ouvert (ms, 30 s en production) : clé ou session révoquée → flux fermé. */
  revalidateMs: number;
  /** Runs actifs (hors pause) d'un même utilisateur au-delà desquels une création répond 429 `user_queue_full` (08b § 3). */
  maxActiveRunsPerUser: number;
  /** Créations de run par clé d'API et par minute au-delà desquelles une création répond 429 `key_rate_limited` (08b § 3). */
  maxRunsPerKeyPerMinute: number;
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
