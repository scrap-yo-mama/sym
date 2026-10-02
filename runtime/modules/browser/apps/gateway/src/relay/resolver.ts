// SPDX-License-Identifier: AGPL-3.0-only
// Résolveur du relais WSS sur la base (tâche 2.3 ; 04 § 7, 04f § 3, BINV7). La décision d'ouverture est celle de la tâche
// 2.1 (`authorizeConnection`) : en-tête `Authorization` prioritaire, sinon query `token` ; jeton de connexion lié à la
// session et au protocole, ou clé d'API (jamais en query) avec le scope du protocole ; session du même client et `running`.
// Toute discordance répond 401 sans dire laquelle (aucune fuite d'existence) ; clé valide sans le scope : 403.
// Puis, propre au relais : CDP sur une session shared → 409 protocol_not_served ; nœud porteur absent ou `down` → 503.
// Le motif détaillé du refus (`reason`) part au journal de la passerelle (`onDenied`), jamais au client.
import { authorizeConnection, type ApiKeyAuthenticator, type ConnectTokens } from '@sym-browser/core';
import { getRelayTarget, type RelayTarget } from '@sym-browser/db';
import type pg from 'pg';
import { ApiProblem } from '../api/errors.js';
import { UUID } from '../api/validation.js';
import type { RelayAuthorization, RelayResolver } from './relay.js';

export function createDbRelayResolver(deps: {
  db: pg.Pool;
  auth: Pick<ApiKeyAuthenticator, 'check'>;
  tokens: Pick<ConnectTokens, 'verify'>;
  onDenied?: (sessionId: string, reason: string) => void;
}): RelayResolver {
  return {
    async authorize({ sessionId, protocol, headers, query }): Promise<RelayAuthorization> {
      if (!UUID.test(sessionId)) return { ok: false, problem: new ApiProblem('unauthorized', 'Missing, invalid or expired credential for this session.') };
      // Une seule lecture de la session, après authentification (authorizeConnection ne lit qu'une fois le jeton validé).
      let target: RelayTarget | null = null;
      const decision = await authorizeConnection(
        {
          auth: deps.auth,
          tokens: deps.tokens,
          session: async (id) => {
            target = await getRelayTarget(deps.db, id);
            return target ? { tenantId: target.tenantId, state: target.state } : null;
          },
        },
        { sessionId, protocol, headers, query },
      );
      if (!decision.ok) {
        deps.onDenied?.(sessionId, decision.reason);
        if (decision.status === 403) return { ok: false, problem: new ApiProblem('forbidden', `Scope ${decision.requiredScope} required.`, { details: { requiredScope: decision.requiredScope } }) };
        return { ok: false, problem: new ApiProblem('unauthorized', 'Missing, invalid or expired credential for this session.') };
      }
      const session = target as RelayTarget | null;
      if (!session) return { ok: false, problem: new ApiProblem('unauthorized', 'Missing, invalid or expired credential for this session.') };
      if (protocol === 'cdp' && session.type !== 'dedicated') return { ok: false, problem: new ApiProblem('protocol_not_served', 'CDP is served for dedicated sessions only.') };
      if (!session.nodeUrl || session.nodeState === 'down') return { ok: false, problem: new ApiProblem('no_node', 'Session node unavailable.', { retryAfter: 1 }) };
      return { ok: true, nodeUrl: session.nodeUrl, sessionId };
    },
  };
}
