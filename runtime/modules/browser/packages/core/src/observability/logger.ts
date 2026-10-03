// SPDX-License-Identifier: AGPL-3.0-only
// Journaux de SYM Browser (cdc/sym-browser 04d § 3.2, tâche 3.7) : pino 10, une ligne JSON par événement sur la sortie
// standard, champs `time` (ISO), `level` (nom), `msg`, et ceux de corrélation passés par l'appelant (`requestId`,
// `sessionId`, `tenantId`, `nodeId`, `event`). Masquage à trois couches de la tâche 0.3 (`loggerRedaction`) : chemins
// `redact`, sérialiseurs d'URL, balayage des arguments et des valeurs connues, puis filtre de motifs sur la ligne finale
// (`Bearer …`, identifiants dans les URL, paramètres sensibles, préfixes de clés d'API). Seuil : `SYMB_LOG_LEVEL`.
import { destination, pino, stdSerializers, stdTimeFunctions, type DestinationStream, type Logger as PinoLogger } from 'pino';
import { loggerRedaction, secretValues, type SecretValueRegistry } from '../crypto/redact.js';
import type { LogLevel } from '../config/load.js';

/** Préfixe des clés d'API de l'instance (04 § 1) : toute suite `symb_` + 16 caractères ou plus est masquée. */
export const API_KEY_PREFIXES: readonly string[] = ['symb_'];

export type PinoLoggerOptions = {
  level?: LogLevel;
  /** Sortie (défaut : stdout). */
  destination?: DestinationStream;
  /** Valeurs secrètes connues du processus (défaut : registre global). */
  registry?: SecretValueRegistry;
  apiKeyPrefixes?: readonly string[];
  /** Champs de chaque ligne (`nodeId`, `mode`…). */
  base?: Record<string, unknown>;
};

export type { PinoLogger };

export function createPinoLogger(options: PinoLoggerOptions = {}): PinoLogger {
  const redaction = loggerRedaction(options.registry ?? secretValues, { apiKeyPrefixes: options.apiKeyPrefixes ?? API_KEY_PREFIXES });
  return pino(
    {
      level: options.level ?? 'info',
      base: options.base ?? null,
      timestamp: stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: { level: (label) => ({ level: label }) },
      redact: redaction.redact,
      serializers: { ...redaction.serializers, err: stdSerializers.err },
      hooks: redaction.hooks,
    },
    options.destination ?? destination({ dest: 1, sync: true }),
  );
}
