// SPDX-License-Identifier: AGPL-3.0-only
// Durées de conservation (14 § 9, 17 § 6). Valeurs initiales : RETENTION_DATASETS_DAYS et RETENTION_SAMPLES_DAYS (14 § 2) ;
// RETENTION_DATASETS_MAX_DAYS (plafond d'instance, revue de 1.8) ; RUN_LOG_RETENTION_DAYS ; ARTIFACT_RETENTION_DAYS.
// Les autres durées sont des défauts de 14 § 9 (audit 12 mois). Tous les chiffres sont à valider.

export type RetentionPolicy = {
  /** Datasets sans `retention_days` ni `expires_at` propres. */
  datasetsDays: number;
  /** Plafond d'instance : aucun dataset (hors épinglage en cours de validité) ne vit plus longtemps. */
  datasetsMaxDays: number;
  /** Charges d'enquête (`investigation_events.payload`, tout kind), `error_detail` et entrées de run (`runs.input`). */
  samplesDays: number;
  /** `run_logs` et `tunnel_jobs` terminés. */
  logsDays: number;
  /** `run_artifacts`. */
  artifactsDays: number;
  /** Runs terminés (avec `run_attempts`), `dedup_keys` non revus depuis. */
  runsDays: number;
  /** `audit_events` (13 § 9, 14 § 9 : 12 mois). */
  auditDays: number;
  /** `run_profiles` hors baseline (tâche 2.12, 19 §3 : 90 jours, à valider) ; la baseline est gardée avec sa version. */
  profilesDays: number;
  /** `BRIEF_VERSIONS_KEEP` (tâche 2.14, 19c § 4 : 5, à valider) : versions du dossier d'enquête gardées par API. */
  briefVersionsKeep: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  datasetsDays: 90,
  datasetsMaxDays: 3650,
  samplesDays: 14,
  logsDays: 30,
  artifactsDays: 7,
  runsDays: 90,
  auditDays: 365,
  profilesDays: 90,
  briefVersionsKeep: 5,
};

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} invalide : entier de jours supérieur ou égal à 1 attendu.`);
  return n;
}

/** Politique de l'instance d'après l'environnement (variables `RETENTION_*`, `RUN_LOG_RETENTION_DAYS`, `ARTIFACT_RETENTION_DAYS`). */
export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const d = DEFAULT_RETENTION_POLICY;
  const policy: RetentionPolicy = {
    ...d,
    datasetsDays: positiveInt(env['RETENTION_DATASETS_DAYS'], d.datasetsDays, 'RETENTION_DATASETS_DAYS'),
    datasetsMaxDays: positiveInt(env['RETENTION_DATASETS_MAX_DAYS'], d.datasetsMaxDays, 'RETENTION_DATASETS_MAX_DAYS'),
    samplesDays: positiveInt(env['RETENTION_SAMPLES_DAYS'], d.samplesDays, 'RETENTION_SAMPLES_DAYS'),
    logsDays: positiveInt(env['RUN_LOG_RETENTION_DAYS'], d.logsDays, 'RUN_LOG_RETENTION_DAYS'),
    artifactsDays: positiveInt(env['ARTIFACT_RETENTION_DAYS'], d.artifactsDays, 'ARTIFACT_RETENTION_DAYS'),
    profilesDays: positiveInt(env['RETENTION_PROFILES_DAYS'], d.profilesDays, 'RETENTION_PROFILES_DAYS'),
    briefVersionsKeep: positiveInt(env['BRIEF_VERSIONS_KEEP'], d.briefVersionsKeep, 'BRIEF_VERSIONS_KEEP'),
  };
  if (policy.datasetsMaxDays < policy.datasetsDays) {
    throw new Error('RETENTION_DATASETS_MAX_DAYS invalide : le plafond d’instance doit valoir au moins RETENTION_DATASETS_DAYS.');
  }
  return policy;
}
