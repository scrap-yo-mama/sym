// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { contentDigest, hasRef, hostAllowed, hostOf, semanticOf, truncateTree } from './snapshot.js';

const TREE = [
  '- generic [ref=e1]:',
  '  - heading "Annuaire" [level=1] [ref=e3]',
  '  - button "Suivant \\"mobile\\"" [active] [ref=e15]',
  '  - link "Vérifier mon compte" [ref=e20] [cursor=pointer]:',
  '    - /url: http://zz_test_evil.localhost:1/collect',
].join('\n');

describe('instantanés agent_step', () => {
  it('rôle et nom accessibles d\'un ref (trace sémantique, jamais le seul ref)', () => {
    expect(semanticOf(TREE, 'e15')).toEqual({ role: 'button', name: 'Suivant "mobile"' });
    expect(semanticOf(TREE, 'e20')).toEqual({ role: 'link', name: 'Vérifier mon compte' });
    expect(semanticOf(TREE, 'e1')).toEqual({ role: 'generic', name: '' });
    expect(semanticOf(TREE, 'e99')).toBeUndefined();
  });
  it('ref connu seulement s\'il figure dans l\'arbre ; e1 ne correspond pas à e15', () => {
    expect(hasRef(TREE, 'e15')).toBe(true);
    expect(hasRef(TREE, 'e2')).toBe(false);
    expect(hasRef(TREE, 'e1]')).toBe(false);
  });
  it('troncature sur une fin de ligne, signalée', () => {
    const { text, truncated } = truncateTree(TREE, 60);
    expect(truncated).toBe(true);
    expect(text.endsWith('- [truncated]')).toBe(true);
    expect(truncateTree(TREE, 10_000)).toEqual({ text: TREE, truncated: false });
  });
  it('empreinte liée à l\'URL et au contenu', () => {
    expect(contentDigest('u', TREE)).toBe(contentDigest('u', TREE));
    expect(contentDigest('u', TREE)).not.toBe(contentDigest('v', TREE));
    expect(contentDigest('u', TREE)).not.toBe(contentDigest('u', `${TREE} `));
  });
  it('verrou de domaines : hôte exact ou *.domaine ; schémas non http refusés', () => {
    const allowed = ['zz_test_agent_mobile_next.localhost', '*.example.invalid'];
    expect(hostAllowed(hostOf('http://zz_test_agent_mobile_next.localhost:4010/x'), allowed)).toBe(true);
    expect(hostAllowed(hostOf('http://ZZ_TEST_AGENT_MOBILE_NEXT.localhost/'), allowed)).toBe(true);
    expect(hostAllowed(hostOf('http://a.example.invalid/'), allowed)).toBe(true);
    expect(hostAllowed(hostOf('http://zz_test_evil.localhost/'), allowed)).toBe(false);
    expect(hostAllowed(hostOf('http://user@zz_test_evil.localhost/'), allowed)).toBe(false);
    expect(hostAllowed(hostOf('http://zz_test_agent_mobile_next.localhost.evil.invalid/'), allowed)).toBe(false);
    expect(hostAllowed(hostOf('javascript:alert(1)'), allowed)).toBe(false);
    expect(hostAllowed(hostOf('file:///etc/passwd'), allowed)).toBe(false);
  });
});
