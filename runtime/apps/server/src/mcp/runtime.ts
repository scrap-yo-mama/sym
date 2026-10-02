// SPDX-License-Identifier: AGPL-3.0-only
// État du serveur MCP d'une instance (tâche 3.2) : mode d'exposition, hôtes et origines admis, jeton de canal interne, et
// signal « liste d'outils changée » (05 § 1.1). Le serveur est sans état : chaque requête construit sa liste d'outils
// depuis la base. Quand l'exposition change (API épinglée, créée, supprimée, stratégie ou schéma d'entrée changés), une
// empreinte relue périodiquement le détecte et le serveur publie `notifications/tools/list_changed` aux clients abonnés
// (`subscriptions/listen`, SDK v2) ; un client qui ne s'abonne pas relit la liste à la reconnexion (« si l'outil
// n'apparaît pas, reconnecte le serveur »).
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { ToolExposure } from './tools.js';

export type McpConfig = {
  /** `DISABLE_MCP=true` : aucune route /mcp (14 § 2). */
  disabled: boolean;
  /** `MCP_TOOL_EXPOSURE` : generic, pinned (défaut) ou all. */
  exposure: ToolExposure;
  /** Hôtes admis dans l'en-tête Host (sans port) : celui de PUBLIC_URL, plus `MCP_ALLOWED_HOSTS`. */
  allowedHosts: string[];
  /** Origines admises (nom d'hôte, sans port) : celle de PUBLIC_URL, plus `MCP_ALLOWED_ORIGINS`. */
  allowedOrigins: string[];
};

export type McpRuntime = McpConfig & {
  /**
   * Jeton aléatoire de ce processus (jamais servi ni journalisé) : marque les requêtes REST internes émises par le serveur
   * MCP pour le compte de la clé, afin que l'audit et le déclencheur des runs disent `mcp` (et non `apikey`/`rest`).
   */
  readonly channelToken: string;
  /** S'abonne au signal « liste d'outils changée » ; rend la fonction de désabonnement. */
  onToolsChanged(listener: () => void): () => void;
  /** Relit l'empreinte de l'exposition et publie le signal si elle a changé depuis la dernière lecture. */
  checkToolsChanged(): Promise<void>;
};

/** Empreinte de tout ce qui change une liste d'outils (toutes API confondues : un changement réveille tous les abonnés). */
const FINGERPRINT_SQL = `SELECT md5(coalesce(string_agg(
    id::text || ':' || slug || ':' || mcp_exposed::text || ':' || visibility || ':' || requires_session::text || ':' ||
    coalesce(current_strategy_version::text, '-') || ':' || md5(input_schema::text), ',' ORDER BY id), '')) AS fp
  FROM apis`;

export function createMcpRuntime(pool: pg.Pool, config: McpConfig): McpRuntime {
  const listeners = new Set<() => void>();
  let last: string | null = null;
  let mode = config.exposure;
  return {
    ...config,
    get exposure() {
      return mode;
    },
    set exposure(value: ToolExposure) {
      mode = value;
    },
    channelToken: randomBytes(32).toString('base64url'),
    onToolsChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async checkToolsChanged() {
      const { rows } = await pool.query<{ fp: string }>(FINGERPRINT_SQL);
      const fp = `${mode}:${rows[0]?.fp ?? ''}`;
      const changed = last !== null && last !== fp;
      last = fp;
      if (changed) for (const listener of listeners) listener();
    },
  };
}
