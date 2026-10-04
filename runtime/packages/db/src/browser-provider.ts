// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur de navigateur publié par le worker (tâche 4.7 ; cdc/sym-browser 04g §3) : `local`, `sym-browser` ou `cdp`, avec ses
// capacités côté navigateur, pour que la console (Réglages > Navigateur) affiche le tableau des capacités présentes et absentes.
// Publié au démarrage du worker (best-effort, comme le moteur embarqué), jamais une adresse, une clé ni un jeton : seuls le genre,
// les sept capacités booléennes et l'état d'activation du fournisseur CDP générique.
import type pg from 'pg';

type Queryable = Pick<pg.ClientBase, 'query'>;

const BROWSER_PROVIDER_SETTING = 'browser_provider';

export const BROWSER_PROVIDER_KINDS = ['local', 'sym-browser', 'cdp'] as const;
export type BrowserProviderKind = (typeof BROWSER_PROVIDER_KINDS)[number];

/** Les sept capacités de `ProviderCapabilities` (`@sym/contracts/browser`). */
export const BROWSER_CAPABILITY_NAMES = ['egressPolicy', 'launchArgs', 'freshContextPerRun', 'killBeforeDetach', 'sandboxProbe', 'engineUserAgent', 'privateLatency'] as const;
export type BrowserCapabilityName = (typeof BROWSER_CAPABILITY_NAMES)[number];

export type BrowserProviderPublication = {
  readonly kind: BrowserProviderKind;
  readonly capabilities: Readonly<Record<BrowserCapabilityName, boolean>>;
  /** `BROWSER_ALLOW_GENERIC_CDP=true` sur le worker. */
  readonly genericCdpEnabled: boolean;
};

export async function publishBrowserProvider(db: Queryable, provider: BrowserProviderPublication): Promise<void> {
  const capabilities: Record<string, boolean> = {};
  for (const name of BROWSER_CAPABILITY_NAMES) capabilities[name] = provider.capabilities[name];
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [BROWSER_PROVIDER_SETTING, JSON.stringify({ kind: provider.kind, capabilities, generic_cdp_enabled: provider.genericCdpEnabled })],
  );
}

/** Dernier fournisseur publié par un worker ; `null` si aucun worker ne l'a encore publié, ou si la valeur est illisible. */
export async function readBrowserProvider(db: Queryable): Promise<BrowserProviderPublication | null> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [BROWSER_PROVIDER_SETTING]);
  const value = rows[0]?.value as { kind?: unknown; capabilities?: Record<string, unknown>; generic_cdp_enabled?: unknown } | undefined;
  if (typeof value?.kind !== 'string' || !(BROWSER_PROVIDER_KINDS as readonly string[]).includes(value.kind)) return null;
  const published = value.capabilities;
  if (typeof published !== 'object' || published === null) return null;
  const capabilities = {} as Record<BrowserCapabilityName, boolean>;
  for (const name of BROWSER_CAPABILITY_NAMES) {
    if (typeof published[name] !== 'boolean') return null;
    capabilities[name] = published[name];
  }
  return { kind: value.kind as BrowserProviderKind, capabilities, genericCdpEnabled: value.generic_cdp_enabled === true };
}
