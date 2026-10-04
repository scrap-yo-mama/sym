// SPDX-License-Identifier: AGPL-3.0-only
// Réglages > Navigateur (tâche 4.7 ; cdc/sym-browser 04g §3) : le fournisseur de navigateur que le worker publie au démarrage
// (`local`, `sym-browser` ou `cdp`), ses capacités côté navigateur et l'activation du CDP générique, en LECTURE SEULE : l'activation
// est une variable du worker (`BROWSER_ALLOW_GENERIC_CDP`), jamais un réglage qu'un membre pose. Même rôle que les autres réglages
// d'instance de l'admin (`settings:identity:write` : admin ou owner), session d'interface seulement. Jamais une adresse ni un secret.
import { readBrowserProvider } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

export function browserSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/settings/browser', async () => {
    const provider = await readBrowserProvider(ctx.pool);
    if (provider === null) return { kind: null, capabilities: null, generic_cdp_enabled: null };
    return { kind: provider.kind, capabilities: provider.capabilities, generic_cdp_enabled: provider.genericCdpEnabled };
  });
}
