// SPDX-License-Identifier: AGPL-3.0-only
// État du serveur MCP d'une instance (tâche 3.2) : mode d'exposition, hôtes et origines admis, jeton de canal interne,
// réglages des flux `subscriptions/listen`, et signal « liste d'outils changée » (05 § 1.1). Le serveur est sans état :
// chaque requête construit sa liste d'outils depuis la base. Les outils par API d'un utilisateur ne viennent que de SES
// API (08b § 3) : l'empreinte est donc calculée PAR UTILISATEUR abonné (ses API, plus le mode d'exposition), relue
// périodiquement, et seul l'utilisateur dont la liste a changé reçoit `notifications/tools/list_changed` (aucun signal
// d'une API d'autrui). Un client qui ne s'abonne pas relit la liste à la reconnexion (« si l'outil n'apparaît pas,
// reconnecte le serveur »).
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
  /** Origines admises, comparées en entier (schéma, hôte, port) : celle de PUBLIC_URL, plus les origines de `MCP_ALLOWED_ORIGINS`. */
  allowedOrigins: string[];
  /** Noms d'hôte admis dans l'en-tête Origin quel que soit le schéma ou le port (entrées sans schéma de `MCP_ALLOWED_ORIGINS`). */
  allowedOriginHosts: string[];
};

/** Réglages des flux `subscriptions/listen` (défauts de production ; les tests les raccourcissent). */
export type McpListenTuning = {
  /** Relecture de la clé et du compte d'un flux ouvert (ms) : clé révoquée ou compte désactivé → flux fermé. */
  listenRevalidateMs?: number;
  /** Flux ouverts en même temps par une clé d'API. */
  maxListenPerKey?: number;
  /** Flux ouverts en même temps par un utilisateur (toutes clés confondues). */
  maxListenPerUser?: number;
};

export type McpRuntime = McpConfig &
  Required<McpListenTuning> & {
    /**
     * Jeton aléatoire de ce processus (jamais servi ni journalisé) : marque les requêtes REST internes émises par le serveur
     * MCP pour le compte de la clé, afin que l'audit et le déclencheur des runs disent `mcp` (et non `apikey`/`rest`).
     */
    readonly channelToken: string;
    /** S'abonne au signal « liste d'outils changée » (utilisateur concerné) ; rend la fonction de désabonnement. */
    onToolsChanged(listener: (userId: string) => void): () => void;
    /** Suit l'empreinte d'un utilisateur tant qu'il a un flux ouvert ; rend la fonction qui arrête le suivi. */
    watch(userId: string): () => void;
    /** Relit l'empreinte de chaque utilisateur suivi et publie le signal pour ceux dont la liste a changé. */
    checkToolsChanged(): Promise<void>;
  };

/** Empreinte de ce qui change la liste d'outils par API d'un utilisateur : SES API (outils par API, 08b § 3). */
const FINGERPRINT_SQL = `SELECT u.id::text AS user_id, md5(coalesce(string_agg(
    a.id::text || ':' || a.slug || ':' || a.mcp_exposed::text || ':' || a.pinned::text || ':' ||
    coalesce(a.current_strategy_version::text, '-') || ':' || md5(a.input_schema::text), ',' ORDER BY a.id), '')) AS fp
  FROM unnest($1::uuid[]) AS u(id) LEFT JOIN apis a ON a.owner_id = u.id
  GROUP BY u.id`;

export function createMcpRuntime(pool: pg.Pool, config: McpConfig, tuning: McpListenTuning = {}): McpRuntime {
  const listeners = new Set<(userId: string) => void>();
  /** Utilisateurs suivis : nombre de flux ouverts et dernière empreinte connue (promesse : relevé initial en cours). */
  const watched = new Map<string, { count: number; last: Promise<string | null> }>();
  let mode = config.exposure;
  let chain: Promise<void> = Promise.resolve();

  const fingerprints = async (users: string[]): Promise<Map<string, string>> => {
    if (users.length === 0) return new Map();
    const { rows } = await pool.query<{ user_id: string; fp: string }>(FINGERPRINT_SQL, [users]);
    return new Map(rows.map((r) => [r.user_id, `${mode}:${r.fp}`]));
  };

  const check = async (): Promise<void> => {
    const users = [...watched.keys()];
    const current = await fingerprints(users);
    for (const user of users) {
      const entry = watched.get(user);
      const fp = current.get(user);
      if (entry === undefined || fp === undefined) continue;
      const last = await entry.last.catch(() => null);
      entry.last = Promise.resolve(fp);
      if (last !== null && last !== fp) for (const listener of listeners) listener(user);
    }
  };

  return {
    ...config,
    get exposure() {
      return mode;
    },
    set exposure(value: ToolExposure) {
      mode = value;
    },
    listenRevalidateMs: tuning.listenRevalidateMs ?? 30_000,
    maxListenPerKey: tuning.maxListenPerKey ?? 4,
    maxListenPerUser: tuning.maxListenPerUser ?? 8,
    channelToken: randomBytes(32).toString('base64url'),
    onToolsChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    watch(userId) {
      const entry = watched.get(userId);
      if (entry) entry.count += 1;
      // Relevé initial dès l'ouverture du flux : un changement survenu avant la relecture périodique suivante est signalé.
      else watched.set(userId, { count: 1, last: fingerprints([userId]).then((m) => m.get(userId) ?? null) });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const current = watched.get(userId);
        if (current === undefined) return;
        current.count -= 1;
        if (current.count <= 0) watched.delete(userId);
      };
    },
    // Relectures en série (minuterie et appels explicites) : un changement n'est publié qu'une fois.
    checkToolsChanged() {
      const next = chain.then(check);
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
