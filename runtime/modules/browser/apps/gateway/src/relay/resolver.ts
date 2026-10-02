// SPDX-License-Identifier: AGPL-3.0-only
// Résolveur du relais WSS sur la base (tâche 2.3 ; 04 § 7, 04f § 3, BINV7). Le secret est reconnu à son préfixe :
//   - jeton de session (`symbt_`) : signature, échéance, session ET protocole qu'il nomme ;
//   - sinon clé d'API (`Authenticator`, tâche 2.1) : session de son client, scope `sessions:write`.
// Toute discordance (session d'un autre client, autre session, autre protocole, session inconnue ou terminée) répond 401
// sans dire laquelle : rien ne révèle l'existence d'une session d'un autre client. Seule une clé valide de BON client sans
// le scope reçoit 403. Session `pending` : 503 no_node (réessayer) ; CDP sur shared : 409 protocol_not_served ; nœud porteur
// déclaré `down` : 503 no_node.
import { isConnectToken, isTerminal, type ConnectTokens } from '@sym-browser/core';
import { getRelayTarget } from '@sym-browser/db';
import type pg from 'pg';
import { ApiProblem } from '../api/errors.js';
import { UUID } from '../api/validation.js';
import type { Authenticator } from '../api/types.js';
import type { RelayAuthorization, RelayResolver } from './relay.js';

const unauthorized = (): RelayAuthorization => ({ ok: false, problem: new ApiProblem('unauthorized', 'Missing, invalid or expired credential for this session.') });

export function createDbRelayResolver(deps: { db: pg.Pool; auth: Authenticator; tokens: Pick<ConnectTokens, 'verify'> }): RelayResolver {
  return {
    async authorize({ sessionId, protocol, secret }) {
      if (secret === null || !UUID.test(sessionId)) return unauthorized();
      let tenantId: string | undefined;
      if (isConnectToken(secret)) {
        const check = deps.tokens.verify(secret);
        if (!check.ok || check.sessionId !== sessionId || check.protocol !== protocol) return unauthorized();
      } else {
        const principal = await deps.auth.authenticate(secret);
        if (!principal) return unauthorized();
        tenantId = principal.tenantId;
        const target = await getRelayTarget(deps.db, sessionId);
        if (!target || target.tenantId !== tenantId) return unauthorized();
        if (!principal.scopes.includes('sessions:write')) return { ok: false, problem: new ApiProblem('forbidden', 'Scope sessions:write required.', { details: { requiredScope: 'sessions:write' } }) };
      }
      const target = await getRelayTarget(deps.db, sessionId);
      if (!target || (tenantId !== undefined && target.tenantId !== tenantId) || isTerminal(target.state)) return unauthorized();
      if (target.state !== 'running') return { ok: false, problem: new ApiProblem('no_node', 'Session not started yet.', { retryAfter: 1 }) };
      if (protocol === 'cdp' && target.type !== 'dedicated') return { ok: false, problem: new ApiProblem('protocol_not_served', 'CDP is served for dedicated sessions only.') };
      if (!target.nodeUrl || target.nodeState === 'down') return { ok: false, problem: new ApiProblem('no_node', 'Session node unavailable.', { retryAfter: 1 }) };
      return { ok: true, nodeUrl: target.nodeUrl, sessionId };
    },
  };
}
