// SPDX-License-Identifier: AGPL-3.0-only
// Prompts de Stagehand nettoyés avant chaque appel au fournisseur (tâche 2.4, correctifs de vérification ; 08 §1
// « llm.redact », 08 §4 mesure 5) : le moteur appelle le fournisseur hors du LlmClient, le masquage doit donc être
// appliqué dans son middleware, sur TOUT le prompt (système, messages, appels et résultats d'outils), et les jetons
// d'URL (requête, fragment) retirés de tout ce qui vient de la page.
import { createRedactor } from '@runtime/llm';
import { describe, expect, it } from 'vitest';
import { cleanUrlTokens, sanitizeModelPrompt } from './stagehand-prompt.js';

const INSTRUCTION = 'Open http://zz_test_shop.localhost/list?page=2 and extract the products.';

const prompt = () => [
  { role: 'system', content: `<goal>${INSTRUCTION}</goal> you are starting your task on this url: http://zz_test_shop.localhost/?session=zz_secret_token#frag` },
  { role: 'user', content: [{ type: 'text', text: INSTRUCTION }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Contact: zz_test_jane@example.invalid' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'goto', input: { url: 'http://zz_test_shop.localhost/p?token=zz_secret_token' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'c2', toolName: 'ariaTree', output: { type: 'text', value: 'RootWebArea: http://zz_test_shop.localhost/c?sid=zz_secret_token\n[0-3] StaticText: zz_test_jane@example.invalid +33 1 23 45 67 89' } },
      { type: 'tool-result', toolCallId: 'c3', toolName: 'extract', output: { type: 'json', value: { email: 'zz_test_john@example.invalid', phone: '01 23 45 67 89', items: ['zz_test_x@example.invalid'] } } },
      { type: 'tool-result', toolCallId: 'c4', toolName: 'screenshot', output: { type: 'content', value: [{ type: 'text', text: 'page http://h.localhost/?k=zz_secret_token' }, { type: 'media', data: 'AAAA', mediaType: 'image/png' }] } },
    ],
  },
];

describe('sanitizeModelPrompt — prompts de Stagehand', () => {
  it('llm.redact actif : e-mails et téléphones masqués partout (système, texte, appels et résultats d’outils)', () => {
    const out = JSON.stringify(sanitizeModelPrompt(prompt(), { redactor: createRedactor({}), instruction: INSTRUCTION }));
    expect(out).not.toMatch(/zz_test_(jane|john|x)@example\.invalid/);
    expect(out).not.toContain('23 45 67 89');
    expect(out).toContain('[email]');
    expect(out).toContain('[téléphone]');
  });

  it('jetons d’URL retirés de tout ce qui vient de la page, même sans llm.redact ; la consigne de l’API reste intacte', () => {
    const sanitized = sanitizeModelPrompt(prompt(), { instruction: INSTRUCTION });
    const out = JSON.stringify(sanitized);
    expect(out).not.toContain('zz_secret_token');
    expect(out).not.toContain('#frag');
    expect(out).toContain('http://zz_test_shop.localhost/c');
    // La consigne (message utilisateur et <goal> du système) n'est pas réécrite.
    expect((sanitized[1] as { content: { text: string }[] }).content[0]!.text).toBe(INSTRUCTION);
    expect((sanitized[0] as { content: string }).content).toContain(`<goal>${INSTRUCTION}</goal>`);
    // Sans masquage configuré, les données ne sont pas réécrites (même règle que le LlmClient).
    expect(out).toContain('zz_test_jane@example.invalid');
    // Pièces non textuelles et identifiants d'outils intacts.
    expect(out).toContain('"data":"AAAA"');
    expect(out).toContain('"toolCallId":"c1"');
  });

  it('nettoyage d’URL : requête et fragment retirés, identifiants aussi', () => {
    expect(cleanUrlTokens('voir https://u:p@h.example/a/b?x=1&y=2#z puis http://h.localhost:8080/c.')).toBe('voir https://h.example/a/b puis http://h.localhost:8080/c.');
  });
});
