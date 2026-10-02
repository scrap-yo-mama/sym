// SPDX-License-Identifier: AGPL-3.0-only
// Corpus de fixtures françaises du masquage en couches 1 et 2 (tâche 2.12, 19 §3, r4 R12, R14) : phrases d'annonces,
// de fiches et de commentaires inventées, chacune avec la valeur personnelle qu'elle porte et son type. Toutes les
// valeurs sont fictives (domaines `example.*`, numéros de la plage de fiction de l'ARCEP 01 99 00, IBAN et cartes de
// test publics, NIR de démonstration). Le rappel par type mesuré sur ce corpus est publié tel quel dans
// `runtime/docs/qualite/rappel-masquage.md` (`assert_llm_redaction_fr_corpus`).
export type PiiType = 'email' | 'phone' | 'iban' | 'card' | 'ip' | 'profile_url' | 'nir';

export type CorpusCase = { readonly type: PiiType; readonly value: string; readonly text: string };

export const FR_PII_CORPUS: readonly CorpusCase[] = [
  // E-mails
  { type: 'email', value: 'jeanne.martin@example.fr', text: 'Contact : jeanne.martin@example.fr pour toute question.' },
  { type: 'email', value: 'zz.vendeur+annonce@mail.example.com', text: 'Écrivez au vendeur (zz.vendeur+annonce@mail.example.com).' },
  { type: 'email', value: 'contact@boulangerie-dupont.example', text: 'Commandes : contact@boulangerie-dupont.example, du lundi au samedi.' },
  { type: 'email', value: 'p.durand@example.org', text: 'Responsable : P. Durand <p.durand@example.org>' },
  { type: 'email', value: 'zz_test%40example.net', text: 'lien mailto:zz_test%40example.net dans la page' },
  { type: 'email', value: 'Lucie.Bernard@Example.FR', text: 'Envoyez votre CV à Lucie.Bernard@Example.FR avant vendredi.' },
  // Téléphones (FR et E.164)
  { type: 'phone', value: '01 99 00 12 34', text: 'Appelez le 01 99 00 12 34 en semaine.' },
  { type: 'phone', value: '06.99.00.12.34', text: 'Portable : 06.99.00.12.34' },
  { type: 'phone', value: '+33 6 99 00 12 34', text: 'Tél. +33 6 99 00 12 34 (WhatsApp)' },
  { type: 'phone', value: '+33199001234', text: 'Standard joignable au +33199001234.' },
  { type: 'phone', value: '0199001234', text: 'tel:0199001234' },
  { type: 'phone', value: '0033 1 99 00 12 34', text: 'Depuis l’étranger : 0033 1 99 00 12 34.' },
  { type: 'phone', value: '07-99-00-12-34', text: 'joindre au 07-99-00-12-34 après 18 h' },
  { type: 'phone', value: '+44 20 7946 0958', text: 'Bureau de Londres : +44 20 7946 0958.' },
  // IBAN
  { type: 'iban', value: 'FR76 3000 6000 0112 3456 7890 189', text: 'Virement sur FR76 3000 6000 0112 3456 7890 189 avant le 5.' },
  { type: 'iban', value: 'FR7630006000011234567890189', text: 'IBAN : FR7630006000011234567890189' },
  { type: 'iban', value: 'DE89 3704 0044 0532 0130 00', text: 'Compte allemand DE89 3704 0044 0532 0130 00.' },
  { type: 'iban', value: 'fr76 1027 8060 3100 0205 5490 168', text: 'rib fr76 1027 8060 3100 0205 5490 168' },
  // Cartes (Luhn)
  { type: 'card', value: '4970 1012 3456 7890', text: 'Carte 4970 1012 3456 7890 refusée.' },
  { type: 'card', value: '4111111111111111', text: 'paiement test 4111111111111111 ok' },
  { type: 'card', value: '5555-5555-5555-4444', text: 'Mastercard 5555-5555-5555-4444 expirée.' },
  // IP
  { type: 'ip', value: '203.0.113.42', text: 'Connexion depuis 203.0.113.42 détectée.' },
  { type: 'ip', value: '192.0.2.7', text: 'adresse IP : 192.0.2.7' },
  { type: 'ip', value: '2001:db8::8a2e:370:7334', text: 'IPv6 2001:db8::8a2e:370:7334 du client' },
  // URL de profil
  { type: 'profile_url', value: 'https://www.linkedin.com/in/jeanne-martin-zz', text: 'Profil : https://www.linkedin.com/in/jeanne-martin-zz' },
  { type: 'profile_url', value: 'https://facebook.com/pierre.durand.zz', text: 'Page perso https://facebook.com/pierre.durand.zz' },
  { type: 'profile_url', value: 'https://x.com/zz_lucie', text: 'Suivez-moi : https://x.com/zz_lucie' },
  { type: 'profile_url', value: 'https://www.instagram.com/zz.atelier/', text: 'Photos sur https://www.instagram.com/zz.atelier/ !' },
  { type: 'profile_url', value: 'https://github.com/zz-dev', text: 'code : https://github.com/zz-dev' },
  // NIR (numéro de sécurité sociale)
  { type: 'nir', value: '2 84 05 75 112 345 67', text: 'N° SS : 2 84 05 75 112 345 67' },
  { type: 'nir', value: '184057511234567', text: 'nir=184057511234567' },
  { type: 'nir', value: '1 93 12 2A 123 456 78', text: 'Assuré né en Corse : 1 93 12 2A 123 456 78.' },
];

/** Phrases sans donnée personnelle : rien ne doit y être masqué (prix, références, dates, codes postaux). */
export const FR_CLEAN_CORPUS: readonly string[] = [
  'Prix : 1 299,00 € TTC, livraison 4,99 €.',
  'Référence ZZ-2026-0042, lot 12, stock 340 unités.',
  'Ouvert du 01/10/2026 au 31/12/2026, 75011 Paris.',
  'Version 2.12.0 publiée le 2026-10-02.',
  'Note moyenne 4,5 / 5 sur 1 234 avis.',
];
