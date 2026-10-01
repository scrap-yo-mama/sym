// Politique des artefacts de run (14 § 2 et § 10) : niveau 0 (`none`) par défaut = aucun artefact, jamais.
// Les niveaux supérieurs n'ajoutent que des captures d'un run ÉCHOUÉ, et jamais sur un run qui charge une session
// serveur, passe par le tunnel ou a rencontré un défi (une capture y contiendrait la session ou la page d'un tiers).
import type { ArtifactLevel } from './config.js';

export type ArtifactKind = 'screenshot' | 'trace' | 'har';

export type ArtifactRunFlags = {
  /** Le run charge une session serveur (cookies d'un utilisateur). */
  serverSession?: boolean;
  tunnel?: boolean;
  /** Le run a rencontré un défi (captcha, protection). */
  challenge?: boolean;
};

export type ArtifactDenial = 'level_none' | 'level_excludes_kind' | 'run_not_failed' | 'server_session' | 'tunnel' | 'challenge';

const KINDS_BY_LEVEL: Record<ArtifactLevel, readonly ArtifactKind[]> = {
  none: [],
  screenshot_on_failure: ['screenshot'],
  trace_on_failure: ['screenshot', 'trace'],
  har_minimal: ['screenshot', 'trace', 'har'],
};

/** `null` : l'artefact peut être conservé ; sinon la raison du refus. Le niveau `none` est testé en premier. */
export function artifactDenial(level: ArtifactLevel, kind: ArtifactKind, run: { failed: boolean } & ArtifactRunFlags): ArtifactDenial | null {
  if (level === 'none') return 'level_none';
  if (!KINDS_BY_LEVEL[level].includes(kind)) return 'level_excludes_kind';
  if (run.serverSession) return 'server_session';
  if (run.tunnel) return 'tunnel';
  if (run.challenge) return 'challenge';
  if (!run.failed) return 'run_not_failed';
  return null;
}
