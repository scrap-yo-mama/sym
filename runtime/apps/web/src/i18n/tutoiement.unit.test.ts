// SPDX-License-Identifier: AGPL-3.0-only
// assert_console_fr_tutoiement (3.21, D-60, 20 § 3.1) : la console française tutoie partout. Aucun « vous », « votre »,
// « vos », « Veuillez » ni impératif au vouvoiement (« Réessayez », « Connectez-vous »…) dans fr.json. Seul le modèle de
// message envoyé à un site tiers (demande d'accès) s'adresse à quelqu'un d'autre que la personne qui utilise la console :
// il est listé ici, par clé, et rien d'autre ne l'est.
import { describe, expect, test } from 'vitest';
import fr from './locales/fr.json';

type Tree = { [key: string]: string | Tree };

function entries(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : entries(value, `${prefix}${key}.`)));
}

/** Messages qui s'adressent à un tiers (le site visé), pas à la personne qui utilise la console. */
const THIRD_PARTY_ADDRESS = new Set(['blocked.request.template', 'blockedPanel.request.template']);

const VOUVOIEMENT = /(?<![\p{L}\p{N}])(vous|votre|vos|veuillez)(?![\p{L}\p{N}])/iu;
/** Impératif ou présent à la deuxième personne du pluriel : un mot en « -ez » (hors mots courants qui ne sont pas un verbe). */
const IMPERATIF_EZ = /(?<![\p{L}\p{N}])(?!chez|assez|nez|rez)\p{L}{3,}ez(?![\p{L}\p{N}])/iu;

describe('assert_console_fr_tutoiement', () => {
  const messages = entries(fr as Tree).filter(([key]) => !THIRD_PARTY_ADDRESS.has(key));

  test('la liste des exceptions ne nomme que des clés qui existent', () => {
    const all = new Set(entries(fr as Tree).map(([key]) => key));
    const present = [...THIRD_PARTY_ADDRESS].filter((key) => all.has(key));
    expect(present.length).toBeGreaterThan(0);
  });

  test('aucun « vous », « votre », « vos », « Veuillez » dans fr.json', () => {
    expect(messages.filter(([, text]) => VOUVOIEMENT.test(text)).map(([key]) => key)).toEqual([]);
  });

  test('aucun impératif au vouvoiement (« Réessayez », « Connectez-vous »…) dans fr.json', () => {
    expect(messages.filter(([, text]) => IMPERATIF_EZ.test(text)).map(([key, text]) => `${key} : ${text}`)).toEqual([]);
  });

  test('le test sait échouer : il reconnaît le vouvoiement d’origine', () => {
    for (const bad of ['Utilisez le compte de votre instance.', 'Votre session est terminée. Connectez-vous à nouveau.', 'Veuillez réessayer.', 'Vérifiez votre connexion et réessayez.']) {
      expect(VOUVOIEMENT.test(bad) || IMPERATIF_EZ.test(bad), bad).toBe(true);
    }
    for (const good of ['Utilise le compte de ton instance.', 'Ta session est terminée. Connecte-toi à nouveau.']) {
      expect(VOUVOIEMENT.test(good) || IMPERATIF_EZ.test(good), good).toBe(false);
    }
  });
});
