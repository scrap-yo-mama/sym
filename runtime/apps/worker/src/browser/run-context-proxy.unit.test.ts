// SPDX-License-Identifier: AGPL-3.0-only
// `BrowserEgress.server` peut être `null` (fournisseur distant : le nœud impose son egress, tâche 4.1 ; 04e §2.2) : le
// contexte de run n'a alors aucun `proxy` ; avec un serveur local, le proxy de l'essai reste posé.
import { describe, expect, it } from 'vitest';
import { runContextProxy } from './run-context.js';

describe('proxy du contexte de run', () => {
  it('serveur local : proxy de l’essai', () => {
    expect(runContextProxy('http://127.0.0.1:4567')).toEqual({ proxy: { server: 'http://127.0.0.1:4567' } });
  });
  it('null : aucune option proxy', () => {
    expect(runContextProxy(null)).toEqual({});
  });
});
