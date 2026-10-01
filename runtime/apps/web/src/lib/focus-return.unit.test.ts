// SPDX-License-Identifier: AGPL-3.0-only
// Retour du focus à l'élément qui a ouvert un panneau (WCAG 2.4.3) : sans lui, fermer la confirmation en ligne laisse le focus
// sur <body> et la personne au clavier repart du haut de la page. Jugé en Chromium par e2e/keyboard.e2e.ts ; ici la logique.
import { describe, expect, test } from 'vitest';
import { captureOpener, returnFocus } from './focus-return';

function fakeDocument(active: unknown) {
  return { activeElement: active, body: { tagName: 'BODY' } } as unknown as Pick<Document, 'activeElement' | 'body'>;
}

function fakeElement(connected = true) {
  const calls: string[] = [];
  return { isConnected: connected, focus: () => calls.push('focus'), calls } as unknown as HTMLElement & { calls: string[] };
}

describe('captureOpener', () => {
  test('garde l’élément qui a le focus au moment de l’ouverture', () => {
    const button = fakeElement();
    expect(captureOpener(fakeDocument(button))).toBe(button);
  });

  test('aucun ouvreur quand le focus est sur <body> ou nulle part', () => {
    const doc = fakeDocument(null);
    expect(captureOpener(doc)).toBeNull();
    const onBody = fakeDocument(null) as { activeElement: unknown; body: unknown };
    onBody.activeElement = onBody.body;
    expect(captureOpener(onBody as unknown as Pick<Document, 'activeElement' | 'body'>)).toBeNull();
    expect(captureOpener(undefined)).toBeNull();
  });
});

describe('returnFocus', () => {
  test('rend le focus à l’ouvreur encore présent dans la page', () => {
    const button = fakeElement();
    returnFocus(button);
    expect((button as unknown as { calls: string[] }).calls).toEqual(['focus']);
  });

  test('ne fait rien si l’ouvreur a disparu de la page ou n’existe pas', () => {
    const gone = fakeElement(false);
    returnFocus(gone);
    returnFocus(null);
    expect((gone as unknown as { calls: string[] }).calls).toEqual([]);
  });
});
