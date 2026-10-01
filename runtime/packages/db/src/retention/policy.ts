// Durées de conservation (14 § 9, 17 § 6). Valeurs initiales : RETENTION_DATASETS_DAYS et RETENTION_SAMPLES_DAYS (14 § 2) ;
// les autres durées sont des défauts de 14 § 9 (journaux 30 jours, artefacts 7 jours). Tous les chiffres sont à valider.

export type RetentionPolicy = {
  /** Datasets sans `retention_days` ni `expires_at` propres. */
  datasetsDays: number;
  /** Plafond d'instance : aucun dataset (hors épinglés) ne vit plus longtemps. */
  datasetsMaxDays: number;
  /** Échantillons d'enquête, `error_detail` et entrées de run (`runs.input`). */
  samplesDays: number;
  /** `run_logs` et `tunnel_jobs` terminés. */
  logsDays: number;
  /** `run_artifacts`. */
  artifactsDays: number;
  /** Runs terminés (avec `run_attempts`), `dedup_keys` non revus depuis. */
  runsDays: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  datasetsDays: 90,
  datasetsMaxDays: 3650,
  samplesDays: 14,
  logsDays: 30,
  artifactsDays: 7,
  runsDays: 90,
};

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} invalide : entier de jours supérieur ou égal à 1 attendu.`);
  return n;
}

/** Politique de l'instance d'après l'environnement (`RETENTION_DATASETS_DAYS`, `RETENTION_SAMPLES_DAYS`). */
export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const d = DEFAULT_RETENTION_POLICY;
  return {
    ...d,
    datasetsDays: positiveInt(env['RETENTION_DATASETS_DAYS'], d.datasetsDays, 'RETENTION_DATASETS_DAYS'),
    samplesDays: positiveInt(env['RETENTION_SAMPLES_DAYS'], d.samplesDays, 'RETENTION_SAMPLES_DAYS'),
  };
}
