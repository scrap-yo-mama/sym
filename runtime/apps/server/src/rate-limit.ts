// SPDX-License-Identifier: AGPL-3.0-only
// Compteurs d'échecs en mémoire, bornés (fenêtre fixe par clé, éviction des plus anciennes entrées au-delà de
// `maxEntries`) : limite par compte à la connexion, ré-authentification, assistant de premier démarrage.
// Une instance = un processus ; en multi-instance, compteurs partagés en PostgreSQL (08b § 3, à valider).
type Entry = { count: number; since: number };

export class AttemptLimiter {
  readonly #entries = new Map<string, Entry>();
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(opts: { max: number; windowMs: number; maxEntries?: number; now?: () => number }) {
    this.#max = opts.max;
    this.#windowMs = opts.windowMs;
    this.#maxEntries = opts.maxEntries ?? 10_000;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  #current(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && this.#now() - entry.since >= this.#windowMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  blocked(key: string): boolean {
    return (this.#current(key)?.count ?? 0) >= this.#max;
  }

  /** Enregistre un échec ; renvoie le nombre d'échecs de la fenêtre. */
  fail(key: string): number {
    const entry = this.#current(key) ?? { count: 0, since: this.#now() };
    entry.count += 1;
    this.#entries.delete(key); // réinsertion : ordre d'insertion = ordre d'activité
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return entry.count;
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }

  /**
   * Annule UNE tentative comptée d'avance par `fail` (elle a réussi). Contrairement à `reset`, les échecs déjà
   * comptés dans la fenêtre restent : un succès intercalé ne rouvre pas la limite.
   */
  cancel(key: string): void {
    const entry = this.#current(key);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) this.#entries.delete(key);
  }
}

/**
 * Clé de limite par adresse : une IPv4 (ou IPv4 mappée en IPv6) telle quelle ; une IPv6 agrégée sur son préfixe /64
 * (un hôte dispose d'ordinaire de tout un /64 : sans agrégation, la limite par IP se contourne en changeant d'adresse).
 */
export function ipBucket(ip: string): string {
  const address = ip.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;
  if (!address.includes(':')) return address;
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (Number.parseInt(g || '0', 16) || 0).toString(16))
    .join(':')}::/64`;
}
