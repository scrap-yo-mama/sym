// SPDX-License-Identifier: AGPL-3.0-only
// Option de session `recordings: {trace, har, video, console, network}` (04 § 3, 04d § 2.1) : booléens, tous faux par
// défaut ; un champ inconnu ou non booléen est refusé avec son nom (422 `invalid_option`).
import { RECORDING_TYPES, type RecordingOptions, type RecordingType } from '@sym/contracts/browser';
import { InvalidSessionOptionError, type InvalidOptionDetail } from '../sessions/options.js';

export type ResolvedRecordingOptions = Record<RecordingType, boolean>;

export function recordingOptions(raw: RecordingOptions | undefined): ResolvedRecordingOptions {
  const out = Object.fromEntries(RECORDING_TYPES.map((t) => [t, false])) as ResolvedRecordingOptions;
  if (raw === undefined) return out;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InvalidSessionOptionError([{ field: 'recordings', reason: 'objet {trace, har, video, console, network} attendu' }]);
  const details: InvalidOptionDetail[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (!(RECORDING_TYPES as readonly string[]).includes(key)) details.push({ field: `recordings.${key}`, reason: 'type d’enregistrement inconnu' });
    else if (typeof value !== 'boolean') details.push({ field: `recordings.${key}`, reason: 'booléen attendu' });
    else out[key as RecordingType] = value;
  }
  if (details.length > 0) throw new InvalidSessionOptionError(details);
  return out;
}

export const anyRecording = (options: ResolvedRecordingOptions): boolean => RECORDING_TYPES.some((t) => options[t]);
