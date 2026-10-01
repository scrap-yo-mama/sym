// SPDX-License-Identifier: AGPL-3.0-only
// E6 limité au serveur (07 §3, ADR 0001, tâche 0.6b) : la règle que l'ordonnancement (2.4) et la passerelle (2.7)
// appliquent avant de choisir une stratégie. Le moteur retenu (Stagehand) ne traverse pas le tunnel.
import { describe, expect, it } from 'vitest';
import { EXECUTIONS, NETWORKS, ExecutionNotOnNetworkError, assertExecutionOnNetwork, executionAllowedOnNetwork } from '../index.js';

describe('assert_e6_not_in_tunnel_mode', () => {
  it('E6 (`agent`) est refusé en mode tunnel, avec une erreur typée ; il reste servi sur tous les autres niveaux réseau', () => {
    expect(executionAllowedOnNetwork('agent', 'tunnel')).toBe(false);
    expect(() => assertExecutionOnNetwork('agent', 'tunnel')).toThrow(ExecutionNotOnNetworkError);
    let caught: unknown;
    try {
      assertExecutionOnNetwork('agent', 'tunnel');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'execution_server_only', execution: 'agent', network: 'tunnel' });
    for (const network of NETWORKS.filter((n) => n !== 'tunnel')) {
      expect(executionAllowedOnNetwork('agent', network), network).toBe(true);
      expect(() => assertExecutionOnNetwork('agent', network)).not.toThrow();
    }
  });

  it('E1 à E5 restent servis en tunnel (scripts E5 compilés puis rejoués sans agent)', () => {
    for (const execution of EXECUTIONS.filter((e) => e !== 'agent')) {
      for (const network of NETWORKS) expect(executionAllowedOnNetwork(execution, network), `${execution}/${network}`).toBe(true);
    }
  });
});
